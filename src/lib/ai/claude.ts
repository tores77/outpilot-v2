// Claude wrapper — the single entry point for calling Anthropic from anywhere
// in the app. Enforces two things:
//   1. Task-based model routing (config/models.ts): haiku for volume, sonnet
//      for quality. Callers pass a task name, not a model.
//   2. Cost accounting: every call persists a row to api_costs with tokens,
//      cost, latency and model. Accounting failures are logged but do NOT
//      fail the caller — the LLM result is what matters, the row is telemetry.
//
// IMPORTANT — ONLY IMPORTABLE FROM /jobs/**.
//
// This module transitively imports the service_role Supabase client
// (lib/supabase/service.ts) to write to api_costs. Importing this wrapper
// from a Server Component, Route Handler or Client Component would drag the
// RLS-bypass client into a request-scoped context. The `server-only` guard
// below prevents client bundling, and the T009 lint rule will enforce the
// /jobs/** import restriction hard (mirroring the service client rule).
//
// Fase 0 · T007.

import "server-only";

import Anthropic from "@anthropic-ai/sdk";
import {
  MODEL_PRICES,
  TASK_MODEL,
  computeCostUsd,
  type ClaudeModel,
  type ClaudeTask,
} from "@/config/models";
import { createSupabaseServiceClient } from "@/lib/supabase/service";

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY!,
});

export type CallClaudeArgs = {
  /** Task identifier — drives the default model (see TASK_MODEL). */
  task: ClaudeTask;
  /** Tenant that owns the resulting api_costs row. */
  tenantId: string;
  /** Optional system prompt. */
  system?: string;
  /** Conversation turns. */
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  /** Anthropic max_tokens. Defaults to 1024. */
  maxTokens?: number;
  /**
   * Escape hatch: pin a specific model instead of TASK_MODEL[task].
   * Use sparingly (e.g. one-off calibration runs). Cost accounting still
   * records the actual model used.
   */
  modelOverride?: ClaudeModel;
};

export type CallClaudeUsage = {
  model: ClaudeModel;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
};

export type CallClaudeResult =
  | { ok: true; text: string; usage: CallClaudeUsage }
  | { ok: false; code: CallClaudeErrorCode; error: string };

export type CallClaudeErrorCode =
  | "anthropic_error"
  | "empty_response";

export async function callClaude(
  args: CallClaudeArgs,
): Promise<CallClaudeResult> {
  const model = args.modelOverride ?? TASK_MODEL[args.task];
  const startedAt = Date.now();

  let response: Anthropic.Message;
  try {
    response = await anthropic.messages.create({
      model,
      max_tokens: args.maxTokens ?? 1024,
      system: args.system,
      messages: args.messages,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[claude] anthropic error task=${args.task} model=${model}`,
      message,
    );
    return { ok: false, code: "anthropic_error", error: message };
  }

  const latencyMs = Date.now() - startedAt;

  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");

  const inputTokens = response.usage.input_tokens;
  const outputTokens = response.usage.output_tokens;
  const costUsd = computeCostUsd(model, inputTokens, outputTokens);

  // Fire-and-forget accounting. If it fails, log and continue — we still
  // want to return the model's answer to the caller.
  await recordApiCost({
    tenantId: args.tenantId,
    task: args.task,
    model,
    inputTokens,
    outputTokens,
    costUsd,
    latencyMs,
  });

  if (!text) {
    return {
      ok: false,
      code: "empty_response",
      error: "Anthropic returned no text blocks",
    };
  }

  return {
    ok: true,
    text,
    usage: { model, inputTokens, outputTokens, costUsd, latencyMs },
  };
}

type RecordApiCostArgs = {
  tenantId: string;
  task: ClaudeTask;
  model: ClaudeModel;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
};

async function recordApiCost(args: RecordApiCostArgs): Promise<void> {
  try {
    const supabase = createSupabaseServiceClient();
    const { error } = await supabase.from("api_costs").insert({
      tenant_id: args.tenantId,
      task: args.task,
      model: args.model,
      tokens_in: args.inputTokens,
      tokens_out: args.outputTokens,
      cost_usd: args.costUsd,
      latency_ms: args.latencyMs,
    });
    if (error) {
      console.error("[claude] api_costs insert failed", error);
    }
  } catch (err) {
    console.error("[claude] api_costs insert threw", err);
  }
}

// Re-export the pricing helpers for callers that want to preview cost
// before/after a batch (e.g. Nova scoring 1000 leads).
export { MODEL_PRICES, TASK_MODEL, computeCostUsd };
export type { ClaudeModel, ClaudeTask };
