import { describe, expect, it } from "vitest";
import {
  buildLeadFieldMap,
  buildUserPrompt,
  LEX_SYSTEM_PROMPT,
  type LeadForLex,
} from "@/lib/lex/prompt";

const fullLead: LeadForLex = {
  firstName: "Alice",
  lastName: "Example",
  company: "Acme Industrial",
  title: "Directora de Exportación",
  sector: "industrial",
  country: "ES",
  city: "Valencia",
  website: "https://acme.example",
  linkedin: "https://linkedin.com/in/alice-example",
  websiteSummary: {
    url: "https://acme.example",
    status: "ok",
    summary: "Title: Acme Industrial\n\nDescription: Fabricantes de válvulas.",
    fetched_at: "2026-09-23T10:00:00Z",
  },
};

describe("LEX_SYSTEM_PROMPT", () => {
  it("empieza con las reglas anti-fabricación (indice 1 antes de todo)", () => {
    // La primera regla debe aparecer antes que cualquier ejemplo o
    // formato — patrón Nova.
    const idxRules = LEX_SYSTEM_PROMPT.indexOf("REGLAS DE FABRICACIÓN");
    const idxFormat = LEX_SYSTEM_PROMPT.indexOf("FORMATO DE RESPUESTA");
    expect(idxRules).toBeGreaterThan(0);
    expect(idxFormat).toBeGreaterThan(idxRules);
  });

  it("prohíbe explícitamente hablar de la web sin website_summary", () => {
    expect(LEX_SYSTEM_PROMPT).toMatch(/website_summary/);
    expect(LEX_SYSTEM_PROMPT).toMatch(/web del lead/);
    expect(LEX_SYSTEM_PROMPT).toMatch(/Sin website_summary/);
  });

  it("prohíbe duplicar datos que ya menciona la plantilla", () => {
    expect(LEX_SYSTEM_PROMPT).toMatch(/plantilla/i);
    expect(LEX_SYSTEM_PROMPT).toMatch(/no duplicar|no repit/i);
  });

  it("obliga a citar fields_used con nombres canónicos", () => {
    expect(LEX_SYSTEM_PROMPT).toMatch(/fields_used/);
    expect(LEX_SYSTEM_PROMPT).toMatch(/firstName/);
    expect(LEX_SYSTEM_PROMPT).toMatch(/companyName|company/);
  });
});

describe("buildLeadFieldMap", () => {
  it("incluye solo los campos con valor no vacío", () => {
    const map = buildLeadFieldMap({
      firstName: "Alice",
      lastName: "",
      company: null,
      title: undefined,
      sector: "industrial",
    });
    expect(map).toEqual({
      firstName: "Alice",
      sector: "industrial",
    });
  });

  it("trimea whitespace y descarta strings vacíos tras trim", () => {
    const map = buildLeadFieldMap({
      firstName: "  Alice  ",
      lastName: "   ",
    });
    expect(map.firstName).toBe("Alice");
    expect(map).not.toHaveProperty("lastName");
  });

  it("incluye website_summary SOLO si status === ok y summary no vacío", () => {
    const withOk = buildLeadFieldMap(fullLead);
    expect(withOk).toHaveProperty("website_summary");

    const withTimeout = buildLeadFieldMap({
      ...fullLead,
      websiteSummary: {
        url: "https://x",
        status: "timeout",
        summary: "",
        fetched_at: "2026-09-23T10:00:00Z",
      },
    });
    expect(withTimeout).not.toHaveProperty("website_summary");

    const withEmpty = buildLeadFieldMap({
      ...fullLead,
      websiteSummary: {
        url: "https://x",
        status: "ok",
        summary: "   ",
        fetched_at: "2026-09-23T10:00:00Z",
      },
    });
    expect(withEmpty).not.toHaveProperty("website_summary");
  });

  it("mapa vacío si el lead no trae nada", () => {
    expect(buildLeadFieldMap({})).toEqual({});
  });
});

describe("buildUserPrompt", () => {
  it("contiene JSON válido con la sección lead", () => {
    const prompt = buildUserPrompt(fullLead);
    expect(prompt).toContain("Lead:");
    const match = prompt.match(/\{[\s\S]*\}/);
    expect(match).not.toBeNull();
    const parsed = JSON.parse(match![0]);
    expect(parsed.lead.firstName).toBe("Alice");
    expect(parsed.lead.company).toBe("Acme Industrial");
    expect(parsed.lead.website_summary).toBeDefined();
  });

  it("no incluye campos ausentes o vacíos en el JSON", () => {
    const prompt = buildUserPrompt({ firstName: "Alice", lastName: "" });
    const match = prompt.match(/\{[\s\S]*\}/)!;
    const parsed = JSON.parse(match[0]);
    expect(parsed.lead).toEqual({ firstName: "Alice" });
  });
});
