// OUTPILOT v2 — Volt smoke candidate selector (T024)
// -----------------------------------------------------------------------------
// Selecciona hasta N leads para un smoke, aplicando estos filtros:
//
//   Base (leads):
//     - tenant_id = X
//     - estado = 'EN_RADAR'
//     - icp_score >= minScore (default 70, alineado con Nova threshold)
//     - needs_review = false
//     - company IS NOT NULL AND trim(company) != ''
//     - email IS NOT NULL AND matches email regex básico
//
//   Exclusiones:
//     - NO en campaign_leads activo (removed_at IS NULL) — evita
//       doble-contacto entre campañas OUTPILOT.
//     - NO en outreach_exclusions (Lemlist histórico + unsubscribes,
//       importados aparte). Comparación case-insensitive.
//
//   Cap por empresa (evidencia Belkins: 1-2/cuenta 7.8% reply vs 10+
//   3.8%): máximo `maxPerCompany` contactos por empresa. Priorización:
//   mayor icp_score DESC, luego más antiguo (created_at ASC).
//
// La query se hace en 3 fetches + merge cliente-side porque
// supabase-js no soporta window functions (ROW_NUMBER OVER) sin
// RPC. Volumen esperado bajo (~cientos de leads); si crece, mover a
// función Postgres.
//
// Función pura (recibe supabase client como parámetro) → testeable
// con mocks.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

export type SmokeCandidate = {
  id: string;
  email: string;
  company: string; // guaranteed non-empty tras filter
  icp_score: number;
  created_at: string;
};

export type SmokeSelectionCounts = {
  pool_after_base_filters: number;
  excluded_by_active_campaign: number;
  excluded_by_outreach_exclusions: number;
  excluded_by_company_cap: number;
  selected: number;
};

export type SmokeSelectionResult = {
  candidates: SmokeCandidate[];
  counts: SmokeSelectionCounts;
};

export type SmokeSelectionArgs = {
  tenantId: string;
  minScore: number;
  limit: number;
  maxPerCompany: number;
  // Máximo de filas a leer de leads en la primera pasada. Con 1 tenant
  // pequeño (miles de leads como máximo) sobra. Si el tenant crece,
  // convertir a RPC con window function server-side.
  candidatePoolSize?: number;
};

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * Selecciona candidatos para el smoke. NO escribe nada — solo lee.
 * El caller (volt-smoke-prepare) usa el resultado para hacer INSERTs
 * en campaign_leads.
 */
export async function selectSmokeCandidates(
  supabase: SupabaseClient<Database>,
  args: SmokeSelectionArgs,
): Promise<SmokeSelectionResult> {
  const { tenantId, minScore, limit, maxPerCompany } = args;
  const poolSize = args.candidatePoolSize ?? 500;

  // 1. Fetch pool base (filtros indexables server-side).
  const { data: rawLeads, error: leadsErr } = await supabase
    .from("leads")
    .select("id, email, company, icp_score, created_at")
    .eq("tenant_id", tenantId)
    .eq("estado", "EN_RADAR")
    .gte("icp_score", minScore)
    .eq("needs_review", false)
    .not("company", "is", null)
    .not("email", "is", null)
    .order("icp_score", { ascending: false })
    .order("created_at", { ascending: true })
    .limit(poolSize);
  if (leadsErr) throw new Error(`selectSmokeCandidates leads: ${leadsErr.message}`);

  // Filtros que no puede hacer supabase-js limpiamente (trim,
  // regex email) → client-side.
  const baseFiltered: SmokeCandidate[] = [];
  for (const l of rawLeads ?? []) {
    if (!l.company || l.company.trim() === "") continue;
    if (!l.email || !EMAIL_RE.test(l.email)) continue;
    if (typeof l.icp_score !== "number") continue;
    baseFiltered.push({
      id: l.id,
      email: l.email,
      company: l.company,
      icp_score: l.icp_score,
      created_at: l.created_at,
    });
  }

  // 2. Fetch lead_ids en campaign_leads activo para exclusión.
  const { data: activeCLs, error: clErr } = await supabase
    .from("campaign_leads")
    .select("lead_id")
    .eq("tenant_id", tenantId)
    .is("removed_at", null);
  if (clErr) throw new Error(`selectSmokeCandidates campaign_leads: ${clErr.message}`);
  const activeLeadIds = new Set(
    (activeCLs ?? []).map((row) => row.lead_id),
  );

  // 3. Fetch emails en outreach_exclusions (lowercase).
  //
  // NOTA: cast temporal hasta que Pere aplique 004c y regenere
  // database.types.ts. La forma del row (`{ email: string }`) coincide
  // con el schema de la migración (tenant_id + lower(email) PK).
  type ExclusionRow = { email: string };
  const supabaseUntyped = supabase as unknown as {
    from: (table: string) => {
      select: (cols: string) => {
        eq: (
          col: string,
          val: string,
        ) => Promise<{
          data: ExclusionRow[] | null;
          error: { message: string } | null;
        }>;
      };
    };
  };
  const { data: exclusions, error: exclErr } = await supabaseUntyped
    .from("outreach_exclusions")
    .select("email")
    .eq("tenant_id", tenantId);
  if (exclErr) {
    // Si la tabla no existe todavía (pre-004c) o el tenant no ha
    // cargado exclusions, seguimos sin ellas. NO silenciamos errores
    // de otro tipo.
    if (!/relation.*outreach_exclusions.*does not exist/i.test(exclErr.message)) {
      throw new Error(`selectSmokeCandidates exclusions: ${exclErr.message}`);
    }
  }
  const excludedEmails = new Set(
    (exclusions ?? []).map((row) => row.email.toLowerCase()),
  );

  // 4. Aplicar exclusiones.
  let excludedByActive = 0;
  let excludedByExclusions = 0;
  const afterExclusions: SmokeCandidate[] = [];
  for (const c of baseFiltered) {
    if (activeLeadIds.has(c.id)) {
      excludedByActive += 1;
      continue;
    }
    if (excludedEmails.has(c.email.toLowerCase())) {
      excludedByExclusions += 1;
      continue;
    }
    afterExclusions.push(c);
  }

  // 5. Cap por empresa. Los candidatos vienen ordenados por
  //    icp_score DESC, created_at ASC (query), así que al agrupar y
  //    tomar los primeros N por empresa, tenemos los de mejor score
  //    ganando el tiebreak.
  const byCompany = new Map<string, SmokeCandidate[]>();
  let excludedByCompanyCap = 0;
  for (const c of afterExclusions) {
    const key = c.company.trim().toLowerCase();
    const arr = byCompany.get(key) ?? [];
    if (arr.length >= maxPerCompany) {
      excludedByCompanyCap += 1;
      continue;
    }
    arr.push(c);
    byCompany.set(key, arr);
  }
  const capped = [...byCompany.values()].flat();

  // 6. Re-ordenar globalmente por score y aplicar limit final.
  capped.sort((a, b) => {
    if (b.icp_score !== a.icp_score) return b.icp_score - a.icp_score;
    return a.created_at.localeCompare(b.created_at);
  });
  const selected = capped.slice(0, limit);

  return {
    candidates: selected,
    counts: {
      pool_after_base_filters: baseFiltered.length,
      excluded_by_active_campaign: excludedByActive,
      excluded_by_outreach_exclusions: excludedByExclusions,
      excluded_by_company_cap: excludedByCompanyCap,
      selected: selected.length,
    },
  };
}
