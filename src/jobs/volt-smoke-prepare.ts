// Volt — preparar smoke test (T024).
//
// Evento: `volt/smoke.prepare.requested` con { tenantId, campaignId,
// requestedBy }. Manual (botón "Preparar smoke" por campaña en
// /campaigns).
//
// Steps:
//   1. load-campaign            — verifica status=draft + smoke_size set
//   2. select-candidates        — selectSmokeCandidates(limit=smoke_size)
//                                  aborta si pool insuficiente
//   3. insert-campaign-leads    — batch upsert (onConflict ignoreDuplicates
//                                  sobre el unique idx activo)
//   4. transition-status        — UPDATE campaigns SET status='smoke_test'
//                                  WHERE id=X AND status='draft' (guard)
//   5. record-event             — cuentas de la selección + inserted/skipped
//
// Concurrency 1 por campaignId (misma key que volt-create-campaign y
// volt-sync-leads → los tres jobs se serializan sobre la misma
// campaña).
//
// NO llama a Lemlist. La creación de la campaña en Lemlist y el push
// de leads se hacen aparte (volt-create-campaign, volt-sync-leads).

import { inngest } from "@/lib/inngest";
import { createSupabaseServiceClient } from "@/lib/supabase/service";
import { selectSmokeCandidates } from "@/lib/volt/candidates";
import { VOLT_SMOKE_MAX_SIZE, VOLT_SMOKE_MIN_SIZE } from "@/config/volt";
import type { Database } from "@/lib/supabase/database.types";

type EventData = {
  tenantId?: unknown;
  campaignId?: unknown;
  requestedBy?: unknown;
};

function parseEventData(raw: unknown): {
  tenantId: string;
  campaignId: string;
  requestedBy: string;
} {
  const data = (raw ?? {}) as EventData;
  return {
    tenantId: typeof data.tenantId === "string" ? data.tenantId : "",
    campaignId: typeof data.campaignId === "string" ? data.campaignId : "",
    requestedBy:
      typeof data.requestedBy === "string" ? data.requestedBy : "volt",
  };
}

// Umbral mínimo de icp_score para entrar en el pool. Alineado con Nova
// T015 (score >= 70 promueve a EN_RADAR). Si algún día se separa el
// gate de scoring del gate de outreach, esto se sube a config.
const MIN_SCORE = 70;
// Máximo de leads por empresa (evidencia Belkins T024: 1-2/cuenta
// mejor reply rate que 10+). Alineado con la spec T024.
const MAX_PER_COMPANY = 2;

type CampaignLeadInsert =
  Database["public"]["Tables"]["campaign_leads"]["Insert"];

