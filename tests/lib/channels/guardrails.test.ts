import { describe, expect, it } from "vitest";
import {
  evaluateGuardrails,
  parseGuardrailsMode,
} from "@/lib/channels/guardrails";

describe("evaluateGuardrails (T025 bloque C)", () => {
  describe("casos del pedido Pere 2026-10-02", () => {
    it("19 sent + 1 bounce → none (sent < 20, no evalúa)", () => {
      const r = evaluateGuardrails({
        sent: 19,
        bounced: 1,
        complaints: 0,
        windowHours: 24,
      });
      expect(r.action).toBe("none");
    });

    it("50 sent + 2 bounces (4 %) → pause bounce_rate_exceeded", () => {
      const r = evaluateGuardrails({
        sent: 50,
        bounced: 2,
        complaints: 0,
        windowHours: 24,
      });
      expect(r.action).toBe("pause");
      if (r.action !== "pause") return;
      expect(r.reason).toBe("bounce_rate_exceeded");
      expect(r.rate).toBeCloseTo(0.04);
      expect(r.threshold).toBe(0.02);
    });

    it("100 sent + 1 complaint (1 %) → pause complaint_rate_exceeded", () => {
      const r = evaluateGuardrails({
        sent: 100,
        bounced: 0,
        complaints: 1,
        windowHours: 24,
      });
      expect(r.action).toBe("pause");
      if (r.action !== "pause") return;
      expect(r.reason).toBe("complaint_rate_exceeded");
      expect(r.rate).toBeCloseTo(0.01);
      expect(r.threshold).toBe(0.001);
    });
  });

  describe("umbral exacto bounce (2 %)", () => {
    it("50 sent + 1 bounce (2 % exacto) → none (umbral es ESTRICTAMENTE mayor)", () => {
      const r = evaluateGuardrails({
        sent: 50,
        bounced: 1,
        complaints: 0,
        windowHours: 24,
      });
      expect(r.action).toBe("none");
    });

    it("20 sent + 1 bounce (5 %) → pause (justo pasa min_sent)", () => {
      const r = evaluateGuardrails({
        sent: 20,
        bounced: 1,
        complaints: 0,
        windowHours: 24,
      });
      expect(r.action).toBe("pause");
      if (r.action !== "pause") return;
      expect(r.reason).toBe("bounce_rate_exceeded");
    });
  });

  describe("umbral exacto complaint (0,1 %)", () => {
    it("1000 sent + 1 complaint (0,1 % exacto) → none", () => {
      const r = evaluateGuardrails({
        sent: 1000,
        bounced: 0,
        complaints: 1,
        windowHours: 24,
      });
      expect(r.action).toBe("none");
    });

    it("1000 sent + 2 complaints (0,2 %) → pause", () => {
      const r = evaluateGuardrails({
        sent: 1000,
        bounced: 0,
        complaints: 2,
        windowHours: 24,
      });
      expect(r.action).toBe("pause");
      if (r.action !== "pause") return;
      expect(r.reason).toBe("complaint_rate_exceeded");
    });
  });

  describe("prioridad bounce > complaint", () => {
    it("ambos exceden → gana bounce (se reporta primero)", () => {
      const r = evaluateGuardrails({
        sent: 100,
        bounced: 3,
        complaints: 1,
        windowHours: 24,
      });
      expect(r.action).toBe("pause");
      if (r.action !== "pause") return;
      expect(r.reason).toBe("bounce_rate_exceeded");
    });
  });

  describe("edge cases", () => {
    it("0 sent → none (sin tráfico, no evalúa)", () => {
      const r = evaluateGuardrails({
        sent: 0,
        bounced: 0,
        complaints: 0,
        windowHours: 24,
      });
      expect(r.action).toBe("none");
    });

    it("sent muy alto, 0 bounces, 0 complaints → none", () => {
      const r = evaluateGuardrails({
        sent: 10000,
        bounced: 0,
        complaints: 0,
        windowHours: 24,
      });
      expect(r.action).toBe("none");
    });

    it("todos bounce (100 %) → pause", () => {
      const r = evaluateGuardrails({
        sent: 50,
        bounced: 50,
        complaints: 0,
        windowHours: 24,
      });
      expect(r.action).toBe("pause");
    });
  });
});

describe("parseGuardrailsMode", () => {
  it("undefined → observe (default)", () => {
    expect(parseGuardrailsMode(undefined)).toBe("observe");
  });
  it("'enforce' → enforce (match exacto)", () => {
    expect(parseGuardrailsMode("enforce")).toBe("enforce");
  });
  it("'ENFORCE' → observe (case-sensitive, un typo no endurece)", () => {
    expect(parseGuardrailsMode("ENFORCE")).toBe("observe");
  });
  it("'observe' → observe", () => {
    expect(parseGuardrailsMode("observe")).toBe("observe");
  });
  it("valor random → observe (fallback seguro)", () => {
    expect(parseGuardrailsMode("audit")).toBe("observe");
  });
});
