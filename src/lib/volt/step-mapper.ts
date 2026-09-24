// OUTPILOT v2 — Volt step mapper (T023 fix)
// -----------------------------------------------------------------------------
// Dos helpers puros:
//   - composeAddStepBody: convierte un step de nuestro sequence (con
//     subject opcional) en un LemlistAddStepBody. Si el subject está
//     vacío o ausente, OMITE la clave `subject` — no la envía como ""
//     (importante para el reply-thread behavior de Lemlist).
//   - stepMatches: comparador para el skip/abort de upload-step-{i}
//     del job volt-create-campaign. Compara actual (respuesta de GET
//     /sequences) vs expected (step del sequence de BD) por posición.
//     Regla: si ambos tienen subject → compara subjects. Si NINGUNO
//     tiene subject → compara los primeros 80 caracteres de message.
//     Si uno lo tiene y otro no → divergente.

import type {
  LemlistAddStepBody,
  LemlistSequenceStepRow,
} from "@/channels/lemlist/campaign-ops";

export type SequenceStepForMapper = {
  subject?: string;
  bodyHtml: string;
  delayDays: number;
};

function nonEmpty(value: string | undefined | null): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Compone el body para POST /sequences/:sid/steps. Omite `subject` si
 * está vacío o ausente — enviar `""` a Lemlist NO dispara el
 * reply-thread behavior; hay que enviar el JSON sin esa clave.
 */
export function composeAddStepBody(
  step: SequenceStepForMapper,
): LemlistAddStepBody {
  const body: LemlistAddStepBody = {
    type: "email",
    message: step.bodyHtml,
    delay: step.delayDays,
  };
  const subject = nonEmpty(step.subject);
  if (subject !== "") body.subject = subject;
  return body;
}

/**
 * Comparador para idempotencia del step upload. Devuelve true si el
 * step existente en Lemlist "matches" el esperado según la regla:
 *
 *   - Ambos con subject           → subject === subject
 *   - Ambos SIN subject (reply)   → bodyHtml[:80] === message[:80]
 *   - Solo uno con subject         → false (divergent)
 *
 * Comparación case-sensitive, trim aplicado por nonEmpty.
 */
export function stepMatches(
  actual: LemlistSequenceStepRow,
  expected: SequenceStepForMapper,
): boolean {
  const expectedSubject = nonEmpty(expected.subject);
  const actualSubject = nonEmpty(actual.subject);

  if (expectedSubject === "" && actualSubject === "") {
    // Ambos follow-ups sin subject → comparar por message[:80].
    const expectedMsg = nonEmpty(expected.bodyHtml).slice(0, 80);
    const actualMsg = nonEmpty(actual.message).slice(0, 80);
    return expectedMsg === actualMsg;
  }
  if (expectedSubject === "" || actualSubject === "") {
    // Uno tiene subject, el otro no → divergent.
    return false;
  }
  return expectedSubject === actualSubject;
}

/**
 * Descripción legible del step para logs / mensajes de error del
 * divergent abort. Nunca vuelca el body completo — solo primeros 80.
 */
export function describeStep(
  step: { subject?: string; message?: string | null; bodyHtml?: string },
): string {
  const subject = nonEmpty(step.subject);
  const rawMsg = step.message ?? step.bodyHtml ?? "";
  const msgHead = nonEmpty(rawMsg).slice(0, 80);
  return `subject="${subject}" msg[:80]="${msgHead}"`;
}
