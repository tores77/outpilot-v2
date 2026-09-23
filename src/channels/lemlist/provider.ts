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
import { VOLT_DEFAULT_SCHEDULE } from "@/config/lemlist";

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

type LemlistCampaignCreatePayload = {
  name: string;
  senderStrategy: "random";
  schedule: {
    name: string;
    timezone: string;
    weekdays: number[];
    windows: ReadonlyArray<{ start: string; end: string }>;
    secondsToWait: number;
  };
};

type LemlistCampaignResponse = {
  _id: string;
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
 * Capacidad de envio semanal estimada para la UI de confirmacion
 * (T019/T021). Deliberadamente pura y testeable.
 *
 * mailboxCount: mailboxes con status 'OK' en la campana.
 * dailyLimitPerMailbox: emailLimit del mailbox en Lemlist.
 * Retorna emails por semana asumiendo el schedule Volt (3 dias M-X-J).
 */
export function computeWeeklyCapacity(
  mailboxCount: number,
  dailyLimitPerMailbox: number,
): number {
  const daysPerWeek = VOLT_DEFAULT_SCHEDULE.weekdays.length;
  return Math.max(0, mailboxCount) * Math.max(0, dailyLimitPerMailbox) * daysPerWeek;
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

  async function upsertCampaign(input: CampaignSpec): Promise<CampaignRef> {
    // Forzar schedule y rotacion desde el codigo — la config del provider
    // es fuente unica (spec R2 §4 Volt).
    const payload: LemlistCampaignCreatePayload = {
      name: input.name,
      senderStrategy: "random",
      schedule: {
        name: VOLT_DEFAULT_SCHEDULE.name,
        timezone: VOLT_DEFAULT_SCHEDULE.timezone,
        weekdays: VOLT_DEFAULT_SCHEDULE.weekdays,
        windows: VOLT_DEFAULT_SCHEDULE.windows,
        secondsToWait: VOLT_DEFAULT_SCHEDULE.secondsBetweenSends,
      },
    };

    if (input.externalId) {
      const updated = await client.patch<LemlistCampaignResponse>(
        `/campaigns/${encodeURIComponent(input.externalId)}`,
        payload,
      );
      return { externalId: updated._id ?? input.externalId };
    }

    const created = await client.post<LemlistCampaignResponse>("/campaigns", payload);
    if (!created?._id) {
      throw new Error(
        "LemlistEmailProvider.upsertCampaign: respuesta sin _id (contrato roto).",
      );
    }
    return { externalId: created._id };
  }

  async function addLead(input: AddLeadInput): Promise<void> {
    // Lemlist convention historica: POST /campaigns/:campaignId/leads/:email
    // con body de variables de personalizacion. La API responde 200 con el
    // lead nuevo, o 409/400 si ya existe. Tratamos "ya existe" como exito
    // silencioso — contrato #1 de ChannelProvider (idempotencia).
    const path = `/campaigns/${encodeURIComponent(input.campaignExternalId)}/leads/${encodeURIComponent(input.leadEmail)}`;
    try {
      await client.post(path, input.personalization);
    } catch (err) {
      if (err instanceof LemlistApiError && isAlreadyAddedError(err)) {
        return;
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
