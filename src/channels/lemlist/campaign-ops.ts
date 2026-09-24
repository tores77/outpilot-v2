// OUTPILOT v2 — Lemlist campaign low-level ops (T023)
// -----------------------------------------------------------------------------
// Wrappers finos sobre el LemlistClient para las operaciones que el
// orquestador Volt encapsula en steps de Inngest, cada uno un recurso
// externo. NO forman parte de la interfaz ChannelProvider (T017) —
// esa interfaz mantiene 3 métodos abstractos (upsertCampaign, addLead,
// parseWebhookEvent) para que LinkedIn/Unipile puedan implementarla
// mañana sin arrastrar estas primitivas Lemlist-específicas.
//
// Endpoints usados (todos verificados en T018 salvo addSequenceStep,
// verificado en T023 con `probe:lemlist-add-step`):
//   POST   /api/campaigns                          → crea campaña
//   GET    /api/campaigns/:cid                     → status + shape
//   GET    /api/campaigns/:cid/schedules           → lista schedules
//   POST   /api/schedules                          → crea schedule
//   PATCH  /api/schedules/:sid                     → parcial
//   POST   /api/campaigns/:cid/schedules/:sid      → asocia
//   GET    /api/campaigns/:cid/sequences           → mapa sequenceId
//                                                    → {steps: [...]}
//   POST   /api/sequences/:sid/steps               → añade step al final
//                                                    (NO idempotente)

import type { LemlistClient } from "./client";

export type LemlistCampaignSummary = {
  _id: string;
  status?: string;
  name?: string;
};

export type LemlistScheduleRow = {
  _id: string;
  name?: string;
  timezone?: string;
  weekdays?: number[];
  start?: string;
  end?: string;
  secondsToWait?: number;
};

export type LemlistSequenceStepRow = {
  _id: string;
  type?: string;
  index?: number; // 1-based
  sequenceStep?: number; // 0-based
  delay?: number; // días
  subject?: string;
  message?: string;
  emailTemplateId?: string;
};

export type LemlistSequenceRow = {
  _id: string;
  steps?: LemlistSequenceStepRow[];
};

export type LemlistSequencesResponse = Record<string, LemlistSequenceRow>;

export type LemlistCreateCampaignPayload = {
  name: string;
  senderStrategy: "random";
};

export type LemlistCreateCampaignResponse = {
  _id: string;
  scheduleIds?: string[];
};

export type LemlistScheduleBody = {
  name: string;
  timezone: string;
  start: string;
  end: string;
  weekdays: number[];
  secondsToWait: number;
};

export type LemlistAddStepBody = {
  type: "email";
  // subject opcional: omitir para follow-ups → Lemlist los envía como
  // respuesta en el hilo del step 1 (comportamiento documentado).
  subject?: string;
  message: string;
  delay: number;
  index?: number;
};

/**
 * POST /campaigns con body minimo. El schedule embebido se ignoraría
 * (verificado en T018), así que no lo pasamos. Sender strategy
 * "random" para que Lemlist alterne mailboxes al enviar.
 */
export async function createLemlistCampaign(
  client: LemlistClient,
  args: { name: string },
): Promise<LemlistCreateCampaignResponse> {
  const payload: LemlistCreateCampaignPayload = {
    name: args.name,
    senderStrategy: "random",
  };
  const res = await client.post<LemlistCreateCampaignResponse>(
    "/campaigns",
    payload,
  );
  if (!res?._id) {
    throw new Error("createLemlistCampaign: response sin _id");
  }
  return res;
}

/**
 * GET /campaigns/:cid — usado por el guard assert-campaign-not-running
 * antes de sync-lead-*. Devuelve el minimum que necesitamos (_id, status,
 * name). El body real de Lemlist trae mucho más; ignoramos el resto.
 */
export async function getLemlistCampaign(
  client: LemlistClient,
  cid: string,
): Promise<LemlistCampaignSummary> {
  return client.get<LemlistCampaignSummary>(
    `/campaigns/${encodeURIComponent(cid)}`,
  );
}

/**
 * GET /campaigns/:cid/schedules. Devuelve las filas necesarias para
 * decidir si ya existe una ventana Volt (M-X-J 15-17) antes de crear
 * la segunda.
 */
