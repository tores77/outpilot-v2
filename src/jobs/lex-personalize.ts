// Lex — personalización pre-envío (T022, refactor tras el fan-out de
// producción del 2026-09-23).
//
// Trigger: evento `lex/personalize.requested` con { tenantId, campaignId,
// requestedBy? }. Manual-only (botón por campaña en /campaigns).
//
// Anti-fan-out (post-mortem):
//   Un solo click generó 9 events porque el botón no daba feedback y el
//   usuario clicó 9 veces. Cada event → 1 run. Sin concurrency + sin
//   claim atómico, los 9 runs leyeron los mismos 2 leads NULL y
//   pagamos 3 llamadas a Haiku para 2 leads. Este fix aporta:
//     1. concurrency: [{ limit: 1, key: "event.data.campaignId" }] —
//        serializa runs por campaña.
//     2. sweep-stale: resetea a NULL cualquier processing con
//        started_at > LEX_STALE_CLAIM_MS.
//     3. claim-pending: UPDATE atómico personalization={state:'processing',
//        started_at} con guard .is(null). Runs posteriores ven 0
//        reclamables y salen limpios.
//     4. process-<id> step POR LEAD (no por lote): un fallo puntual
//        reintenta ese lead, no re-llama a Haiku sobre los ya hechos.
//     5. finalizePersonalization guarda con eq(state,'processing') +
//        eq(started_at, claim_started_at) — nunca pisa otro claim.
//
// La UI (botón de /campaigns) cuenta NULL + processing_stale como
// "pendientes" y muestra "Procesando N…" deshabilitado mientras haya
// processing_active. Eso es lo que corta el fan-out en la raíz.

import { inngest } from "@/lib/inngest";
import { createSupabaseServiceClient } from "@/lib/supabase/service";
import { callClaude } from "@/lib/ai/claude";
import {
  LEX_MAX_PER_TRIGGER,
  LEX_MAX_TOKENS,
  LEX_PERSONALIZATION_VERSION,
  LEX_STALE_CLAIM_MS,
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
import {
  claimPendingLeads,
  finalizePersonalization,
  sweepStaleClaims,
  type ClaimedRow,
} from "@/lib/lex/claim";
import type { Database } from "@/lib/supabase/database.types";

type LeadRow = Database["public"]["Tables"]["leads"]["Row"];
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

type PerLeadOutcome =
  | { kind: "personalized" | "generic"; websiteFetched: boolean; websiteCached: boolean; usage?: { inputTokens: number; outputTokens: number; costUsd: number } }
  | { kind: "error"; websiteFetched: boolean; websiteCached: boolean; error: string }
  | { kind: "lost_race"; websiteFetched: boolean; websiteCached: boolean };

export const lexPersonalize = inngest.createFunction(
  {
    id: "lex-personalize",
    triggers: [{ event: "lex/personalize.requested" }],
    // Serializa runs por campaña. Dos clicks al mismo botón (o dos
    // triggers concurrentes) se procesan uno detrás de otro; nunca
    // en paralelo sobre la misma campaña.
    concurrency: [{ limit: 1, key: "event.data.campaignId" }],
  },
  async ({ event, step }) => {
    const startedAt = Date.now();
    const { tenantId, campaignId, requestedBy } = parseEventData(event.data);
    if (!tenantId) throw new Error("lex-personalize: missing tenantId");
    if (!campaignId) throw new Error("lex-personalize: missing campaignId");

    const supabase = createSupabaseServiceClient();

    // ===== 1. Sweep de claims stuck (opportunistic) =====
    const sweptCount = await step.run("sweep-stale", () =>
      sweepStaleClaims(supabase, {
        tenantId,
        campaignId,
        staleMs: LEX_STALE_CLAIM_MS,
      }),
    );

    // ===== 2. Claim atómico de hasta LEX_MAX_PER_TRIGGER filas =====
    const claimed: ClaimedRow[] = await step.run("claim-pending", () =>
      claimPendingLeads(supabase, {
        tenantId,
        campaignId,
        limit: LEX_MAX_PER_TRIGGER,
      }),
    );

    if (claimed.length === 0) {
      return {
        claimed: 0,
        swept_stale: sweptCount,
        personalized: 0,
        generic: 0,
        website_fetched: 0,
        website_cached: 0,
        errors: 0,
        lost_races: 0,
        latency_ms: Date.now() - startedAt,
      };
    }

    // ===== 3. Un step.run POR LEAD =====
    // Motivación: un reintento de step por un fallo puntual (5xx de
    // Anthropic, timeout de fetch) NO debe re-llamar a Haiku para
    // leads ya procesados en ese trigger. Con step por lead, Inngest
    // memoiza cada uno y solo reintenta el que falló.
    const outcomes: PerLeadOutcome[] = [];
    for (const row of claimed) {
      const outcome = await step.run(
        `process-${row.campaign_lead_id}`,
        () => processLead(supabase, tenantId, row),
      );
      outcomes.push(outcome);
    }

    // ===== 4. Aggregate para events =====
    let personalized = 0;
    let generic = 0;
    let websiteFetched = 0;
    let websiteCached = 0;
    let errors = 0;
    let lostRaces = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCostUsd = 0;

    for (const o of outcomes) {
      if (o.websiteFetched) websiteFetched += 1;
      if (o.websiteCached) websiteCached += 1;
      if (o.kind === "personalized") {
        personalized += 1;
      } else if (o.kind === "generic") {
        generic += 1;
      } else if (o.kind === "lost_race") {
        lostRaces += 1;
      } else {
        errors += 1;
      }
      if ("usage" in o && o.usage) {
        totalInputTokens += o.usage.inputTokens;
        totalOutputTokens += o.usage.outputTokens;
        totalCostUsd += o.usage.costUsd;
      }
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
          claimed: claimed.length,
          swept_stale: sweptCount,
          personalized,
          generic,
          website_fetched: websiteFetched,
          website_cached: websiteCached,
          errors,
          lost_races: lostRaces,
          claude_input_tokens: totalInputTokens,
          claude_output_tokens: totalOutputTokens,
          claude_cost_usd: totalCostUsd,
          latency_ms: latencyMs,
        },
      });
      if (error) console.error("[lex-personalize] events insert failed", error);
    });

    return {
      claimed: claimed.length,
      swept_stale: sweptCount,
      personalized,
      generic,
      website_fetched: websiteFetched,
      website_cached: websiteCached,
      errors,
      lost_races: lostRaces,
      claude: {
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        costUsd: totalCostUsd,
      },
      latency_ms: latencyMs,
    };
  },
);

