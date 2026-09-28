import { describe, expect, it } from "vitest";
import {
  applyFieldGate,
  guardOpenerContent,
  parseLexResponse,
  sanitizeOpenerStyle,
} from "@/lib/lex/response";

describe("parseLexResponse", () => {
  it("parsea un JSON limpio", () => {
    const raw = JSON.stringify({
      opener: "Hola, vi vuestro sitio.",
      personalization: "personalized",
      fields_used: ["company", "website_summary"],
      reason_if_generic: null,
    });
    const r = parseLexResponse(raw);
    expect(r.personalization).toBe("personalized");
    expect(r.opener).toBe("Hola, vi vuestro sitio.");
    expect(r.fields_used).toEqual(["company", "website_summary"]);
  });

  it("tolera fences markdown ```json ... ```", () => {
    const raw = "```json\n" +
      JSON.stringify({
        opener: "x",
        personalization: "personalized",
        fields_used: ["company"],
        company_display: null,
        reason_if_generic: null,
      }) +
      "\n```";
    const r = parseLexResponse(raw);
    expect(r.personalization).toBe("personalized");
    expect(r.opener).toBe("x");
  });

  it("tolera texto antes y después del JSON", () => {
    const raw = "Claro, aquí tienes:\n" +
      JSON.stringify({
        opener: "x",
        personalization: "personalized",
        fields_used: ["company"],
        company_display: null,
        reason_if_generic: null,
      }) +
      "\n\nEspero que sirva.";
    const r = parseLexResponse(raw);
    expect(r.opener).toBe("x");
  });

  it("degrada a generic con parse_failed_no_json si no hay { }", () => {
    const r = parseLexResponse("solo texto sin json");
    expect(r.personalization).toBe("generic");
    expect(r.reason_if_generic).toBe("parse_failed_no_json");
  });

  it("degrada a generic con parse_failed_invalid_json si el JSON no parsea", () => {
    const r = parseLexResponse("{ not json }");
    expect(r.personalization).toBe("generic");
    expect(r.reason_if_generic).toMatch(/parse_failed_invalid_json/);
  });

  it("degrada a generic si el schema no valida (personalization inventado)", () => {
    const raw = JSON.stringify({
      opener: "x",
      personalization: "maybe",
      fields_used: [],
      reason_if_generic: null,
    });
    const r = parseLexResponse(raw);
    expect(r.personalization).toBe("generic");
    expect(r.reason_if_generic).toMatch(/parse_failed_schema/);
  });

  it("acepta directamente respuesta generic válida", () => {
    const raw = JSON.stringify({
      opener: "",
      personalization: "generic",
      fields_used: [],
      reason_if_generic: "no_signal",
    });
    const r = parseLexResponse(raw);
    expect(r.personalization).toBe("generic");
    expect(r.reason_if_generic).toBe("no_signal");
  });
});

