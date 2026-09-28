// OUTPILOT v2 — Lex retry con motivo del guard (T024)
// -----------------------------------------------------------------------------
// Cuando parseLexResponse degrada a "generic" por
// "opener_rejected_by_guard" (regla 12), reintentamos UNA vez la
// llamada a Haiku añadiendo el motivo al userPrompt para que el modelo
// se autocorrija. Si el segundo intento también se rechaza, fallback
// definitivo y fields_used incluye "opener_rejected_x2" como señal
// de observabilidad.
//
// Diseño: función pura que recibe una `callClaudeFn` inyectada. El
// caller (lex-personalize job) le pasa un closure sobre callClaude
// con task+tenantId+model ya cerrados. Tests usan mock.

import { parseLexResponse, type LexResponse } from "./response";

export type ClaudeCallSuccess = {
  ok: true;
  text: string;
  usage: {
    model: string;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
  };
};

export type ClaudeCallError = {
  ok: false;
  code: string;
  error: string;
};

export type ClaudeCallResult = ClaudeCallSuccess | ClaudeCallError;

export type CallClaudeFn = (userPrompt: string) => Promise<ClaudeCallResult>;

export type LexWithRetryResult =
  | {
      ok: true;
      parsed: LexResponse;
      attempts: 1 | 2;
      usages: ClaudeCallSuccess["usage"][];
    }
  | {
      ok: false;
      code: string;
      error: string;
    };

function isRejectedByGuard(parsed: LexResponse): boolean {
  return (
    parsed.personalization === "generic" &&
    typeof parsed.reason_if_generic === "string" &&
    parsed.reason_if_generic.startsWith("opener_rejected_by_guard")
  );
}

/**
 * Llama a Lex con reintento único cuando el guard determinista
 * rechaza el opener. Máximo 2 intentos.
 *
 * Flujo:
 *   1. Primer intento con userPrompt tal cual.
 *   2. Si parseLexResponse degrada con reason "opener_rejected_by_guard:...",
 *      compone un userPrompt aumentado con el motivo y reintenta.
 *   3. Si el segundo también degrada por el guard, se marca
 *      fields_used con "opener_rejected_x2" para trazabilidad.
 *   4. En degrade por cualquier OTRA razón (parse_failed, empty
 *      response, etc.) NO se reintenta — es señal distinta.
 */
export async function callLexWithGuardRetry(args: {
  userPrompt: string;
  callClaudeFn: CallClaudeFn;
}): Promise<LexWithRetryResult> {
  const { userPrompt, callClaudeFn } = args;

  const first = await callClaudeFn(userPrompt);
  if (!first.ok) return first;

  const firstParsed = parseLexResponse(first.text);
  if (!isRejectedByGuard(firstParsed)) {
    return {
      ok: true,
      parsed: firstParsed,
      attempts: 1,
      usages: [first.usage],
    };
  }

  // Reintento con motivo del rechazo añadido al prompt.
  const augmentedPrompt =
    userPrompt +
    `\n\nEl intento anterior fue rechazado por: ${firstParsed.reason_if_generic}. Devuelve solo la observación.`;
  const second = await callClaudeFn(augmentedPrompt);
  if (!second.ok) {
    // El segundo call falló como red (no como guard). Devolvemos
    // el error de red del segundo — el primer parseado ya estaba
    // rejected, no rescatable.
    return second;
  }
  const secondParsed = parseLexResponse(second.text);
  if (!isRejectedByGuard(secondParsed)) {
    return {
      ok: true,
      parsed: secondParsed,
      attempts: 2,
      usages: [first.usage, second.usage],
    };
  }

  // Segundo también rejected → añadir señal a fields_used.
  return {
    ok: true,
    parsed: {
      ...secondParsed,
      fields_used: [...secondParsed.fields_used, "opener_rejected_x2"],
    },
    attempts: 2,
    usages: [first.usage, second.usage],
  };
}
