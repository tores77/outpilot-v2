import { describe, expect, it } from "vitest";
import {
  ALLOWED_VARIABLES,
  extractVariables,
  getIcpBySlug,
  ICPS,
  validateVariables,
} from "@/config/icps";

describe("ICPS catalog", () => {
  it("expone al menos industrial_premium_es", () => {
    const t = getIcpBySlug("industrial_premium_es");
    expect(t).not.toBeNull();
    expect(t!.name).toBe("Industrial Premium ES");
  });

  it("industrial_premium_es tiene 3 pasos con delays 0, 4, 1", () => {
    const t = getIcpBySlug("industrial_premium_es")!;
    expect(t.steps).toHaveLength(3);
    expect(t.steps.map((s) => s.delayDays)).toEqual([0, 4, 1]);
    expect(t.steps.map((s) => s.index)).toEqual([1, 2, 3]);
  });

  it("todos los pasos de todos los ICPs pasan validateVariables (subject + body)", () => {
    for (const t of ICPS) {
      for (const step of t.steps) {
        const subj = validateVariables(step.subject);
        const body = validateVariables(step.bodyHtml);
        expect(subj.ok, `${t.slug} step ${step.index} subject`).toBe(true);
        expect(body.ok, `${t.slug} step ${step.index} bodyHtml`).toBe(true);
      }
    }
  });

  it("todos los ICPs tienen openerFallback no vacío que valida variables", () => {
    for (const t of ICPS) {
      expect(t.openerFallback.length, `${t.slug}`).toBeGreaterThan(0);
      const check = validateVariables(t.openerFallback);
      expect(check.ok, `${t.slug} openerFallback`).toBe(true);
    }
  });

  it("industrial_premium_es step 1 tiene {{opener}} y NO tiene la frase original que ahora es fallback", () => {
    const t = getIcpBySlug("industrial_premium_es")!;
    const step1 = t.steps[0];
    expect(step1.bodyHtml).toContain("{{opener}}");
    // La frase que sustituimos por {{opener}} ya no debe estar dura en el body.
    expect(step1.bodyHtml).not.toContain(
      "He estado viendo {{companyName}} y se nota el nivel del producto",
    );
    // Pero SÍ debe estar en openerFallback.
    expect(t.openerFallback).toContain(
      "He estado viendo {{companyName}} y se nota el nivel del producto",
    );
  });

  it("getIcpBySlug devuelve null si el slug no existe", () => {
    expect(getIcpBySlug("no_existe")).toBeNull();
    expect(getIcpBySlug("")).toBeNull();
  });
});

describe("extractVariables", () => {
  it("devuelve [] cuando no hay variables", () => {
    expect(extractVariables("hola mundo")).toEqual([]);
    expect(extractVariables("")).toEqual([]);
  });

  it("captura una variable simple", () => {
    expect(extractVariables("Hola {{firstName}}")).toEqual(["firstName"]);
  });

  it("captura múltiples variables en orden de aparición", () => {
    expect(
      extractVariables("{{firstName}} de {{companyName}} — cc: {{lastName}}"),
    ).toEqual(["firstName", "companyName", "lastName"]);
  });

  it("dedupe: cada variable aparece una vez aunque se repita", () => {
    expect(
      extractVariables("{{firstName}} y otra vez {{firstName}} y {{companyName}}"),
    ).toEqual(["firstName", "companyName"]);
  });

  it("tolera espacios dentro de las llaves", () => {
    expect(extractVariables("{{ firstName }} y {{  companyName  }}")).toEqual([
      "firstName",
      "companyName",
    ]);
  });

  it("ignora patrones que no son {{identifier}}", () => {
    expect(extractVariables("{{123}} y {{}} y {{ some space}}")).toEqual([]);
  });
});

describe("validateVariables", () => {
  it("ok cuando todas las variables están en ALLOWED_VARIABLES", () => {
    for (const v of ALLOWED_VARIABLES) {
      expect(validateVariables(`texto con {{${v}}}`)).toEqual({ ok: true });
    }
  });

  it("ok cuando no hay variables", () => {
    expect(validateVariables("solo texto")).toEqual({ ok: true });
  });

  it("rechaza una variable desconocida y la reporta", () => {
    const r = validateVariables("Hola {{unknownVar}}");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.unknownVariables).toEqual(["unknownVar"]);
  });

  it("mezcla: permitidas ok, desconocidas reportadas", () => {
    const r = validateVariables(
      "{{firstName}} y {{invented}} y {{companyName}} y {{other}}",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.unknownVariables).toEqual(["invented", "other"]);
  });

  it("mismo unknown repetido cuenta una vez", () => {
    const r = validateVariables("{{invented}} y {{invented}}");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.unknownVariables).toEqual(["invented"]);
  });
});
