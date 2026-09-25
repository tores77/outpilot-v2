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
  enrichBusiness,
  fetchProspectsPage,
  getCreditsBalance,
} from "@/lib/vibe/client";
import {
  extractFetchProspects,
  indexEnrichResponseByProspectId,
  mapProspectToLeadDraft,
  mergeBusinessFirmographics,
  mergeEnrichedContact,
} from "@/lib/vibe/mapper";
import {
  cleanupLeadBatch,
  isGenericEmail,
  titleRank,
  type LeadDraft,
} from "@/lib/nova/cleanup";
import {
  VIBE_CREDITS_PER_BUSINESS_ENRICH,
  VIBE_CREDITS_PER_LEAD_ENRICH,
  VIBE_CREDITS_PER_LEAD_FETCH,
  VIBE_ENRICH_BATCH_SIZE,
  VIBE_FETCH_MODE,
  VIBE_INTER_PAGE_DELAY_MS,
  VIBE_MAX_LEADS_PER_FETCH,
  VIBE_PAGE_SIZE,
  VIBE_SMOKE_MAX_TITLE_RANK,
  estimateCredits,
} from "@/config/vibe";
import type {
  VibeApiFilters,
  VibeBusinessData as VibeBusinessDataMinimal,
} from "@/lib/vibe/types";
import type { Database } from "@/lib/supabase/database.types";

type LeadInsert = Database["public"]["Tables"]["leads"]["Insert"];

// T024: el evento lleva icpSlug + países (editables en /radar/vibe) +
// limit + apiFilters ya resueltos (los que la server action envió al
// endpoint de stats y son los que enviaremos al fetch real, para que
// matches y fetch coincidan). El job NO vuelve a resolver desde el
// ICP para evitar drift si Pere cambia icps.ts entre el estimate y
// el execute del mismo run.
type EventData = {
  tenantId?: unknown;
  requestedBy?: unknown;
  filters?: {
    icpSlug?: unknown;
    countries?: unknown;
    limit?: unknown;
    apiFilters?: unknown;
  };
  estimatedCredits?: unknown;
};

