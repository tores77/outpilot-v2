import { describe, expect, it } from "vitest";
import {
  applyScoreMechanicalGates,
  buildLeadPayload,
  classifyDecider,
  computeScoreUpdate,
  parseScoringResponse,
  type ScoredLead,
} from "@/lib/nova/scoring";
import {
  ANA_NO_SIGNAL,
  EPSILON_INSUFFICIENT_DATA,
  JOSE_WITH_SIGNALS,
} from "../fixtures/leads";
import {
  FENCED_JSON,
  FENCED_JSON_LANG_ON_OWN_LINE,
  MALFORMED_ENTRY,
  NOISY_JSON,
  NOT_JSON_AT_ALL,
  RAW_JSON_ARRAY,
  TRUNCATED_BY_MAX_TOKENS,
} from "../fixtures/scoring-responses";

// Wrapper para tests que solo se preocupan del array parseado
// (bypass del discriminated union). Los tests de error usan
// parseScoringResponse directamente y comprueban ok=false.
function scoredOrFail(text: string): ScoredLead[] {
  const r = parseScoringResponse(text);
  if (!r.ok) throw new Error(`expected ok, got: ${r.error}`);
  return r.scored;
}

const THRESHOLDS = { enRadar: 70, review: 40 };

describe("buildLeadPayload", () => {
  it("strips null/empty fields so absence stays absence", () => {
    const payload = buildLeadPayload(ANA_NO_SIGNAL);
    expect(payload.id).toBe("fixture-ana");
    expect(payload.first_name).toBe("Ana");
    expect(payload.title).toBe("CEO");
    // Fields that were not present must not appear
    expect(payload).not.toHaveProperty("website");
    expect(payload).not.toHaveProperty("linkedin_url");
    expect(payload).not.toHaveProperty("linkedin_category");
  });

  it("surfaces linkedin_category from custom_fields when present", () => {
    const payload = buildLeadPayload(JOSE_WITH_SIGNALS);
    expect(payload.linkedin_category).toBe("marketing services");
    expect(payload.website).toBe("https://producthackers.com");
  });

  it("returns only the id for a lead with no useful field", () => {
    const payload = buildLeadPayload({ id: "bare" });
    expect(payload).toEqual({ id: "bare" });
  });

  it("does not confuse whitespace with content", () => {
    const payload = buildLeadPayload({
      id: "x",
      first_name: "   ",
      company: "",
      title: "CEO",
    });
    expect(payload).not.toHaveProperty("first_name");
    expect(payload).not.toHaveProperty("company");
    expect(payload.title).toBe("CEO");
  });
});

