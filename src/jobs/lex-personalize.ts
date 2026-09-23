// Lex — personalización pre-envío (T022).
//
// Trigger: evento `lex/personalize.requested` con { tenantId, campaignId,
// requestedBy? }. Manual-only (botón por campaña en /campaigns).
//
// Flujo por trigger:
//   1. Lee hasta LEX_MAX_PER_TRIGGER campaign_leads con personalization
//      IS NULL para (tenantId, campaignId), JOIN con leads.
//   2. Divide en batches de LEX_BATCH_SIZE (dentro de un step.run cada
//      batch, para retry aislado).
//   3. Por cada lead del batch, en serie:
//      a. Website summary: si custom_fields.website_summary está
//         cacheado y fetched_at es más nuevo que LEX_WEBSITE_CACHE_TTL_DAYS,
//         se reusa. Si no, fetch (respetando robots.txt), actualiza
//         leads.custom_fields.
//      b. Compone lead field map (fuente única para prompt y para el
//         gate mecánico de fields_used).
//      c. Llama a Haiku (task lex.personalize) con system + user
//         prompts. api_costs se registra automáticamente en el wrapper.
//      d. Parsea la respuesta (tolerante). Aplica gate mecánico:
//         cualquier fields_used citado que estuviera vacío degrada a
//         "generic" con reason cited_empty_field.
//      e. UPDATE campaign_leads.personalization solo si sigue NULL
//         (idempotencia — dos triggers concurrentes no se pisan).
//   4. Registra un events row con estadísticas del batch.

import { inngest } from "@/lib/inngest";
import { createSupabaseServiceClient } from "@/lib/supabase/service";
import { callClaude } from "@/lib/ai/claude";
import {
  LEX_BATCH_SIZE,
  LEX_MAX_PER_TRIGGER,
  LEX_MAX_TOKENS,
  LEX_PERSONALIZATION_VERSION,
  LEX_WEBSITE_CACHE_TTL_DAYS,
} from "@/config/lex";
import {
  buildLeadFieldMap,
  buildUserPrompt,
  LEX_SYSTEM_PROMPT,
  type LeadForLex,
} from "@/lib/lex/prompt";
import { applyFieldGate, parseLexResponse } from "@/lib/lex/response";
import { fetchWebsiteSummary, type WebsiteSummary } from "@/lib/lex/website";
import type { Database } from "@/lib/supabase/database.types";

type LeadRow = Database["public"]["Tables"]["leads"]["Row"];
type CampaignLeadUpdate =
  Database["public"]["Tables"]["campaign_leads"]["Update"];
type LeadUpdate = Database["public"]["Tables"]["leads"]["Update"];

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
      typeof data.requestedBy === "string" ? data.requestedBy : "lex",
  };
}

type PendingRow = {
  campaign_lead_id: string;
  lead: LeadRow;
};

function isCacheFresh(fetchedAt: string | undefined): boolean {
  if (!fetchedAt) return false;
  const then = Date.parse(fetchedAt);
  if (!Number.isFinite(then)) return false;
  const ageMs = Date.now() - then;
  return ageMs < LEX_WEBSITE_CACHE_TTL_DAYS * 24 * 60 * 60 * 1000;
}

function readCachedWebsiteSummary(
  customFields: unknown,
): WebsiteSummary | null {
  if (!customFields || typeof customFields !== "object") return null;
  const raw = (customFields as Record<string, unknown>).website_summary;
  if (!raw || typeof raw !== "object") return null;
  const ws = raw as Partial<WebsiteSummary>;
  if (typeof ws.url !== "string" || typeof ws.status !== "string") return null;
  if (typeof ws.fetched_at !== "string") return null;
  if (typeof ws.summary !== "string") return null;
  if (!isCacheFresh(ws.fetched_at)) return null;
  return ws as WebsiteSummary;
}

function leadForLexFromRow(
  lead: LeadRow,
  websiteSummary: WebsiteSummary | null,
): LeadForLex {
  return {
    firstName: lead.first_name,
    lastName: lead.last_name,
    company: lead.company,
    title: lead.title,
    sector: lead.sector,
    country: lead.country,
    city: lead.city,
    website: lead.website,
    linkedin: lead.linkedin_url,
    websiteSummary,
  };
}

