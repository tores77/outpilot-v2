// Vibe -> LeadDraft mapping. Two stages:
//
//   1. mapProspectToLeadDraft(p): fetch response -> LeadDraft. Email is
//      left NULL on purpose — the fetch endpoint returns
//      professional_email_hashed only. The dedupe pass in cleanupLeadBatch
//      runs on these email-less drafts and prunes the batch before we pay
//      for enrich.
//
//   2. mergeEnrichedContact(draft, contact): fills email + phone + status
//      + prospect_id echo into the surviving draft. Returns null when the
//      contact is missing an email, the status is not "valid", or the
//      contact block is null/empty — the caller counts those as
//      enrich_no_email and drops them (a lead without a verified email
//      cannot enter a Volt sequence).
//
// All field names are verified against real responses (see the four
// probe:vibe-* scripts).

import type { LeadDraft } from "@/lib/nova/cleanup";
import type {
  VibeBulkEnrichItem,
  VibeBulkEnrichResponse,
  VibeEnrichedContact,
  VibeFetchResponse,
  VibeProspect,
} from "./types";

// ===== fetch mapping =====

const PROSPECT_KNOWN_KEYS = new Set([
  "prospect_id",
  "first_name",
  "last_name",
  "full_name",
  "job_title",
  "job_level_main",
  "company_name",
  "company_website",
  "linkedin",
  "linkedin_url_array",
  "country_name",
  "country_code",
  "city",
  "linkedin_category",
]);

function pickString(...candidates: Array<string | null | undefined>): string | null {
  for (const c of candidates) {
    if (typeof c === "string" && c.trim() !== "") return c.trim();
  }
  return null;
}

function pickLinkedin(p: VibeProspect): string | null {
  const single = pickString(p.linkedin);
  if (single) return single;
  const arr = p.linkedin_url_array;
  if (Array.isArray(arr) && arr.length > 0) {
    for (const url of arr) {
      if (typeof url === "string" && url.trim() !== "") return url.trim();
    }
  }
  return null;
}

function extractCustomFields(p: VibeProspect): Record<string, string> {
  const custom: Record<string, string> = {};
  for (const [k, v] of Object.entries(p)) {
    if (PROSPECT_KNOWN_KEYS.has(k)) continue;
    if (v === null || v === undefined) continue;
    custom[k] = typeof v === "string" ? v : JSON.stringify(v);
  }
  return custom;
}

export function mapProspectToLeadDraft(p: VibeProspect): LeadDraft | null {
  // prospect_id is the anchor for the enrich step and future re-enrich.
  // Without it we can't correlate the enrich response, so we drop.
  if (typeof p.prospect_id !== "string" || p.prospect_id.length === 0) {
    return null;
  }

  const custom_fields = extractCustomFields(p);
  // Persist the anchor id so a future re-enrich (BACKLOG idea) can find it.
  custom_fields.prospect_id = p.prospect_id;

  return {
    // email left null on purpose — filled in by the enrich merge.
    email: null,
    first_name: pickString(p.first_name),
    last_name: pickString(p.last_name),
    company: pickString(p.company_name),
    title: pickString(p.job_title),
    linkedin_url: pickLinkedin(p),
    website: pickString(p.company_website),
    sector: pickString(p.linkedin_category),
    country: pickString(p.country_name, p.country_code),
    city: pickString(p.city),
    custom_fields,
  };
}

export function extractFetchProspects(payload: VibeFetchResponse): VibeProspect[] {
  return Array.isArray(payload.data) ? payload.data : [];
}

// ===== enrich merge =====

function extractEmailAndType(
  contact: VibeEnrichedContact,
): { email: string; type: string | null } | null {
  const shortcut = typeof contact.professions_email === "string" && contact.professions_email.trim() !== ""
    ? contact.professions_email.trim()
    : null;
  if (shortcut) {
    const type = contact.emails?.find((e) => e.address === shortcut)?.type ?? null;
    return { email: shortcut, type };
  }
  if (Array.isArray(contact.emails) && contact.emails.length > 0) {
    // Prefer current_professional if present, else the first non-empty.
    const prof = contact.emails.find(
      (e) => typeof e.address === "string" && e.address.trim() !== "" && e.type === "current_professional",
    );
    if (prof) return { email: prof.address.trim(), type: "current_professional" };
    const first = contact.emails.find(
      (e) => typeof e.address === "string" && e.address.trim() !== "",
    );
    if (first) return { email: first.address.trim(), type: first.type ?? null };
  }
  return null;
}

function extractPhone(contact: VibeEnrichedContact): string | null {
  const mobile = typeof contact.mobile_phone === "string" ? contact.mobile_phone.trim() : "";
  if (mobile) return mobile;
  if (Array.isArray(contact.phone_numbers) && contact.phone_numbers.length > 0) {
    for (const p of contact.phone_numbers) {
      if (typeof p === "string" && p.trim() !== "") return p.trim();
    }
  }
  return null;
}

export type EnrichOutcome =
  | { ok: true; draft: LeadDraft }
  | { ok: false; reason: "no_contact_block" | "no_email" | "invalid_status" };

export function mergeEnrichedContact(
  draft: LeadDraft,
  item: VibeBulkEnrichItem,
): EnrichOutcome {
  const contact = item.data;
  if (!contact) return { ok: false, reason: "no_contact_block" };

  const emailInfo = extractEmailAndType(contact);
  if (!emailInfo) return { ok: false, reason: "no_email" };

  const status =
    typeof contact.professional_email_status === "string"
      ? contact.professional_email_status.trim().toLowerCase()
      : null;
  if (status !== null && status !== "valid") {
    return { ok: false, reason: "invalid_status" };
  }

  const phone = extractPhone(contact);
  const custom_fields: Record<string, string> = { ...(draft.custom_fields ?? {}) };
  if (status) custom_fields.email_status = status;
  if (emailInfo.type) custom_fields.email_type = emailInfo.type;

  return {
    ok: true,
    draft: {
      ...draft,
      email: emailInfo.email,
      phone: phone ?? draft.phone ?? null,
      custom_fields,
    },
  };
}

export function indexEnrichResponseByProspectId(
  payload: VibeBulkEnrichResponse,
): Map<string, VibeBulkEnrichItem> {
  const map = new Map<string, VibeBulkEnrichItem>();
  if (!Array.isArray(payload.data)) return map;
  for (const item of payload.data) {
    if (typeof item.prospect_id === "string") map.set(item.prospect_id, item);
  }
  return map;
}
