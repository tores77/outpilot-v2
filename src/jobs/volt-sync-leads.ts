// Volt — sincronizar leads a Lemlist (T023).
//
// Evento: `volt/leads.sync.requested` con { tenantId, campaignId,
// requestedBy }. Manual (botón "Sincronizar N leads" por campaña).
//
// Requisito: la campaña debe estar creada en Lemlist (provider_external_id
// no null). El botón solo se muestra si lo está.
//
// Steps (regla T023: 1 recurso Lemlist por step):
//   1. load-campaign               — provider_external_id + openerFallback
//   2. assert-campaign-not-running — GET Lemlist, aborta si status
//                                     ∈ {running, started, active}
//   3. load-pending-leads          — filtro estricto: personalization
//                                     final + provider_lead_id NULL +
//                                     company no vacía + no processing +
//                                     no removed
//   4. sync-lead-{campaign_lead_id} — resolveOpener → addLead →
//                                     persist provider_lead_id + contact_id
//   5. record-event                — stats + lista de campaign_lead_id
//                                     fallidos
//
// Concurrency 1 por campaignId (comparte key con volt-create-campaign,
// así los dos jobs se serializan sobre la misma campaña).

import { inngest } from "@/lib/inngest";
import { createSupabaseServiceClient } from "@/lib/supabase/service";
import { createLemlistClient } from "@/channels/lemlist/client";
import { createLemlistEmailProvider } from "@/channels/lemlist/provider";
import { getLemlistCampaign } from "@/channels/lemlist/campaign-ops";
import { buildAddLeadPersonalization } from "@/lib/volt/opener";
import {
  LEMLIST_UNSAFE_CAMPAIGN_STATES,
  VOLT_ERROR_CAMPAIGN_UNSAFE,
  VOLT_MAX_SYNC_PER_TRIGGER,
} from "@/config/volt";
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

type LeadRow = Database["public"]["Tables"]["leads"]["Row"];
type CampaignLeadUpdate =
  Database["public"]["Tables"]["campaign_leads"]["Update"];

type PendingLead = {
  campaign_lead_id: string;
  lead: LeadRow;
  personalization: unknown;
};

type SyncOutcome =
  | { kind: "sent"; providerLeadId: string | undefined; providerContactId: string | undefined }
  | { kind: "lost_race" }
  | { kind: "error"; error: string };

function getLemlistClient() {
  const apiKey = process.env.LEMLIST_API_KEY;
  if (!apiKey || apiKey.trim() === "") {
    throw new Error("volt-sync-leads: LEMLIST_API_KEY no está configurada");
  }
  return createLemlistClient({ apiKey });
}

