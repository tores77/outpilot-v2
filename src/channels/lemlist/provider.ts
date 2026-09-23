// OUTPILOT v2 — LemlistEmailProvider
// Fase 2 · T018
//
// Implementa ChannelProvider (canal 'email', provider 'lemlist').
// Descubrimientos de contrato consolidados aqui; el cliente HTTP vive en
// ./client.ts y se inyecta para poder mockear en tests.
//
// PROTOCOLO DE ESCRITURA NO VERIFICADO EN VIVO. Los shapes de POST /campaigns
// y POST /campaigns/:id/leads/:email se infieren de la doc de Lemlist y
// del shape observado en GETs. El PRIMER POST REAL es el gate de T024
// (smoke test). Los tests aqui usan mocks; no golpean la API.

import type {
  ActiveProviderId,
  AddLeadInput,
  AddLeadResult,
  CampaignRef,
  CampaignSpec,
  ChannelKind,
  ChannelProvider,
  NormalizedEvent,
  TouchpointDirection,
  TouchpointKind,
} from "@/channels/types";
import type { LemlistClient } from "./client";
import { LemlistApiError } from "./client";
import {
  VOLT_ACTIVE_DAYS_PER_WEEK,
  VOLT_DEFAULT_SCHEDULES,
  VOLT_SCHEDULE_DAILY_CAP,
  type LemlistScheduleBody,
} from "@/config/lemlist";

// ===== Mapping de tipos de evento =====
// De los observados en histórico real (T018) + los documentados en
// developer.lemlist.com. Los que devuelven null son reconocidos-pero-
// ignorables: `emailsInterested`/`NotInterested` son labels de interes
// que clasifica Echo (T027), no eventos operativos de touchpoint.
// Un type NO listado aqui NI en IGNORED_TYPES es "no reconocido" y
// parseWebhookEvent LANZA (contrato #3 de ChannelProvider).

const EVENT_MAP: Record<string, TouchpointKind> = {
  emailsSent: "email_sent",
  emailsOpened: "email_opened",
  emailsClicked: "email_clicked",
  emailsReplied: "email_replied",
  emailsBounced: "email_bounced",
  emailsFailed: "email_failed",
  emailsUnsubscribed: "email_unsubscribed",
};

const IGNORED_TYPES = new Set<string>([
  "emailsInterested",
  "emailsNotInterested",
]);

const INBOUND_TYPES = new Set<TouchpointKind>(["email_replied"]);

// Campos de identidad PII a strippear defensivamente de raw en cualquier
// evento (spec §5 y decision de T018). Reply-specific: preservamos el
// contenido de la respuesta (subject/body/text/html) solo en email_replied
// porque Echo (T027) lo necesita para clasificar; el resto de eventos NO
// lleva copy relevante.
const PII_FIELDS = new Set<string>([
  "email",
  "firstName",
  "lastName",
  "phone",
  "linkedinUrl",
  "linkedinUrlSalesNav",
  "companyName",
  "companyDomain",
  "leadEmail",
  "leadFirstName",
  "leadLastName",
  "leadCompanyName",
  "to",
  "recipient",
  "sendUserEmail",
  "sendUserLoginEmail",
]);

const REPLY_CONTENT_FIELDS = new Set<string>([
  "subject",
  "body",
  "text",
  "html",
  "plainText",
  "message",
]);

/**
 * Devuelve una copia del objeto sin los campos PII. Si `preserveReplyContent`
 * es false, tambien limpia campos de contenido (subject/body/...); si es
 * true, los conserva (caso emailsReplied → Echo).
 */
function stripPII(input: unknown, preserveReplyContent: boolean): unknown {
  if (Array.isArray(input)) {
    return input.map((v) => stripPII(v, preserveReplyContent));
  }
  if (input && typeof input === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      if (PII_FIELDS.has(k)) continue;
      if (!preserveReplyContent && REPLY_CONTENT_FIELDS.has(k)) continue;
      out[k] = stripPII(v, preserveReplyContent);
    }
    return out;
  }
  return input;
}

