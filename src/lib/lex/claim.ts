// OUTPILOT v2 — Lex claim helpers (T022 fix)
// -----------------------------------------------------------------------------
// Reserva atómica de campaign_leads antes de llamar a Haiku. Evita el
// fan-out visto en producción (9 clicks → 9 events → 9 runs → cada run
// lee los mismos 2 leads NULL → 3 llamadas a Haiku para 2 leads).
//
// Modelo:
//   - personalization = NULL          → pendiente
//   - {state:'processing', started_at:T}  → reclamado por un run
//   - {version:1, opener, personalization:'personalized'|'generic', ...}
//                                     → resultado final
//
// El claim escribe {state:'processing', started_at} con guard
// .is("personalization", null). Dos runs concurrentes solo pueden
// pisar el "personalization = NULL"; el segundo update falla el guard
// y devuelve 0 filas → 0 llamadas a Haiku extras.
//
// sweepStaleClaims: reset opportunistic al principio de cada trigger
// para claims cuyo started_at supera LEX_STALE_CLAIM_MS (10 min por
// defecto). Sin cron dedicado.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/supabase/database.types";

type LeadRow = Database["public"]["Tables"]["leads"]["Row"];

export type ClaimedRow = {
  campaign_lead_id: string;
  lead: LeadRow;
  claim_started_at: string;
};

export type ProcessingClaim = {
  state: "processing";
  started_at: string;
};

function isProcessingClaim(value: unknown): value is ProcessingClaim {
  return (
    !!value &&
    typeof value === "object" &&
    (value as { state?: unknown }).state === "processing"
  );
}

/**
 * Resetea a NULL cualquier fila cuyo personalization sea
 * {state:'processing'} con started_at más antiguo que now - staleMs.
 * Devuelve el count reseteado (para el events log).
 *
 * Sin filtro de estado en Supabase — hacemos el filtro cliente después
 * de una lectura acotada. Es simple y suficiente: la ventana de sweep
 * es pequeña (100s leads/tenant) y solo corre 1x por trigger.
 */
export async function sweepStaleClaims(
  supabase: SupabaseClient<Database>,
  args: { tenantId: string; campaignId: string; staleMs: number },
): Promise<number> {
  const { tenantId, campaignId, staleMs } = args;
  const staleBefore = Date.now() - staleMs;

  const { data: candidates, error: selErr } = await supabase
    .from("campaign_leads")
    .select("id, personalization")
    .eq("tenant_id", tenantId)
    .eq("campaign_id", campaignId)
    .is("removed_at", null);
  if (selErr) throw new Error(`sweep select failed: ${selErr.message}`);
  if (!candidates || candidates.length === 0) return 0;

  const staleIds: string[] = [];
  for (const row of candidates) {
    const p = row.personalization;
    if (!isProcessingClaim(p)) continue;
    const startedAtMs = Date.parse(p.started_at);
    if (!Number.isFinite(startedAtMs)) continue;
    if (startedAtMs < staleBefore) staleIds.push(row.id);
  }
  if (staleIds.length === 0) return 0;

  // Reset a NULL. Guardo el update contra el state='processing' de la
  // fila específica para no pisar un resultado final que llegara justo
  // ahora en otro run.
  const { data: reset, error: upErr } = await supabase
    .from("campaign_leads")
    .update({ personalization: null })
    .eq("tenant_id", tenantId)
    .in("id", staleIds)
    .eq("personalization->>state", "processing")
    .select("id");
  if (upErr) throw new Error(`sweep update failed: ${upErr.message}`);
  return (reset ?? []).length;
}

/**
 * Reserva atómica: intenta reclamar hasta `limit` filas con
 * personalization=NULL, escribiendo {state:'processing', started_at:now}.
 * Devuelve solo las filas efectivamente reclamadas (el `.is(null)`
 * guard filtra las que otro run haya pisado entre el SELECT y el
 * UPDATE).
 *
 * Two-phase: Postgres no permite UPDATE ORDER BY LIMIT nativo. Fase 1
 * escoge candidatos por added_at ASC; fase 2 los UPDATEa con guard.
 * La carrera es benigna: si otro run llega a la mitad, nuestra fase 2
 * devuelve un subconjunto (posiblemente vacío) y solo procesamos eso.
 */
