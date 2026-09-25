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

// Título → categoría de decisor para el gate mecánico. Ver
// computeScoreUpdate: cuando el título del lead SOLO matchea
// secondaryDeciders del ICP, el score global se capa a
// secondaryMaxScore aunque Haiku puntúe más alto.
export type DeciderCategory = "primary" | "secondary" | "neither";

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
  // Campos de custom_fields que Nova surface al prompt. T024
  // (post-mortem Sklum): sin company_description Haiku no puede
  // distinguir un fabricante genuino de un e-commerce D2C con el
  // mismo linkedin_category ("furniture manufacturing"). Con la
  // descripción, "somos el puente entre tu historia y tu hogar"
  // marca a Sklum como B2C excluido.
  linkedin_category?: string;
  company_description?: string;
  company_size?: string;
  company_revenue?: string;
  naics_description?: string;
};

const CUSTOM_KEYS_TO_SURFACE = [
  "linkedin_category",
  "company_description",
  "company_size",
  "company_revenue",
  "naics_description",
] as const;

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
  // T024: campos del lead que el modelo dice haber usado. Se usa en
  // el gate mecánico anti-fabricación de sector — si esta lista no
  // contiene sector/website_summary/company_description/linkedin_category,
  // el score > 50 se capa. Opcional para tolerancia con respuestas
  // sin el campo (parser degrada score en ese caso).
  reasoning_fields_used?: string[];
};

export type ScoreThresholds = {
  enRadar: number;
  review: number;
};

// T024 gate mecánico anti-fabricación de sector (caso Linq real:
// puntuado 72 porque Haiku afirmó "despacho de abogados boutique" —
// inventado). Estas señales tienen que estar en el fields_used citado
// por el modelo para autorizar un score alto. Si el modelo no las
// cita pero puntúa alto, el gate capa el score y marca needs_review.
const SECTOR_FIELDS: readonly string[] = [
  "sector",
  "website_summary",
  "company_description",
  "linkedin_category",
];

// Título matchea primary/secondary/ninguno según el ICP. Comparación
// case-insensitive con contains — cubre variantes de idioma sin
// tener que enumerar todas las inflexiones ("CEO", "ceo", "chief
// executive officer" matchean "ceo" en primaryDeciders).
export function classifyDecider(
  title: string | null | undefined,
  primaryDeciders: readonly string[],
  secondaryDeciders: readonly string[],
): DeciderCategory {
  if (!title || title.trim() === "") return "neither";
  const norm = title.toLowerCase();
  for (const p of primaryDeciders) {
    if (norm.includes(p.toLowerCase())) return "primary";
  }
  for (const s of secondaryDeciders) {
    if (norm.includes(s.toLowerCase())) return "secondary";
  }
  return "neither";
}

export type MechanicalGateOptions = {
  // Cuando el título matchea solo secondaryDeciders, capamos aquí.
  secondaryMaxScore: number;
  primaryDeciders: readonly string[];
  secondaryDeciders: readonly string[];
};

export type MechanicalGateResult = {
  score: number;
  needs_review_reasons: string[];
  gated: Array<"sector_unknown" | "secondary_decider_cap">;
};

/**
 * Aplica gates mecánicos post-modelo sobre el score/reasoning que
 * devuelve Haiku. Nunca sube el score; solo lo baja. Se combina con
 * computeScoreUpdate para producir la decisión final.
 *
 * Gates:
 *   1. sector_unknown: si el reasoning no cita ningún campo de sector
 *      (SECTOR_FIELDS) Y el score > 50, capa a 50 y marca la razón.
 *   2. secondary_decider_cap: si el título matchea SOLO secondaryDeciders
 *      del ICP y el score supera secondaryMaxScore, capa ahí.
 */
export function applyScoreMechanicalGates(
  raw: ScoredLead,
  lead: Pick<LeadForScoring, "title">,
  opts: MechanicalGateOptions,
): MechanicalGateResult {
  let score = raw.score;
  const reasons: string[] = [];
  const gated: Array<"sector_unknown" | "secondary_decider_cap"> = [];

  // Gate 1: sector_unknown
  const citesSector = raw.reasoning_fields_used
    ? raw.reasoning_fields_used.some((f) => SECTOR_FIELDS.includes(f))
    : false;
  if (!citesSector && score > 50) {
    score = 50;
    reasons.push("sector_unknown");
    gated.push("sector_unknown");
  }

  // Gate 2: secondary_decider_cap
  const category = classifyDecider(
    lead.title,
    opts.primaryDeciders,
    opts.secondaryDeciders,
  );
  if (category === "secondary" && score > opts.secondaryMaxScore) {
    score = opts.secondaryMaxScore;
    reasons.push(`secondary_decider_cap:${opts.secondaryMaxScore}`);
    gated.push("secondary_decider_cap");
  }

  return { score, needs_review_reasons: reasons, gated };
}

