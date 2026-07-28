// Pure helpers for Nova ICP scoring — no I/O.
//
// - buildLeadPayload: extracts only the fields Haiku is allowed to reason
//   over from a raw leads row. Nulls/empties are stripped so the prompt
//   surfaces genuine absence of signal without smuggling "false" as data.
// - parseScoringResponse: tolerates markdown fences and validates each
//   entry's shape before the job trusts the numbers.

export type LeadForScoring = {
  id: string;
  email?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  company?: string | null;
  title?: string | null;
  sector?: string | null;
  country?: string | null;
  city?: string | null;
  website?: string | null;
  linkedin_url?: string | null;
  custom_fields?: Record<string, unknown> | null;
};

export type LeadPromptEntry = {
  id: string;
  first_name?: string;
  last_name?: string;
  company?: string;
  title?: string;
  sector?: string;
  country?: string;
  city?: string;
  website?: string;
  linkedin_url?: string;
  // Selected keys from custom_fields we know can help the model
  // (e.g. linkedin_category from Vibe). No blanket dump.
  linkedin_category?: string;
};

const CUSTOM_KEYS_TO_SURFACE = ["linkedin_category"] as const;

function nonEmpty(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

export function buildLeadPayload(lead: LeadForScoring): LeadPromptEntry {
  const entry: LeadPromptEntry = { id: lead.id };
  const first_name = nonEmpty(lead.first_name);
  if (first_name) entry.first_name = first_name;
  const last_name = nonEmpty(lead.last_name);
  if (last_name) entry.last_name = last_name;
  const company = nonEmpty(lead.company);
  if (company) entry.company = company;
  const title = nonEmpty(lead.title);
  if (title) entry.title = title;
  const sector = nonEmpty(lead.sector);
  if (sector) entry.sector = sector;
  const country = nonEmpty(lead.country);
  if (country) entry.country = country;
  const city = nonEmpty(lead.city);
  if (city) entry.city = city;
  const website = nonEmpty(lead.website);
  if (website) entry.website = website;
  const linkedin_url = nonEmpty(lead.linkedin_url);
  if (linkedin_url) entry.linkedin_url = linkedin_url;

  if (lead.custom_fields) {
    for (const key of CUSTOM_KEYS_TO_SURFACE) {
      const value = lead.custom_fields[key];
      if (typeof value === "string") {
        const nv = nonEmpty(value);
        if (nv) entry[key] = nv;
      }
    }
  }
  return entry;
}

export type SubScores = {
  sector_fit: number;
  seniority_fit: number;
  brand_signal: number;
  budget_signal: number;
};

export type ScoredLead = {
  id: string;
  score: number;
  sub_scores: SubScores;
  reasoning: string;
};

function clampScore(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function stripJsonFences(text: string): string {
  const trimmed = text.trim();
  // ```json ... ``` fenced
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced) return fenced[1].trim();
  // Otherwise slice from the first '[' to the last ']'
  const start = trimmed.indexOf("[");
  const end = trimmed.lastIndexOf("]");
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
  return trimmed;
}

export function parseScoringResponse(text: string): ScoredLead[] {
  const jsonText = stripJsonFences(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    throw new Error(
      `Nova scoring: response is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error("Nova scoring: response is not a JSON array");
  }
  const out: ScoredLead[] = [];
  for (const item of parsed) {
    if (item === null || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id : null;
    if (!id) continue;
    const sub = (record.sub_scores as Record<string, unknown> | undefined) ?? {};
    out.push({
      id,
      score: clampScore(record.score),
      sub_scores: {
        sector_fit: clampScore(sub.sector_fit),
        seniority_fit: clampScore(sub.seniority_fit),
        brand_signal: clampScore(sub.brand_signal),
        budget_signal: clampScore(sub.budget_signal),
      },
      reasoning:
        typeof record.reasoning === "string"
          ? record.reasoning
          : "(sin reasoning)",
    });
  }
  return out;
}