export async function getCampaignSchedules(
  client: LemlistClient,
  cid: string,
): Promise<LemlistScheduleRow[]> {
  const res = await client.get<LemlistScheduleRow[]>(
    `/campaigns/${encodeURIComponent(cid)}/schedules`,
  );
  return Array.isArray(res) ? res : [];
}

/**
 * PATCH /schedules/:sid. Naturalmente idempotente — aplicar el mismo
 * body N veces produce el mismo resultado. Usado para el "Default
 * schedule" auto-creado, que hay que reconfigurar a la ventana 1 de
 * Volt (M-X-J 09-11 Europe/Madrid).
 */
export async function patchSchedule(
  client: LemlistClient,
  sid: string,
  body: LemlistScheduleBody,
): Promise<{ _id: string }> {
  return client.patch<{ _id: string }>(
    `/schedules/${encodeURIComponent(sid)}`,
    body,
  );
}

/**
 * POST /schedules. Devuelve un schedule nuevo. Usado para crear la
 * ventana 2 (M-X-J 15-17). NO idempotente por sí solo — el caller
 * debe verificar antes con getCampaignSchedules si ya existe una con
 * el mismo shape.
 */
export async function createSchedule(
  client: LemlistClient,
  body: LemlistScheduleBody,
): Promise<{ _id: string }> {
  const res = await client.post<{ _id: string }>("/schedules", body);
  if (!res?._id) throw new Error("createSchedule: response sin _id");
  return res;
}

/**
 * POST /campaigns/:cid/schedules/:sid — asocia un schedule existente
 * a una campaña. Body vacío. Puede aplicarse N veces sin efecto extra
 * (verificado indirectamente en T018: la segunda associate no crea
 * duplicado en /campaigns/:cid/schedules).
 */
export async function associateSchedule(
  client: LemlistClient,
  cid: string,
  sid: string,
): Promise<void> {
  await client.post(
    `/campaigns/${encodeURIComponent(cid)}/schedules/${encodeURIComponent(sid)}`,
    undefined,
  );
}

/**
 * GET /campaigns/:cid/sequences — mapa {sequenceId: {steps: [...]}}.
 * Volt lo usa para (a) descubrir el sequenceId auto-creado por
 * Lemlist en el momento de la creación, (b) verificar antes de POST
 * step si ya existe uno en la posición esperada.
 */
export async function getCampaignSequences(
  client: LemlistClient,
  cid: string,
): Promise<LemlistSequencesResponse> {
  return client.get<LemlistSequencesResponse>(
    `/campaigns/${encodeURIComponent(cid)}/sequences`,
  );
}

/**
 * POST /sequences/:sid/steps — añade un step al final de la sequence.
 * Verificado en T023 (probe add-step): NO idempotente — dos POST
 * iguales crean dos steps. La idempotencia se implementa en el
 * caller (Volt job) haciendo GET sequences primero y comparando por
 * posición + subject.
 *
 * Body mínimo probado:
 *   { type: "email", subject, message, delay }
 * (index es opcional; sin él, se añade al final)
 */
export async function addSequenceStep(
  client: LemlistClient,
  sid: string,
  body: LemlistAddStepBody,
): Promise<LemlistSequenceStepRow> {
  const res = await client.post<LemlistSequenceStepRow>(
    `/sequences/${encodeURIComponent(sid)}/steps`,
    body,
  );
  if (!res?._id) {
    throw new Error("addSequenceStep: response sin _id");
  }
  return res;
}

/**
 * Utilidad para el step de asociación de la ventana 2: dado un listado
 * de schedules y una definición objetivo, devuelve el _id si ya existe
 * uno con el mismo shape lógico (mismos start/end/weekdays/timezone/
 * secondsToWait). Null si no hay match.
 */
export function findScheduleMatching(
  schedules: readonly LemlistScheduleRow[],
  target: LemlistScheduleBody,
): string | null {
  const targetWeekdays = [...target.weekdays].sort().join(",");
  for (const s of schedules) {
    if (
      s.timezone === target.timezone &&
      s.start === target.start &&
      s.end === target.end &&
      s.secondsToWait === target.secondsToWait &&
      Array.isArray(s.weekdays) &&
      [...s.weekdays].sort().join(",") === targetWeekdays
    ) {
      return s._id;
    }
  }
  return null;
}