// Pure state-machine decision for one lead's post-score update.
// - `estado` only advances (NUEVO -> EN_RADAR). Later states like
//   EN_SECUENCIA/RESPONDIO are not reverted by a new score, even if
//   the score drops below the threshold.
// - `needs_review` is only ever set to true here. Clearing it after
//   manual review is a separate action.
export type ScoreUpdate = {
  icp_score: number;
  estado?: "EN_RADAR";
  needs_review?: true;
  score_reasoning: string;
  sub_scores: SubScores;
};

export function computeScoreUpdate(
  currentEstado: string,
  result: ScoredLead,
  thresholds: ScoreThresholds,
): ScoreUpdate {
  const update: ScoreUpdate = {
    icp_score: result.score,
    score_reasoning: result.reasoning,
    sub_scores: result.sub_scores,
  };
  if (result.score >= thresholds.enRadar && currentEstado === "NUEVO") {
    update.estado = "EN_RADAR";
  }
  if (result.score < thresholds.review) {
    update.needs_review = true;
  }
  return update;
}

function clampScore(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/**
 * Extrae el payload JSON del texto crudo devuelto por Haiku. Robusto
 * ante los tres modos observados en producción:
 *   1. Fence markdown: "```json\n[...]\n```" — regex captura el interior.
 *   2. Fence + language en línea propia: "```\njson\n[...]\n```" — la
 *      captura del regex viene "json\n[...]" y el slice por `[` / `]`
 *      lo limpia. Este es el modo que rompía al parser original y
 *      producía `Unexpected token '', "js..."` (el "js" era el
 *      prefijo "json\n" no eliminado).
 *   3. Texto llano con contexto: el modelo comenta antes/después.
 *      Slice de primer `[` a último `]` recupera solo el array.
 *
 * Idempotente: aplicar N veces produce el mismo resultado.
 */
export function extractJsonArrayPayload(text: string): string {
  let candidate = text.trim();
  // 1. Fence pair opcional. Non-greedy para no atrapar bloques anidados.
  const fenced = candidate.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced) candidate = fenced[1].trim();
  // 2. Slice de primer `[` a último `]` — Nova siempre emite ARRAY, así
  //    que si el modelo añade "json\n" o comenta "Here is:", este slice
  //    los elimina como side-effect.
  const start = candidate.indexOf("[");
  const end = candidate.lastIndexOf("]");
  if (start !== -1 && end > start) return candidate.slice(start, end + 1);
  // Sin `[…]` reconocible: devolvemos lo que haya para que JSON.parse
  // falle con un mensaje útil (el caller lo captura como parse error).
  return candidate;
}

/**
 * Resultado tolerante del parseo del batch. NO lanza — el caller
 * decide qué hacer con un batch roto (liberar claims, marcar error,
 * seguir con el siguiente batch sin tumbar el run).
 */
export type ScoreParseResult =
  | { ok: true; scored: ScoredLead[] }
  | { ok: false; error: string; preview: string };

export function parseScoringResponse(text: string): ScoreParseResult {
  const payload = extractJsonArrayPayload(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch (err) {
    return {
      ok: false,
      error: `not_valid_json: ${err instanceof Error ? err.message : String(err)}`,
      preview: text.slice(0, 200),
    };
  }
  if (!Array.isArray(parsed)) {
    return {
      ok: false,
      error: "not_array",
      preview: text.slice(0, 200),
    };
  }
  const out: ScoredLead[] = [];
  for (const item of parsed) {
    if (item === null || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id : null;
    if (!id) continue;
    const sub = (record.sub_scores as Record<string, unknown> | undefined) ?? {};
    const fieldsUsed = Array.isArray(record.fields_used)
      ? record.fields_used.filter((v): v is string => typeof v === "string")
      : undefined;
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
      reasoning_fields_used: fieldsUsed,
    });
  }
  return { ok: true, scored: out };
}