export const voltSyncLeads = inngest.createFunction(
  {
    id: "volt-sync-leads",
    triggers: [{ event: "volt/leads.sync.requested" }],
    // Misma key que volt-create-campaign para serializar por campaña.
    concurrency: [{ limit: 1, key: "event.data.campaignId" }],
  },
  async ({ event, step }) => {
    const startedAt = Date.now();
    const { tenantId, campaignId, requestedBy } = parseEventData(event.data);
    if (!tenantId) throw new Error("volt-sync-leads: missing tenantId");
    if (!campaignId) throw new Error("volt-sync-leads: missing campaignId");

    const supabase = createSupabaseServiceClient();
    const lemlist = getLemlistClient();
    const provider = createLemlistEmailProvider({ client: lemlist });

    // ===== 1. Load campaign =====
    const campaign = await step.run("load-campaign", async () => {
      const { data, error } = await supabase
        .from("campaigns")
        .select("id, provider_external_id, sequence")
        .eq("tenant_id", tenantId)
        .eq("id", campaignId)
        .maybeSingle();
      if (error) throw new Error(`load-campaign failed: ${error.message}`);
      if (!data) throw new Error(`campaign ${campaignId} not found`);
      if (!data.provider_external_id) {
        throw new Error(
          `campaign ${campaignId} no tiene provider_external_id — corre volt-create-campaign primero`,
        );
      }
      return data;
    });

    const externalId = campaign.provider_external_id!;
    const seq = campaign.sequence as { openerFallback?: unknown } | null;
    const openerFallback =
      typeof seq?.openerFallback === "string" ? seq.openerFallback : "";
    if (openerFallback === "") {
      throw new Error(
        `campaign ${campaignId} sin sequence.openerFallback — necesario para leads generic`,
      );
    }

    // ===== 2. Assert campaign not running =====
    await step.run("assert-campaign-not-running", async () => {
      const summary = await getLemlistCampaign(lemlist, externalId);
      const status = (summary.status ?? "").toLowerCase();
      if (LEMLIST_UNSAFE_CAMPAIGN_STATES.includes(status)) {
        throw new Error(
          `${VOLT_ERROR_CAMPAIGN_UNSAFE}: campaign ${externalId} status="${status}" — abortando para no añadir leads a una campaña en marcha`,
        );
      }
      return { status };
    });

    // ===== 3. Load pending leads (filtro estricto) =====
    const pending: PendingLead[] = await step.run("load-pending-leads", async () => {
      const { data, error } = await supabase
        .from("campaign_leads")
        .select("id, personalization, lead:leads!inner(*)")
        .eq("tenant_id", tenantId)
        .eq("campaign_id", campaignId)
        .is("provider_lead_id", null)
        .is("removed_at", null)
        .not("personalization", "is", null)
        // El estado "processing" del claim de Lex NO es un resultado final.
        // Filtro cliente para simplicidad (Postgres jsonb en cliente:
        // .neq("personalization->>state", "processing") también funciona).
        .order("added_at", { ascending: true })
        .limit(VOLT_MAX_SYNC_PER_TRIGGER);
      if (error) throw new Error(`load-pending-leads failed: ${error.message}`);
      const rows = data ?? [];
      const usable: PendingLead[] = [];
      for (const row of rows) {
        const p = row.personalization as { state?: unknown } | null;
        if (p && typeof p === "object" && p.state === "processing") continue;
        const lead = row.lead as unknown as LeadRow;
        if (!lead.company || lead.company.trim() === "") continue;
        usable.push({
          campaign_lead_id: row.id,
          lead,
          personalization: row.personalization,
        });
      }
      return usable;
    });

    if (pending.length === 0) {
      const latencyMs = Date.now() - startedAt;
      return {
        pending: 0,
        sent: 0,
        errors: 0,
        lost_races: 0,
        failed_ids: [],
        latency_ms: latencyMs,
      };
    }

    // ===== 4. Sync lead uno a uno (step por lead) =====
    let sent = 0;
    let errors = 0;
    let lostRaces = 0;
    const failedIds: string[] = [];

    for (const { campaign_lead_id, lead, personalization } of pending) {
      // Cast necesario: Inngest ensancha los literal types del return
      // via JsonifyObject; el SyncOutcome discriminado se reconstruye
      // aquí.
      const outcome = (await step.run(
        `sync-lead-${campaign_lead_id}`,
        async () => {
          try {
            const personalizationMap = buildAddLeadPersonalization({
              personalization,
              openerFallback,
              lead: {
                first_name: lead.first_name,
                last_name: lead.last_name,
                company: lead.company,
              },
            });

            const result = await provider.addLead({
              campaignExternalId: externalId,
              leadEmail: lead.email,
              personalization: personalizationMap,
            });

            // Persist provider_lead_id + provider_contact_id con guard
            // idempotente: solo si provider_lead_id sigue NULL.
            const update: CampaignLeadUpdate = {
              provider_lead_id: result.providerLeadId ?? null,
              provider_contact_id: result.providerContactId ?? null,
            };
            const { data, error } = await supabase
              .from("campaign_leads")
              .update(update)
              .eq("tenant_id", tenantId)
              .eq("id", campaign_lead_id)
              .is("provider_lead_id", null)
              .select("id");
            if (error) {
              return {
                kind: "error",
                error: `persist failed: ${error.message}`,
              };
            }
            if ((data ?? []).length === 0) {
              // Otro run lo actualizó entre el addLead y el UPDATE.
              // Lemlist ya tiene el lead (o iba a; addLead es idempotente
              // del lado del provider). Sin daño.
              return { kind: "lost_race" };
            }
            return {
              kind: "sent",
              providerLeadId: result.providerLeadId,
              providerContactId: result.providerContactId,
            };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return { kind: "error", error: msg };
          }
        },
      )) as SyncOutcome;
      if (outcome.kind === "sent") sent += 1;
      else if (outcome.kind === "lost_race") lostRaces += 1;
      else {
        errors += 1;
        failedIds.push(campaign_lead_id);
      }
    }

    const latencyMs = Date.now() - startedAt;

    // ===== 5. record-event =====
    await step.run("record-event", async () => {
      const { error } = await supabase.from("events").insert({
        tenant_id: tenantId,
        kind: "volt.sync_leads",
        actor: requestedBy,
        entity_type: "campaign",
        entity_id: campaignId,
        payload: {
          provider_external_id: externalId,
          pending: pending.length,
          sent,
          errors,
          lost_races: lostRaces,
          failed_campaign_lead_ids: failedIds,
          latency_ms: latencyMs,
        },
      });
      if (error) console.error("[volt-sync-leads] events insert failed", error);
    });

    return {
      pending: pending.length,
      sent,
      errors,
      lost_races: lostRaces,
      failed_ids: failedIds,
      latency_ms: latencyMs,
    };
  },
);
