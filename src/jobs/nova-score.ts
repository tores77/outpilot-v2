// Nova ICP scoring — batch job (T024 harness · fix bucle infinito).
//
// Trigger: event `nova/score.requested`. Manual-only (botón
// "Puntuar N pendientes" en /radar).
//
// Historia del harness:
//   T015 — versión ingenua (1 batch, sin claim).
//   2026-09-25 (mañana) — post-mortem fan-out: 6 clicks → 4 runs
//   solapados llamando a Haiku sobre los mismos leads. Fix:
//     · concurrency 1 por tenant.
//     · migración 005 + claim atómico.
//     · sweep-stale para claims muertos.
//     · loop "un click procesa todos los pendientes".
//   2026-09-25 (tarde) — post-mortem bucle infinito
//   (run 01M3CJ4MBAY12EJQ1B2TH4KHKW): el batch fallaba a parsear
//   y el release-on-parse-error devolvía los leads a pendientes;
//   el loop los volvía a coger. 10 min y ~15 llamadas a Haiku
//   desperdiciadas hasta cancelar a mano. Fix (este archivo):
//     · Causa raíz identificada por probe local: Haiku alcanzaba
//       max_tokens=3000 con 20 leads → JSON truncado sin recuperación.
//       Subido a NOVA_SCORE_MAX_TOKENS (16 000).
//     · Migración 006 + scoring_error jsonb: batches con parse_error
//       se marcan (no liberan) → excluidos del claim en este run
//       y siguientes hasta limpieza manual.
//     · Hard cap dinámico ceil(pending_start / batch_size) + 1:
//       si el loop supera esto, aborta con error explícito.
//     · El step `mark-on-parse-error` devuelve el payload de error
//       (reason + response_preview + stop_reason) para verlo en Inngest.
//     · Distinción claude_error (transitorio → release) vs parse_error
//       (persistente → markScoringError).

import { inngest } from "@/lib/inngest";
import { createSupabaseServiceClient } from "@/lib/supabase/service";
import { callClaude } from "@/lib/ai/claude";
import {
  buildLeadPayload,
  computeScoreUpdate,
  parseScoringResponse,
  type LeadForScoring,
  type ScoredLead,
} from "@/lib/nova/scoring";
import {
  NOVA_SCORE_BATCH_SIZE,
  NOVA_SCORE_MAX_BATCHES_PER_RUN,
  NOVA_SCORE_MAX_TOKENS,
  NOVA_SCORE_STALE_CLAIM_MS,
  NOVA_SCORE_THRESHOLD_EN_RADAR,
  NOVA_SCORE_THRESHOLD_REVIEW,
  NOVA_SCORING_SYSTEM_PROMPT,
} from "@/config/scoring";
import {
  claimPendingScoring,
  countScoringPending,
  finalizeScore,
  markScoringError,
  releaseScoringClaims,
  sweepStaleScoringClaims,
  type ClaimedLead,
} from "@/lib/nova/claim";
import type { Database } from "@/lib/supabase/database.types";

type LeadUpdate = Database["public"]["Tables"]["leads"]["Update"];

type EventData = {
  tenantId?: unknown;
  requestedBy?: unknown;
};

function parseEventData(raw: unknown): { tenantId: string; requestedBy: string } {
  const data = (raw ?? {}) as EventData;
  const tenantId = typeof data.tenantId === "string" ? data.tenantId : "";
  const requestedBy =
    typeof data.requestedBy === "string" ? data.requestedBy : "";
  return { tenantId, requestedBy };
}

type BatchOutcome = {
  batch_index: number;
  claimed: number;
  scored: number;
  promoted: number;
  flagged_review: number;
  unscored: number;
  outcome:
    | "ok"
    | "parse_error"
    | "claude_error";
  parse_error: string | null;
  claude_input_tokens: number;
  claude_output_tokens: number;
  claude_cost_usd: number;
  claude_latency_ms: number;
  batch_latency_ms: number;
};

