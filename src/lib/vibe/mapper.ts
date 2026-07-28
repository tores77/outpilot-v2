// Vibe prospect -> LeadDraft mapping.
// Fase 1 · T014.
//
// Field names are ASSUMED from common REST conventions. Validate by running
// `npm run probe:vibe-fetch` (costs ~1 credit). If the real API returns
// different keys, edit this single file.

import type { LeadDraft } from "@/lib/nova/cleanup";
import type { VibeProspect } from "./types";

const KNOWN_KEYS = new Set([
  "email",
  "first_name",
  "last_name",
  "full_name",
  "job_title",
  "title",
  "company_name",
  "company",
  "linkedin_url",
  "linkedin",
  "phone",
  "phone_number",
  "country",
  "country_code",
  "city",
  "company_size",
  "company_industry",
  "industry",
  "company_website",
  "website",
]);

function pickString(...candidates: Array<string | null | undefined>): string | null {
  for (const c of candidates) {
    if (typeof c === "string" && c.trim() !== "") return c.trim();
  }
  return null;
}

function splitFullName(
  full: string | null,
): { first: string | null; last: string | null } {
  if (!full) return { first: null, last: null };
  const parts = full.trim().split(/\s+/);
  if (parts.length === 0) return { first: null, last: null };
  if (parts.length === 1) return { first: parts[0], last: null };
  return { first: parts[0], last: parts.slice(1).join(" ") };
}

function extractCustomFields(p: VibeProspect): Record<string, string> {
  const custom: Record<string, string> = {};
  for (const [k, v] of Object.entries(p)) {
    if (KNOWN_KEYS.has(k)) continue;
    if (v === null || v === undefined) continue;
    custom[k] = typeof v === "string" ? v : JSON.stringify(v);
  }
  return custom;
}

/**
 * Returns null if no usable email can be extracted — such rows are counted
 * as invalid upstream and skipped.
 */
export function mapProspectToLeadDraft(p: VibeProspect): LeadDraft | null {
  const email = pickString(p.email);
  if (!email) return null;

  let first = pickString(p.first_name);
  let last = pickString(p.last_name);
  if (!first && !last) {
    const split = splitFullName(pickString(p.full_name));
    first = split.first;
    last = split.last;
  }

  const custom_fields = extractCustomFields(p);

  return {
    email,
    first_name: first,
    last_name: last,
    company: pickString(p.company_name, p.company),
    title: pickString(p.job_title, p.title),
    phone: pickString(p.phone, p.phone_number),
    linkedin_url: pickString(p.linkedin_url, p.linkedin),
    website: pickString(p.company_website, p.website),
    sector: pickString(p.company_industry, p.industry),
    country: pickString(p.country, p.country_code),
    city: pickString(p.city),
    custom_fields: Object.keys(custom_fields).length > 0 ? custom_fields : undefined,
  };
}

/**
 * Extracts the prospect array from a fetch response, tolerating three
 * common conventions (data / results / prospects).
 */
export function extractProspects(payload: unknown): VibeProspect[] {
  if (payload === null || typeof payload !== "object") return [];
  const obj = payload as Record<string, unknown>;
  for (const key of ["data", "results", "prospects"] as const) {
    const arr = obj[key];
    if (Array.isArray(arr)) return arr as VibeProspect[];
  }
  return [];
}
