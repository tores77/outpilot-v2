// Nova bulk fetch from Vibe/Explorium.
// Fase 1 · T014.
//
// Trigger: event `nova/vibe.fetch.requested`. MANUAL-ONLY — dispatched by
// the executeFetchAction in /radar/vibe after the human confirms the
// estimation. No cron. Never dispatched by another job.
//
// Flow per invocation:
//   1. loop pages (page_size=100, up to VIBE_MAX_LEADS_PER_FETCH)
//   2. map prospects -> LeadDraft (assumed shape; see mapper.ts)
//   3. run cleanupLeadBatch (T013) to dedupe by company + flag REVIEW
//   4. apply post-fetch seniority filter (drop rows above maxRank)
//   5. upsert into leads with source='vibe_prospecting', ignore duplicates
//   6. write to api_costs (task='nova.vibe_fetch', model='vibe_prospecting',
//      cost_usd stores the estimate — real cost lives in Vibe's account
//      dashboard, and events.payload records cost_source: 'estimated')
//   7. write to events (kind='nova.vibe_fetch') with the full context.
//
// If any page throws, the job fails and Inngest retries it. Partial data
// that was already upserted stays in the DB; the retry starts from page 1
// but the upsert onConflict handles idempotency.

import { inngest } from "@/lib/inngest";
import { createSupabaseServiceClient } from "@/lib/supabase/service";
import { fetchProspectsPage } from "@/lib/vibe/client";
import { extractProspects, mapProspectToLeadDraft } from "@/lib/vibe/mapper";
import { cleanupLeadBatch, titleRank, type LeadDraft } from "@/lib/nova/cleanup";
import {
  VIBE_CREDITS_PER_LEAD_ESTIMATE,
  VIBE_INTER_PAGE_DELAY_MS,
  VIBE_MAX_LEADS_PER_FETCH,
  VIBE_PAGE_SIZE,
  maxRankFor,
} from "@/config/vibe";
import type { Database } from "@/lib/supabase/database.types";

type LeadInsert = Database["public"]["Tables"]["leads"]["Insert"];

type EventData = {
  tenantId?: unknown;
  requestedBy?: unknown;
  filters?: {
    countries?: unknown;
    sectors?: unknown;
    seniority?: unknown;
    limit?: unknown;
  };
  estimatedCredits?: unknown;
};

function parseEventData(raw: unknown): {
  tenantId: string;
  requestedBy: string;
  countries: string[];
  sectors: string[];
  seniority: string;
  limit: number;
  estimatedCredits: number;
} {
  const data = (raw ?? {}) as EventData;
  const tenantId = typeof data.tenantId === "string" ? data.tenantId : "";
  const requestedBy = typeof data.requestedBy === "string" ? data.requestedBy : "";
  const filters = data.filters ?? {};
  const countries = Array.isArray(filters.countries)
    ? filters.countries.filter((v): v is string => typeof v === "string")
    : [];
  const sectors = Array.isArray(filters.sectors)
    ? filters.sectors.filter((v): v is string => typeof v === "string")
    : [];
  const seniority =
    typeof filters.seniority === "string" ? filters.seniority : "director";
  const limitRaw = typeof filters.limit === "number" ? filters.limit : 0;
  const limit = Math.min(
    Math.max(Math.floor(limitRaw), 1),
    VIBE_MAX_LEADS_PER_FETCH,
  );
  const estimatedCredits =
    typeof data.estimatedCredits === "number"
      ? data.estimatedCredits
      : limit * VIBE_CREDITS_PER_LEAD_ESTIMATE;
  return {
    tenantId,
    requestedBy,
    countries,
    sectors,
    seniority,
    limit,
    estimatedCredits,
  };
}