function parseEventData(raw: unknown): {
  tenantId: string;
  requestedBy: string;
  icpSlug: string;
  countries: string[];
  limit: number;
  apiFilters: VibeApiFilters;
} {
  const data = (raw ?? {}) as EventData;
  const tenantId = typeof data.tenantId === "string" ? data.tenantId : "";
  const requestedBy =
    typeof data.requestedBy === "string" ? data.requestedBy : "";
  const filters = data.filters ?? {};
  const icpSlug = typeof filters.icpSlug === "string" ? filters.icpSlug : "";
  const countries = Array.isArray(filters.countries)
    ? filters.countries.filter((v): v is string => typeof v === "string")
    : [];
  const limitRaw = typeof filters.limit === "number" ? filters.limit : 0;
  const limit = Math.min(
    Math.max(Math.floor(limitRaw), 1),
    VIBE_MAX_LEADS_PER_FETCH,
  );
  // apiFilters ya viene resuelto por la server action. Se pasa opaco
  // al cliente Vibe. Si viene malformado el fetch fallará con 4xx.
  const apiFilters =
    (filters.apiFilters as VibeApiFilters | undefined) ?? {};
  return { tenantId, requestedBy, icpSlug, countries, limit, apiFilters };
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
    if (!params.tenantId || params.icpSlug === "") {
      throw new Error("nova-vibe-fetch: invalid event data (tenantId/icpSlug)");
    }
    if (!params.apiFilters || Object.keys(params.apiFilters).length === 0) {
      throw new Error("nova-vibe-fetch: apiFilters vacío (ICP sin vibeFilters?)");
    }

    const supabase = createSupabaseServiceClient();

    // Filtro API resuelto por la server action; se envía tal cual a
    // stats (ya lo hizo) y a fetchProspectsPage (aquí).
    const serverFilters = params.apiFilters;

    // ===== 0. Snapshot del saldo Vibe ANTES del fetch =====
    // GET /credits es gratis. Guardamos el remaining antes/después
    // para calibrar la heurística de crédito por lead contra el
    // consumo real de la API (no el panel web del usuario, que puede
    // pertenecer a otra cuenta).
    const creditsBefore = await step.run("credits-before", () =>
      getCreditsBalance(),
    );

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
    //
    // Vibe ya recibió job_level en el filtro, pero defensivo: cualquier
    // fila con titleRank > VIBE_SMOKE_MAX_TITLE_RANK cae. Umbral fijo
    // (director-and-above); si un ICP futuro necesita otro, se convierte
    // en campo del bloque vibeFilters (o del propio ICP).
    const maxRank = VIBE_SMOKE_MAX_TITLE_RANK;
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

    // ===== 5a. Business firmographics enrich (dedup por business_id) =====
    //
    // T024 (post-mortem scoring genérico): /prospects NO devuelve
    // sector (linkedin_category) por prospect, así que Nova puntuaba
    // a ciegas. Añadimos aquí un enrich por EMPRESA (dedup por
    // business_id — típicamente 60-80% de leads son empresas
    // distintas). Coste marginal: ~1 crédito por empresa única.
    // Fuente descubierta en probe 2026-09-25:
    // POST /businesses/firmographics/enrich devuelve
    // linkedin_industry_category + business_description +
    // number_of_employees_range + yearly_revenue_range + NAICS.
    const survivingDrafts: LeadDraft[] = [];
    for (const outcome of enrichedById.values()) {
      if (outcome.ok && outcome.draft.email) survivingDrafts.push(outcome.draft);
    }
    const uniqueBusinessIds = new Set<string>();
    for (const draft of survivingDrafts) {
      const bid = draft.custom_fields?.business_id;
      if (typeof bid === "string" && bid.length > 0) {
        uniqueBusinessIds.add(bid);
      }
    }
    const businessByCid = new Map<string, VibeBusinessDataMinimal>();
    let businessEnrichRequestsSent = 0;
    let businessEnrichReturned = 0;
    const businessStartedAt = Date.now();
    const businessIds = [...uniqueBusinessIds];
    for (let i = 0; i < businessIds.length; i++) {
      const bid = businessIds[i];
      const result = await step.run(`business-enrich-${bid}`, async () => {
        const response = await enrichBusiness({ business_id: bid });
        return response.data ?? null;
      });
      businessEnrichRequestsSent += 1;
      if (result) {
        businessEnrichReturned += 1;
        businessByCid.set(bid, result);
      }
    }
    const businessLatencyMs = Date.now() - businessStartedAt;
    const businessCreditsSpent =
      businessEnrichRequestsSent * VIBE_CREDITS_PER_BUSINESS_ENRICH;

    // ===== 5b. Merge firmographics + generic email check =====
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
      const draft0 = outcome.draft;
      const email = draft0.email;
      if (!email) {
        enrichNoEmail += 1;
        continue;
      }
      // Merge firmographics si tenemos el business (immutable — sin
      // perder narrowing del email). Guard de dominio: T024 caso Linq
      // — si el website del enrich no coincide con el del lead, es
      // matching erróneo de Vibe → NO persistir firmographics.
      const bid = draft0.custom_fields?.business_id;
      const firmMerge =
        typeof bid === "string" && businessByCid.has(bid)
          ? mergeBusinessFirmographics(draft0, businessByCid.get(bid)!)
          : null;
      const draft = firmMerge ? firmMerge.draft : draft0;
      const dataMismatch = firmMerge?.mismatch !== undefined;

      const isGeneric = isGenericEmail(email);
      const needsReview = isGeneric || dataMismatch;
      if (needsReview) markedReview += 1;

      // review_reason en custom_fields (T024): motivo estructurado
      // para poder desglosar por qué se marcó (evita el problema de
      // "61 needs_review sin razón" reportado por Pere).
      const customFields: Record<string, string> = {
        ...(draft.custom_fields ?? {}),
        prospect_id: pid,
      };
      if (isGeneric) customFields.review_reason = "generic_email";
      else if (dataMismatch) customFields.review_reason = "data_mismatch";

      rows.push({
        tenant_id: params.tenantId,
        email,
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
        custom_fields: customFields,
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

    // ===== Snapshot del saldo Vibe DESPUÉS =====
    const creditsAfter = await step.run("credits-after", () =>
      getCreditsBalance(),
    );
    const creditsChargedReal =
      creditsBefore && creditsAfter
        ? creditsBefore.remaining_credits - creditsAfter.remaining_credits
        : null;

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

    if (businessEnrichRequestsSent > 0) {
      await step.run("record-cost-business-enrich", async () => {
        const { error } = await supabase.from("api_costs").insert({
          tenant_id: params.tenantId,
          task: "nova.vibe_business_enrich",
          model: "vibe_prospecting",
          tokens_in: businessEnrichRequestsSent,
          tokens_out: businessEnrichReturned,
          cost_usd: businessCreditsSpent,
          latency_ms: businessLatencyMs,
        });
        if (error)
          console.error(
            "[nova-vibe-fetch] api_costs(business_enrich) failed",
            error,
          );
      });
    }

    // ===== 8. events row with the full run context =====
    await step.run("record-event", async () => {
      const { error } = await supabase.from("events").insert({
        tenant_id: params.tenantId,
        kind: "nova.vibe_fetch",
        actor: params.requestedBy || "nova",
        entity_type: "lead",
        payload: {
          filters: {
            icpSlug: params.icpSlug,
            countries: params.countries,
            limit: params.limit,
            api_filters_sent: serverFilters,
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
          cost_business_enrich_credits: businessCreditsSpent,
          business_enrich_requests: businessEnrichRequestsSent,
          business_enrich_returned: businessEnrichReturned,
          cost_total_credits:
            fetchCreditsSpent + enrichCreditsSpent + businessCreditsSpent,
          cost_source: "estimated",
          // T024 calibración: saldo real reportado por GET /credits
          // antes/después. `credits_charged_real` es la diferencia
          // — es la fuente de verdad para calibrar la heurística
          // por lead. `credits_charged_real` null = probe del saldo
          // falló (no bloquea el fetch).
          credits_before: creditsBefore?.remaining_credits ?? null,
          credits_after: creditsAfter?.remaining_credits ?? null,
          credits_charged_real: creditsChargedReal,
          credits_allocated: creditsBefore?.allocated_credits ?? null,
          account_type: creditsBefore?.account_type ?? null,
        },
      });
      if (error) console.error("[nova-vibe-fetch] events insert failed", error);
    });

    // credits_estimated is what the UI showed on the ConfirmView (fixed at
    // request time based on `limit`). credits_charged is what we actually
    // billed against Vibe based on how many rows the API returned. The
    // real deduction on the account may still differ — BACKLOG "calibrar
    // heurística Vibe" tracks the ratio across runs.
    const credits_estimated = estimateCredits(params.limit);

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
      credits_estimated,
      credits_charged: {
        fetch: fetchCreditsSpent,
        enrich: enrichCreditsSpent,
        total: fetchCreditsSpent + enrichCreditsSpent,
      },
      credits_charged_real: creditsChargedReal,
      credits_after: creditsAfter?.remaining_credits ?? null,
      latency_ms: totalLatencyMs,
    };
  },
);
