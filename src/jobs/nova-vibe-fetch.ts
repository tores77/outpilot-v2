// Nova bulk fetch from Vibe/Explorium.
// Fase 1 · T014 (rewritten after 3 contract-probe rounds).
//
// Trigger: event `nova/vibe.fetch.requested`. MANUAL-ONLY — dispatched by
// executeFetchAction in /radar/vibe after the human confirms the estimate.
// No cron. Never dispatched by another job.
//
// Flow (each step is a step.run so Inngest retries them idempotently):
//
//   1. FETCH pages (page_size=100, up to VIBE_MAX_LEADS_PER_FETCH) with
//      the full server-side filter set: country_code + job_level +
//      company_size + linkedin_category. Each lead delivered costs
//      VIBE_CREDITS_PER_LEAD_FETCH credit(s).
//   2. MAP prospects -> LeadDraft. Email is left NULL here — /prospects
//      returns professional_email_hashed only.
//   3. CLEANUP (T013): dedupe by normalised company keeping the
//      highest-ranked title. isGenericEmail is skipped for now (no
//      email yet); it runs again after enrich.
//   4. SENIORITY belt-and-braces: drop rows above the requested maxRank
//      even though we already sent job_level server-side.
//   5. ENRICH survivors in batches of 50 via bulk_enrich. Each prospect_id
//      costs VIBE_CREDITS_PER_LEAD_ENRICH credit(s).
//   6. MERGE contact into each survivor. Drop rows with no email or
//      status !== "valid" — a lead without a verified email cannot enter
//      a Volt sequence and would only pollute Radar.
//   7. RE-CHECK isGenericEmail on enriched emails; flag needs_review.
//   8. UPSERT with source='vibe_prospecting', ignoreDuplicates.
//   9. Record TWO api_costs rows (fetch + enrich) so the Daily Brief can
//      split the spend by task; write ONE events row with the full
//      breakdown and cost_source: 'estimated'.

