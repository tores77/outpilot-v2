// Vibe Prospecting / Explorium — defaults, caps, endpoints and mappings.
// Fase 1 · T014 (rewritten after 3 rounds of contract probing).
//
// Cost model (calibrated after the first full end-to-end run):
//   fetch (POST /prospects, mode:"full"):  billed 2 credits / lead
//   enrich (POST /prospects/contacts_information/bulk_enrich):
//                                          billed 4 credits / prospect_id
//   -> total per contactable lead: ~6 credits (fetch + enrich)
//
// Isolated probes reported 1 + 2 = 3, but the first real fetch+enrich
// cycle deducted 6 credits from the account. We bias the UI estimate
// toward the observed billing (2x the isolated probes) so the ConfirmView
// never under-promises. `credits_estimated` is written into the run
// output on every fetch so BACKLOG > "calibrar heurística Vibe" can
// keep tightening the ratio with real data.
//
// Server-side filters (all validated via probe:vibe-round2 + round3):
//   country_code       — ISO alpha-2, e.g. ["ES"]
//   job_level          — enum: owner, c-suite, vice president, director,
//                        senior non-managerial, manager, partner
//   company_size       — enum: 1-10 | 11-50 | 51-200 | 201-500 |
//                        501-1000 | 1001-5000 | 5001-10000 | 10001+
//   linkedin_category  — LinkedIn's industry taxonomy strings
//
// Budget lock (double, unchanged intent):
//   VIBE_MAX_LEADS_PER_FETCH caps the requested count (250 in v2.1).
//   VIBE_MAX_CREDITS_PER_FETCH caps the ESTIMATED total (fetch + enrich).
//   Above the credit cap the UI requires a separate acknowledgement.
//   With the 3-credits-per-lead heuristic and the 500 cap, the checkbox
//   triggers when limit > ~166.

export const VIBE_BASE_URL = "https://api.explorium.ai/v1";
export const VIBE_STATS_ENDPOINT = "/prospects/stats";
export const VIBE_FETCH_ENDPOINT = "/prospects";
export const VIBE_BULK_ENRICH_ENDPOINT =
  "/prospects/contacts_information/bulk_enrich";
// POST business_id → firmographics (sector, descripción, tamaño,
// revenue). 1 crédito por lookup. Descubierto 2026-09-25.
export const VIBE_BUSINESS_ENRICH_ENDPOINT =
  "/businesses/firmographics/enrich";
export const VIBE_CREDITS_PER_BUSINESS_ENRICH = 1;
// GET (gratis). Descubierto en probe 2026-09-25. Devuelve
// { allocated_credits, remaining_credits, account_type }.
export const VIBE_CREDITS_ENDPOINT = "/credits";

// POST /prospects always requires mode:"full" (round 1: 422 without it).
export const VIBE_FETCH_MODE = "full";

export const VIBE_PAGE_SIZE = 100;
export const VIBE_ENRICH_BATCH_SIZE = 50;
export const VIBE_MAX_LEADS_PER_FETCH = 250;
export const VIBE_DEFAULT_LIMIT = 100;

// Per-lead credit cost, calibrated with a 2x margin over the isolated
// probes (1+2=3) to match the observed billing of the first real run
// (6 credits per lead). Recalibrate with 3-5 real fetches (BACKLOG).
export const VIBE_CREDITS_PER_LEAD_FETCH = 2;
export const VIBE_CREDITS_PER_LEAD_ENRICH = 4;
export const VIBE_MAX_CREDITS_PER_FETCH = 500;

// Paginable results cap reported by /prospects: total_results is 60_000
// regardless of the stats total (which for ES alone is ~16M). Not an issue
// in v2.1 (limit 250 << 60k) but keep it visible so nobody assumes stats
// numbers scale linearly to fetch.
export const VIBE_PAGINATION_CAP = 60_000;

export const VIBE_TIMEOUT_MS = 30_000;
export const VIBE_MAX_RETRIES = 3;
export const VIBE_INTER_PAGE_DELAY_MS = 500;

export const VIBE_ESTIMATE_TOKEN_TTL_MS = 5 * 60 * 1000;

// Países que Pere puede seleccionar como override en /radar/vibe. El
// ICP declara sus defaults en vibeFilters.company_country_code /
// prospect_country_code; la UI permite cambiarlos aquí.
export const VIBE_AVAILABLE_COUNTRIES = [
  { code: "ES", label: "España" },
  { code: "PT", label: "Portugal" },
  { code: "MX", label: "México" },
  { code: "AR", label: "Argentina" },
  { code: "CO", label: "Colombia" },
  { code: "CL", label: "Chile" },
  { code: "PE", label: "Perú" },
  { code: "UY", label: "Uruguay" },
] as const;

// Belt-and-braces post-fetch: cualquier fila cuyo titleRank supere
// este umbral cae, aunque Vibe la haya devuelto tras filtrar por
// job_level. Alineado con la política actual (director-and-above).
// Si un ICP futuro necesita subir el listón (p.ej. c-suite only),
// se promueve a campo del bloque vibeFilters.
export const VIBE_SMOKE_MAX_TITLE_RANK = 4;

export function estimateCredits(limit: number): {
  fetch: number;
  enrich: number;
  total: number;
} {
  const fetch = limit * VIBE_CREDITS_PER_LEAD_FETCH;
  const enrich = limit * VIBE_CREDITS_PER_LEAD_ENRICH;
  return { fetch, enrich, total: fetch + enrich };
}
