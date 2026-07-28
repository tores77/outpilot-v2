// Types for the Vibe/Explorium REST API.
// Fase 1 · T014.
//
// Stats shape is validated via scripts/probe-vibe.mjs (returns 200 with
// { response_context, total_results, stats: { total_per_location } }).
//
// Fetch shape is ASSUMED — run `npm run probe:vibe-fetch` (costs ~1 credit)
// to validate before the first production execute. If the API returns a
// different shape, adjust src/lib/vibe/mapper.ts (single place).

export type VibeResponseContext = {
  correlation_id: string;
  request_status: string;
  time_took_in_seconds: number;
};

// ===== stats =====

export type VibeStatsRequest = {
  filters: {
    country_code: { values: string[] };
  };
};

export type VibeStatsResponse = {
  response_context: VibeResponseContext;
  total_results: number;
  stats: {
    total_per_location: Record<string, number>;
  };
};

// ===== fetch (assumed shape) =====

export type VibeFetchRequest = {
  filters: {
    country_code: { values: string[] };
  };
  page: number;
  page_size: number;
};

/**
 * Fields commonly returned by prospect-search REST APIs. The mapper tries
 * each of the expected keys in order and falls back to null.
 */
export type VibeProspect = {
  email?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  full_name?: string | null;
  job_title?: string | null;
  title?: string | null;
  company_name?: string | null;
  company?: string | null;
  linkedin_url?: string | null;
  linkedin?: string | null;
  phone?: string | null;
  phone_number?: string | null;
  country?: string | null;
  country_code?: string | null;
  city?: string | null;
  company_size?: string | null;
  company_industry?: string | null;
  industry?: string | null;
  company_website?: string | null;
  website?: string | null;
  [key: string]: unknown;
};

export type VibeFetchResponse = {
  response_context?: VibeResponseContext;
  data?: VibeProspect[];
  results?: VibeProspect[];
  prospects?: VibeProspect[];
  total_results?: number;
  pagination?: {
    page?: number;
    total_pages?: number;
    total?: number;
  };
};

// ===== UI-level filters (form) =====

export type VibeUiFilters = {
  countries: string[];
  sectors: string[];
  seniority: string;
  limit: number;
};
