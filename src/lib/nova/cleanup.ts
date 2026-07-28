// Nova cleanup pipeline (spec §4, T013).
//
// Pure functions — no I/O, no Supabase. Takes a batch of lead drafts as they
// come from CSV or Vibe Prospecting, applies:
//   1. Accent normalisation for keys used in comparisons (not for storage;
//      we keep the original casing/accents in the row).
//   2. Generic-email detection (info@, hello@, sales@, ...) -> needs_review.
//   3. Dedupe by normalised company keeping the highest-ranked title
//      (spec §4 "dedupe por empresa con jerarquía de cargos").
//
// Rows without a company skip the dedupe pass (there's no company key to
// group them by) but still get needs_review scored.
//
// Returns kept + dropped rows and stats, so the caller can report exactly
// how the pipeline reshaped the batch.

export type LeadDraft = {
  email: string;
  first_name?: string | null;
  last_name?: string | null;
  company?: string | null;
  title?: string | null;
  phone?: string | null;
  linkedin_url?: string | null;
  website?: string | null;
  sector?: string | null;
  country?: string | null;
  city?: string | null;
  custom_fields?: Record<string, string>;
};

export type CleanLead = LeadDraft & { needs_review: boolean };

export type DroppedLead = {
  row: CleanLead;
  reason: "dedupe_lower_rank";
  kept_email: string;
};

export type CleanupStats = {
  total: number;
  kept: number;
  dropped_dedupe: number;
  marked_review: number;
};

export type CleanupResult = {
  clean: CleanLead[];
  dropped: DroppedLead[];
  stats: CleanupStats;
};

// ===== Normalisation =====

/** Lowercase + strip accents (NFD) + collapse whitespace. */
export function normaliseText(input: string): string {
  return input
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * Comparison key for a company name. Strips legal-form suffixes and
 * punctuation, keeps only word tokens. Used exclusively for grouping;
 * we never overwrite leads.company with the normalised form.
 */
export function normaliseCompanyKey(
  company: string | null | undefined,
): string | null {
  if (!company) return null;
  const stripped = normaliseText(company)
    // legal forms: es (s.l., s.a., srl), en (llc, inc, ltd, corp),
    // de (gmbh, ag), fr (sarl, sas), nl (bv, nv)
    .replace(
      /\b(s\.?\s?l\.?|s\.?\s?a\.?|srl|llc|inc|ltd|corp|corporation|gmbh|ag|sarl|sas|bv|nv|plc|co)\b/g,
      "",
    )
    // punctuation -> space
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return stripped === "" ? null : stripped;
}

// ===== Generic emails =====

// Local parts we treat as generic mailboxes. Add cautiously — false
// positives push real leads into REVIEW.
const GENERIC_LOCAL_PARTS = new Set<string>([
  "info",
  "hello",
  "hi",
  "hola",
  "contact",
  "contacto",
  "contact-us",
  "contactus",
  "sales",
  "ventas",
  "admin",
  "office",
  "oficina",
  "support",
  "soporte",
  "help",
  "ayuda",
  "team",
  "equipo",
  "mail",
  "correo",
  "no-reply",
  "noreply",
  "notifications",
  "marketing",
  "press",
  "prensa",
  "hr",
  "rrhh",
  "jobs",
  "empleo",
  "careers",
  "invoice",
  "billing",
  "facturacion",
]);

export function isGenericEmail(email: string): boolean {
  const at = email.indexOf("@");
  if (at <= 0) return false;
  const local = email.slice(0, at).toLowerCase();
  if (GENERIC_LOCAL_PARTS.has(local)) return true;
  // Split on . / - / _ and check each segment; catches
  // "info.spain@..." or "sales-eu@..."
  const parts = local.split(/[._-]/);
  return parts.some((p) => GENERIC_LOCAL_PARTS.has(p));
}

// ===== Title rank =====

// Rank scale: lower number = more senior. Applied to the *first* pattern
// that matches, so order the patterns from broadest+most senior to
// narrower+less senior.
const TITLE_RANKS: ReadonlyArray<[RegExp, number]> = [
  [/\b(founder|co-?founder|fundador|fundadora)\b/, 1],
  [/\bceo\b|chief\s+executive/, 1],
  [/\b(owner|propietari[oa]|dueñ[oa])\b/, 1],
  [/\b(president|presidente|presidenta)\b/, 2],
  [/\bcto\b|chief\s+technology/, 2],
  [/\bcfo\b|chief\s+financial/, 2],
  [/\bcoo\b|chief\s+operating/, 2],
  [/\bcmo\b|chief\s+marketing/, 2],
  [/\bcro\b|chief\s+revenue/, 2],
  [/\bchief\b/, 2],
  [/\b(vp|vice\s+president|vicepresidente|vicepresidenta)\b/, 3],
  [/\b(director|directora)\b/, 4],
  [/\bhead\s+of\b|responsable\s+de/, 5],
  [/\b(manager|gerente)\b/, 6],
  [/\blead\b/, 7],
  [/\bsenior\b/, 8],
];

export function titleRank(title: string | null | undefined): number {
  if (!title) return 100;
  const norm = normaliseText(title);
  for (const [pattern, rank] of TITLE_RANKS) {
    if (pattern.test(norm)) return rank;
  }
  return 100;
}

// ===== Pipeline =====

export function cleanupLeadBatch(rows: LeadDraft[]): CleanupResult {
  // Pass 1: annotate needs_review
  const annotated: CleanLead[] = rows.map((r) => ({
    ...r,
    needs_review: isGenericEmail(r.email),
  }));

  // Pass 2: group by normalised company, keep top-ranked title per group.
  // Rows without a company skip grouping — they can't be deduped by company
  // and pass through directly.
  const groups = new Map<string, CleanLead[]>();
  const orphans: CleanLead[] = [];

  for (const row of annotated) {
    const key = normaliseCompanyKey(row.company);
    if (!key) {
      orphans.push(row);
      continue;
    }
    const bucket = groups.get(key);
    if (bucket) bucket.push(row);
    else groups.set(key, [row]);
  }

  const clean: CleanLead[] = [];
  const dropped: DroppedLead[] = [];

  for (const bucket of groups.values()) {
    bucket.sort((a, b) => {
      const ra = titleRank(a.title);
      const rb = titleRank(b.title);
      if (ra !== rb) return ra - rb;
      // Tie-break: prefer non-generic email over generic
      if (a.needs_review !== b.needs_review) return a.needs_review ? 1 : -1;
      // Final tie-break: keep whatever came first (stable-ish)
      return 0;
    });
    const [winner, ...losers] = bucket;
    clean.push(winner);
    for (const loser of losers) {
      dropped.push({
        row: loser,
        reason: "dedupe_lower_rank",
        kept_email: winner.email,
      });
    }
  }

  clean.push(...orphans);

  const marked_review = clean.filter((r) => r.needs_review).length;

  return {
    clean,
    dropped,
    stats: {
      total: rows.length,
      kept: clean.length,
      dropped_dedupe: dropped.length,
      marked_review,
    },
  };
}
