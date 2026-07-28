// Vibe Prospecting / Explorium — defaults, caps and endpoints.
// Fase 1 · T014.
//
// Stats is free per the T014 gate; only /v1/prospects (fetch) consumes
// credits. Double budget lock enforced client-side:
//   - VIBE_MAX_LEADS_PER_FETCH caps the requested count (250 in v2.1)
//   - VIBE_MAX_CREDITS_PER_FETCH caps the estimated cost; above it the UI
//     requires a separate, explicit confirmation checkbox.
//
// Sectors + seniority + company_size are applied POST-FETCH via
// cleanupLeadBatch / titleRank because the Explorium filter taxonomy for
// those has not been validated yet (only country_code was probed). A future
// probe can push these server-side.

export const VIBE_BASE_URL = "https://api.explorium.ai/v1";
export const VIBE_STATS_ENDPOINT = "/prospects/stats";
export const VIBE_FETCH_ENDPOINT = "/prospects";

export const VIBE_PAGE_SIZE = 100;
export const VIBE_MAX_LEADS_PER_FETCH = 250;
export const VIBE_DEFAULT_LIMIT = 100;

// Heuristic: 1 credit per lead requested. Real cost is deducted by Vibe;
// api_costs.cost_usd stores this estimate and events.payload records
// cost_source: 'estimated'.
export const VIBE_CREDITS_PER_LEAD_ESTIMATE = 1;
export const VIBE_MAX_CREDITS_PER_FETCH = 500;

export const VIBE_TIMEOUT_MS = 30_000;
export const VIBE_MAX_RETRIES = 3;
export const VIBE_INTER_PAGE_DELAY_MS = 500;

export const VIBE_ESTIMATE_TOKEN_TTL_MS = 5 * 60 * 1000;

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

export const VIBE_DEFAULT_COUNTRIES: readonly string[] = ["ES"];

export const VIBE_AVAILABLE_SECTORS = [
  "SaaS",
  "Digital Agency",
  "E-commerce",
  "Producción audiovisual",
] as const;

export const VIBE_DEFAULT_SECTORS: readonly string[] = [
  "SaaS",
  "Digital Agency",
  "E-commerce",
];

// Seniority option -> max titleRank kept (lower = more senior).
export const VIBE_SENIORITY_OPTIONS = [
  { value: "director", label: "Director+ (default)", maxRank: 4 },
  { value: "vp", label: "VP+", maxRank: 3 },
  { value: "csuite", label: "C-suite+", maxRank: 2 },
] as const;

export type VibeSeniority = (typeof VIBE_SENIORITY_OPTIONS)[number]["value"];
export const VIBE_DEFAULT_SENIORITY: VibeSeniority = "director";

export function maxRankFor(seniority: string): number {
  return (
    VIBE_SENIORITY_OPTIONS.find((o) => o.value === seniority)?.maxRank ?? 4
  );
}