export const lexPersonalize = inngest.createFunction(
  {
    id: "lex-personalize",
    triggers: [{ event: "lex/personalize.requested" }],
  },
  async ({ event, step }) => {
    const startedAt = Date.now();
    const { tenantId, campaignId, requestedBy } = parseEventData(event.data);
    if (!tenantId) throw new Error("lex-personalize: missing tenantId");
    if (!campaignId) throw new Error("lex-personalize: missing campaignId");

    const supabase = createSupabaseServiceClient();

    // ===== 1. Fetch pending campaign_leads + join leads =====
    const pending: PendingRow[] = await step.run("fetch-pending", async () => {
      const { data, error } = await supabase
        .from("campaign_leads")
        .select("id, lead:leads!inner(*)")
        .eq("tenant_id", tenantId)
        .eq("campaign_id", campaignId)
        .is("personalization", null)
        .is("removed_at", null)
        .order("added_at", { ascending: true })
        .limit(LEX_MAX_PER_TRIGGER);
      if (error) {
        console.error("[lex-personalize] fetch failed", error);
        throw new Error(`fetch failed: ${error.message}`);
      }
      return (data ?? []).map((row) => ({
        campaign_lead_id: row.id,
        lead: row.lead as unknown as LeadRow,
      }));
    });

    if (pending.length === 0) {
      return {
        pending: 0,
        personalized: 0,
        generic: 0,
        website_fetched: 0,
        website_cached: 0,
        errors: 0,
        latency_ms: Date.now() - startedAt,
      };
    }

    // ===== 2. Batches =====
    let personalized = 0;
    let generic = 0;
    let websiteFetched = 0;
    let websiteCached = 0;
    let errors = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCostUsd = 0;

    for (let batchStart = 0; batchStart < pending.length; batchStart += LEX_BATCH_SIZE) {
      const batchIdx = Math.floor(batchStart / LEX_BATCH_SIZE);
      const batch = pending.slice(batchStart, batchStart + LEX_BATCH_SIZE);

      const batchSummary = await step.run(`batch-${batchIdx}`, async () => {
        const stats = {
          personalized: 0,
          generic: 0,
          websiteFetched: 0,
          websiteCached: 0,
          errors: 0,
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
        };

        for (const { campaign_lead_id, lead } of batch) {
          try {
            // 3a. Website summary (cache or fetch).
            let ws = readCachedWebsiteSummary(lead.custom_fields);
            if (ws) {
              stats.websiteCached += 1;
            } else if (lead.website && lead.website.trim().length > 0) {
              ws = await fetchWebsiteSummary(lead.website);
              stats.websiteFetched += 1;
              // Cache en leads.custom_fields.website_summary.
              const existingCustom =
                lead.custom_fields && typeof lead.custom_fields === "object"
                  ? (lead.custom_fields as Record<string, unknown>)
                  : {};
              const leadUpdate: LeadUpdate = {
                custom_fields: { ...existingCustom, website_summary: ws },
              };
              const { error: cacheErr } = await supabase
                .from("leads")
                .update(leadUpdate)
                .eq("tenant_id", tenantId)
                .eq("id", lead.id);
              if (cacheErr) {
                console.error(
                  "[lex-personalize] website cache write failed",
                  lead.id,
                  cacheErr,
                );
              }
            }

            // 3b. Field map (fuente única).
            const leadForLex = leadForLexFromRow(lead, ws);
            const fieldMap = buildLeadFieldMap(leadForLex);
            const userPrompt = buildUserPrompt(leadForLex);

            // 3c. Haiku via wrapper (registra api_costs).
            const claudeResult = await callClaude({
              task: "lex.personalize",
              tenantId,
              system: LEX_SYSTEM_PROMPT,
              maxTokens: LEX_MAX_TOKENS,
              messages: [{ role: "user", content: userPrompt }],
            });

            if (!claudeResult.ok) {
              console.error(
                "[lex-personalize] claude failed",
                lead.id,
                claudeResult.code,
                claudeResult.error,
              );
              stats.errors += 1;
              continue;
            }

            stats.inputTokens += claudeResult.usage.inputTokens;
            stats.outputTokens += claudeResult.usage.outputTokens;
            stats.costUsd += claudeResult.usage.costUsd;

            // 3d. Parse + gate mecánico.
            const parsedResponse = parseLexResponse(claudeResult.text);
            const gated = applyFieldGate(parsedResponse, fieldMap);

            // 3e. Update solo si sigue NULL (idempotencia).
            const personalizationPayload = {
              version: LEX_PERSONALIZATION_VERSION,
              opener: gated.opener,
              personalization: gated.personalization,
              fields_used: gated.fields_used,
              reason_if_generic: gated.reason_if_generic,
              model: claudeResult.usage.model,
              generated_at: new Date().toISOString(),
            };

            const clUpdate: CampaignLeadUpdate = {
              personalization: personalizationPayload,
            };

            const { error: updErr, count } = await supabase
              .from("campaign_leads")
              .update(clUpdate, { count: "exact" })
              .eq("tenant_id", tenantId)
              .eq("id", campaign_lead_id)
              .is("personalization", null);

            if (updErr) {
              console.error(
                "[lex-personalize] update failed",
                campaign_lead_id,
                updErr,
              );
              stats.errors += 1;
              continue;
            }
            if (count === 0) {
              // Alguien lo actualizó en paralelo — ignoramos.
              continue;
            }

            if (gated.personalization === "personalized") stats.personalized += 1;
            else stats.generic += 1;
          } catch (err) {
            console.error(
              "[lex-personalize] unexpected error",
              campaign_lead_id,
              err,
            );
            stats.errors += 1;
          }
        }

        return stats;
      });

      personalized += batchSummary.personalized;
      generic += batchSummary.generic;
      websiteFetched += batchSummary.websiteFetched;
      websiteCached += batchSummary.websiteCached;
      errors += batchSummary.errors;
      totalInputTokens += batchSummary.inputTokens;
      totalOutputTokens += batchSummary.outputTokens;
      totalCostUsd += batchSummary.costUsd;
    }

    const latencyMs = Date.now() - startedAt;

    await step.run("record-event", async () => {
      const { error } = await supabase.from("events").insert({
        tenant_id: tenantId,
        kind: "lex.personalize",
        actor: requestedBy,
        entity_type: "campaign",
        entity_id: campaignId,
        payload: {
          batch_pending: pending.length,
          personalized,
          generic,
          website_fetched: websiteFetched,
          website_cached: websiteCached,
          errors,
          claude_input_tokens: totalInputTokens,
          claude_output_tokens: totalOutputTokens,
          claude_cost_usd: totalCostUsd,
          latency_ms: latencyMs,
        },
      });
      if (error) console.error("[lex-personalize] events insert failed", error);
    });

    return {
      pending: pending.length,
      personalized,
      generic,
      website_fetched: websiteFetched,
      website_cached: websiteCached,
      errors,
      claude: {
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        costUsd: totalCostUsd,
      },
      latency_ms: latencyMs,
    };
  },
);
