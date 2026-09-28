import { describe, expect, it } from "vitest";
import {
  classifyForRepersonalize,
  isFlaggedForRepersonalize,
} from "@/lib/lex/repersonalize-criteria";

describe("classifyForRepersonalize (T024 fix repersonalize --only-flagged)", () => {
  it("personalization=null → unpersonalized (NO flagged)", () => {
    const c = classifyForRepersonalize(null);
    expect(c.kind).toBe("unpersonalized");
    expect(isFlaggedForRepersonalize(c)).toBe(false);
  });

  it("personalization=undefined → unpersonalized", () => {
    const c = classifyForRepersonalize(undefined);
    expect(c.kind).toBe("unpersonalized");
    expect(isFlaggedForRepersonalize(c)).toBe(false);
  });

  it("personalization=generic con reason='no_signal' → generic (flagged)", () => {
    const c = classifyForRepersonalize({
      personalization: "generic",
      reason_if_generic: "no_signal",
    });
    expect(c.kind).toBe("generic");
    expect(c.reason).toBe("no_signal");
    expect(isFlaggedForRepersonalize(c)).toBe(true);
  });

  it("personalization=generic con reason='opener_rejected_by_guard:*' → opener_rejected_by_guard (flagged)", () => {
    const c = classifyForRepersonalize({
      personalization: "generic",
      reason_if_generic: "opener_rejected_by_guard:forbidden_pattern_persists",
    });
    expect(c.kind).toBe("opener_rejected_by_guard");
    expect(isFlaggedForRepersonalize(c)).toBe(true);
  });

  it("personalization=personalized + opener limpio → personalized_ok (NO flagged)", () => {
    const c = classifyForRepersonalize({
      personalization: "personalized",
      opener:
        "Veo que en Intarcon diseñáis unidades de refrigeración industrial autoportantes.",
    });
    expect(c.kind).toBe("personalized_ok");
    expect(isFlaggedForRepersonalize(c)).toBe(false);
  });

  it("REGRESIÓN pedido Pere: opener guardado con '?' → flagged (opener_would_be_recut)", () => {
    // Opener con '?' pero SIN dónde recortar (no hay '.' ni ';'
    // antes) → el guard lo rechazaría hoy aunque en su momento
    // se persistió como personalized.
    const c = classifyForRepersonalize({
      personalization: "personalized",
      opener:
        "Veo que en Fluytec diseñáis sistemas de desalinización para sectores industriales exigentes ¿qué proyecto tenéis en curso?",
    });
    expect(c.kind).toBe("opener_would_be_recut");
    expect(isFlaggedForRepersonalize(c)).toBe(true);
  });

  it("opener personalizado con 'web' pero segunda cláusula tras '.' → flagged (would_trim)", () => {
    // El guard recortaría al '.' y la primera oración quedaría
    // limpia — pero como TRIMMED > 0, ya cuenta como flagged
    // (Pere: "un opener que el guard recortaría O rechazaría").
    const c = classifyForRepersonalize({
      personalization: "personalized",
      opener:
        "Veo que en Palinox diseñáis túneles de congelación para pescado y marisco desde hace 40 años. Vuestra web actual no lo refleja.",
    });
    expect(c.kind).toBe("opener_would_be_recut");
    expect(c.reason).toBe("would_trim_second_clause");
    expect(isFlaggedForRepersonalize(c)).toBe(true);
  });

  it("opener con 'me pregunto' (palabra nueva del prompt) → flagged", () => {
    const c = classifyForRepersonalize({
      personalization: "personalized",
      opener:
        "Veo que fabricáis maquinaria industrial premium, me pregunto cómo enfocáis las ferias del sector",
    });
    expect(c.kind).toBe("opener_would_be_recut");
    expect(isFlaggedForRepersonalize(c)).toBe(true);
  });

  it("opener con 'debe de ser' → flagged", () => {
    const c = classifyForRepersonalize({
      personalization: "personalized",
      opener:
        "Veo que fabricáis equipamiento premium para exportación, vuestra marca debe de ser referencia en el sector",
    });
    expect(c.kind).toBe("opener_would_be_recut");
    expect(isFlaggedForRepersonalize(c)).toBe(true);
  });

  it("personalized pero opener vacío → flagged (personalized_empty_opener)", () => {
    const c = classifyForRepersonalize({
      personalization: "personalized",
      opener: "",
    });
    expect(c.kind).toBe("opener_would_be_recut");
    expect(c.reason).toBe("personalized_empty_opener");
    expect(isFlaggedForRepersonalize(c)).toBe(true);
  });

  it("status desconocido → unpersonalized (defensivo, no re-lex accidental)", () => {
    const c = classifyForRepersonalize({
      personalization: "processing",
      opener: "",
    });
    expect(c.kind).toBe("unpersonalized");
    expect(isFlaggedForRepersonalize(c)).toBe(false);
  });
});
