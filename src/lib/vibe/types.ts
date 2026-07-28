// Types for the Vibe/Explorium REST API — post-round-3 (all shapes verified
// with real 200 responses; see scripts/probe-vibe-*.mjs for the history).

export type VibeResponseContext = {
  correlation_id: string;
  request_status: string;
  time_took_in_seconds: number;
};

// ===== stats =====

export type VibeStatsRequest = {
  filters: {
    country_code: { values: string[] };
    job_level?: { values: string[] };
    company_size?: { values: string[] };
    linkedin_category?: { values: string[] };
  };
};

export type VibeStatsResponse = {
  response_context: VibeResponseContext;
  total_results: number;
  stats?: {
    total_per_location?: Record<string, number>;
  };
};

// ===== fetch =====
//
// Shape verified in round 1. The prospect object carries the fields we
// pipe into LeadDraft (job_title, company_name, company_website, city,
// country_name, linkedin, linkedin_url_array, job_level_main). The email
// field lives in the enrich response, not here.

export type VibeFetchRequest = {
  mode: "full";
  filters: {
    country_code: { values: string[] };
    job_level?: { values: string[] };
    company_size?: { values: string[] };
    linkedin_category?: { values: string[] };
  };
  page: number;
  page_size: number;
};

export type VibeProspect = {
  prospect_id: string;
  first_name?: string | null;
  last_name?: string | null;
  full_name?: string | null;
  job_title?: string | null;
  job_level_main?: string | null;
  company_name?: string | null;
  company_website?: string | null;
  linkedin?: string | null;
  linkedin_url_array?: string[] | null;
  country_name?: string | null;
  country_code?: string | null;
  city?: string | null;
  linkedin_category?: string | null;
  [key: string]: unknown;
};

export type VibeFetchResponse = {
  response_context?: VibeResponseContext;
  data?: VibeProspect[];
  total_results?: number;
};

// ===== bulk_enrich =====
//
// Shape verified in probe-vibe-enrich-first (200 in 941ms, 2 credits).
// The response is an array; each item echoes the prospect_id and nests
// the contact info under `data`.

export type VibeBulkEnrichRequest = {
  prospect_ids: string[];
};

export type VibeEnrichedEmail = {
  address: string;
  type?: string | null;
};

export type VibeEnrichedContact = {
  emails?: VibeEnrichedEmail[] | null;
  professions_email?: string | null;
  professional_email_status?: string | null;
  phone_numbers?: string[] | null;
  mobile_phone?: string | null;
  [key: string]: unknown;
};

export type VibeBulkEnrichItem = {
  prospect_id: string;
  data?: VibeEnrichedContact | null;
};

export type VibeBulkEnrichResponse = {
  response_context?: VibeResponseContext;
  data?: VibeBulkEnrichItem[];
  total_results?: number;
  entity_id?: string | null;
};

// ===== UI-level filters (form) =====

export type VibeUiFilters = {
  countries: string[];
  sectors: string[];
  seniority: string;
  limit: number;
};
