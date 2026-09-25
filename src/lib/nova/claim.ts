// OUTPILOT v2 — Nova scoring claim helpers (T024 harness)
// -----------------------------------------------------------------------------
// Reserva atómica de leads antes de llamar a Haiku. Mismo patrón que
// Lex T022 (src/lib/lex/claim.ts) pero sobre la tabla leads
// directamente porque el scoring vive ahí.
//
// Fan-out observado en producción (2026-09-25):
//   6 clicks al botón "Puntuar N pendientes" → 4 runs solapados. Sin
//   concurrency + sin claim, cada run leyó los mismos leads sin score
//   y habría llamado a Haiku sobre la misma batch.
//
// Modelo (columna 005_leads_scoring_claim):
//   icp_score IS NULL, scoring_claimed_at IS NULL      → pendiente
//   icp_score IS NULL, scoring_claimed_at = <ts>       → reclamado
//   icp_score IS NOT NULL, scoring_claimed_at IS NULL  → puntuado
//
// El finalize del job pone icp_score + resto de campos Y limpia
// scoring_claimed_at en la misma UPDATE (con guard atómico sobre el
// claim_started_at que tenía este run).
//
// NOTA: cast temporal a `unknown` sobre supabase-js hasta que Pere
// aplique 005 y regenere database.types.ts. El cliente-JS acepta la
// columna a runtime (Postgres la tiene tras la migración); solo el
// tipo generado no la conoce todavía. Se elimina en el commit
// posterior al regen de tipos.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

type LeadRow = Database["public"]["Tables"]["leads"]["Row"];
type LeadUpdate = Database["public"]["Tables"]["leads"]["Update"];

// Row shape con la columna nueva (hasta regen).
type LeadWithClaim = LeadRow & { scoring_claimed_at: string | null };

// Fuerza al cliente supabase a aceptar la columna nueva y los chains
// laxos que Postgrest permite. Todos los helpers de este módulo van
// contra `leads` así que centralizamos el cast aquí.
function asUntyped(supabase: SupabaseClient<Database>): {
  from: (table: string) => Record<string, (...args: unknown[]) => unknown>;
} {
  return supabase as unknown as {
    from: (table: string) => Record<string, (...args: unknown[]) => unknown>;
  };
}

export type ClaimedLead = {
  lead: LeadWithClaim;
  claim_started_at: string;
};

/**
 * Resetea a NULL cualquier scoring_claimed_at más antiguo que
 * now - staleMs (leads que un run muerto dejó reclamados). Sin cron
 * dedicado: corre al inicio de cada trigger.
 */
export async function sweepStaleScoringClaims(
  supabase: SupabaseClient<Database>,
  args: { tenantId: string; staleMs: number },
): Promise<number> {
  const { tenantId, staleMs } = args;
  const staleThreshold = new Date(Date.now() - staleMs).toISOString();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const q: any = asUntyped(supabase).from("leads");
  const { data, error } = await q
    .update({ scoring_claimed_at: null })
    .eq("tenant_id", tenantId)
    .not("scoring_claimed_at", "is", null)
    .lt("scoring_claimed_at", staleThreshold)
    .select("id");
  if (error) throw new Error(`sweep-stale failed: ${error.message}`);
  return (data ?? []).length;
}

/**
 * Reserva atómica: intenta reclamar hasta `limit` leads con icp_score
 * IS NULL AND scoring_claimed_at IS NULL, escribiendo el timestamp
 * actual. Devuelve solo los leads efectivamente reclamados. La
 * carrera es benigna: dos runs concurrentes pueden intentar reclamar
 * los mismos IDs pero la UPDATE con guard .is(scoring_claimed_at, null)
 * solo deja pasar al primero.
 */
export async function claimPendingScoring(
  supabase: SupabaseClient<Database>,
  args: { tenantId: string; limit: number },
): Promise<ClaimedLead[]> {
  const { tenantId, limit } = args;

  // Fase 1: candidatos ordenados por created_at ASC (los más antiguos
  // primero, misma política que el fetch original de nova-score).
  // Excluye scoring_error != NULL — batches fallidos NO se re-reclaman.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const q1: any = asUntyped(supabase).from("leads");
  const { data: candidates, error: selErr } = await q1
    .select("id")
    .eq("tenant_id", tenantId)
    .is("icp_score", null)
    .is("scoring_claimed_at", null)
    .is("scoring_error", null)
    .order("created_at", { ascending: true })
    .limit(limit);
  if (selErr) throw new Error(`claim select failed: ${selErr.message}`);
  if (!candidates || candidates.length === 0) return [];

  const ids: string[] = candidates.map((c: { id: string }) => c.id);
  const startedAt = new Date().toISOString();

  // Fase 2: UPDATE con race guard (misma exclusión de scoring_error).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const q2: any = asUntyped(supabase).from("leads");
  const { data: claimed, error: upErr } = await q2
    .update({ scoring_claimed_at: startedAt })
    .eq("tenant_id", tenantId)
    .in("id", ids)
    .is("icp_score", null)
    .is("scoring_claimed_at", null)
    .is("scoring_error", null)
    .select("*");
  if (upErr) throw new Error(`claim update failed: ${upErr.message}`);
  if (!claimed) return [];

  return (claimed as LeadWithClaim[]).map((lead) => ({
    lead,
    claim_started_at: startedAt,
  }));
}

