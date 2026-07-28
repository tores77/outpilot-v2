// Golden Vibe/Explorium fixtures based on the real probe outputs.

import type {
  VibeBulkEnrichItem,
  VibeBulkEnrichResponse,
  VibeFetchResponse,
  VibeProspect,
} from "@/lib/vibe/types";

// A minimal but realistic prospect matching the shape returned by the
// round-1 fetch probe (mode:"full").
export const PROSPECT_FEDERICO: VibeProspect = {
  prospect_id: "8c2455c2bcea6407caf430a34160e45641933896",
  first_name: "Federico",
  last_name: "Linares García de Cosío",
  job_title: "Consultor",
  job_level_main: "director",
  company_name: "EY",
  company_website: "https://www.ey.com",
  linkedin: "https://www.linkedin.com/in/federico-example",
  linkedin_url_array: ["https://www.linkedin.com/in/federico-example"],
  country_name: "Spain",
  country_code: "ES",
  city: "Madrid",
  linkedin_category: "professional services",
};

export const FETCH_RESPONSE_ONE: VibeFetchResponse = {
  response_context: {
    correlation_id: "test",
    request_status: "success",
    time_took_in_seconds: 0.3,
  },
  data: [PROSPECT_FEDERICO],
  total_results: 60000,
};

// From the enrich-first probe: professions_email shortcut + status "valid".
export const ENRICH_ITEM_FEDERICO: VibeBulkEnrichItem = {
  prospect_id: "8c2455c2bcea6407caf430a34160e45641933896",
  data: {
    emails: [
      {
        address: "federico@example.com",
        type: "current_professional",
      },
    ],
    professions_email: "federico@example.com",
    professional_email_status: "valid",
    phone_numbers: null,
    mobile_phone: null,
  },
};

export const ENRICH_RESPONSE: VibeBulkEnrichResponse = {
  response_context: {
    correlation_id: "test",
    request_status: "success",
    time_took_in_seconds: 0.6,
  },
  data: [ENRICH_ITEM_FEDERICO],
  total_results: 1,
};

export const ENRICH_ITEM_NO_EMAIL: VibeBulkEnrichItem = {
  prospect_id: "no-email-id",
  data: {
    emails: [],
    professions_email: null,
    professional_email_status: null,
    phone_numbers: null,
    mobile_phone: null,
  },
};

export const ENRICH_ITEM_INVALID_STATUS: VibeBulkEnrichItem = {
  prospect_id: "invalid-status-id",
  data: {
    emails: [{ address: "bad@example.com", type: "current_professional" }],
    professions_email: "bad@example.com",
    professional_email_status: "invalid",
    phone_numbers: null,
    mobile_phone: null,
  },
};

export const ENRICH_ITEM_NO_BLOCK: VibeBulkEnrichItem = {
  prospect_id: "no-block-id",
  data: null,
};