export const voltSmokePrepare = inngest.createFunction(
  {
    id: "volt-smoke-prepare",
    triggers: [{ event: "volt/smoke.prepare.requested" }],
    // Serializa por campaignId — dos clicks al mismo botón, o carrera
    // entre prepare y create/sync sobre la misma campaña, se procesan
    // uno detrás de otro.
    concurrency: [{ limit: 1, key: "event.data.campaignId" }],
  },
  async ({ event, step }) => {
    const startedAt = Date.now();
    const { tenantId, campaignId, requestedBy } = parseEventData(event.data);
    if (!tenantId) throw new Error("volt-smoke-prepare: missing tenantId");
    if (!campaignId) throw new Error("volt-smoke-prepare: missing campaignId");

    const supabase = createSupabaseServiceClient();

    // ===== 1. Load campaign =====
    const campaign = await step.run("load-campaign", async () => {
      const { data, error } = await supabase
        .from("campaigns")
        .select("id, status, smoke_size")
        .eq("tenant_id", tenantId)
        .eq("id", campaignId)
        .maybeSingle();
      if (error) throw new Error(`load-campaign failed: ${error.message}`);
      if (!data) throw new Error(`campaign ${campaignId} not found for tenant`);
      if (data.status !== "draft") {
        throw new Error(
          `volt-smoke-prepare: campaign ${campaignId} status='${data.status}' (esperaba 'draft'). Smoke ya preparado o campaña ya en otro estado.`,
        );
      }
      const size = data.smoke_size;
      if (
        typeof size !== "number" ||
        size < VOLT_SMOKE_MIN_SIZE ||
        size > VOLT_SMOKE_MAX_SIZE
      ) {
        throw new Error(
          `volt-smoke-prepare: campaign ${campaignId} smoke_size=${size} fuera de rango [${VOLT_SMOKE_MIN_SIZE}, ${VOLT_SMOKE_MAX_SIZE}]`,
        );
      }
      return { smoke_size: size };
    });

    // ===== 2. Select candidates =====
    const selection = await step.run("select-candidates", async () => {
      const result = await selectSmokeCandidates(supabase, {
        tenantId,
        minScore: MIN_SCORE,
        limit: campaign.smoke_size,
        maxPerCompany: MAX_PER_COMPANY,
      });
      if (result.counts.selected < campaign.smoke_size) {
        const reasonBreakdown = Object.entries(
          result.counts.excluded_by_outreach_exclusions_by_reason,
        )
          .map(([k, v]) => `${k}=${v}`)
          .join(", ");
        throw new Error(
          `volt-smoke-prepare: pool insuficiente. smoke_size=${campaign.smoke_size}, ` +
            `pool_after_base_filters=${result.counts.pool_after_base_filters}, ` +
            `excluded_by_active_campaign=${result.counts.excluded_by_active_campaign}, ` +
            `excluded_by_outreach_exclusions=${result.counts.excluded_by_outreach_exclusions} ` +
            `{${reasonBreakdown || "—"}}, ` +
            `excluded_by_company_cap=${result.counts.excluded_by_company_cap}, ` +
            `selected=${result.counts.selected}. Corre Nova (fetch Vibe) para engordar el pool.`,
        );
      }
      return {
        lead_ids: result.candidates.map((c) => c.id),
        counts: result.counts,
      };
    });

    // ===== 3. Insert campaign_leads (idempotente vía unique idx activo) =====
    const insertResult = await step.run("insert-campaign-leads", async () => {
      const rows: CampaignLeadInsert[] = selection.lead_ids.map((leadId) => ({
        tenant_id: tenantId,
        campaign_id: campaignId,
        lead_id: leadId,
      }));
      // Unique idx: (campaign_id, lead_id) WHERE removed_at IS NULL. Con
      // ignoreDuplicates evitamos error si un lead ya está activo. En un
      // flujo limpio (status=draft, primer prep) esto no debería
      // dispararse, pero es defensivo ante re-runs de Inngest.
      const { data, error } = await supabase
        .from("campaign_leads")
        .upsert(rows, {
          onConflict: "campaign_id,lead_id",
          ignoreDuplicates: true,
        })
        .select("id");
      if (error) {
        throw new Error(`insert-campaign-leads failed: ${error.message}`);
      }
      const inserted = (data ?? []).length;
      return {
        candidatas: rows.length,
        inserted,
        skipped: rows.length - inserted,
      };
    });

    // ===== 4. Transition status draft → smoke_test =====
    const transition = await step.run("transition-status", async () => {
      const { data, error } = await supabase
        .from("campaigns")
        .update({ status: "smoke_test" })
        .eq("tenant_id", tenantId)
        .eq("id", campaignId)
        .eq("status", "draft")
        .select("id");
      if (error) {
        throw new Error(`transition-status failed: ${error.message}`);
      }
      // updated=0 puede pasar en re-runs (otro run ya avanzó el status).
      // No es error.
      return { updated: (data ?? []).length };
    });

    const latencyMs = Date.now() - startedAt;

    // ===== 5. record-event =====
    await step.run("record-event", async () => {
      const { error } = await supabase.from("events").insert({
        tenant_id: tenantId,
        kind: "volt.smoke_prepare",
        actor: requestedBy,
        entity_type: "campaign",
        entity_id: campaignId,
        payload: {
          smoke_size: campaign.smoke_size,
          selection_counts: selection.counts,
          insert: insertResult,
          status_updated: transition.updated,
          latency_ms: latencyMs,
        },
      });
      if (error) console.error("[volt-smoke-prepare] events insert failed", error);
    });

    return {
      smoke_size: campaign.smoke_size,
      selection_counts: selection.counts,
      inserted: insertResult.inserted,
      skipped: insertResult.skipped,
      status_transition_applied: transition.updated > 0,
      latency_ms: latencyMs,
    };
  },
);