describe("sanitizeOpenerStyle — reglas de estilo NO confiadas al prompt", () => {
  it("fixture real del smoke T022: opener de Jose Perez con em-dash → coma", () => {
    // Caso real que motivó el sanitizer: pese a la regla 8 del prompt,
    // Haiku metió un guion largo. Verificamos que el output post-sanitizer
    // no lo lleva y que la coma preserva la lectura.
    const raw =
      "Vi que en Product Hackers diseñan sistemas de crecimiento conectando datos, tecnología y negocio — no optimizan métricas aisladas sino impacto real.";
    const clean = sanitizeOpenerStyle(raw);
    expect(clean).toBe(
      "Vi que en Product Hackers diseñan sistemas de crecimiento conectando datos, tecnología y negocio, no optimizan métricas aisladas sino impacto real.",
    );
    expect(clean).not.toContain("—");
    expect(clean).not.toContain("–");
  });

  it("em-dash seguido de mayúscula → punto + espacio (nueva frase)", () => {
    expect(sanitizeOpenerStyle("Producto premium — Fabricantes desde 1980")).toBe(
      "Producto premium. Fabricantes desde 1980",
    );
    // También si le sigue una vocal acentuada mayúscula.
    expect(sanitizeOpenerStyle("Interesante — Álvaro dijo eso")).toBe(
      "Interesante. Álvaro dijo eso",
    );
  });

  it("en-dash (–) también se trata como em-dash", () => {
    expect(sanitizeOpenerStyle("primera parte – segunda parte")).toBe(
      "primera parte, segunda parte",
    );
  });

  it("comillas tipográficas → rectas", () => {
    expect(sanitizeOpenerStyle("Él dijo “hola” y ‘adiós’")).toBe(
      'Él dijo "hola" y \'adiós\'',
    );
  });

  it("ellipsis Unicode → tres puntos ASCII", () => {
    expect(sanitizeOpenerStyle("Vi vuestra web…")).toBe("Vi vuestra web...");
  });

  it("colapsa 2+ espacios y trimea puntas", () => {
    expect(sanitizeOpenerStyle("  hola   mundo  ")).toBe("hola mundo");
  });

  it("idempotente: un opener ya limpio no cambia", () => {
    const clean = "Vi que exportáis a Alemania y Francia.";
    expect(sanitizeOpenerStyle(clean)).toBe(clean);
  });

  it("parseLexResponse aplica el sanitizer sobre opener antes de devolver", () => {
    const raw = JSON.stringify({
      opener: "algo — Empresa X",
      personalization: "personalized",
      fields_used: ["company"],
      reason_if_generic: null,
    });
    const r = parseLexResponse(raw);
    // El sanitizer se ha aplicado: em-dash + mayúscula → punto.
    expect(r.opener).toBe("algo. Empresa X");
  });
});

describe("applyFieldGate — mecánico anti-fabricación", () => {
  const fieldMap = {
    firstName: "Alice",
    company: "Acme",
    sector: "industrial",
    website_summary: "Title: Acme\n\nDescription: valves.",
  };

  it("passthrough si personalization es generic (no verifica)", () => {
    const r = applyFieldGate(
      {
        opener: "",
        personalization: "generic",
        fields_used: ["company"], // cita algo aunque sea generic — no importa
        company_display: null,
        reason_if_generic: "x",
      },
      fieldMap,
    );
    expect(r.personalization).toBe("generic");
  });

  it("passthrough si cada fields_used citado existe con valor no vacío", () => {
    const r = applyFieldGate(
      {
        opener: "Vi que Acme fabrica válvulas.",
        personalization: "personalized",
        fields_used: ["company", "website_summary"],
        company_display: null,
        reason_if_generic: null,
      },
      fieldMap,
    );
    expect(r.personalization).toBe("personalized");
    expect(r.opener).toBe("Vi que Acme fabrica válvulas.");
  });

  it("DEGRADA si cita un campo que no está en el mapa", () => {
    const r = applyFieldGate(
      {
        opener: "Vi que sois de Valencia.",
        personalization: "personalized",
        fields_used: ["city"], // no está en fieldMap
        company_display: null,
        reason_if_generic: null,
      },
      fieldMap,
    );
    expect(r.personalization).toBe("generic");
    expect(r.reason_if_generic).toBe("cited_empty_field: city");
    expect(r.opener).toBe("");
  });

  it("DEGRADA si cita un campo que está en el mapa pero vacío (defensivo)", () => {
    const partial = { ...fieldMap, city: "" };
    const r = applyFieldGate(
      {
        opener: "x",
        personalization: "personalized",
        fields_used: ["city"],
        company_display: null,
        reason_if_generic: null,
      },
      partial,
    );
    expect(r.personalization).toBe("generic");
    expect(r.reason_if_generic).toMatch(/cited_empty_field: city/);
  });

  it("DEGRADA si personalized pero opener vacío", () => {
    const r = applyFieldGate(
      {
        opener: "   ",
        personalization: "personalized",
        fields_used: ["company"],
        company_display: null,
        reason_if_generic: null,
      },
      fieldMap,
    );
    expect(r.personalization).toBe("generic");
    expect(r.reason_if_generic).toBe("personalized_but_empty_opener");
  });

  it("DEGRADA si opener supera 400 caracteres", () => {
    const long = "a".repeat(401);
    const r = applyFieldGate(
      {
        opener: long,
        personalization: "personalized",
        fields_used: ["company"],
        company_display: null,
        reason_if_generic: null,
      },
      fieldMap,
    );
    expect(r.personalization).toBe("generic");
    expect(r.reason_if_generic).toBe("opener_too_long");
  });

  it("DEGRADA si personalized sin ningún campo citado", () => {
    const r = applyFieldGate(
      {
        opener: "x",
        personalization: "personalized",
        fields_used: [],
        company_display: null,
        reason_if_generic: null,
      },
      fieldMap,
    );
    expect(r.personalization).toBe("generic");
    expect(r.reason_if_generic).toBe("personalized_without_fields_used");
  });
});