describe("parseScoringResponse", () => {
  it("parses a plain JSON array", () => {
    const parsed = scoredOrFail(RAW_JSON_ARRAY);
    expect(parsed).toHaveLength(3);
    const ana = parsed.find((r) => r.id === "fixture-ana");
    expect(ana?.score).toBe(69);
    const jose = parsed.find((r) => r.id === "fixture-jose");
    expect(jose?.score).toBe(78);
  });

  it("tolerates markdown code fences (inline language marker)", () => {
    const parsed = scoredOrFail(FENCED_JSON);
    expect(parsed).toHaveLength(3);
  });

  it("REGRESIÓN 2026-09-25: fence con 'json' en línea propia (rompía el parser original)", () => {
    // Haiku respondió con "```\njson\n[...]\n```" y el parser antiguo
    // capturaba "json\n[...]" dentro del fence → Unexpected token '', "js..."
    // El slice `[` → `]` limpia el prefijo "json\n" como side-effect.
    const parsed = scoredOrFail(FENCED_JSON_LANG_ON_OWN_LINE);
    expect(parsed).toHaveLength(3);
    expect(parsed.find((r) => r.id === "fixture-ana")?.score).toBe(69);
  });

  it("tolerates leading/trailing prose around the array", () => {
    const parsed = scoredOrFail(NOISY_JSON);
    expect(parsed).toHaveLength(3);
  });

  it("skips malformed entries but preserves the good ones", () => {
    const parsed = scoredOrFail(MALFORMED_ENTRY);
    const ids = parsed.map((r) => r.id).sort();
    expect(ids).toEqual(["fixture-clamp-high", "fixture-clamp-low", "fixture-good"]);
  });

  it("clamps scores into 0..100 (both extremes)", () => {
    const parsed = scoredOrFail(MALFORMED_ENTRY);
    const high = parsed.find((r) => r.id === "fixture-clamp-high");
    expect(high?.score).toBe(100);
    expect(high?.sub_scores.sector_fit).toBe(100);
    const low = parsed.find((r) => r.id === "fixture-clamp-low");
    expect(low?.score).toBe(0);
    expect(low?.sub_scores.sector_fit).toBe(0);
  });

  it("returns ok:false on non-JSON input (no throw — caller decide)", () => {
    const r = parseScoringResponse(NOT_JSON_AT_ALL);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/^not_valid_json/);
      expect(r.preview.length).toBeGreaterThan(0);
    }
  });

  it("returns ok:false cuando el payload es objeto en vez de array", () => {
    const r = parseScoringResponse('{"id": "x"}');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("not_array");
  });

  it("REGRESIÓN 2026-09-25 tarde: respuesta truncada por max_tokens (bucle infinito) → ok:false, sin lanzar", () => {
    // Fixture anonimizado de la respuesta real que rompió el batch.
    // El parser NO puede recuperar un JSON truncado; el guarantee es
    // devolver ok:false para que el harness marque scoring_error y no
    // vuelva a reclamar. La cura de raíz es NOVA_SCORE_MAX_TOKENS=16000,
    // pero el parser+guard son la salvaguarda si vuelve a pasar.
    const r = parseScoringResponse(TRUNCATED_BY_MAX_TOKENS);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/^not_valid_json/);
      // Preview contiene el inicio de la respuesta (útil para
      // diagnosticar en el step output de Inngest sin abrir BD).
      expect(r.preview.length).toBeGreaterThan(0);
      expect(r.preview).toContain("fixture-a");
    }
  });
});

describe("computeScoreUpdate — state machine only advances", () => {
  const baseResult = (
    id: string,
    score: number,
  ): ScoredLead => ({
    id,
    score,
    sub_scores: { sector_fit: 0, seniority_fit: 0, brand_signal: 0, budget_signal: 0 },
    reasoning: "test",
  });

  it("promotes NUEVO -> EN_RADAR when score >= threshold", () => {
    const decision = computeScoreUpdate("NUEVO", baseResult("x", 78), THRESHOLDS);
    expect(decision.icp_score).toBe(78);
    expect(decision.estado).toBe("EN_RADAR");
    expect(decision.needs_review).toBeUndefined();
  });

  it("does NOT promote from a later estado even with a high score", () => {
    const decision = computeScoreUpdate(
      "EN_SECUENCIA",
      baseResult("x", 90),
      THRESHOLDS,
    );
    expect(decision.icp_score).toBe(90);
    expect(decision.estado).toBeUndefined();
    expect(decision.needs_review).toBeUndefined();
  });

  it("does NOT revert EN_RADAR down to NUEVO when the new score drops", () => {
    const decision = computeScoreUpdate(
      "EN_RADAR",
      baseResult("x", 30),
      THRESHOLDS,
    );
    expect(decision.icp_score).toBe(30);
    expect(decision.estado).toBeUndefined();
    // score < review still trips the review flag
    expect(decision.needs_review).toBe(true);
  });

  it("flags needs_review when score < review threshold", () => {
    const decision = computeScoreUpdate(
      "NUEVO",
      baseResult("epsilon", 28),
      THRESHOLDS,
    );
    expect(decision.needs_review).toBe(true);
    expect(decision.estado).toBeUndefined();
  });

  it("leaves the mid-band alone (no state change, no flag)", () => {
    const decision = computeScoreUpdate(
      "NUEVO",
      baseResult("x", 55),
      THRESHOLDS,
    );
    expect(decision.estado).toBeUndefined();
    expect(decision.needs_review).toBeUndefined();
  });

  it("passes reasoning + sub_scores through untouched", () => {
    const result: ScoredLead = {
      id: "x",
      score: 60,
      sub_scores: { sector_fit: 70, seniority_fit: 80, brand_signal: 45, budget_signal: 50 },
      reasoning: "Campos usados: title, sector.",
    };
    const decision = computeScoreUpdate("NUEVO", result, THRESHOLDS);
    expect(decision.score_reasoning).toBe("Campos usados: title, sector.");
    expect(decision.sub_scores).toEqual(result.sub_scores);
  });
});

