import { describe, expect, it } from "vitest";
import {
  buildAddLeadPersonalization,
  resolveOpener,
  shareAnyCompanyWord,
  substituteLeadVars,
  type LeadForOpener,
} from "@/lib/volt/opener";

const LEAD_JOSE: LeadForOpener = {
  first_name: "Jose",
  last_name: "Perez",
  company: "Product hackers",
};

const LEAD_ANA: LeadForOpener = {
  first_name: "Ana",
  last_name: "García",
  company: "Acme S.L.",
};

const OPENER_FALLBACK =
  "He estado viendo {{companyName}} y se nota el nivel del producto que tenéis. Cuando uno compite con italianos y franceses en vuestra categoría, eso solo se consigue con años de oficio detrás.";

describe("substituteLeadVars", () => {
  it("sustituye {{firstName}}, {{lastName}}, {{companyName}} con valores literales de BD", () => {
    const text = "Hola {{firstName}} {{lastName}} de {{companyName}}";
    expect(substituteLeadVars(text, LEAD_JOSE)).toBe(
      "Hola Jose Perez de Product hackers",
    );
  });

  it("deja {{signature}} y {{opener}} intactos (los expande Lemlist / fail-safe)", () => {
    const text = "{{firstName}} — {{opener}} — {{signature}}";
    expect(substituteLeadVars(text, LEAD_JOSE)).toBe(
      "Jose — {{opener}} — {{signature}}",
    );
  });

  it("no toca variables desconocidas (defensivo)", () => {
    expect(substituteLeadVars("hola {{invented}}", LEAD_JOSE)).toBe(
      "hola {{invented}}",
    );
  });

  it("company null → string vacío (SIN 'vuestra empresa'; instrucción explícita del gate)", () => {
    const lead = { ...LEAD_JOSE, company: null };
    expect(substituteLeadVars("Vi {{companyName}} ayer", lead)).toBe(
      "Vi  ayer",
    );
  });

  it("first_name/last_name null → string vacío", () => {
    const lead = { first_name: null, last_name: null, company: "Acme" };
    expect(substituteLeadVars("Hola {{firstName}} {{lastName}}", lead)).toBe(
      "Hola  ",
    );
  });

  it("company literal: NO trim, NO titlecase — 'Product hackers' se queda tal cual", () => {
    // Verificación explícita de la regla del gate C.
    expect(substituteLeadVars("Vi {{companyName}}", LEAD_JOSE)).toBe(
      "Vi Product hackers",
    );
    // No lo convertimos a "Product Hackers" ni a "PRODUCT HACKERS".
  });
});

describe("resolveOpener", () => {
  it("personalized: devuelve personalization.opener literal", () => {
    const p = {
      personalization: "personalized",
      opener: "Vi que en Product Hackers diseñáis sistemas de crecimiento.",
    };
    expect(
      resolveOpener({
        personalization: p,
        openerFallback: OPENER_FALLBACK,
        lead: LEAD_JOSE,
      }),
    ).toBe("Vi que en Product Hackers diseñáis sistemas de crecimiento.");
  });

  it("generic: devuelve openerFallback con {{companyName}} sustituido", () => {
    const p = {
      personalization: "generic",
      opener: "",
      reason_if_generic: "no signal",
    };
    const result = resolveOpener({
      personalization: p,
      openerFallback: OPENER_FALLBACK,
      lead: LEAD_ANA,
    });
    expect(result).toContain("Acme S.L.");
    expect(result).not.toContain("{{companyName}}");
    // El resto del fallback (competencia italiana/francesa) intacto.
    expect(result).toContain("italianos y franceses");
  });

  it("throws si personalization no es un objeto", () => {
    expect(() =>
      resolveOpener({
        personalization: null,
        openerFallback: OPENER_FALLBACK,
        lead: LEAD_JOSE,
      }),
    ).toThrow(/no es un objeto/);
    expect(() =>
      resolveOpener({
        personalization: "personalized" as unknown,
        openerFallback: OPENER_FALLBACK,
        lead: LEAD_JOSE,
      }),
    ).toThrow(/no es un objeto/);
  });

  it("throws si personalized pero opener vacío (Lex debería haber degradado)", () => {
    const p = { personalization: "personalized", opener: "   " };
    expect(() =>
      resolveOpener({
        personalization: p,
        openerFallback: OPENER_FALLBACK,
        lead: LEAD_JOSE,
      }),
    ).toThrow(/opener vacío/);
  });

  it("throws si personalization tiene un valor desconocido", () => {
    const p = { personalization: "maybe", opener: "x" };
    expect(() =>
      resolveOpener({
        personalization: p,
        openerFallback: OPENER_FALLBACK,
        lead: LEAD_JOSE,
      }),
    ).toThrow(/desconocido/);
  });

  it("throws si personalization es el claim de Lex ({state:'processing'})", () => {
    // Volt debe filtrar antes de llegar aquí; test defensivo.
    const p = { state: "processing", started_at: "2026-09-24T12:00:00.000Z" };
    expect(() =>
      resolveOpener({
        personalization: p,
        openerFallback: OPENER_FALLBACK,
        lead: LEAD_JOSE,
      }),
    ).toThrow(/desconocido/);
  });
});

