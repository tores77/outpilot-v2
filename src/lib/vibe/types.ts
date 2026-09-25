// Types for the Vibe/Explorium REST API — post-round-3 (all shapes verified
// with real 200 responses; see scripts/probe-vibe-*.mjs for the history).

export type VibeResponseContext = {
  correlation_id: string;
  request_status: string;
  time_took_in_seconds: number;
};

// ===== filter shape (T024 · verified against real API 422s) =====
//
// La API cruda de Explorium (/prospects/stats, /prospects) acepta
// company_country_code para país de la empresa. NO expone
// prospect_country_code — ese nombre es del conector MCP y devuelve
// 422 "extra fields not permitted" en la API directa (verificado
// 2026-09-25). Si en el futuro queremos filtrar por país del contacto,
// probar country_code con un probe gratis a /prospects/stats antes de
// añadirlo al tipo (BACKLOG).
//
// has_contact_details ({ value: "email" }) fuerza que el fetch solo
// devuelva prospects con email disponible (evita gastar créditos en
// filas hasheadas).
//
// linkedin_category es la taxonomía LinkedIn en cadenas literales
// (verificadas por autocomplete); NO se "arreglan" ni se normalizan.
export type VibeApiFilters = {
  company_country_code?: { values: string[] };
  linkedin_category?: { values: string[] };
  company_size?: { values: string[] };
  job_level?: { values: string[] };
  has_contact_details?: { value: string };
};

// ===== stats =====

export type VibeStatsRequest = {
  filters: VibeApiFilters;
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
  filters: VibeApiFilters;
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

// ===== credits =====
//
// GET /credits (gratis, sin body). Descubierto en probe 2026-09-25
// tras el hallazgo de que la key del app pertenece a una cuenta
// distinta que la del panel de Pere: la fuente de verdad para el
// saldo es la propia API, no el dashboard web.

export type VibeCreditsResponse = {
  response_context?: VibeResponseContext;
  allocated_credits: number;
  remaining_credits: number;
  account_type?: string;
};

// ===== UI-level filters (form) =====
//
// T024: la UI se reduce a elegir un ICP (que trae los filtros duros
// de linkedin_category, company_size, job_level, has_contact_details)
// + países (editables) + límite. El resto del filtro se resuelve del
// bloque vibeFilters del ICP en resolveVibeApiFilters.

export type VibeUiFilters = {
  icpSlug: string;
  countries: string[];
  limit: number;
};