export async function claimPendingLeads(
  supabase: SupabaseClient<Database>,
  args: { tenantId: string; campaignId: string; limit: number },
): Promise<ClaimedRow[]> {
  const { tenantId, campaignId, limit } = args;

  // Fase 1: candidatos ordenados.
  const { data: candidates, error: selErr } = await supabase
    .from("campaign_leads")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("campaign_id", campaignId)
    .is("personalization", null)
    .is("removed_at", null)
    .order("added_at", { ascending: true })
    .limit(limit);
  if (selErr) throw new Error(`claim select failed: ${selErr.message}`);
  if (!candidates || candidates.length === 0) return [];

  const ids = candidates.map((c) => c.id);
  const startedAt = new Date().toISOString();
  const claimPayload: ProcessingClaim = { state: "processing", started_at: startedAt };

  // Fase 2: UPDATE atómico con race guard .is(personalization, null).
  const { data: claimed, error: upErr } = await supabase
    .from("campaign_leads")
    .update({ personalization: claimPayload })
    .eq("tenant_id", tenantId)
    .in("id", ids)
    .is("personalization", null)
    .is("removed_at", null)
    .select("id, lead:leads!inner(*)");
  if (upErr) throw new Error(`claim update failed: ${upErr.message}`);
  if (!claimed) return [];

  return claimed.map((row) => ({
    campaign_lead_id: row.id,
    lead: row.lead as unknown as LeadRow,
    claim_started_at: startedAt,
  }));
}

/**
 * Escribe el resultado final de Lex sobre la fila reclamada, con guard
 * doble: state='processing' + started_at coincide con el de nuestro
 * claim. Si sweep-stale nos reseteó y otro run reclamó con nuevo
 * started_at, este UPDATE no toca la fila (fail-safe).
 * Devuelve true si escribió, false si perdió la carrera.
 */
export async function finalizePersonalization(
  supabase: SupabaseClient<Database>,
  args: {
    tenantId: string;
    campaignLeadId: string;
    claimStartedAt: string;
    payload: Record<string, unknown>;
  },
): Promise<boolean> {
  const { tenantId, campaignLeadId, claimStartedAt, payload } = args;
  const { data, error } = await supabase
    .from("campaign_leads")
    .update({ personalization: payload as Json })
    .eq("tenant_id", tenantId)
    .eq("id", campaignLeadId)
    .eq("personalization->>state", "processing")
    .eq("personalization->>started_at", claimStartedAt)
    .select("id");
  if (error) throw new Error(`finalize update failed: ${error.message}`);
  return (data ?? []).length > 0;
}

/**
 * Cuentas para la UI de /campaigns. Distingue tres cubos:
 *   - null: pendientes propiamente dichos
 *   - processingStale: reclamados hace más de staleMs (se van a sweep
 *     y luego a NULL en el próximo trigger; para el usuario son
 *     "pendientes" también)
 *   - processingActive: reclamados dentro del TTL (el usuario ve
 *     "Procesando N…" deshabilitado)
 *
 * `activePending = null + processingStale` — lo que verá el usuario
 * como "pendiente" en el botón. `activeProcessing = processingActive`
 * — lo que verá como "Procesando N…".
 */
export async function countPending(
  supabase: SupabaseClient<Database>,
  args: { tenantId: string; campaignId: string; staleMs: number },
): Promise<{ activePending: number; activeProcessing: number }> {
  const { tenantId, campaignId, staleMs } = args;

  const { data: rows, error } = await supabase
    .from("campaign_leads")
    .select("personalization")
    .eq("tenant_id", tenantId)
    .eq("campaign_id", campaignId)
    .is("removed_at", null);
  if (error) throw new Error(`count select failed: ${error.message}`);

  const staleBefore = Date.now() - staleMs;
  let nullCount = 0;
  let processingActive = 0;
  let processingStale = 0;

  for (const row of rows ?? []) {
    const p = row.personalization;
    if (p === null) {
      nullCount += 1;
      continue;
    }
    if (isProcessingClaim(p)) {
      const startedAtMs = Date.parse(p.started_at);
      if (Number.isFinite(startedAtMs) && startedAtMs < staleBefore) {
        processingStale += 1;
      } else {
        processingActive += 1;
      }
    }
    // Resultado final ({version:1, opener, ...}): no cuenta ni como
    // pendiente ni como procesando.
  }

  return {
    activePending: nullCount + processingStale,
    activeProcessing: processingActive,
  };
}