describe("buildAddLeadPersonalization", () => {
  it("compone map completo para Jose (personalized)", () => {
    const p = {
      personalization: "personalized",
      opener: "Vi que en Product Hackers diseñáis sistemas de crecimiento.",
    };
    const { map } = buildAddLeadPersonalization({
      personalization: p,
      openerFallback: OPENER_FALLBACK,
      lead: LEAD_JOSE,
    });
    expect(map).toEqual({
      firstName: "Jose",
      lastName: "Perez",
      companyName: "Product hackers",
      opener: "Vi que en Product Hackers diseñáis sistemas de crecimiento.",
    });
  });

  it("compone map completo para Ana (generic con fallback resuelto)", () => {
    const p = {
      personalization: "generic",
      opener: "",
      reason_if_generic: "no signal",
    };
    const { map } = buildAddLeadPersonalization({
      personalization: p,
      openerFallback: OPENER_FALLBACK,
      lead: LEAD_ANA,
    });
    expect(map.firstName).toBe("Ana");
    expect(map.lastName).toBe("García");
    expect(map.companyName).toBe("Acme S.L.");
    expect(map.opener).toContain("Acme S.L.");
    expect(map.opener).not.toContain("{{companyName}}");
    // {{signature}} se deja para que Lemlist lo expanda (aunque
    // openerFallback estándar no lo lleva).
  });

  it("T024 company_display: si Lex lo devuelve, gana sobre lead.company (Vibe suele darlo en MAYÚSCULAS)", () => {
    const p = {
      personalization: "personalized",
      opener: "Vi que Metales del Sur fabrica válvulas.",
      company_display: "Metales del Sur",
    };
    const { map } = buildAddLeadPersonalization({
      personalization: p,
      openerFallback: OPENER_FALLBACK,
      lead: {
        first_name: "Pepe",
        last_name: "López",
        // Company en la BD viene en TODO MAYÚSCULAS de Vibe.
        company: "METALES DEL SUR S.L.",
      },
    });
    expect(map.companyName).toBe("Metales del Sur");
  });

  it("T024 company_display: null/undefined → fallback a lead.company (compat con v1 payloads)", () => {
    // Sin company_display en el payload (v1).
    const p = {
      personalization: "personalized",
      opener: "algo",
    };
    const { map } = buildAddLeadPersonalization({
      personalization: p,
      openerFallback: OPENER_FALLBACK,
      lead: {
        first_name: "X",
        last_name: "Y",
        company: "ACME S.L.",
      },
    });
    expect(map.companyName).toBe("ACME S.L.");
  });

  it("T024 company_display: string vacío o blank NO gana (fallback a lead.company)", () => {
    const p = {
      personalization: "personalized",
      opener: "algo",
      company_display: "   ",
    };
    const { map } = buildAddLeadPersonalization({
      personalization: p,
      openerFallback: OPENER_FALLBACK,
      lead: {
        first_name: "X",
        last_name: "Y",
        company: "ACME",
      },
    });
    expect(map.companyName).toBe("ACME");
  });

  it("T024 guard shareAnyCompanyWord: company_display sin ninguna palabra en común con lead.company → descartado", () => {
    // Lex scrapea la web equivocada (dominio caducado, redirección, etc.)
    // y devuelve un nombre que no tiene NADA que ver con la empresa.
    const p = {
      personalization: "personalized",
      opener: "algo",
      company_display: "Acme Studio",
    };
    const { map } = buildAddLeadPersonalization({
      personalization: p,
      openerFallback: OPENER_FALLBACK,
      lead: {
        first_name: "Pepe",
        last_name: "López",
        company: "METALES DEL SUR S.L.",
      },
    });
    expect(map.companyName).toBe("METALES DEL SUR S.L.");
  });

  it("T024 guard shareAnyCompanyWord: al menos una palabra en común → company_display gana", () => {
    // Caso normal: Lex re-capitaliza correctamente. "Metales del Sur"
    // comparte "metales", "del", "sur" con "METALES DEL SUR S.L.".
    const p = {
      personalization: "personalized",
      opener: "algo",
      company_display: "Metales del Sur",
    };
    const { map } = buildAddLeadPersonalization({
      personalization: p,
      openerFallback: OPENER_FALLBACK,
      lead: {
        first_name: "Pepe",
        last_name: "López",
        company: "METALES DEL SUR S.L.",
      },
    });
    expect(map.companyName).toBe("Metales del Sur");
  });

  it("T024 meta.companyDisplayRejected: true cuando el guard descarta el display", () => {
    const p = {
      personalization: "personalized",
      opener: "x",
      company_display: "Acme Studio",
    };
    const { meta } = buildAddLeadPersonalization({
      personalization: p,
      openerFallback: OPENER_FALLBACK,
      lead: {
        first_name: "Pepe",
        last_name: "López",
        company: "METALES DEL SUR S.L.",
      },
    });
    expect(meta.companyDisplayRejected).toBe(true);
  });

  it("T024 meta.companyDisplayRejected: false cuando el display encaja", () => {
    const p = {
      personalization: "personalized",
      opener: "x",
      company_display: "Metales del Sur",
    };
    const { meta } = buildAddLeadPersonalization({
      personalization: p,
      openerFallback: OPENER_FALLBACK,
      lead: {
        first_name: "Pepe",
        last_name: "López",
        company: "METALES DEL SUR S.L.",
      },
    });
    expect(meta.companyDisplayRejected).toBe(false);
  });

  it("T024 meta.companyDisplayRejected: false cuando NO hay company_display en el payload (nada que rechazar)", () => {
    const p = { personalization: "personalized", opener: "x" };
    const { meta } = buildAddLeadPersonalization({
      personalization: p,
      openerFallback: OPENER_FALLBACK,
      lead: LEAD_JOSE,
    });
    expect(meta.companyDisplayRejected).toBe(false);
  });

  it("T024 meta.companyDisplayRejected: false cuando el lead no tiene company (no hay contra qué comparar)", () => {
    const p = {
      personalization: "personalized",
      opener: "x",
      company_display: "Cualquier Cosa",
    };
    const { meta } = buildAddLeadPersonalization({
      personalization: p,
      openerFallback: OPENER_FALLBACK,
      lead: {
        first_name: "X",
        last_name: "Y",
        company: null,
      },
    });
    expect(meta.companyDisplayRejected).toBe(false);
  });
});