/**
 * Marca un batch fallido con scoring_error (payload JSONB) y libera
 * el scoring_claimed_at en la misma UPDATE. Guard atómico: solo
 * escribe si el claim sigue siendo el nuestro. Los leads marcados
 * quedan excluidos del claim en runs posteriores hasta que un humano
 * limpie el error manualmente.
 *
 * Uso: parse_error (respuesta rota persistente). Para errores
 * transitorios (5xx Anthropic, timeout), usa releaseScoringClaims que
 * NO marca (los leads quedan disponibles inmediatamente).
 */
export async function markScoringError(
  supabase: SupabaseClient<Database>,
  args: {
    tenantId: string;
    leadIds: string[];
    claimStartedAt: string;
    errorPayload: Record<string, unknown>;
  },
): Promise<number> {
  const { tenantId, leadIds, claimStartedAt, errorPayload } = args;
  if (leadIds.length === 0) return 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const q: any = asUntyped(supabase).from("leads");
  const { data, error } = await q
    .update({
      scoring_claimed_at: null,
      scoring_error: errorPayload,
    })
    .eq("tenant_id", tenantId)
    .in("id", leadIds)
    .eq("scoring_claimed_at", claimStartedAt)
    .select("id");
  if (error) throw new Error(`mark-error failed: ${error.message}`);
  return (data ?? []).length;
}

/**
 * Libera un batch de claims (los devuelve a NULL) sin escribir score.
 * Se usa cuando el parseo de la respuesta de Haiku falla y queremos
 * que el próximo click pueda reintentar ese batch sin esperar al TTL.
 * Guard sobre el claim_started_at: solo libera si el claim sigue
 * siendo el nuestro (evita pisar un run posterior que ya reclamó).
 */
export async function releaseScoringClaims(
  supabase: SupabaseClient<Database>,
  args: {
    tenantId: string;
    leadIds: string[];
    claimStartedAt: string;
  },
): Promise<number> {
  const { tenantId, leadIds, claimStartedAt } = args;
  if (leadIds.length === 0) return 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const q: any = asUntyped(supabase).from("leads");
  const { data, error } = await q
    .update({ scoring_claimed_at: null })
    .eq("tenant_id", tenantId)
    .in("id", leadIds)
    .eq("scoring_claimed_at", claimStartedAt)
    .select("id");
  if (error) throw new Error(`release failed: ${error.message}`);
  return (data ?? []).length;
}

/**
 * Escribe el resultado del scoring sobre un lead reclamado. Guard
 * atómico: solo escribe si scoring_claimed_at coincide con nuestro
 * claim (fail-safe si sweep-stale lo reseteó entre medias). Limpia
 * scoring_claimed_at a NULL en la misma update. Devuelve true si
 * escribió, false si perdió la carrera.
 */
export async function finalizeScore(
  supabase: SupabaseClient<Database>,
  args: {
    tenantId: string;
    leadId: string;
    claimStartedAt: string;
    update: LeadUpdate;
  },
): Promise<boolean> {
  const { tenantId, leadId, claimStartedAt, update } = args;
  const merged = { ...update, scoring_claimed_at: null };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const q: any = asUntyped(supabase).from("leads");
  const { data, error } = await q
    .update(merged)
    .eq("tenant_id", tenantId)
    .eq("id", leadId)
    .eq("scoring_claimed_at", claimStartedAt)
    .select("id");
  if (error) throw new Error(`finalize failed: ${error.message}`);
  return (data ?? []).length > 0;
}

/**
 * Cuenta pendientes vs procesando para la UI del botón:
 *   - activePending: icp_score NULL y (scoring_claimed_at NULL O stale)
 *   - activeProcessing: icp_score NULL y scoring_claimed_at fresco
 *
 * "Fresco" = dentro de staleMs. El sweep del próximo trigger devolverá
 * los stale a NULL. Desde el punto de vista del usuario los stale son
 * "pendientes" (los va a poder reclamar); los frescos son "procesando"
 * y el botón se muestra deshabilitado.
 */
export async function countScoringPending(
  supabase: SupabaseClient<Database>,
  args: { tenantId: string; staleMs: number },
): Promise<{
  activePending: number;
  activeProcessing: number;
  errored: number;
}> {
  const { tenantId, staleMs } = args;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const q: any = asUntyped(supabase).from("leads");
  const { data, error } = await q
    .select("scoring_claimed_at, scoring_error")
    .eq("tenant_id", tenantId)
    .is("icp_score", null);
  if (error) throw new Error(`count-pending failed: ${error.message}`);

  const staleBefore = Date.now() - staleMs;
  let nullCount = 0;
  let processingActive = 0;
  let processingStale = 0;
  let errored = 0;
  for (const row of (data ?? []) as Array<{
    scoring_claimed_at: string | null;
    scoring_error: unknown;
  }>) {
    // Leads con error previo NO cuentan como pendientes ni procesando.
    // Bloqueados hasta que un humano limpie scoring_error.
    if (row.scoring_error !== null) {
      errored += 1;
      continue;
    }
    if (row.scoring_claimed_at === null) {
      nullCount += 1;
      continue;
    }
    const ts = Date.parse(row.scoring_claimed_at);
    if (Number.isFinite(ts) && ts < staleBefore) {
      processingStale += 1;
    } else {
      processingActive += 1;
    }
  }
  return {
    activePending: nullCount + processingStale,
    activeProcessing: processingActive,
    errored,
  };
}
