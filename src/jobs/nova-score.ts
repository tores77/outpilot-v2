// Nova ICP scoring — batch job (T024 harness).
//
// Trigger: event `nova/score.requested`. Manual-only (botón
// "Puntuar N pendientes" en /radar).
//
// Anti-fan-out (post-mortem 2026-09-25, mismo patrón que Lex T022):
//   6 clicks generaron 4 runs solapados porque el botón no daba
//   feedback y el usuario clicó varias veces mientras el batch
//   estaba en vuelo. Cada run leyó los mismos leads sin score y
//   habría llamado a Haiku sobre la misma batch. Fix:
//     1. concurrency: [{ limit: 1, key: "event.data.tenantId" }] —
//        serializa runs por tenant. Runs posteriores esperan a que
//        el primero termine.
//     2. sweep-stale al inicio: resetea scoring_claimed_at NULL para
//        claims más antiguos que NOVA_SCORE_STALE_CLAIM_MS.
//     3. claim atómico por batch antes de llamar a Haiku (UPDATE
//        con guard .is(scoring_claimed_at, null)).
//     4. Un solo click procesa TODOS los pendientes en lotes
//        sucesivos DENTRO del mismo run (loop con cap
//        NOVA_SCORE_MAX_BATCHES_PER_RUN). Sin necesidad de 6 clicks.
//     5. Parser tolerante (parseScoringResponse devuelve {ok, ...}):
//        un batch con respuesta rota no tumba el run; libera sus
//        claims y sigue con el siguiente batch.
//
// La UI (botón de /radar) cuenta pendientes reales vs claims frescos
// y muestra "Puntuando N…" deshabilitado mientras haya procesando.

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
  NOVA_SCORE_STALE_CLAIM_MS,
  NOVA_SCORE_THRESHOLD_EN_RADAR,
  NOVA_SCORE_THRESHOLD_REVIEW,
  NOVA_SCORING_SYSTEM_PROMPT,
} from "@/config/scoring";
import {
  claimPendingScoring,
  countScoringPending,
  finalizeScore,
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
  parse_error: string | null;
  released_on_parse_error: number;
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

    // ===== 2. Loop de batches sucesivos dentro del mismo run =====
    //
    // Cada iteración: claim atómico → Haiku batch → finalize por lead.
    // Termina cuando claim devuelve 0 (no hay más pendientes) o cuando
    // se alcanza NOVA_SCORE_MAX_BATCHES_PER_RUN (safety cap).
    const batches: BatchOutcome[] = [];
    let batchIndex = 0;

    while (batchIndex < NOVA_SCORE_MAX_BATCHES_PER_RUN) {
      const batchStartedAt = Date.now();

      // Claim atómico
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
            maxTokens: 3000,
            messages: [{ role: "user", content: userMessage }],
          }),
      );

      if (!claudeResult.ok) {
        // Haiku falló (llamada, no la respuesta). Libera claims para
        // reintentar en el próximo click sin esperar al TTL.
        const released = await step.run(
          `release-on-claude-error-${batchIndex}`,
          () =>
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
          parse_error: `claude_error: ${claudeResult.code}: ${claudeResult.error}`,
          released_on_parse_error: released,
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
        // Parse falló. Libera claims: próximo click reintenta.
        console.error(
          "[nova-score] parse error",
          parseResult.error,
          "preview:",
          parseResult.preview,
        );
        const released = await step.run(
          `release-on-parse-error-${batchIndex}`,
          () =>
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
          parse_error: parseResult.error,
          released_on_parse_error: released,
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
            // Alguien reseteó nuestro claim (sweep + reclaim de otro
            // run). No pasa nada: el otro run persistirá su resultado.
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
        parse_error: null,
        released_on_parse_error: 0,
        claude_input_tokens: claudeResult.usage.inputTokens,
        claude_output_tokens: claudeResult.usage.outputTokens,
        claude_cost_usd: claudeResult.usage.costUsd,
        claude_latency_ms: claudeResult.usage.latencyMs,
        batch_latency_ms: Date.now() - batchStartedAt,
      });
      batchIndex += 1;
    }

    // Si terminamos por el cap y hay más pendientes, lo dejamos claro
    // en el evento; Pere clica de nuevo. La concurrency guard serializa.
    const capHit = batchIndex >= NOVA_SCORE_MAX_BATCHES_PER_RUN;

    // Aggregate
    const totals = batches.reduce(
      (acc, b) => ({
        claimed: acc.claimed + b.claimed,
        scored: acc.scored + b.scored,
        promoted: acc.promoted + b.promoted,
        flagged_review: acc.flagged_review + b.flagged_review,
        unscored: acc.unscored + b.unscored,
        parse_errors: acc.parse_errors + (b.parse_error ? 1 : 0),
        released_on_parse_error:
          acc.released_on_parse_error + b.released_on_parse_error,
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
        parse_errors: 0,
        released_on_parse_error: 0,
        claude_input_tokens: 0,
        claude_output_tokens: 0,
        claude_cost_usd: 0,
      },
    );

    // Cuenta restante para el evento (útil cuando cap_hit=true).
    const remaining = capHit
      ? await step.run("count-remaining", () =>
          countScoringPending(supabase, {
            tenantId,
            staleMs: NOVA_SCORE_STALE_CLAIM_MS,
          }),
        )
      : null;

    const latencyMs = Date.now() - startedAt;

    // ===== 3. events row =====
    await step.run("record-event", async () => {
      const { error } = await supabase.from("events").insert({
        tenant_id: tenantId,
        kind: "nova.score",
        actor: requestedBy || "nova",
        entity_type: "lead",
        payload: {
          batches_processed: batches.length,
          swept_stale: sweptCount,
          claimed_total: totals.claimed,
          scored_total: totals.scored,
          promoted_to_en_radar: totals.promoted,
          flagged_needs_review: totals.flagged_review,
          unscored: totals.unscored,
          parse_errors: totals.parse_errors,
          released_on_parse_error: totals.released_on_parse_error,
          cap_hit: capHit,
          remaining_after_run: remaining,
          per_batch_latency_ms: batches.map((b) => b.batch_latency_ms),
          claude_input_tokens: totals.claude_input_tokens,
          claude_output_tokens: totals.claude_output_tokens,
          claude_cost_usd: totals.claude_cost_usd,
          latency_ms: latencyMs,
        },
      });
      if (error) console.error("[nova-score] events insert failed", error);
    });

    return {
      batches_processed: batches.length,
      swept_stale: sweptCount,
      claimed_total: totals.claimed,
      scored_total: totals.scored,
      promoted: totals.promoted,
      flagged_review: totals.flagged_review,
      unscored: totals.unscored,
      parse_errors: totals.parse_errors,
      released_on_parse_error: totals.released_on_parse_error,
      cap_hit: capHit,
      remaining_after_run: remaining,
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
