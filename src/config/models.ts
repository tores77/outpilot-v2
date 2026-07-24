// Model routing and pricing for the Claude wrapper (lib/ai/claude.ts).
//
// Two axes:
//   1. Task -> model (haiku for volume, sonnet for quality)
//   2. Model -> price (USD per 1M tokens, input and output)
//
// Prices reflect Anthropic public pricing as of Fase 0. Verify before
// running production traffic:
//   https://www.anthropic.com/pricing
//
// New tasks are added here as agents come online (Nova T015, Lex T022,
// Echo T027/T028, Sage T035). Keep the union tight — no wildcard strings.

export type ClaudeModel =
  | "claude-haiku-4-5-20251001"
  | "claude-sonnet-4-6";

export type ClaudeTask =
  | "nova.score"
  | "lex.personalize"
  | "lex.website_summary"
  | "echo.classify"
  | "echo.draft";

export const TASK_MODEL: Record<ClaudeTask, ClaudeModel> = {
  "nova.score":          "claude-haiku-4-5-20251001",
  "lex.personalize":     "claude-haiku-4-5-20251001",
  "lex.website_summary": "claude-haiku-4-5-20251001",
  "echo.classify":       "claude-haiku-4-5-20251001",
  "echo.draft":          "claude-sonnet-4-6",
};

export type ModelPrice = {
  /** USD per 1M input tokens. */
  inputPer1M: number;
  /** USD per 1M output tokens. */
  outputPer1M: number;
};

export const MODEL_PRICES: Record<ClaudeModel, ModelPrice> = {
  "claude-haiku-4-5-20251001": {
    inputPer1M: 1.0,
    outputPer1M: 5.0,
  },
  "claude-sonnet-4-6": {
    inputPer1M: 3.0,
    outputPer1M: 15.0,
  },
};

/**
 * USD cost for a single completion, rounded to 6 decimals (matches the
 * numeric(10,6) precision of api_costs.cost_usd).
 */
export function computeCostUsd(
  model: ClaudeModel,
  tokensIn: number,
  tokensOut: number,
): number {
  const { inputPer1M, outputPer1M } = MODEL_PRICES[model];
  const raw =
    (tokensIn / 1_000_000) * inputPer1M +
    (tokensOut / 1_000_000) * outputPer1M;
  return Math.round(raw * 1_000_000) / 1_000_000;
}