export const novaVibeFetch = inngest.createFunction(
  {
    id: "nova-vibe-fetch",
    triggers: [{ event: "nova/vibe.fetch.requested" }],
  },
  async ({ event, step }) => {
    const startedAt = Date.now();
    const params = parseEventData(event.data);
    if (!params.tenantId || params.countries.length === 0) {
      throw new Error("nova-vibe-fetch: invalid event data");
    }

    const supabase = createSupabaseServiceClient();

    // 1-2. Fetch pages and map to LeadDraft.
    const totalPages = Math.ceil(params.limit / VIBE_PAGE_SIZE);
    const drafts: LeadDraft[] = [];
    let fetchedFromApi = 0;

    for (let page = 1; page <= totalPages; page++) {
      const remaining = params.limit - drafts.length;
      if (remaining <= 0) break;
      const pageSize = Math.min(VIBE_PAGE_SIZE, remaining);

      const response = await step.run(`fetch-page-${page}`, () =>
        fetchProspectsPage({
          filters: { country_code: { values: params.countries } },
          page,
          page_size: pageSize,
        }),
      );

      const prospects = extractProspects(response);
      fetchedFromApi += prospects.length;
      for (const p of prospects) {
        const draft = mapProspectToLeadDraft(p);
        if (draft) drafts.push(draft);
      }

      if (prospects.length < pageSize) break; // no more results
      if (page < totalPages) {
        await new Promise((r) => setTimeout(r, VIBE_INTER_PAGE_DELAY_MS));
      }
    }

    // 3. Cleanup pipeline (dedupe + REVIEW flag).
    const cleanup = cleanupLeadBatch(drafts);

    // 4. Post-fetch seniority filter — drop rows whose titleRank exceeds
    //    the requested maxRank. Rows without a title (rank 100) fall out
    //    unless seniority accepts them.
    const maxRank = maxRankFor(params.seniority);
    const acceptedByRank = cleanup.clean.filter(
      (r) => titleRank(r.title) <= maxRank,
    );
    const droppedByRank = cleanup.clean.length - acceptedByRank.length;

    // 5. Upsert (idempotent).
    const rows: LeadInsert[] = acceptedByRank.map((clean) => ({
      tenant_id: params.tenantId,
      email: clean.email,
      first_name: clean.first_name ?? null,
      last_name: clean.last_name ?? null,
      company: clean.company ?? null,
      title: clean.title ?? null,
      phone: clean.phone ?? null,
      linkedin_url: clean.linkedin_url ?? null,
      website: clean.website ?? null,
      sector: clean.sector ?? null,
      country: clean.country ?? null,
      city: clean.city ?? null,
      source: "vibe_prospecting",
      needs_review: clean.needs_review,
      custom_fields: clean.custom_fields ?? {},
    }));

    let inserted = 0;
    if (rows.length > 0) {
      inserted = await step.run("upsert-leads", async () => {
        const { data, error } = await supabase
          .from("leads")
          .upsert(rows, { onConflict: "tenant_id,email", ignoreDuplicates: true })
          .select("id");
        if (error) {
          console.error("[nova-vibe-fetch] upsert failed", error);
          throw new Error(`upsert failed: ${error.message}`);
        }
        return data?.length ?? 0;
      });
    }

    const latencyMs = Date.now() - startedAt;

    // 6. api_costs. Non-Claude row on purpose: task/model are text columns,
    //    api_costs is the single cost ledger the Daily Brief reads.
    await step.run("record-api-cost", async () => {
      const { error } = await supabase
        .from("api_costs")
        .insert({
          tenant_id: params.tenantId,
          task: "nova.vibe_fetch",
          model: "vibe_prospecting",
          tokens_in: 0,
          tokens_out: inserted,
          cost_usd: params.estimatedCredits,
          latency_ms: latencyMs,
        });
      if (error) console.error("[nova-vibe-fetch] api_costs insert failed", error);
    });

    // 7. events row with the full run context.
    await step.run("record-event", async () => {
      const { error } = await supabase.from("events").insert({
        tenant_id: params.tenantId,
        kind: "nova.vibe_fetch",
        actor: params.requestedBy || "nova",
        entity_type: "lead",
        payload: {
          filters: {
            countries: params.countries,
            sectors: params.sectors,
            seniority: params.seniority,
            limit: params.limit,
          },
          fetched_from_api: fetchedFromApi,
          drafts_after_mapping: drafts.length,
          kept_after_cleanup: cleanup.clean.length,
          dropped_by_dedupe: cleanup.stats.dropped_dedupe,
          dropped_by_seniority: droppedByRank,
          marked_review: cleanup.stats.marked_review,
          inserted,
          estimated_credits: params.estimatedCredits,
          cost_source: "estimated",
        },
      });
      if (error) console.error("[nova-vibe-fetch] events insert failed", error);
    });

    return {
      fetched_from_api: fetchedFromApi,
      drafts_after_mapping: drafts.length,
      kept_after_cleanup: cleanup.clean.length,
      dropped_by_dedupe: cleanup.stats.dropped_dedupe,
      dropped_by_seniority: droppedByRank,
      marked_review: cleanup.stats.marked_review,
      inserted,
      estimated_credits: params.estimatedCredits,
      latency_ms: latencyMs,
    };
  },
);