describe("shareAnyCompanyWord (guard T024)", () => {
  it("match exacto case-insensitive", () => {
    expect(shareAnyCompanyWord("Acme", "acme")).toBe(true);
  });

  it("match ignorando sufijos legales tipo S.L.", () => {
    expect(shareAnyCompanyWord("Metales del Sur", "METALES DEL SUR S.L.")).toBe(
      true,
    );
  });

  it("match ignorando diacríticos", () => {
    expect(shareAnyCompanyWord("Álava Química", "alava")).toBe(true);
    expect(shareAnyCompanyWord("Cañón Prensados", "canon prensados sl")).toBe(
      true,
    );
  });

  it("no match: nombres distintos sin overlap", () => {
    expect(shareAnyCompanyWord("Acme Studio", "Metales del Sur")).toBe(false);
    expect(shareAnyCompanyWord("Nova Corp", "Zenith Foods")).toBe(false);
  });

  it("no match: solo tokens < 3 chars en común (S, L, y)", () => {
    // "S.L." vs "S.A." — ambos generan solo tokens < 3, que se filtran.
    // El shareAnyCompanyWord devuelve false porque no queda ningún token
    // significativo que comparar.
    expect(shareAnyCompanyWord("S.L.", "S.A.")).toBe(false);
  });

  it("no match: string vacío o solo puntuación", () => {
    expect(shareAnyCompanyWord("", "acme")).toBe(false);
    expect(shareAnyCompanyWord("acme", "")).toBe(false);
    expect(shareAnyCompanyWord("...", "acme")).toBe(false);
  });

  it("match con palabras cortas significativas (>=3 chars)", () => {
    // "Sur" (3) se conserva; "Del" (3) también.
    expect(shareAnyCompanyWord("Grupo Sur", "Sur Inc")).toBe(true);
  });
});