import { inngest } from "@/lib/inngest";
import { createSupabaseServiceClient } from "@/lib/supabase/service";
import {
  bulkEnrichContacts,
  fetchProspectsPage,
} from "@/lib/vibe/client";
import {
  extractFetchProspects,
  indexEnrichResponseByProspectId,
  mapProspectToLeadDraft,
  mergeEnrichedContact,
} from "@/lib/vibe/mapper";
import {
  cleanupLeadBatch,
  isGenericEmail,
  titleRank,
  type LeadDraft,
} from "@/lib/nova/cleanup";
import {
  VIBE_COMPANY_SIZE_VALUES,
  VIBE_CREDITS_PER_LEAD_ENRICH,
  VIBE_CREDITS_PER_LEAD_FETCH,
  VIBE_ENRICH_BATCH_SIZE,
  VIBE_FETCH_MODE,
  VIBE_INTER_PAGE_DELAY_MS,
  VIBE_MAX_LEADS_PER_FETCH,
  VIBE_PAGE_SIZE,
  jobLevelsFor,
  linkedinCategoriesFor,
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
} {
  const data = (raw ?? {}) as EventData;
  const tenantId = typeof data.tenantId === "string" ? data.tenantId : "";
  const requestedBy =
    typeof data.requestedBy === "string" ? data.requestedBy : "";
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
  return { tenantId, requestedBy, countries, sectors, seniority, limit };
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
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

    // Server-side filter set (all validated in probe rounds 2 & 3).
    const jobLevels = jobLevelsFor(params.seniority);
    const linkedinCategories = linkedinCategoriesFor(params.sectors);
    const serverFilters = {
      country_code: { values: params.countries },
      job_level: { values: jobLevels },
      company_size: { values: [...VIBE_COMPANY_SIZE_VALUES] },
      ...(linkedinCategories.length > 0
        ? { linkedin_category: { values: linkedinCategories } }
        : {}),
    };

    // ===== 1. FETCH pages =====
    const totalPages = Math.ceil(params.limit / VIBE_PAGE_SIZE);
    const drafts: LeadDraft[] = [];
    let fetchedFromApi = 0;
    const fetchStartedAt = Date.now();

    for (let page = 1; page <= totalPages; page++) {
      const remaining = params.limit - drafts.length;
      if (remaining <= 0) break;
      const pageSize = Math.min(VIBE_PAGE_SIZE, remaining);

      const pageResult = await step.run(`fetch-page-${page}`, async () => {
        const response = await fetchProspectsPage({
          mode: VIBE_FETCH_MODE,
          filters: serverFilters,
          page,
          page_size: pageSize,
        });
        const prospects = extractFetchProspects(response);
        return {
          count: prospects.length,
          drafts: prospects
            .map((p) => mapProspectToLeadDraft(p))
            .filter((d): d is LeadDraft => d !== null),
        };
      });

      fetchedFromApi += pageResult.count;
      for (const d of pageResult.drafts) drafts.push(d);

      if (pageResult.count < pageSize) break;
      if (page < totalPages) {
        await new Promise((r) => setTimeout(r, VIBE_INTER_PAGE_DELAY_MS));
      }
    }

    const fetchLatencyMs = Date.now() - fetchStartedAt;
    const fetchCreditsSpent = fetchedFromApi * VIBE_CREDITS_PER_LEAD_FETCH;

    // ===== 2. CLEANUP (dedupe by company; email pass is skipped here) =====
    const cleanup = cleanupLeadBatch(drafts);

    // ===== 3. SENIORITY belt-and-braces =====
    const maxRank = maxRankFor(params.seniority);
    const afterSeniority = cleanup.clean.filter(
      (r) => titleRank(r.title) <= maxRank,
    );
    const droppedBySeniority = cleanup.clean.length - afterSeniority.length;

    // ===== 4. ENRICH surviving prospect_ids in batches =====
    const survivorsById = new Map<string, LeadDraft>();
    for (const draft of afterSeniority) {
      const pid = draft.custom_fields?.prospect_id;
      if (typeof pid === "string" && pid.length > 0) {
        survivorsById.set(pid, draft);
      }
    }

    const batches = chunk([...survivorsById.keys()], VIBE_ENRICH_BATCH_SIZE);
    const enrichedById = new Map<string, ReturnType<typeof mergeEnrichedContact>>();
    let enrichRequestsSent = 0;
    let enrichContactsReturned = 0;
    const enrichStartedAt = Date.now();

    for (let i = 0; i < batches.length; i++) {
      const prospectIds = batches[i];
      const result = await step.run(`enrich-batch-${i + 1}`, async () => {
        const response = await bulkEnrichContacts({ prospect_ids: prospectIds });
        const indexed = indexEnrichResponseByProspectId(response);
        const outcomes: Record<string, ReturnType<typeof mergeEnrichedContact>> = {};
        let contactsReturned = 0;
        for (const pid of prospectIds) {
          const item = indexed.get(pid);
          if (!item) {
            outcomes[pid] = { ok: false, reason: "no_contact_block" };
            continue;
          }
          contactsReturned += 1;
          const draft = survivorsById.get(pid);
          if (!draft) continue; // should never happen — id came from the map
          outcomes[pid] = mergeEnrichedContact(draft, item);
        }
        return { outcomes, contactsReturned, requested: prospectIds.length };
      });

      enrichRequestsSent += result.requested;
      enrichContactsReturned += result.contactsReturned;
      for (const [pid, outcome] of Object.entries(result.outcomes)) {
        enrichedById.set(pid, outcome);
      }
    }

    const enrichLatencyMs = Date.now() - enrichStartedAt;
    const enrichCreditsSpent = enrichRequestsSent * VIBE_CREDITS_PER_LEAD_ENRICH;

    // ===== 5. Merge outcomes + re-check generic email =====
    const rows: LeadInsert[] = [];
    let enrichedOk = 0;
    let enrichNoEmail = 0;
    let enrichInvalidStatus = 0;
    let markedReview = 0;

    for (const [pid, outcome] of enrichedById) {
      if (!outcome.ok) {
        if (outcome.reason === "invalid_status") enrichInvalidStatus += 1;
        else enrichNoEmail += 1;
        continue;
      }
      enrichedOk += 1;
      const draft = outcome.draft;
      if (!draft.email) {
        enrichNoEmail += 1;
        continue;
      }
      const needsReview = isGenericEmail(draft.email);
      if (needsReview) markedReview += 1;

      rows.push({
        tenant_id: params.tenantId,
        email: draft.email,
        first_name: draft.first_name ?? null,
        last_name: draft.last_name ?? null,
        company: draft.company ?? null,
        title: draft.title ?? null,
        phone: draft.phone ?? null,
        linkedin_url: draft.linkedin_url ?? null,
        website: draft.website ?? null,
        sector: draft.sector ?? null,
        country: draft.country ?? null,
        city: draft.city ?? null,
        source: "vibe_prospecting",
        needs_review: needsReview,
        custom_fields: {
          ...(draft.custom_fields ?? {}),
          prospect_id: pid,
        },
      });
    }

    // ===== 6. UPSERT =====
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

    const totalLatencyMs = Date.now() - startedAt;

    // ===== 7. api_costs: TWO rows so the Daily Brief can split =====
    await step.run("record-cost-fetch", async () => {
      const { error } = await supabase.from("api_costs").insert({
        tenant_id: params.tenantId,
        task: "nova.vibe_fetch",
        model: "vibe_prospecting",
        tokens_in: 0,
        tokens_out: fetchedFromApi,
        cost_usd: fetchCreditsSpent,
        latency_ms: fetchLatencyMs,
      });
      if (error) console.error("[nova-vibe-fetch] api_costs(fetch) failed", error);
    });

    await step.run("record-cost-enrich", async () => {
      const { error } = await supabase.from("api_costs").insert({
        tenant_id: params.tenantId,
        task: "nova.vibe_enrich",
        model: "vibe_prospecting",
        tokens_in: enrichRequestsSent,
        tokens_out: enrichContactsReturned,
        cost_usd: enrichCreditsSpent,
        latency_ms: enrichLatencyMs,
      });
      if (error) console.error("[nova-vibe-fetch] api_costs(enrich) failed", error);
    });

    // ===== 8. events row with the full run context =====
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
            job_levels_sent: jobLevels,
            linkedin_categories_sent: linkedinCategories,
            company_size_sent: [...VIBE_COMPANY_SIZE_VALUES],
          },
          fetched_from_api: fetchedFromApi,
          drafts_after_mapping: drafts.length,
          kept_after_cleanup: cleanup.clean.length,
          dropped_by_dedupe: cleanup.stats.dropped_dedupe,
          dropped_by_seniority: droppedBySeniority,
          enriched_ok: enrichedOk,
          enrich_no_email: enrichNoEmail,
          enrich_invalid_status: enrichInvalidStatus,
          marked_review: markedReview,
          inserted,
          cost_fetch_credits: fetchCreditsSpent,
          cost_enrich_credits: enrichCreditsSpent,
          cost_total_credits: fetchCreditsSpent + enrichCreditsSpent,
          cost_source: "estimated",
        },
      });
      if (error) console.error("[nova-vibe-fetch] events insert failed", error);
    });

    return {
      fetched_from_api: fetchedFromApi,
      kept_after_cleanup: cleanup.clean.length,
      dropped_by_dedupe: cleanup.stats.dropped_dedupe,
      dropped_by_seniority: droppedBySeniority,
      enriched_ok: enrichedOk,
      enrich_no_email: enrichNoEmail,
      enrich_invalid_status: enrichInvalidStatus,
      marked_review: markedReview,
      inserted,
      cost_fetch_credits: fetchCreditsSpent,
      cost_enrich_credits: enrichCreditsSpent,
      cost_total_credits: fetchCreditsSpent + enrichCreditsSpent,
      latency_ms: totalLatencyMs,
    };
  },
);