export const novaScore = inngest.createFunction(
  {
    id: "nova-score",
    triggers: [{ event: "nova/score.requested" }],
    // Serializa runs por tenant — dos clicks al mismo botón (o eventos
    // concurrentes) se procesan uno detrás de otro. El segundo run
    // arrancará después de que el primero termine y verá 0 pendientes.
    concurrency: [{ limit: 1, key: "event.data.tenantId" }],
  },
  async ({ event, step }) => {
    const startedAt = Date.now();
    const { tenantId, requestedBy } = parseEventData(event.data);
    if (!tenantId) throw new Error("nova-score: missing tenantId");

    const supabase = createSupabaseServiceClient();

    // ===== 1. Sweep de claims stuck (opportunistic) =====
    const sweptCount = await step.run("sweep-stale", () =>
      sweepStaleScoringClaims(supabase, {
        tenantId,
        staleMs: NOVA_SCORE_STALE_CLAIM_MS,
      }),
    );

    // ===== 2. Snapshot inicial de pendientes → hard cap dinámico =====
    //
    // El cap protege contra el bucle infinito: si algo hace que el
    // mismo lead siga apareciendo en el claim tras un batch (bug de
    // guard, race pathológica), el cap corta el loop en un número de
    // iteraciones que TIENE sentido para el pool inicial. Fórmula:
    //   ceil(pending_start / batch_size) + 1
    // El +1 tolera una re-entrada legítima (p.ej. sweep libera stale
    // durante el run). Si excedemos → error explícito, no silencioso.
    // Y aún tenemos NOVA_SCORE_MAX_BATCHES_PER_RUN como techo global.
    const initialCount = await step.run("count-initial", () =>
      countScoringPending(supabase, {
        tenantId,
        staleMs: NOVA_SCORE_STALE_CLAIM_MS,
      }),
    );
    const dynamicCap = Math.max(
      1,
      Math.ceil(initialCount.activePending / NOVA_SCORE_BATCH_SIZE) + 1,
    );
    const effectiveCap = Math.min(dynamicCap, NOVA_SCORE_MAX_BATCHES_PER_RUN);

    // ===== 3. Loop de batches sucesivos dentro del mismo run =====
    const batches: BatchOutcome[] = [];
    let batchIndex = 0;

    while (batchIndex < effectiveCap) {
      const batchStartedAt = Date.now();

      // Claim atómico (excluye scoring_error != NULL en la propia SQL).
      const claimed: ClaimedLead[] = await step.run(
        `claim-batch-${batchIndex}`,
        () =>
          claimPendingScoring(supabase, {
            tenantId,
            limit: NOVA_SCORE_BATCH_SIZE,
          }),
      );

      if (claimed.length === 0) break;

      const claimStartedAt = claimed[0].claim_started_at;
      const leadIds = claimed.map((c) => c.lead.id);

      // Batch Haiku (memoizado como step.run)
      const payload = claimed.map((c) =>
        buildLeadPayload(c.lead as LeadForScoring),
      );
      const userMessage = JSON.stringify(payload, null, 2);

      const claudeResult = await step.run(
        `call-claude-${batchIndex}`,
        () =>
          callClaude({
            task: "nova.score",
            tenantId,
            system: NOVA_SCORING_SYSTEM_PROMPT,
            maxTokens: NOVA_SCORE_MAX_TOKENS,
            messages: [{ role: "user", content: userMessage }],
          }),
      );

      if (!claudeResult.ok) {
        // Haiku falló (llamada de red, 5xx, timeout — transitorio).
        // Libera claims (sin marcar error) para reintentar en el
        // próximo click.
        await step.run(`release-on-claude-error-${batchIndex}`, () =>
          releaseScoringClaims(supabase, {
            tenantId,
            leadIds,
            claimStartedAt,
          }),
        );
        batches.push({
          batch_index: batchIndex,
          claimed: claimed.length,
          scored: 0,
          promoted: 0,
          flagged_review: 0,
          unscored: claimed.length,
          outcome: "claude_error",
          parse_error: `claude_error: ${claudeResult.code}: ${claudeResult.error}`,
          claude_input_tokens: 0,
          claude_output_tokens: 0,
          claude_cost_usd: 0,
          claude_latency_ms: 0,
          batch_latency_ms: Date.now() - batchStartedAt,
        });
        batchIndex += 1;
        continue;
      }

      const parseResult = parseScoringResponse(claudeResult.text);
      if (!parseResult.ok) {
        // Parse falló (respuesta rota persistente, p.ej. truncada por
        // max_tokens). Marca scoring_error con motivo + preview de la
        // respuesta cruda + stop_reason. Los leads quedan EXCLUIDOS
        // del claim en este run y en futuros — el humano limpia con
        // SQL cuando decida reintentar. El step devuelve el payload
        // para que se vea en Inngest sin tener que abrir BD.
        console.error(
          "[nova-score] parse error",
          parseResult.error,
          "preview:",
          parseResult.preview,
        );
        const errorPayload = {
          reason: parseResult.error,
          response_preview: claudeResult.text.slice(0, 500),
          stop_reason: claudeResult.usage.stopReason ?? null,
          batch_index: batchIndex,
          claude_input_tokens: claudeResult.usage.inputTokens,
          claude_output_tokens: claudeResult.usage.outputTokens,
          timestamp: new Date().toISOString(),
        };
        await step.run(`mark-on-parse-error-${batchIndex}`, async () => {
          const marked = await markScoringError(supabase, {
            tenantId,
            leadIds,
            claimStartedAt,
            errorPayload,
          });
          // Devolvemos el payload de error como salida del step.
          // Inngest lo persiste como resultado del step → visible en
          // la UI sin abrir BD.
          return { marked, ...errorPayload };
        });
        batches.push({
          batch_index: batchIndex,
          claimed: claimed.length,
          scored: 0,
          promoted: 0,
          flagged_review: 0,
          unscored: claimed.length,
          outcome: "parse_error",
          parse_error: parseResult.error,
          claude_input_tokens: claudeResult.usage.inputTokens,
          claude_output_tokens: claudeResult.usage.outputTokens,
          claude_cost_usd: claudeResult.usage.costUsd,
          claude_latency_ms: claudeResult.usage.latencyMs,
          batch_latency_ms: Date.now() - batchStartedAt,
        });
        batchIndex += 1;
        continue;
      }

      // Finalize per-lead (un step.run por lead).
      const scoredById = new Map<string, ScoredLead>(
        parseResult.scored.map((s) => [s.id, s]),
      );
      let promoted = 0;
      let flaggedReview = 0;
      let unscored = 0;
      let scoredCount = 0;

      for (const { lead, claim_started_at } of claimed) {
        const result = scoredById.get(lead.id);
        if (!result) {
          unscored += 1;
          continue;
        }
        scoredCount += 1;
        const decision = computeScoreUpdate(lead.estado, result, {
          enRadar: NOVA_SCORE_THRESHOLD_EN_RADAR,
          review: NOVA_SCORE_THRESHOLD_REVIEW,
        });
        if (decision.estado === "EN_RADAR") promoted += 1;
        if (decision.needs_review) flaggedReview += 1;

        const existingCustom =
          lead.custom_fields && typeof lead.custom_fields === "object"
            ? (lead.custom_fields as Record<string, unknown>)
            : {};
        const update: LeadUpdate = {
          icp_score: decision.icp_score,
          estado: decision.estado,
          needs_review: decision.needs_review,
          custom_fields: {
            ...existingCustom,
            score_reasoning: decision.score_reasoning,
            score_sub_scores: decision.sub_scores,
          },
        };

        await step.run(`finalize-${batchIndex}-${lead.id}`, async () => {
          const wrote = await finalizeScore(supabase, {
            tenantId,
            leadId: lead.id,
            claimStartedAt: claim_started_at,
            update,
          });
          if (!wrote) {
            console.warn(
              "[nova-score] lost race on finalize",
              lead.id,
              batchIndex,
            );
          }
        });
      }

      batches.push({
        batch_index: batchIndex,
        claimed: claimed.length,
        scored: scoredCount,
        promoted,
        flagged_review: flaggedReview,
        unscored,
        outcome: "ok",
        parse_error: null,
        claude_input_tokens: claudeResult.usage.inputTokens,
        claude_output_tokens: claudeResult.usage.outputTokens,
        claude_cost_usd: claudeResult.usage.costUsd,
        claude_latency_ms: claudeResult.usage.latencyMs,
        batch_latency_ms: Date.now() - batchStartedAt,
      });
      batchIndex += 1;
    }

    const capHit = batchIndex >= effectiveCap;

    // Aggregate
    const totals = batches.reduce(
      (acc, b) => ({
        claimed: acc.claimed + b.claimed,
        scored: acc.scored + b.scored,
        promoted: acc.promoted + b.promoted,
        flagged_review: acc.flagged_review + b.flagged_review,
        unscored: acc.unscored + b.unscored,
        batches_failed:
          acc.batches_failed +
          (b.outcome === "parse_error" || b.outcome === "claude_error" ? 1 : 0),
        parse_errors: acc.parse_errors + (b.outcome === "parse_error" ? 1 : 0),
        claude_errors:
          acc.claude_errors + (b.outcome === "claude_error" ? 1 : 0),
        claude_input_tokens: acc.claude_input_tokens + b.claude_input_tokens,
        claude_output_tokens:
          acc.claude_output_tokens + b.claude_output_tokens,
        claude_cost_usd: acc.claude_cost_usd + b.claude_cost_usd,
      }),
      {
        claimed: 0,
        scored: 0,
        promoted: 0,
        flagged_review: 0,
        unscored: 0,
        batches_failed: 0,
        parse_errors: 0,
        claude_errors: 0,
        claude_input_tokens: 0,
        claude_output_tokens: 0,
        claude_cost_usd: 0,
      },
    );

    // Cuenta restante para el evento (útil cuando cap_hit=true o hay
    // batches_failed).
    const remaining = await step.run("count-remaining", () =>
      countScoringPending(supabase, {
        tenantId,
        staleMs: NOVA_SCORE_STALE_CLAIM_MS,
      }),
    );

    const latencyMs = Date.now() - startedAt;

    // ===== events row =====
    await step.run("record-event", async () => {
      const { error } = await supabase.from("events").insert({
        tenant_id: tenantId,
        kind: "nova.score",
        actor: requestedBy || "nova",
        entity_type: "lead",
        payload: {
          batches_processed: batches.length,
          batches_failed: totals.batches_failed,
          parse_errors: totals.parse_errors,
          claude_errors: totals.claude_errors,
          swept_stale: sweptCount,
          initial_pending: initialCount.activePending,
          effective_cap: effectiveCap,
          cap_hit: capHit,
          remaining_after_run: remaining,
          claimed_total: totals.claimed,
          scored_total: totals.scored,
          promoted_to_en_radar: totals.promoted,
          flagged_needs_review: totals.flagged_review,
          unscored: totals.unscored,
          per_batch_latency_ms: batches.map((b) => b.batch_latency_ms),
          per_batch_outcome: batches.map((b) => b.outcome),
          claude_input_tokens: totals.claude_input_tokens,
          claude_output_tokens: totals.claude_output_tokens,
          claude_cost_usd: totals.claude_cost_usd,
          latency_ms: latencyMs,
        },
      });
      if (error) console.error("[nova-score] events insert failed", error);
    });

    // Si superamos effectiveCap con MÁS reclamables aún, lanza error
    // explícito para que Inngest lo marque failed (no silenciar el
    // bug si vuelve a aparecer).
    if (
      capHit &&
      remaining.activePending > 0 &&
      dynamicCap < NOVA_SCORE_MAX_BATCHES_PER_RUN
    ) {
      throw new Error(
        `nova-score: cap dinámico superado (batches=${batches.length}, ` +
          `cap=${effectiveCap}, initial_pending=${initialCount.activePending}, ` +
          `remaining=${remaining.activePending}). Posible bucle: revisa ` +
          `parse_errors y scoring_error de los leads.`,
      );
    }

    return {
      batches_processed: batches.length,
      batches_failed: totals.batches_failed,
      parse_errors: totals.parse_errors,
      claude_errors: totals.claude_errors,
      swept_stale: sweptCount,
      initial_pending: initialCount.activePending,
      effective_cap: effectiveCap,
      cap_hit: capHit,
      remaining_after_run: remaining,
      claimed_total: totals.claimed,
      scored_total: totals.scored,
      promoted: totals.promoted,
      flagged_review: totals.flagged_review,
      unscored: totals.unscored,
      per_batch_latency_ms: batches.map((b) => b.batch_latency_ms),
      claude: {
        inputTokens: totals.claude_input_tokens,
        outputTokens: totals.claude_output_tokens,
        costUsd: totals.claude_cost_usd,
      },
      latency_ms: latencyMs,
    };
  },
);
