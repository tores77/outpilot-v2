// Nova ICP scoring — batch job.
// Fase 1 · T015.
//
// Trigger: event `nova/score.requested`. MANUAL-ONLY — dispatched by the
// "Puntuar N pendientes" button on /radar. No cron. Constitution §7:
// human pulls the trigger in v2.1.
//
// Flow:
//   1. Fetch up to NOVA_SCORE_BATCH_SIZE leads without icp_score, scoped
//      to the tenant.
//   2. Build a compact prompt payload with only the fields present
//      (buildLeadPayload strips empties so absence stays absence).
//   3. Call the shared Claude wrapper (task 'nova.score' -> haiku). Cost
//      is recorded automatically in api_costs by the wrapper.
//   4. Parse the JSON response. Update each lead in place:
//        icp_score        <- score
//        estado           <- 'EN_RADAR' if score >= EN_RADAR threshold
//                            AND current estado is 'NUEVO'
//        needs_review     <- true if score < REVIEW threshold
//        custom_fields    <- merged with score_reasoning + score_sub_scores
//   5. Write one events row per batch with distribution stats.
//
// Rows returned by Claude but not present in the input batch (should not
// happen) are ignored. Rows expected but missing from the response are
// counted as `unscored`.

import { inngest } from "@/lib/inngest";
import { createSupabaseServiceClient } from "@/lib/supabase/service";
import { callClaude } from "@/lib/ai/claude";
import {
  buildLeadPayload,
  parseScoringResponse,
  type LeadForScoring,
} from "@/lib/nova/scoring";
import {
  NOVA_SCORE_BATCH_SIZE,
  NOVA_SCORE_THRESHOLD_EN_RADAR,
  NOVA_SCORE_THRESHOLD_REVIEW,
  NOVA_SCORING_SYSTEM_PROMPT,
} from "@/config/scoring";
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

export const novaScore = inngest.createFunction(
  {
    id: "nova-score",
    triggers: [{ event: "nova/score.requested" }],
  },
  async ({ event, step }) => {
    const startedAt = Date.now();
    const { tenantId, requestedBy } = parseEventData(event.data);
    if (!tenantId) throw new Error("nova-score: missing tenantId");

    const supabase = createSupabaseServiceClient();

    // ===== 1. Fetch pending leads =====
    const pending = await step.run("fetch-pending", async () => {
      const { data, error } = await supabase
        .from("leads")
        .select(
          "id, email, first_name, last_name, company, title, sector, country, city, website, linkedin_url, estado, custom_fields",
        )
        .eq("tenant_id", tenantId)
        .is("icp_score", null)
        .order("created_at", { ascending: true })
        .limit(NOVA_SCORE_BATCH_SIZE);
      if (error) {
        console.error("[nova-score] fetch failed", error);
        throw new Error(`fetch failed: ${error.message}`);
      }
      return data ?? [];
    });

    if (pending.length === 0) {
      return {
        pending: 0,
        scored: 0,
        promoted: 0,
        flagged_review: 0,
        latency_ms: Date.now() - startedAt,
      };
    }

    // ===== 2. Build prompt payload =====
    const payload = pending.map((lead) =>
      buildLeadPayload(lead as LeadForScoring),
    );
    const userMessage = JSON.stringify(payload, null, 2);

    // ===== 3. Call Haiku via the wrapper (registers cost automatically) =====
    const claudeResult = await step.run("call-claude", () =>
      callClaude({
        task: "nova.score",
        tenantId,
        system: NOVA_SCORING_SYSTEM_PROMPT,
        maxTokens: 3000,
        messages: [{ role: "user", content: userMessage }],
      }),
    );

    if (!claudeResult.ok) {
      throw new Error(
        `nova-score: claude failed (${claudeResult.code}): ${claudeResult.error}`,
      );
    }

    // ===== 4. Parse + update =====
    const scored = parseScoringResponse(claudeResult.text);
    const scoredById = new Map(scored.map((s) => [s.id, s]));

    let promoted = 0;
    let flaggedReview = 0;
    let unscored = 0;

    for (const lead of pending) {
      const result = scoredById.get(lead.id);
      if (!result) {
        unscored += 1;
        continue;
      }
      const update: LeadUpdate = {
        icp_score: result.score,
      };
      const willPromote =
        result.score >= NOVA_SCORE_THRESHOLD_EN_RADAR &&
        lead.estado === "NUEVO";
      if (willPromote) {
        update.estado = "EN_RADAR";
        promoted += 1;
      }
      const willFlag = result.score < NOVA_SCORE_THRESHOLD_REVIEW;
      if (willFlag) {
        update.needs_review = true;
        flaggedReview += 1;
      }
      const existingCustom =
        lead.custom_fields && typeof lead.custom_fields === "object"
          ? (lead.custom_fields as Record<string, unknown>)
          : {};
      update.custom_fields = {
        ...existingCustom,
        score_reasoning: result.reasoning,
        score_sub_scores: result.sub_scores,
      };

      await step.run(`update-${lead.id}`, async () => {
        const { error } = await supabase
          .from("leads")
          .update(update)
          .eq("tenant_id", tenantId)
          .eq("id", lead.id);
        if (error) {
          console.error("[nova-score] update failed", lead.id, error);
          throw new Error(`update ${lead.id} failed: ${error.message}`);
        }
      });
    }

    const latencyMs = Date.now() - startedAt;

    // ===== 5. events row =====
    await step.run("record-event", async () => {
      const { error } = await supabase.from("events").insert({
        tenant_id: tenantId,
        kind: "nova.score",
        actor: requestedBy || "nova",
        entity_type: "lead",
        payload: {
          batch_size: pending.length,
          scored: scored.length,
          promoted_to_en_radar: promoted,
          flagged_needs_review: flaggedReview,
          unscored,
          claude_input_tokens: claudeResult.usage.inputTokens,
          claude_output_tokens: claudeResult.usage.outputTokens,
          claude_cost_usd: claudeResult.usage.costUsd,
          claude_latency_ms: claudeResult.usage.latencyMs,
        },
      });
      if (error) console.error("[nova-score] events insert failed", error);
    });

    return {
      pending: pending.length,
      scored: scored.length,
      promoted,
      flagged_review: flaggedReview,
      unscored,
      claude: claudeResult.usage,
      latency_ms: latencyMs,
    };
  },
);
