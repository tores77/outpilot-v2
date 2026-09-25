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

  it("copia openerFallback del template al sequence", () => {
    const t = getIcpBySlug("industrial_premium_es")!;
    const seq = sequenceFromTemplate(t);
    expect(seq.openerFallback).toBe(t.openerFallback);
    expect(seq.openerFallback.length).toBeGreaterThan(0);
  });

  it("legalFooter: se copia del template a la sequence y se sustituye el marcador {{legalFooter}} en cada bodyHtml", () => {
    const t = getIcpBySlug("industrial_premium_es")!;
    const seq = sequenceFromTemplate(t);
    // El template industrial_premium_es lleva legalFooter (T024).
    expect(seq.legalFooter).toBeDefined();
    expect(seq.legalFooter).toBe(t.legalFooter);
    // Y todos los bodyHtml quedan sin el marcador (ya resueltos).
    for (const step of seq.steps) {
      expect(step.bodyHtml).not.toMatch(/\{\{\s*legalFooter\s*\}\}/);
    }
  });

  it("legalFooter: si el template NO lo lleva, el marcador se sustituye por '' y la key no aparece en el sequence", () => {
    const t = getIcpBySlug("industrial_premium_es")!;
    const { legalFooter: _drop, ...noFooterTpl } = t;
    void _drop;
    const seq = sequenceFromTemplate({
      ...noFooterTpl,
      // Marcador crudo en un step para verificar el reemplazo por ''.
      steps: [
        {
          index: 1,
          delayDays: 0,
          subject: "hola",
          bodyHtml: "<p>body</p>\n{{legalFooter}}",
        },
      ],
    });
    expect(seq.legalFooter).toBeUndefined();
    expect("legalFooter" in seq).toBe(false);
    expect(seq.steps[0].bodyHtml).toBe("<p>body</p>\n");
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

  const baseValid = {
    version: 1 as const,
    templateSlug: "industrial_premium_es",
    channel: "email_cold" as const,
    openerFallback: "Fallback con {{companyName}} dentro.",
    legalFooter: "<p>Umania Labs SL · dirección · unsub</p>",
    steps: [validStep],
  };

  it("acepta un sequence válido", () => {
    const r = sequenceSchema.safeParse(baseValid);
    expect(r.success).toBe(true);
  });

  it("rechaza version distinta de 1", () => {
    const r = sequenceSchema.safeParse({ ...baseValid, version: 2 });
    expect(r.success).toBe(false);
  });

  it("rechaza templateSlug vacío", () => {
    const r = sequenceSchema.safeParse({ ...baseValid, templateSlug: "" });
    expect(r.success).toBe(false);
  });

  it("rechaza openerFallback vacío", () => {
    const r = sequenceSchema.safeParse({ ...baseValid, openerFallback: "" });
    expect(r.success).toBe(false);
  });

  it("rechaza openerFallback con variable no permitida", () => {
    const r = sequenceSchema.safeParse({
      ...baseValid,
      openerFallback: "Texto con {{invented}}",
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      const messages = r.error.issues.map((i) => i.message).join(" | ");
      expect(messages).toMatch(/invented/);
    }
  });

  it("rechaza steps vacío", () => {
    const r = sequenceSchema.safeParse({ ...baseValid, steps: [] });
    expect(r.success).toBe(false);
  });

  it("rechaza subject con variable no permitida", () => {
    const r = sequenceSchema.safeParse({
      ...baseValid,
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
      ...baseValid,
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
      ...baseValid,
      steps: [{ ...validStep, delayDays: -1 }],
    });
    expect(r.success).toBe(false);
  });

  it("rechaza index 0 (positivo estricto)", () => {
    const r = sequenceSchema.safeParse({
      ...baseValid,
      steps: [{ ...validStep, index: 0 }],
    });
    expect(r.success).toBe(false);
  });

  it("rechaza subject vacío EN EL STEP 1 (abre el hilo, obligatorio)", () => {
    const r = sequenceSchema.safeParse({
      ...baseValid,
      steps: [{ ...validStep, subject: "" }],
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      const messages = r.error.issues.map((i) => i.message).join(" | ");
      expect(messages).toMatch(/primer step requiere subject/i);
    }
  });

  it("ACEPTA subject undefined/omitido en steps 2+ (reply-thread)", () => {
    const r = sequenceSchema.safeParse({
      ...baseValid,
      steps: [
        { ...validStep, index: 1 }, // subject presente
        { index: 2, delayDays: 4, bodyHtml: "<p>{{firstName}} sigue.</p>" }, // sin subject
        { index: 3, delayDays: 1, bodyHtml: "<p>Cierro el hilo.</p>" }, // sin subject
      ],
    });
    expect(r.success).toBe(true);
  });

  it("ACEPTA subject vacío ('') en steps 2+ (equivalente a omitido)", () => {
    const r = sequenceSchema.safeParse({
      ...baseValid,
      steps: [
        { ...validStep, index: 1 },
        { index: 2, delayDays: 4, subject: "", bodyHtml: "<p>x</p>" },
      ],
    });
    expect(r.success).toBe(true);
  });

  it("channel 'email_cold' requiere legalFooter no vacío", () => {
    // Con footer → OK (baseValid ya lo trae).
    expect(sequenceSchema.safeParse(baseValid).success).toBe(true);

    // Sin footer → falla.
    const { legalFooter: _drop, ...sinFooter } = baseValid;
    void _drop;
    const rSin = sequenceSchema.safeParse(sinFooter);
    expect(rSin.success).toBe(false);
    if (!rSin.success) {
      const msgs = rSin.error.issues.map((i) => i.message).join(" | ");
      expect(msgs).toMatch(/legalFooter obligatorio/i);
    }

    // Footer vacío → falla (min(1) del campo + superRefine del canal).
    const rVacio = sequenceSchema.safeParse({ ...baseValid, legalFooter: "" });
    expect(rVacio.success).toBe(false);
  });

  it("channel 'email_cold' rechaza {{signature}} en subject de cualquier step", () => {
    const r = sequenceSchema.safeParse({
      ...baseValid,
      steps: [
        { ...validStep, subject: "Hola {{firstName}} {{signature}}" },
      ],
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      const msgs = r.error.issues.map((i) => i.message).join(" | ");
      expect(msgs).toMatch(/\{\{signature\}\} prohibido/i);
    }
  });

  it("channel 'email_cold' rechaza {{signature}} en bodyHtml de cualquier step", () => {
    const r = sequenceSchema.safeParse({
      ...baseValid,
      steps: [
        { ...validStep },
        {
          index: 2,
          delayDays: 4,
          bodyHtml: "<p>seguimiento</p><p>{{signature}}</p>",
        },
      ],
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      const msgs = r.error.issues.map((i) => i.message).join(" | ");
      expect(msgs).toMatch(/\{\{signature\}\} prohibido/i);
    }
  });

  it("rechaza subject en step 2+ con variable no permitida", () => {
    // Aunque sea opcional, si lo pones tiene que validar variables.
    const r = sequenceSchema.safeParse({
      ...baseValid,
      steps: [
        { ...validStep, index: 1 },
        {
          index: 2,
          delayDays: 4,
          subject: "hola {{invented}}",
          bodyHtml: "<p>x</p>",
        },
      ],
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      const messages = r.error.issues.map((i) => i.message).join(" | ");
      expect(messages).toMatch(/invented/);
    }
  });

  it("acepta un sequence sacado de un template real (round-trip)", () => {
    const seq = sequenceFromSlug("industrial_premium_es");
    expect(seq).not.toBeNull();
    const r = sequenceSchema.safeParse(seq);
    expect(r.success).toBe(true);
  });
});
