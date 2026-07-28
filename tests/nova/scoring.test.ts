import { describe, expect, it } from "vitest";
import {
  buildLeadPayload,
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
  MALFORMED_ENTRY,
  NOISY_JSON,
  RAW_JSON_ARRAY,
} from "../fixtures/scoring-responses";

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
    const parsed = parseScoringResponse(RAW_JSON_ARRAY);
    expect(parsed).toHaveLength(3);
    const ana = parsed.find((r) => r.id === "fixture-ana");
    expect(ana?.score).toBe(69);
    const jose = parsed.find((r) => r.id === "fixture-jose");
    expect(jose?.score).toBe(78);
  });

  it("tolerates markdown code fences", () => {
    const parsed = parseScoringResponse(FENCED_JSON);
    expect(parsed).toHaveLength(3);
  });

  it("tolerates leading/trailing prose around the array", () => {
    const parsed = parseScoringResponse(NOISY_JSON);
    expect(parsed).toHaveLength(3);
  });

  it("skips malformed entries but preserves the good ones", () => {
    const parsed = parseScoringResponse(MALFORMED_ENTRY);
    const ids = parsed.map((r) => r.id).sort();
    expect(ids).toEqual(["fixture-clamp-high", "fixture-clamp-low", "fixture-good"]);
  });

  it("clamps scores into 0..100 (both extremes)", () => {
    const parsed = parseScoringResponse(MALFORMED_ENTRY);
    const high = parsed.find((r) => r.id === "fixture-clamp-high");
    expect(high?.score).toBe(100);
    expect(high?.sub_scores.sector_fit).toBe(100);
    const low = parsed.find((r) => r.id === "fixture-clamp-low");
    expect(low?.score).toBe(0);
    expect(low?.sub_scores.sector_fit).toBe(0);
  });

  it("throws on non-JSON input", () => {
    expect(() => parseScoringResponse("not json at all")).toThrow();
  });

  it("throws when the payload is a JSON object instead of an array", () => {
    expect(() => parseScoringResponse('{"id": "x"}')).toThrow();
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
    const parsed = parseScoringResponse(RAW_JSON_ARRAY);
    const ana = parsed.find((r) => r.id === "fixture-ana");
    if (!ana) throw new Error("fixture ana missing");
    const decision = computeScoreUpdate("NUEVO", ana, THRESHOLDS);
    expect(decision.icp_score).toBe(69);
    expect(decision.estado).toBeUndefined();
  });

  it("promotes Jose at 78 to EN_RADAR", () => {
    const parsed = parseScoringResponse(RAW_JSON_ARRAY);
    const jose = parsed.find((r) => r.id === "fixture-jose");
    if (!jose) throw new Error("fixture jose missing");
    const decision = computeScoreUpdate("NUEVO", jose, THRESHOLDS);
    expect(decision.icp_score).toBe(78);
    expect(decision.estado).toBe("EN_RADAR");
  });

  it("puts Epsilon on the review queue", () => {
    const parsed = parseScoringResponse(RAW_JSON_ARRAY);
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
