// Echo — procesar eventos de Lemlist persistidos en lemlist_events
// (T025 bloque B).
//
// Dos funciones Inngest:
//
//   1. echoProcessLemlistEventCron — cron cada 5 min. Lista tenants
//      y hace fan-out: envía un evento `echo/lemlist.events.process`
//      por tenant. Mínimo trabajo propio; permite escalar a N
//      tenants sin bloquear.
//
//   2. echoProcessLemlistEvent — se dispara por el evento del fan-out.
//      Concurrency 1 por tenant (`event.data.tenantId`). Dentro:
//      sweep stale claims → claim batch (hard cap 200) → step.run
//      por evento. Un fallo en un evento no para el run.
//
// Garantías de aislamiento:
//   - El claim atómico (claimed_at con TTL) evita que dos runs del
//     mismo tenant procesen el mismo evento. Concurrency 1 por
//     tenant además lo hace casi imposible (dos runs encolados).
//   - processed_at IS NOT NULL excluye del claim los ya procesados.
//
// Garantías de resiliencia:
//   - Un throw dentro del step.run deja la fila con claimed_at !=
//     null. El sweep del próximo run (claimed_at < now - 10min)
//     la libera. No hay registros "en limbo" permanentes.
//   - processing_error marca eventos no procesables (lead no
//     encontrado, unhandled_type) sin reintentar.

import { inngest } from "@/lib/inngest";
import { createSupabaseServiceClient } from "@/lib/supabase/service";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import {
  claimPendingLemlistEvents,
  sweepStaleLemlistClaims,
} from "@/lib/lemlist/event-claim";
import {
  processLemlistEvent,
  type LemlistEventDeps,
} from "@/lib/channels/lemlist-event-process";
import {
  evaluateGuardrails,
  parseGuardrailsMode,
  GUARDRAIL_WINDOW_HOURS,
} from "@/lib/channels/guardrails";
import { createLemlistClient } from "@/channels/lemlist/client";
import { pauseLemlistCampaign } from "@/channels/lemlist/campaign-ops";

// Hard cap por run (pedido Pere: 200). Si hay más, el siguiente
// run los coge. En steady state con 1 tenant y un flujo normal de
// webhooks (decenas por día), no se tocará.
const ECHO_HARD_CAP = 200;

// Staleness del claim antes de reset por sweep.
const ECHO_CLAIM_STALE_MS = 10 * 60 * 1000;

function makeDeps(
  supabase: SupabaseClient<Database>,
): LemlistEventDeps {
  return {
    findCampaignLead: async ({ tenantId, providerLeadId }) => {
      const { data, error } = await supabase
        .from("campaign_leads")
        .select("id, lead_id, outcome")
        .eq("tenant_id", tenantId)
        .eq("provider_lead_id", providerLeadId)
        .is("removed_at", null)
        .maybeSingle();
      if (error) throw new Error(`findCampaignLead failed: ${error.message}`);
      if (!data) return null;
      return {
        id: data.id,
        lead_id: data.lead_id,
        outcome: data.outcome,
      };
    },

    getLeadEmail: async ({ tenantId, leadId }) => {
      const { data, error } = await supabase
        .from("leads")
        .select("email")
        .eq("tenant_id", tenantId)
        .eq("id", leadId)
        .maybeSingle();
      if (error) throw new Error(`getLeadEmail failed: ${error.message}`);
      if (!data?.email) return null;
      return data.email.toLowerCase().trim();
    },

    updateCampaignLeadOutcome: async ({
      tenantId,
      campaignLeadId,
      outcome,
      outcomeAt,
    }) => {
      const { error } = await supabase
        .from("campaign_leads")
        .update({ outcome, outcome_at: outcomeAt })
        .eq("tenant_id", tenantId)
        .eq("id", campaignLeadId);
      if (error)
        throw new Error(`updateCampaignLeadOutcome failed: ${error.message}`);
    },

    markLeadNeedsReview: async ({ tenantId, leadId }) => {
      const { error } = await supabase
        .from("leads")
        .update({ needs_review: true })
        .eq("tenant_id", tenantId)
        .eq("id", leadId);
      if (error)
        throw new Error(`markLeadNeedsReview failed: ${error.message}`);
    },

    insertReply: async ({
      tenantId,
      campaignLeadId,
      lemlistEventId,
      receivedAt,
      bodyText,
      bodyHtml,
    }) => {
      const { error } = await supabase.from("replies").insert({
        tenant_id: tenantId,
        campaign_lead_id: campaignLeadId,
        lemlist_event_id: lemlistEventId,
        received_at: receivedAt,
        body_text: bodyText,
        body_html: bodyHtml,
      });
      if (error) {
        const code = (error as { code?: string }).code;
        if (code === "23505") return { duplicate: true };
        throw new Error(`insertReply failed: ${error.message}`);
      }
      return { duplicate: false };
    },

    addOutreachExclusion: async ({ tenantId, email, reason, source }) => {
      // PK = (tenant_id, email). ignoreDuplicates: segundo evento
      // sobre el mismo email no revienta.
      const { error } = await supabase.from("outreach_exclusions").upsert(
        {
          tenant_id: tenantId,
          email: email.toLowerCase().trim(),
          reason,
          source,
        },
        { onConflict: "tenant_id,email", ignoreDuplicates: true },
      );
      if (error)
        throw new Error(`addOutreachExclusion failed: ${error.message}`);
    },

    finalizeEvent: async ({ tenantId, eventId, processingError }) => {
      const { error } = await supabase
        .from("lemlist_events")
        .update({
          processed_at: new Date().toISOString(),
          processing_error: processingError,
          claimed_at: null, // libera el claim al terminar
        })
        .eq("tenant_id", tenantId)
        .eq("id", eventId);
      if (error) throw new Error(`finalizeEvent failed: ${error.message}`);
    },
  };
}