// ============================================================
// T024 (2026-09-28 eval smoke): guard determinista del contenido
// del opener. Casos reales extraídos de los 16 openers con
// "segunda cláusula que pisa el cuerpo" del CSV eval.
// ============================================================

describe("guardOpenerContent — recorte de segunda cláusula (T024)", () => {
  it("opener limpio sin patrones prohibidos → devuelve tal cual, no trimmed", () => {
    const clean =
      "Veo que en Intarcon diseñáis unidades de refrigeración industrial autoportantes.";
    const r = guardOpenerContent(clean);
    expect(r.rejected).toBe(false);
    if (!r.rejected) {
      expect(r.opener).toBe(clean);
      expect(r.trimmed).toBe(false);
    }
  });

  it("REGRESIÓN Palinox: 'imagino' + 'web' tras ';' → recorta a la primera oración", () => {
    // Opener real capturado del smoke: contiene "imagino" tras ";"
    // que "pisa el cuerpo". Recorte al ";" deja la primera cláusula
    // limpia y > 60 chars.
    const real =
      "Veo que en Palinox diseñáis túneles de congelación industrial especializados en pescado y marisco desde hace más de 40 años; imagino que vuestra web actual no refleja toda la complejidad de vuestro catálogo de máquinas.";
    const r = guardOpenerContent(real);
    expect(r.rejected).toBe(false);
    if (!r.rejected) {
      expect(r.opener).toBe(
        "Veo que en Palinox diseñáis túneles de congelación industrial especializados en pescado y marisco desde hace más de 40 años;",
      );
      expect(r.trimmed).toBe(true);
    }
  });

  it("REGRESIÓN Fluytec: '?' + pregunta tras '.' → recorta a la primera oración", () => {
    const real =
      "Veo que en Fluytec diseñáis sistemas de desalinización y tratamiento de agua a medida para sectores industriales específicos. ¿cómo gestionáis hoy la captación de proyectos nuevos en vuestros mercados clave?";
    const r = guardOpenerContent(real);
    expect(r.rejected).toBe(false);
    if (!r.rejected) {
      expect(r.opener).toBe(
        "Veo que en Fluytec diseñáis sistemas de desalinización y tratamiento de agua a medida para sectores industriales específicos.",
      );
      expect(r.trimmed).toBe(true);
    }
  });

  it("REGRESIÓN Senttix: 'requiere' + 'web' sin '.' ni ';' → sin dónde recortar, rejected", () => {
    // El opener real no tiene punto ni punto-y-coma antes de la
    // segunda cláusula con "requiere" y "web". El guard no puede
    // recortar limpio → rejected → fallback.
    const real =
      "Veo que en Senttix apostáis por colchones de alta gama con un enfoque en sostenibilidad y materiales naturales, ese posicionamiento premium en un sector tan competitivo requiere una web que comunique esa diferencia.";
    const r = guardOpenerContent(real);
    expect(r.rejected).toBe(true);
    if (r.rejected) {
      expect(r.reason).toContain("opener_rejected_by_guard");
    }
  });

  it("< 60 chars tras el recorte → rejected", () => {
    const short = "Veo que trabajáis con ? algo mal aquí.";
    const r = guardOpenerContent(short);
    expect(r.rejected).toBe(true);
    if (r.rejected) {
      expect(r.reason).toContain("too_short_after_trim");
    }
  });

  it("cada palabra prohibida por separado dispara el guard", () => {
    const cases = [
      "Vi vuestra web y me pareció mejorable en algunos apartados obvios.",
      "Tenéis un problema de visibilidad claro que se puede resolver en poco tiempo.",
      "Imagino que estáis buscando renovar la marca con un enfoque nuevo y actual ahora.",
      "El posicionamiento premium requiere presencia digital coherente y bien construida.",
      "Vuestro producto debe ser más visible en canales digitales de forma continuada.",
      "Me preguntaba si estáis abiertos a mejorar la experiencia digital de vuestra marca.",
      "Me gustaría mostrar cómo otras marcas del sector han renovado su presencia digital.",
      "Me interesa saber cómo trabajáis la parte digital de vuestro negocio a día de hoy.",
    ];
    for (const c of cases) {
      const r = guardOpenerContent(c);
      // Todos son "oración única con prohibido" → tras recorte sigue
      // conteniendo el prohibido → rejected.
      expect(r.rejected, `caso: ${c.slice(0, 40)}...`).toBe(true);
    }
  });

  it("interrogación tanto '?' como '¿' cuentan como prohibidas", () => {
    const q1 =
      "Veo que fabricáis maquinaria industrial premium para sectores muy exigentes en Europa.¿algún proyecto reciente que os interese destacar?";
    const q2 =
      "Veo que fabricáis maquinaria industrial premium para sectores muy exigentes en Europa. algún proyecto reciente que os interese destacar?";
    // Ambos: recorte en "." → primera oración sin prohibido → OK.
    for (const q of [q1, q2]) {
      const r = guardOpenerContent(q);
      expect(r.rejected).toBe(false);
      if (!r.rejected) {
        expect(r.opener.startsWith("Veo que fabricáis")).toBe(true);
        expect(r.opener).not.toContain("?");
        expect(r.opener).not.toContain("¿");
      }
    }
  });

  it("parseLexResponse integra el guard: opener con prohibido tras ';' se recorta", () => {
    const raw = JSON.stringify({
      opener:
        "Veo que en Palinox diseñáis túneles de congelación industrial especializados en pescado y marisco desde hace más de 40 años; imagino que vuestra web actual no refleja toda la complejidad de vuestro catálogo de máquinas.",
      personalization: "personalized",
      fields_used: ["company", "website_summary"],
      company_display: "Palinox",
      reason_if_generic: null,
    });
    const r = parseLexResponse(raw);
    expect(r.personalization).toBe("personalized");
    expect(r.opener).toContain("Palinox diseñáis túneles");
    expect(r.opener).not.toContain("imagino");
    expect(r.opener).not.toContain("web");
  });

  it("parseLexResponse integra el guard: opener sin dónde recortar → degrade a generic", () => {
    const raw = JSON.stringify({
      opener:
        "Veo que en Senttix apostáis por colchones de alta gama con un enfoque en sostenibilidad y materiales naturales, ese posicionamiento premium en un sector tan competitivo requiere una web que comunique esa diferencia.",
      personalization: "personalized",
      fields_used: ["company", "website_summary"],
      company_display: "Senttix",
      reason_if_generic: null,
    });
    const r = parseLexResponse(raw);
    expect(r.personalization).toBe("generic");
    expect(r.opener).toBe("");
    expect(r.reason_if_generic).toContain("opener_rejected_by_guard");
    // company_display se preserva incluso en degrade (regla T024
    // company_display es factual, no depende del opener).
    expect(r.company_display).toBe("Senttix");
  });

  it("parseLexResponse NO aplica guard cuando personalization=generic (opener ya vacío)", () => {
    const raw = JSON.stringify({
      opener: "",
      personalization: "generic",
      fields_used: [],
      company_display: null,
      reason_if_generic: "no_signal",
    });
    const r = parseLexResponse(raw);
    expect(r.personalization).toBe("generic");
    expect(r.reason_if_generic).toBe("no_signal");
  });
});