describe("regression: the Ana/Jose anti-fabrication case", () => {
  it("uses only present fields when building Ana's payload", () => {
    const payload = buildLeadPayload(ANA_NO_SIGNAL);
    expect(payload).not.toHaveProperty("website");
    expect(payload).not.toHaveProperty("linkedin_url");
    expect(payload).not.toHaveProperty("linkedin_category");
  });

  it("keeps Ana at 69 in the golden response, no promotion", () => {
    const parsed = scoredOrFail(RAW_JSON_ARRAY);
    const ana = parsed.find((r) => r.id === "fixture-ana");
    if (!ana) throw new Error("fixture ana missing");
    const decision = computeScoreUpdate("NUEVO", ana, THRESHOLDS);
    expect(decision.icp_score).toBe(69);
    expect(decision.estado).toBeUndefined();
  });

  it("promotes Jose at 78 to EN_RADAR", () => {
    const parsed = scoredOrFail(RAW_JSON_ARRAY);
    const jose = parsed.find((r) => r.id === "fixture-jose");
    if (!jose) throw new Error("fixture jose missing");
    const decision = computeScoreUpdate("NUEVO", jose, THRESHOLDS);
    expect(decision.icp_score).toBe(78);
    expect(decision.estado).toBe("EN_RADAR");
  });

  it("puts Epsilon on the review queue", () => {
    const parsed = scoredOrFail(RAW_JSON_ARRAY);
    const eps = parsed.find((r) => r.id === "fixture-epsilon");
    if (!eps) throw new Error("fixture epsilon missing");
    const decision = computeScoreUpdate("NUEVO", eps, THRESHOLDS);
    expect(decision.needs_review).toBe(true);
    expect(decision.estado).toBeUndefined();
    // Sanity: the fixture is consistent with the "insufficient data" heuristic
    expect(EPSILON_INSUFFICIENT_DATA.first_name).toBeUndefined();
    expect(EPSILON_INSUFFICIENT_DATA.title).toBeUndefined();
  });
});

// ==============================================================
// T024: gate mecánico anti-fabricación de sector (caso Linq)
// ==============================================================

describe("classifyDecider (T024)", () => {
  const primary = ["CEO", "Director General", "propietario"];
  const secondary = ["CFO", "COO"];

  it("case-insensitive contains match para primary", () => {
    expect(classifyDecider("CEO at Acme", primary, secondary)).toBe("primary");
    expect(classifyDecider("ceo & founder", primary, secondary)).toBe("primary");
    expect(classifyDecider("Director General", primary, secondary)).toBe("primary");
  });

  it("matchea secondary si el título solo tiene CFO/COO", () => {
    expect(classifyDecider("CFO at Something", primary, secondary)).toBe("secondary");
    expect(classifyDecider("Chief Operating Officer / COO", primary, secondary)).toBe("secondary");
  });

  it("primary gana sobre secondary si ambos matchean", () => {
    // "CEO/CFO" — primary evaluado primero
    expect(classifyDecider("CEO/CFO", primary, secondary)).toBe("primary");
  });

  it("neither si no matchea ni primary ni secondary", () => {
    expect(classifyDecider("Marketing Manager", primary, secondary)).toBe("neither");
    expect(classifyDecider(null, primary, secondary)).toBe("neither");
    expect(classifyDecider("", primary, secondary)).toBe("neither");
  });
});