// ============================================================
// Fan-out cron: dispatcher
// ============================================================

export const echoProcessLemlistEventCron = inngest.createFunction(
  {
    id: "echo-process-lemlist-event-cron",
    triggers: [{ cron: "*/5 * * * *" }],
  },
  async ({ step }) => {
    const supabase = createSupabaseServiceClient();

    // `tenants` exenta de la regla outpilot/require-tenant-id-filter.
    const { data: tenantRows, error } = await supabase
      .from("tenants")
      .select("id");
    if (error) throw new Error(`load-tenants failed: ${error.message}`);
    const tenantIds = (tenantRows ?? []).map((t) => t.id);
    if (tenantIds.length === 0) return { tenants: 0, dispatched: 0 };

    // Fan-out: un evento por tenant. Inngest acepta array como
    // payload (batch). El job consumer de abajo tiene concurrency
    // key = event.data.tenantId → serializa cada tenant.
    await step.sendEvent(
      "fanout",
      tenantIds.map((tenantId) => ({
        name: "echo/lemlist.events.process.requested",
        data: { tenantId },
      })),
    );

    return { tenants: tenantIds.length, dispatched: tenantIds.length };
  },
);

// ============================================================
// Procesador por tenant (consumer del fan-out)
// ============================================================

export const echoProcessLemlistEvent = inngest.createFunction(
  {
    id: "echo-process-lemlist-event",
    triggers: [{ event: "echo/lemlist.events.process.requested" }],
    concurrency: [{ limit: 1, key: "event.data.tenantId" }],
  },
  async ({ event, step }) => {
    const data = (event.data ?? {}) as { tenantId?: unknown };
    const tenantId = typeof data.tenantId === "string" ? data.tenantId : "";
    if (!tenantId) {
      throw new Error("echo-process-lemlist-event: missing tenantId");
    }

    const supabase = createSupabaseServiceClient();
    const deps = makeDeps(supabase);

    // 1. Sweep claims muertos (TTL).
    const sweptCount = await step.run("sweep-stale", async () => {
      return await sweepStaleLemlistClaims(supabase, {
        tenantId,
        staleMs: ECHO_CLAIM_STALE_MS,
      });
    });

    // 2. Claim batch (hard cap).
    const claimed = await step.run("claim-batch", async () => {
      return await claimPendingLemlistEvents(supabase, {
        tenantId,
        limit: ECHO_HARD_CAP,
      });
    });

    if (claimed.length === 0) {
      return {
        tenantId,
        swept: sweptCount,
        claimed: 0,
        processed: 0,
        unhandled: 0,
        lead_not_found: 0,
        errors: 0,
      };
    }

    // 3. Procesado 1 a 1 (step.run por evento, pedido Pere).
    let processed = 0;
    let unhandled = 0;
    let leadNotFound = 0;
    let errors = 0;

    for (const ev of claimed) {
      const result = (await step.run(`process-${ev.id}`, async () => {
        try {
          const r = await processLemlistEvent(deps, ev);
          return { kind: "ok" as const, result: r };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          // Un fallo transitorio NO para el run. Marcamos
          // processing_error con el mensaje para que humano revise;
          // libera el claim (claimed_at=null) implícitamente al
          // poner processed_at para que no vuelva al claim.
          try {
            await deps.finalizeEvent({
              tenantId,
              eventId: ev.id,
              processingError: `error:${msg.slice(0, 200)}`,
            });
          } catch (finalizeErr) {
            // Si el propio finalize revienta, dejamos el claim
            // puesto; el sweep siguiente lo libera y el próximo
            // run lo reintenta.
            const fmsg =
              finalizeErr instanceof Error
                ? finalizeErr.message
                : String(finalizeErr);
            console.error(
              `[echo] finalize-after-error failed id=${ev.id}: ${fmsg}`,
            );
          }
          return { kind: "error" as const, error: msg };
        }
      })) as
        | { kind: "ok"; result: { kind: string } }
        | { kind: "error"; error: string };

      if (result.kind === "error") {
        errors += 1;
        continue;
      }
      switch (result.result.kind) {
        case "processed":
          processed += 1;
          break;
        case "unhandled_type":
          unhandled += 1;
          break;
        case "lead_not_found":
          leadNotFound += 1;
          break;
      }
    }

    // ===== 4. Guardarraíles por campaña tocada (bloque C) =====
    //
    // Set de campaign_external_id únicos de los eventos procesados
    // en este run. Para cada uno:
    //   - Si campaigns.status ya está paused_guardrail/paused/done
    //     → skip (no reanudamos solo).
    //   - Else: SELECT counts últimas 24h, evaluateGuardrails.
    //   - Si pause: según GUARDRAILS_ENFORCE actuar.
    const touchedExtIds = Array.from(
      new Set(
        claimed
          .map((c) => c.campaign_external_id)
          .filter((x): x is string => !!x),
      ),
    );

    const mode = parseGuardrailsMode(process.env.GUARDRAILS_ENFORCE);
    let guardrailAlerts = 0;
    let guardrailPauses = 0;

    if (touchedExtIds.length > 0) {
      const lemlistApiKey = process.env.LEMLIST_API_KEY;
      const lemlist = lemlistApiKey
        ? createLemlistClient({ apiKey: lemlistApiKey })
        : null;

      for (const extId of touchedExtIds) {
        const outcome = await step.run(
          `guardrails-${extId}`,
          async () => {
            // Resolver la campaign del tenant.
            const { data: campaign, error: cErr } = await supabase
              .from("campaigns")
              .select("id, status")
              .eq("tenant_id", tenantId)
              .eq("provider_external_id", extId)
              .maybeSingle();
            if (cErr) {
              return {
                kind: "error" as const,
                error: `campaign lookup: ${cErr.message}`,
              };
            }
            if (!campaign) {
              return { kind: "no_campaign" as const };
            }
            // No reanuda ni re-evalúa terminales.
            if (
              campaign.status === "paused_guardrail" ||
              campaign.status === "paused" ||
              campaign.status === "done"
            ) {
              return { kind: "skip_terminal" as const, status: campaign.status };
            }

            // Counts 24h por event_created_at.
            const windowStart = new Date(
              Date.now() - GUARDRAIL_WINDOW_HOURS * 60 * 60 * 1000,
            ).toISOString();

            async function countType(type: string): Promise<number> {
              const { count, error } = await supabase
                .from("lemlist_events")
                .select("*", { count: "exact", head: true })
                .eq("tenant_id", tenantId)
                .eq("campaign_external_id", extId)
                .eq("type", type)
                .gte("event_created_at", windowStart);
              if (error) throw new Error(`count-${type}: ${error.message}`);
              return count ?? 0;
            }

            const [sent, bounced] = await Promise.all([
              countType("emailsSent"),
              countType("emailsBounced"),
            ]);
            // Complaints: Lemlist no documenta un type separado. 0
            // hasta identificar la señal; cuando se identifique,
            // añadir otra countType aquí.
            const complaints = 0;

            const result = evaluateGuardrails({
              sent,
              bounced,
              complaints,
              windowHours: GUARDRAIL_WINDOW_HOURS,
            });

            if (result.action === "none") {
              return {
                kind: "ok" as const,
                sent,
                bounced,
                complaints,
              };
            }

            // action = pause. Dos ramas según mode.
            let actionTaken:
              | "observe_only"
              | "pause_api_ok"
              | "pause_api_failed" = "observe_only";
            let apiError: string | null = null;

            if (mode === "enforce" && lemlist) {
              try {
                await pauseLemlistCampaign(lemlist, extId);
                actionTaken = "pause_api_ok";
              } catch (err) {
                apiError =
                  err instanceof Error ? err.message : String(err);
                actionTaken = "pause_api_failed";
              }
              if (actionTaken === "pause_api_ok") {
                const { error: upErr } = await supabase
                  .from("campaigns")
                  .update({ status: "paused_guardrail" })
                  .eq("tenant_id", tenantId)
                  .eq("id", campaign.id);
                if (upErr) {
                  console.error(
                    `[echo-guardrails] update campaigns.status failed: ${upErr.message}`,
                  );
                }
              }
            }

            // Alerta siempre (observe o enforce).
            const { error: alertErr } = await supabase.from("alerts").insert({
              tenant_id: tenantId,
              kind: "guardrail_pause",
              campaign_id: campaign.id,
              payload: {
                reason: result.reason,
                rate: result.rate,
                threshold: result.threshold,
                sent,
                bounced,
                complaints,
                window_hours: GUARDRAIL_WINDOW_HOURS,
                mode,
                action_taken: actionTaken,
                api_error: apiError,
                provider_external_id: extId,
              },
            });
            if (alertErr) {
              console.error(
                `[echo-guardrails] alerts insert failed: ${alertErr.message}`,
              );
            }

            return {
              kind: "pause" as const,
              reason: result.reason,
              action_taken: actionTaken,
              sent,
              bounced,
            };
          },
        );

        if (outcome.kind === "pause") {
          guardrailAlerts += 1;
          if (outcome.action_taken === "pause_api_ok") guardrailPauses += 1;
        }
      }
    }

    return {
      tenantId,
      swept: sweptCount,
      claimed: claimed.length,
      processed,
      unhandled,
      lead_not_found: leadNotFound,
      errors,
      guardrail_alerts: guardrailAlerts,
      guardrail_pauses: guardrailPauses,
    };
  },
);
