// Criterios de "flagged" para el script scripts/repersonalize.mjs.
//
// Fuente única para "¿este campaign_lead debe re-personalizarse?".
// Aplica guardOpenerContent al OPENER YA GUARDADO — no confía en un
// flag persistido. Motivo (2026-09-28): openers escritos antes de
// que existiera el guard (o antes de ampliarlo con "me pregunto" y
// "debe de ser") están personalizados pero dispararían el guard hoy
// si volvieran a pasar por él.
//
// Función pura, testeable. El script .mjs duplica la lógica inline
// para ser self-contained (ver comentario ahí).

import { guardOpenerContent } from "./response";

export type FlagKind =
  | "unpersonalized" // personalization === null (no se ha llamado Lex todavía)
  | "personalized_ok" // opener actual pasa el guard sin recorte
  | "generic" // Lex degradó a generic por razón distinta al guard
  | "opener_rejected_by_guard" // Lex degradó a generic con reason opener_rejected_by_guard:*
  | "opener_would_be_recut"; // opener personalizado que HOY el guard recortaría o rechazaría

export type Classification = {
  kind: FlagKind;
  // Texto corto para mostrar al humano en el dry-run. Nunca PII.
  reason: string;
};

/**
 * Clasifica el estado de la personalization de un campaign_lead.
 *
 *   - unpersonalized: personalization === null. NO cuenta como
 *     flagged (esos leads los procesa "Personalizar" normal).
 *   - personalized_ok: opener pasa el guard limpio, sin recorte.
 *     NO flagged.
 *   - generic: Lex ya lo dejó en generic por otra razón (no guard).
 *     Sí flagged.
 *   - opener_rejected_by_guard: Lex ya lo dejó en generic con
 *     reason del guard. Sí flagged.
 *   - opener_would_be_recut: personalization=personalized pero el
 *     opener HOY dispararía el guard (recorte o rechazo). Sí flagged.
 */
export function classifyForRepersonalize(personalization: unknown): Classification {
  if (personalization === null || typeof personalization !== "object") {
    return { kind: "unpersonalized", reason: "no_personalization_yet" };
  }
  const p = personalization as Record<string, unknown>;
  const status = p.personalization;

  if (status === "generic") {
    const reason =
      typeof p.reason_if_generic === "string" ? p.reason_if_generic : "";
    if (reason.startsWith("opener_rejected_by_guard")) {
      return { kind: "opener_rejected_by_guard", reason };
    }
    return { kind: "generic", reason: reason || "no_reason_recorded" };
  }

  if (status === "personalized") {
    const opener = typeof p.opener === "string" ? p.opener : "";
    if (opener.trim().length === 0) {
      // personalized pero opener vacío — anómalo, marcamos como
      // flagged para forzar re-lex.
      return { kind: "opener_would_be_recut", reason: "personalized_empty_opener" };
    }
    const guard = guardOpenerContent(opener);
    if (guard.rejected) {
      return { kind: "opener_would_be_recut", reason: guard.reason };
    }
    if (guard.trimmed) {
      return {
        kind: "opener_would_be_recut",
        reason: "would_trim_second_clause",
      };
    }
    return { kind: "personalized_ok", reason: "opener_passes_guard" };
  }

  // status desconocido (o processing legacy) → tratamos como
  // unpersonalized para no re-lexar accidentalmente.
  return { kind: "unpersonalized", reason: "unknown_status" };
}

/**
 * true si el campaign_lead debe entrar en --only-flagged.
 */
export function isFlaggedForRepersonalize(c: Classification): boolean {
  return (
    c.kind === "generic" ||
    c.kind === "opener_rejected_by_guard" ||
    c.kind === "opener_would_be_recut"
  );
}