// ===== Payloads =====

// Descubierto en el probe write-protocol de T018: el schedule embebido en
// POST /campaigns se IGNORA en silencio (Lemlist crea un "Default schedule"
// propio). Por eso el body de creacion es minimo — el schedule se aplica
// via PATCH sobre el default + POST del segundo schedule + associate,
// dentro de upsertCampaign.
type LemlistCampaignCreatePayload = {
  name: string;
  senderStrategy: "random";
};

// Respuesta de POST /campaigns. Trae mucho mas (sequenceId, scheduleIds,
// tracking flags, etc.) pero solo `_id` es contrato hoy. Ojo: incluye un
// campo `state: "running"` que NO refleja el estado operativo — el estado
// real (draft|paused|ended|...) vive en el `status` del detalle GET
// /campaigns/:id. NO confundir state con status; en el probe la campana
// nacia con state=running Y status=draft simultaneamente.
type LemlistCampaignResponse = {
  _id: string;
  scheduleIds?: string[];
};

// Item de /campaigns/:id/schedules — reducido al minimo que usamos.
type LemlistScheduleItem = {
  _id: string;
};

// Respuesta de POST /schedules o PATCH /schedules/:id.
type LemlistScheduleResponse = {
  _id: string;
};

// Respuesta de POST /campaigns/:id/leads/:email — trae mas campos pero
// solo _id y contactId nos interesan (PII fuera).
type LemlistAddLeadResponse = {
  _id?: string; // lea_...
  contactId?: string; // ctc_...
};

// Shape de una activity segun observado en T018 (campos criticos).
// Todos opcionales excepto type + createdAt porque Lemlist varia por
// tipo. Los campos PII no se declaran aqui — stripPII los limpia de raw
// aunque no esten en el type.
type LemlistActivity = {
  _id?: string;
  type: string;
  createdAt: string;
  campaignId?: string;
  sequenceId?: string;
  sequenceStep?: number;
  leadId?: string;
  sendUserMailboxId?: string;
  // Campos que solo aparecen en replies (T027 los usa):
  subject?: string;
  body?: string;
  text?: string;
  html?: string;
  // Cualquier otro campo termina en raw si no es PII.
  [k: string]: unknown;
};

/**
 * Envios efectivos por dia para un mailbox: el minimo entre su
 * emailLimit de Lemlist y el techo que imponen las ventanas del
 * schedule Volt. Pura, testeable, sin efectos.
 *
 * Con el schedule actual (2 ventanas de 2h, secondsToWait 1200):
 *   emailLimit 30 → min(30, 12) = 12
 *   emailLimit  5 → min(5, 12)  = 5
 *   emailLimit  0 → 0
 *
 * El techo por ventanas se recalcula desde VOLT_DEFAULT_SCHEDULES si
 * cambia; esta funcion no lo cachea.
 */
export function effectiveDailySendsPerMailbox(emailLimit: number): number {
  return Math.max(0, Math.min(emailLimit, VOLT_SCHEDULE_DAILY_CAP));
}

/**
 * Capacidad de envio semanal estimada para la UI (T019/T021). SUMA por
 * mailbox activo — NO usa un minimo comun. La spec de T019 exige que
 * un mailbox con emailLimit menor no infle el total del resto.
 *
 * Recibe los `emailLimit` de los mailboxes con `status === 'OK'`.
 * Devuelve emails/semana asumiendo M-X-J (VOLT_ACTIVE_DAYS_PER_WEEK).
 *
 * Fuente unica de la cifra que la UI muestra; el desglose visual usa
 * `effectiveDailySendsPerMailbox` y `VOLT_SCHEDULE_DAILY_CAP` para
 * anotar cuando el techo por ventanas es el dominante.
 */
export function computeWeeklyCapacity(emailLimits: readonly number[]): number {
  const totalDaily = emailLimits.reduce(
    (sum, limit) => sum + effectiveDailySendsPerMailbox(limit),
    0,
  );
  return totalDaily * VOLT_ACTIVE_DAYS_PER_WEEK;
}