describe("applyScoreMechanicalGates (T024)", () => {
  const primary = ["CEO", "Founder"];
  const secondary = ["CFO", "COO"];
  const opts = {
    secondaryMaxScore: 65,
    primaryDeciders: primary,
    secondaryDeciders: secondary,
  };

  function scoredLead(overrides: Partial<ScoredLead>): ScoredLead {
    return {
      id: "test",
      score: 72,
      sub_scores: {
        sector_fit: 70,
        seniority_fit: 80,
        brand_signal: 70,
        budget_signal: 60,
      },
      reasoning: "test",
      reasoning_fields_used: ["sector", "title"],
      ...overrides,
    };
  }

  it("SIN gate: score alto con sector citado y CEO → sin cambios", () => {
    const r = applyScoreMechanicalGates(
      scoredLead({ score: 78 }),
      { title: "CEO" },
      opts,
    );
    expect(r.score).toBe(78);
    expect(r.gated).toEqual([]);
    expect(r.needs_review_reasons).toEqual([]);
  });

  it("REGRESIÓN caso Linq: score 72 sin sector citado → capa a 50 + sector_unknown", () => {
    // Linq (linqcase.com, fundas de móvil) puntuado 72 porque Haiku
    // afirmó "despacho de abogados boutique" — sector inventado. El
    // gate mecánico cata a 50 y marca needs_review.
    const linq = scoredLead({
      id: "linq",
      score: 72,
      reasoning:
        "Despacho de abogados boutique en Madrid. Sector servicios profesionales, encaje bajo.",
      reasoning_fields_used: ["title", "city"], // NO cita sector/website_summary
    });
    const r = applyScoreMechanicalGates(linq, { title: "CEO" }, opts);
    expect(r.score).toBe(50);
    expect(r.gated).toContain("sector_unknown");
    expect(r.needs_review_reasons).toContain("sector_unknown");
  });

  it("REGRESIÓN cap secundario: CFO puntuado 78 → capa a 65", () => {
    const cfo = scoredLead({
      score: 78,
      reasoning_fields_used: ["sector", "title", "website"], // sector citado, no dispara sector_unknown
    });
    const r = applyScoreMechanicalGates(cfo, { title: "CFO" }, opts);
    expect(r.score).toBe(65);
    expect(r.gated).toContain("secondary_decider_cap");
    expect(r.needs_review_reasons.some((s) => s.startsWith("secondary_decider_cap:"))).toBe(true);
  });

  it("los dos gates se pueden disparar a la vez", () => {
    const cfoSinSector = scoredLead({
      score: 85,
      reasoning_fields_used: ["title"], // sin sector
    });
    const r = applyScoreMechanicalGates(cfoSinSector, { title: "CFO" }, opts);
    // sector_unknown baja a 50, secondary_cap baja a 65 — pero 50 < 65, así que solo aplica el sector_unknown
    expect(r.score).toBe(50);
    expect(r.gated).toContain("sector_unknown");
  });

  it("score ≤ 50 sin sector citado NO se degrada más (el gate solo baja, no marca sin razón)", () => {
    const low = scoredLead({ score: 42, reasoning_fields_used: ["title"] });
    const r = applyScoreMechanicalGates(low, { title: "CEO" }, opts);
    expect(r.score).toBe(42);
    expect(r.gated).toEqual([]);
  });

  it("reasoning_fields_used ausente equivale a 'sin citar sector' → gate activo si score > 50", () => {
    const noFields = scoredLead({
      score: 72,
      reasoning_fields_used: undefined,
    });
    const r = applyScoreMechanicalGates(noFields, { title: "CEO" }, opts);
    expect(r.score).toBe(50);
    expect(r.gated).toContain("sector_unknown");
  });
});
