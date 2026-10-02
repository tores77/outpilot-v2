// OUTPILOT v2 · Claim atómico de lemlist_events (T025 bloque B)
//
// Patrón idéntico a Nova (src/lib/nova/claim.ts). Dos fases:
//
//   Fase 1 — Select de candidatos: processed_at IS NULL AND
//     processing_error IS NULL AND claimed_at IS NULL AND
//     tenant_id = <this>. Ordenados por received_at ASC. Limit N.
//
//   Fase 2 — UPDATE con race guard: in(ids) + is(claimed_at, null) +
//     is(processed_at, null) + is(processing_error, null) +
//     eq(tenant_id, <this>). Devuelve solo los que efectivamente
//     reclamó este run.
//
// Sweep al inicio de cada run resetea claims muertos (más antiguos
// que staleMs) para que un worker colgado no bloquee las filas.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import type { LemlistEventRow } from "@/lib/channels/lemlist-event-process";

type EventRow = Database["public"]["Tables"]["lemlist_events"]["Row"];

/**
 * Resetea claimed_at=NULL para filas con claim más antiguo que
 * staleMs. Un run muerto deja filas con claimed_at != NULL que
 * nunca se procesan; este sweep las libera.
 */
export async function sweepStaleLemlistClaims(
  supabase: SupabaseClient<Database>,
  args: { tenantId: string; staleMs: number },
): Promise<number> {
  const threshold = new Date(Date.now() - args.staleMs).toISOString();
  const { data, error } = await supabase
    .from("lemlist_events")
    .update({ claimed_at: null })
    .eq("tenant_id", args.tenantId)
    .is("processed_at", null)
    .not("claimed_at", "is", null)
    .lt("claimed_at", threshold)
    .select("id");
  if (error) throw new Error(`sweep-stale-events failed: ${error.message}`);
  return (data ?? []).length;
}

function rowToEvent(row: EventRow): LemlistEventRow {
  return {
    id: row.id,
    tenant_id: row.tenant_id!, // claim filtra IS NOT NULL
    type: row.type,
    event_external_id: row.event_external_id ?? row.id, // defensa
    campaign_external_id: row.campaign_external_id,
    lead_external_id: row.lead_external_id,
    event_created_at: row.event_created_at,
    payload: row.payload,
  };
}

export async function claimPendingLemlistEvents(
  supabase: SupabaseClient<Database>,
  args: { tenantId: string; limit: number },
): Promise<LemlistEventRow[]> {
  const { tenantId, limit } = args;

  // Fase 1: candidatos.
  const { data: candidates, error: selErr } = await supabase
    .from("lemlist_events")
    .select("id")
    .eq("tenant_id", tenantId)
    .is("processed_at", null)
    .is("processing_error", null)
    .is("claimed_at", null)
    .order("received_at", { ascending: true })
    .limit(limit);
  if (selErr) throw new Error(`claim-events select failed: ${selErr.message}`);
  if (!candidates || candidates.length === 0) return [];

  const ids = candidates.map((c) => c.id);
  const claimedAt = new Date().toISOString();

  // Fase 2: UPDATE con race guard. Devuelve filas completas.
  const { data: claimed, error: upErr } = await supabase
    .from("lemlist_events")
    .update({ claimed_at: claimedAt })
    .eq("tenant_id", tenantId)
    .in("id", ids)
    .is("claimed_at", null)
    .is("processed_at", null)
    .is("processing_error", null)
    .select("*");
  if (upErr) throw new Error(`claim-events update failed: ${upErr.message}`);
  if (!claimed) return [];

  return claimed.map(rowToEvent);
}