// ===== Provider =====

export type LemlistEmailProviderOptions = {
  client: LemlistClient;
};

export function createLemlistEmailProvider(
  opts: LemlistEmailProviderOptions,
): ChannelProvider {
  const { client } = opts;

  const id: ActiveProviderId = "lemlist";
  const channel: ChannelKind = "email";

  /**
   * Crea o actualiza una campana. Ojo con la asimetria por descubrimiento
   * del probe write-protocol (T018):
   *
   * CREATE (input.externalId ausente) — flujo de 5 pasos:
   *   1. POST /campaigns con body minimo (name + senderStrategy).
   *   2. GET /campaigns/:cid/schedules → captura _id del "Default schedule"
   *      auto-creado por Lemlist (Europe/Paris L-V 09:00-18:00).
   *   3. PATCH /schedules/:defaultId con la ventana 1 (M-X-J 09-11 Madrid).
   *   4. POST /schedules con la ventana 2 (M-X-J 15-17 Madrid).
   *   5. POST /campaigns/:cid/schedules/:sid2 para asociar la ventana 2.
   *
   * El schedule embebido en POST /campaigns se IGNORA en silencio — por
   * eso el body de creacion es minimo. Lemlist no expone multi-windows
   * en un solo schedule; la spec §4 se preserva con dos schedules
   * asociados a la misma campana (verificado en probe: ambos conviven).
   *
   * UPDATE (input.externalId presente) — solo PATCH /campaigns/:id con
   * el name. NO reconciliamos schedules en update: la campana ya tiene
   * sus dos ventanas de la creacion, y v2.1 no permite cambiarlas por
   * UI (spec §4 fuente unica). Si esa asuncion cambia, extender aqui.
   */
  async function upsertCampaign(input: CampaignSpec): Promise<CampaignRef> {
    if (input.externalId) {
      const updated = await client.patch<LemlistCampaignResponse>(
        `/campaigns/${encodeURIComponent(input.externalId)}`,
        { name: input.name },
      );
      return { externalId: updated?._id ?? input.externalId };
    }

    // === Step 1: crear campana ===
    const createPayload: LemlistCampaignCreatePayload = {
      name: input.name,
      senderStrategy: "random",
    };
    const created = await client.post<LemlistCampaignResponse>(
      "/campaigns",
      createPayload,
    );
    if (!created?._id) {
      throw new Error(
        "LemlistEmailProvider.upsertCampaign: POST /campaigns sin _id (contrato roto).",
      );
    }
    const campaignId = created._id;

    // === Step 2: capturar el Default schedule auto-creado ===
    const existingSchedules = await client.get<LemlistScheduleItem[]>(
      `/campaigns/${encodeURIComponent(campaignId)}/schedules`,
    );
    const defaultScheduleId = Array.isArray(existingSchedules)
      ? existingSchedules[0]?._id
      : undefined;
    if (!defaultScheduleId) {
      throw new Error(
        `LemlistEmailProvider.upsertCampaign: no encuentro Default schedule para ${campaignId}.`,
      );
    }

    // === Step 3: PATCH del default con la ventana 1 ===
    const [window1, window2] = VOLT_DEFAULT_SCHEDULES as readonly LemlistScheduleBody[];
    await client.patch<LemlistScheduleResponse>(
      `/schedules/${encodeURIComponent(defaultScheduleId)}`,
      window1,
    );

    // === Step 4: POST del segundo schedule (ventana 2) ===
    const window2Created = await client.post<LemlistScheduleResponse>(
      "/schedules",
      window2,
    );
    if (!window2Created?._id) {
      throw new Error(
        "LemlistEmailProvider.upsertCampaign: POST /schedules (window2) sin _id.",
      );
    }

    // === Step 5: asociar la ventana 2 a la campana ===
    await client.post(
      `/campaigns/${encodeURIComponent(campaignId)}/schedules/${encodeURIComponent(window2Created._id)}`,
      undefined,
    );

    return { externalId: campaignId };
  }

  async function addLead(input: AddLeadInput): Promise<AddLeadResult> {
    // Lemlist: POST /campaigns/:campaignId/leads/:email con body de
    // variables de personalizacion. Respuesta 200 con lead nuevo, o
    // 400/409 con "Lead already in the campaign" si existe (verificado
    // en el probe write-protocol). Duplicado → exito silencioso sin ids
    // (contrato #1 de ChannelProvider — idempotencia).
    const path = `/campaigns/${encodeURIComponent(input.campaignExternalId)}/leads/${encodeURIComponent(input.leadEmail)}`;
    try {
      const created = await client.post<LemlistAddLeadResponse>(
        path,
        input.personalization,
      );
      return {
        providerLeadId: typeof created?._id === "string" ? created._id : undefined,
        providerContactId:
          typeof created?.contactId === "string" ? created.contactId : undefined,
      };
    } catch (err) {
      if (err instanceof LemlistApiError && isAlreadyAddedError(err)) {
        return {};
      }
      throw err;
    }
  }

  function parseWebhookEvent(
    rawBody: string,
    _headers: Record<string, string>,
  ): NormalizedEvent | null {
    // El caller (T025) YA ha verificado el secret y lo ha eliminado del
    // body antes de invocar. El contrato #4 asi lo dice.
    let parsed: LemlistActivity;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      throw new Error(
        `LemlistEmailProvider.parseWebhookEvent: body no es JSON valido.`,
      );
    }

    if (!parsed || typeof parsed.type !== "string") {
      throw new Error(
        `LemlistEmailProvider.parseWebhookEvent: falta campo 'type' obligatorio.`,
      );
    }

    if (IGNORED_TYPES.has(parsed.type)) {
      return null;
    }

    const kind = EVENT_MAP[parsed.type];
    if (!kind) {
      throw new Error(
        `LemlistEmailProvider.parseWebhookEvent: type desconocido '${parsed.type}'. ` +
          `Anadir a EVENT_MAP o IGNORED_TYPES con evidencia real.`,
      );
    }

    const direction: TouchpointDirection = INBOUND_TYPES.has(kind) ? "inbound" : "outbound";

    // Extraccion segura de campos requeridos por NormalizedEvent.
    const providerEventId = typeof parsed._id === "string" ? parsed._id : null;
    const channelAccountExternalId =
      typeof parsed.sendUserMailboxId === "string" ? parsed.sendUserMailboxId : "";
    // Prioridad: leadEmail (campo estable en activities). Si no viene,
    // lanzamos — sin lead no podemos anclar el touchpoint (spec §5).
    const leadEmailField =
      typeof (parsed as Record<string, unknown>).leadEmail === "string"
        ? ((parsed as Record<string, unknown>).leadEmail as string)
        : typeof (parsed as Record<string, unknown>).email === "string"
          ? ((parsed as Record<string, unknown>).email as string)
          : null;
    if (!leadEmailField) {
      throw new Error(
        `LemlistEmailProvider.parseWebhookEvent: falta leadEmail/email para type '${parsed.type}'.`,
      );
    }

    const occurredAt = parsed.createdAt ? new Date(parsed.createdAt) : new Date();

    const raw = stripPII(parsed, kind === "email_replied");

    return {
      providerEventId,
      kind,
      direction,
      channelAccountExternalId,
      leadEmail: leadEmailField,
      occurredAt,
      raw,
    };
  }

  return {
    id,
    channel,
    upsertCampaign,
    addLead,
    parseWebhookEvent,
  };
}

/**
 * Heuristica para detectar "lead ya existe en campana" desde el error
 * de Lemlist. La API responde con status 400/409 y body que menciona
 * "already". Sin probe real (T024) mantenemos la heuristica conservadora:
 * status 409 exacto O status 400 con texto que contiene 'already'.
 */
function isAlreadyAddedError(err: LemlistApiError): boolean {
  if (err.status === 409) return true;
  if (err.status === 400 && /already/i.test(err.bodyPreview)) return true;
  return false;
}
