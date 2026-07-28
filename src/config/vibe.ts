// Vibe Prospecting / Explorium — defaults, caps, endpoints and mappings.
// Fase 1 · T014 (rewritten after 3 rounds of contract probing).
//
// Cost model (verified with 2 real paid probes):
//   fetch (POST /prospects, mode:"full"):  1 credit / lead delivered
//   enrich (POST /prospects/contacts_information/bulk_enrich):
//                                          2 credits / prospect_id
//   -> total per contactable lead: ~3 credits (fetch + enrich)
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

// POST /prospects always requires mode:"full" (round 1: 422 without it).
export const VIBE_FETCH_MODE = "full";

export const VIBE_PAGE_SIZE = 100;
export const VIBE_ENRICH_BATCH_SIZE = 50;
export const VIBE_MAX_LEADS_PER_FETCH = 250;
export const VIBE_DEFAULT_LIMIT = 100;

// Verified per-lead credit cost (real, not heuristic).
export const VIBE_CREDITS_PER_LEAD_FETCH = 1;
export const VIBE_CREDITS_PER_LEAD_ENRICH = 2;
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

// UI sector -> LinkedIn category values pushed to the API. Mapping
// approved after round 3A discovery on ES.
export const VIBE_SECTOR_TO_LINKEDIN_CATEGORIES: Record<string, string[]> = {
  SaaS: [
    "it services and it consulting",
    "software development",
    "technology, information and internet",
  ],
  "Digital Agency": [
    "marketing services",
    "advertising services",
    "public relations and communications services",
  ],
  "E-commerce": ["retail", "consumer goods"],
  "Producción audiovisual": [
    "media production",
    "movies, videos, and sound",
    "entertainment providers",
  ],
};

// Seniority option -> job_level values pushed to the API + max titleRank
// kept post-fetch (belt-and-braces if the API returns edge cases).
export const VIBE_SENIORITY_OPTIONS = [
  {
    value: "director",
    label: "Director+ (default)",
    maxRank: 4,
    jobLevels: ["owner", "c-suite", "vice president", "director", "partner"],
  },
  {
    value: "vp",
    label: "VP+",
    maxRank: 3,
    jobLevels: ["owner", "c-suite", "vice president", "partner"],
  },
  {
    value: "csuite",
    label: "C-suite+",
    maxRank: 2,
    jobLevels: ["owner", "c-suite", "partner"],
  },
] as const;

export type VibeSeniority = (typeof VIBE_SENIORITY_OPTIONS)[number]["value"];
export const VIBE_DEFAULT_SENIORITY: VibeSeniority = "director";

// Company size is hardcoded to the mid-market range in v2.1. When
// Nova needs finer control, promote to a UI selector.
export const VIBE_COMPANY_SIZE_VALUES: readonly string[] = [
  "11-50",
  "51-200",
  "201-500",
];

export function maxRankFor(seniority: string): number {
  return (
    VIBE_SENIORITY_OPTIONS.find((o) => o.value === seniority)?.maxRank ?? 4
  );
}

export function jobLevelsFor(seniority: string): string[] {
  return (
    VIBE_SENIORITY_OPTIONS.find((o) => o.value === seniority)?.jobLevels?.slice() ??
    ["owner", "c-suite", "vice president", "director", "partner"]
  );
}

export function linkedinCategoriesFor(sectors: string[]): string[] {
  const set = new Set<string>();
  for (const s of sectors) {
    const mapped = VIBE_SECTOR_TO_LINKEDIN_CATEGORIES[s];
    if (mapped) for (const c of mapped) set.add(c);
  }
  return [...set];
}

export function estimateCredits(limit: number): {
  fetch: number;
  enrich: number;
  total: number;
} {
  const fetch = limit * VIBE_CREDITS_PER_LEAD_FETCH;
  const enrich = limit * VIBE_CREDITS_PER_LEAD_ENRICH;
  return { fetch, enrich, total: fetch + enrich };
}
