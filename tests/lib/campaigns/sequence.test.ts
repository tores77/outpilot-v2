import { describe, expect, it } from "vitest";
import {
  sequenceFromSlug,
  sequenceFromTemplate,
  sequenceSchema,
} from "@/lib/campaigns/sequence";
import { getIcpBySlug } from "@/config/icps";

describe("sequenceFromTemplate", () => {
  it("copia un template a un Sequence con version 1 y templateSlug", () => {
    const t = getIcpBySlug("industrial_premium_es")!;
    const seq = sequenceFromTemplate(t);
    expect(seq.version).toBe(1);
    expect(seq.templateSlug).toBe("industrial_premium_es");
    expect(seq.steps).toHaveLength(t.steps.length);
    expect(seq.steps.map((s) => s.index)).toEqual([1, 2, 3]);
    // Los steps son objetos planos (mutables), no readonly del template.
    expect(seq.steps[0].subject).toBe(t.steps[0].subject);
  });

  it("no muta el template", () => {
    const t = getIcpBySlug("industrial_premium_es")!;
    const originalStepCount = t.steps.length;
    sequenceFromTemplate(t);
    expect(t.steps).toHaveLength(originalStepCount);
  });
});

describe("sequenceFromSlug", () => {
  it("devuelve un sequence completo para un slug conocido", () => {
    const seq = sequenceFromSlug("industrial_premium_es");
    expect(seq).not.toBeNull();
    expect(seq!.templateSlug).toBe("industrial_premium_es");
    expect(seq!.steps.length).toBeGreaterThan(0);
  });

  it("devuelve null si el slug no existe", () => {
    expect(sequenceFromSlug("no_existe")).toBeNull();
  });
});

describe("sequenceSchema", () => {
  const validStep = {
    index: 1,
    delayDays: 0,
    subject: "Hola {{firstName}}",
    bodyHtml: "<p>{{firstName}}, texto de prueba.</p>",
  };

  it("acepta un sequence válido", () => {
    const r = sequenceSchema.safeParse({
      version: 1,
      templateSlug: "industrial_premium_es",
      steps: [validStep],
    });
    expect(r.success).toBe(true);
  });

  it("rechaza version distinta de 1", () => {
    const r = sequenceSchema.safeParse({
      version: 2,
      templateSlug: "x",
      steps: [validStep],
    });
    expect(r.success).toBe(false);
  });

  it("rechaza templateSlug vacío", () => {
    const r = sequenceSchema.safeParse({
      version: 1,
      templateSlug: "",
      steps: [validStep],
    });
    expect(r.success).toBe(false);
  });

  it("rechaza steps vacío", () => {
    const r = sequenceSchema.safeParse({
      version: 1,
      templateSlug: "x",
      steps: [],
    });
    expect(r.success).toBe(false);
  });

  it("rechaza subject con variable no permitida", () => {
    const r = sequenceSchema.safeParse({
      version: 1,
      templateSlug: "x",
      steps: [{ ...validStep, subject: "Hola {{invented}}" }],
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      const messages = r.error.issues.map((i) => i.message).join(" | ");
      expect(messages).toMatch(/invented/);
    }
  });

  it("rechaza bodyHtml con variable no permitida", () => {
    const r = sequenceSchema.safeParse({
      version: 1,
      templateSlug: "x",
      steps: [{ ...validStep, bodyHtml: "<p>{{whatever}}</p>" }],
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      const messages = r.error.issues.map((i) => i.message).join(" | ");
      expect(messages).toMatch(/whatever/);
    }
  });

  it("rechaza delayDays negativo", () => {
    const r = sequenceSchema.safeParse({
      version: 1,
      templateSlug: "x",
      steps: [{ ...validStep, delayDays: -1 }],
    });
    expect(r.success).toBe(false);
  });

  it("rechaza index 0 (positivo estricto)", () => {
    const r = sequenceSchema.safeParse({
      version: 1,
      templateSlug: "x",
      steps: [{ ...validStep, index: 0 }],
    });
    expect(r.success).toBe(false);
  });

  it("rechaza subject vacío", () => {
    const r = sequenceSchema.safeParse({
      version: 1,
      templateSlug: "x",
      steps: [{ ...validStep, subject: "" }],
    });
    expect(r.success).toBe(false);
  });

  it("acepta un sequence sacado de un template real (round-trip)", () => {
    const seq = sequenceFromSlug("industrial_premium_es");
    expect(seq).not.toBeNull();
    const r = sequenceSchema.safeParse(seq);
    expect(r.success).toBe(true);
  });
});
