import { describe, expect, it } from "vitest";
import { applyFieldGate, parseLexResponse } from "@/lib/lex/response";

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
        reason_if_generic: null,
      },
      fieldMap,
    );
    expect(r.personalization).toBe("generic");
    expect(r.reason_if_generic).toBe("personalized_without_fields_used");
  });
});
