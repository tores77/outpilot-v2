import { describe, expect, it } from "vitest";
import { callLexWithGuardRetry, type CallClaudeFn } from "@/lib/lex/retry";

// Helper para construir respuestas JSON de Haiku.
function haikuResponse(fields: {
  opener?: string;
  personalization?: "personalized" | "generic";
  fields_used?: string[];
  company_display?: string | null;
  reason_if_generic?: string | null;
}): string {
  return JSON.stringify({
    opener: fields.opener ?? "",
    personalization: fields.personalization ?? "personalized",
    fields_used: fields.fields_used ?? ["company", "website_summary"],
    company_display: fields.company_display ?? null,
    reason_if_generic: fields.reason_if_generic ?? null,
  });
}

const USAGE = {
  model: "claude-haiku-4-5-20251001",
  inputTokens: 1000,
  outputTokens: 100,
  costUsd: 0.001,
};

function successCall(text: string): {
  ok: true;
  text: string;
  usage: typeof USAGE;
} {
  return { ok: true, text, usage: USAGE };
}

describe("callLexWithGuardRetry (T024)", () => {
  it("primer intento OK → devuelve attempts=1, sin retry", async () => {
    const cleanOpener =
      "Veo que en Intarcon diseñáis unidades de refrigeración industrial autoportantes.";
    const call: CallClaudeFn = async () =>
      successCall(haikuResponse({ opener: cleanOpener }));
    let callCount = 0;
    const wrapped: CallClaudeFn = async (up) => {
      callCount += 1;
      return call(up);
    };
    const r = await callLexWithGuardRetry({
      userPrompt: "Lead: ...",
      callClaudeFn: wrapped,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.attempts).toBe(1);
      expect(r.parsed.personalization).toBe("personalized");
      expect(r.parsed.opener).toBe(cleanOpener);
      expect(r.parsed.fields_used).not.toContain("opener_rejected_x2");
    }
    expect(callCount).toBe(1);
  });

  it("REGRESIÓN pedido Pere: primer intento con '?' sin dónde recortar → segundo limpio → personalized", async () => {
    // Opener con "requiere" y "web" sin "." ni ";" → rejected en
    // el 1º intento porque el guard no puede recortar limpio y
    // queda con los prohibidos.
    const rejectedWithForbidden =
      "Veo que en Senttix apostáis por colchones de alta gama con enfoque en sostenibilidad y materiales naturales, ese posicionamiento premium requiere una web coherente";
    const clean =
      "Veo que en Senttix apostáis por colchones de alta gama con enfoque en sostenibilidad y materiales naturales.";
    const responses = [
      haikuResponse({ opener: rejectedWithForbidden }),
      haikuResponse({ opener: clean }),
    ];
    let callCount = 0;
    const call: CallClaudeFn = async (up) => {
      const text = responses[callCount] ?? responses[responses.length - 1];
      callCount += 1;
      if (callCount === 2) {
        expect(up).toContain("El intento anterior fue rechazado por:");
        expect(up).toContain("Devuelve solo la observación.");
      }
      return successCall(text);
    };
    const r = await callLexWithGuardRetry({
      userPrompt: "Lead: ...",
      callClaudeFn: call,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.attempts).toBe(2);
      expect(r.parsed.personalization).toBe("personalized");
      expect(r.parsed.opener).toBe(clean);
      expect(r.parsed.fields_used).not.toContain("opener_rejected_x2");
      expect(r.usages).toHaveLength(2);
    }
    expect(callCount).toBe(2);
    // La usage total es la suma de ambos intentos (2000 in, 200 out, $0.002).
    if (r.ok) {
      const totalIn = r.usages.reduce((a, u) => a + u.inputTokens, 0);
      expect(totalIn).toBe(2000);
    }
  });

  it("REGRESIÓN pedido Pere: dos intentos rejected → fallback + fields_used incluye opener_rejected_x2", async () => {
    // Ambos intentos con prohibido sin dónde recortar → siempre rejected.
    const bad1 =
      "Veo que en X apostáis por colchones premium, esto requiere una web más coherente y visible";
    const bad2 =
      "Vuestro producto premium requiere una web más visible y coherente en canales digitales";
    const responses = [
      haikuResponse({ opener: bad1, fields_used: ["company", "sector"] }),
      haikuResponse({ opener: bad2, fields_used: ["company", "sector"] }),
    ];
    let callCount = 0;
    const call: CallClaudeFn = async () => {
      const text = responses[callCount] ?? responses[responses.length - 1];
      callCount += 1;
      return successCall(text);
    };
    const r = await callLexWithGuardRetry({
      userPrompt: "Lead: ...",
      callClaudeFn: call,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.attempts).toBe(2);
      expect(r.parsed.personalization).toBe("generic");
      expect(r.parsed.opener).toBe("");
      expect(r.parsed.fields_used).toContain("opener_rejected_x2");
      expect(r.parsed.reason_if_generic).toContain(
        "opener_rejected_by_guard",
      );
    }
    expect(callCount).toBe(2);
  });

  it("primer intento degrada a generic por OTRA razón (no guard) → NO retry", async () => {
    // parse_failed_no_json es señal distinta al guard → no reintentar.
    // (El código de retry solo dispara cuando reason empieza por
    // "opener_rejected_by_guard".)
    let callCount = 0;
    const call: CallClaudeFn = async () => {
      callCount += 1;
      return successCall("not json at all");
    };
    const r = await callLexWithGuardRetry({
      userPrompt: "Lead: ...",
      callClaudeFn: call,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.attempts).toBe(1);
      expect(r.parsed.personalization).toBe("generic");
      expect(r.parsed.reason_if_generic).toContain("parse_failed");
    }
    expect(callCount).toBe(1);
  });

  it("primer intento error de red → propaga el error, no reintenta", async () => {
    let callCount = 0;
    const call: CallClaudeFn = async () => {
      callCount += 1;
      return { ok: false, code: "anthropic_error", error: "5xx from API" };
    };
    const r = await callLexWithGuardRetry({
      userPrompt: "Lead: ...",
      callClaudeFn: call,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("anthropic_error");
      expect(r.error).toBe("5xx from API");
    }
    expect(callCount).toBe(1);
  });

  it("primer intento rejected + segundo error de red → propaga el error del segundo", async () => {
    const rejected =
      "Veo que fabricáis maquinaria premium para sectores exigentes que requiere una web coherente";
    let callCount = 0;
    const call: CallClaudeFn = async () => {
      callCount += 1;
      if (callCount === 1) return successCall(haikuResponse({ opener: rejected }));
      return {
        ok: false,
        code: "anthropic_error",
        error: "timeout on retry",
      };
    };
    const r = await callLexWithGuardRetry({
      userPrompt: "Lead: ...",
      callClaudeFn: call,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe("timeout on retry");
    }
    expect(callCount).toBe(2);
  });

  it("palabras prohibidas nuevas: 'me pregunto' y 'debe de ser' disparan retry", async () => {
    const withMePregunto =
      "Veo que fabricáis maquinaria industrial para sectores exigentes, me pregunto cómo enfocáis las ferias del sector";
    const withDebeDeSer =
      "Veo que fabricáis equipamiento premium para exportación, vuestra presencia debe de ser reforzada digitalmente";
    for (const bad of [withMePregunto, withDebeDeSer]) {
      const clean =
        "Veo que fabricáis maquinaria industrial premium para sectores muy exigentes en Europa.";
      const responses = [
        haikuResponse({ opener: bad }),
        haikuResponse({ opener: clean }),
      ];
      let callCount = 0;
      const call: CallClaudeFn = async () => {
        const text = responses[callCount] ?? responses[responses.length - 1];
        callCount += 1;
        return successCall(text);
      };
      const r = await callLexWithGuardRetry({
        userPrompt: "Lead: ...",
        callClaudeFn: call,
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.attempts).toBe(2);
        expect(r.parsed.personalization).toBe("personalized");
      }
    }
  });
});