/**
 * Procesa un solo lead reclamado: cache-check website → fetch si falta
 * → Haiku → gate mecánico → finalize con guard state='processing' +
 * started_at coincidente. Devuelve el outcome para el events log.
 *
 * Aislado en función independiente para que sea:
 *   - Ejecutable como un step.run (retornable serializable).
 *   - Testeable (aunque las dependencias supabase/claude son reales,
 *     el flow es aislado por lead).
 */
async function processLead(
  supabase: ReturnType<typeof createSupabaseServiceClient>,
  tenantId: string,
  row: ClaimedRow,
): Promise<PerLeadOutcome> {
  const { campaign_lead_id, lead, claim_started_at } = row;

  let websiteSummary: WebsiteSummary | null = null;
  let websiteFetched = false;
  let websiteCached = false;

  try {
    // 1. Cache-check website summary.
    const cached = readCachedWebsiteSummary(lead.custom_fields);
    if (cached) {
      websiteSummary = cached;
      websiteCached = true;
    } else if (lead.website && lead.website.trim().length > 0) {
      websiteSummary = await fetchWebsiteSummary(lead.website);
      websiteFetched = true;
      // Cache en leads.custom_fields.website_summary.
      const existingCustom =
        lead.custom_fields && typeof lead.custom_fields === "object"
          ? (lead.custom_fields as Record<string, unknown>)
          : {};
      const leadUpdate: LeadUpdate = {
        custom_fields: { ...existingCustom, website_summary: websiteSummary },
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

    // 2. Compose prompt.
    const leadForLex = leadForLexFromRow(lead, websiteSummary);
    const fieldMap = buildLeadFieldMap(leadForLex);
    const userPrompt = buildUserPrompt(leadForLex);

    // 3. Haiku via wrapper (registra api_costs).
    const claudeResult = await callClaude({
      task: "lex.personalize",
      tenantId,
      system: LEX_SYSTEM_PROMPT,
      maxTokens: LEX_MAX_TOKENS,
      messages: [{ role: "user", content: userPrompt }],
    });

    if (!claudeResult.ok) {
      return {
        kind: "error",
        websiteFetched,
        websiteCached,
        error: `${claudeResult.code}: ${claudeResult.error}`,
      };
    }

    // 4. Parse + gate mecánico.
    const parsedResponse = parseLexResponse(claudeResult.text);
    const gated = applyFieldGate(parsedResponse, fieldMap);

    // 5. Finalize con doble guard (state='processing' + started_at).
    const finalPayload = {
      version: LEX_PERSONALIZATION_VERSION,
      opener: gated.opener,
      personalization: gated.personalization,
      fields_used: gated.fields_used,
      company_display: gated.company_display,
      reason_if_generic: gated.reason_if_generic,
      model: claudeResult.usage.model,
      generated_at: new Date().toISOString(),
    };

    const wrote = await finalizePersonalization(supabase, {
      tenantId,
      campaignLeadId: campaign_lead_id,
      claimStartedAt: claim_started_at,
      payload: finalPayload,
    });

    if (!wrote) {
      // Alguien reseteó nuestro claim (sweep + reclaim de otro run).
      // No pasa nada: el otro run persistirá su resultado.
      return { kind: "lost_race", websiteFetched, websiteCached };
    }

    return {
      kind: gated.personalization === "personalized" ? "personalized" : "generic",
      websiteFetched,
      websiteCached,
      usage: {
        inputTokens: claudeResult.usage.inputTokens,
        outputTokens: claudeResult.usage.outputTokens,
        costUsd: claudeResult.usage.costUsd,
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[lex-personalize] processLead threw", campaign_lead_id, msg);
    return { kind: "error", websiteFetched, websiteCached, error: msg };
  }
}
