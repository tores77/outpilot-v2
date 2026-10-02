// OUTPILOT v2 · processLemlistEvent (T025 bloque B)
//
// Núcleo testeable del job echo-process-lemlist-event. Toma un evento
// crudo de lemlist_events + una colección de "deps" (callbacks sobre
// BD) y aplica la lógica:
//
//   1. Dispatcher (lemlist-event-dispatch) decide la acción.
//   2. Lookup del campaign_lead por provider_lead_id.
//   3. Transición monotónica del outcome (outcome-transition).
//   4. Side-effects (replies, outreach_exclusions, needs_review).
//   5. finalizeEvent: processed_at + processing_error.
//
// Se expone sin tocar supabase para que los tests mocken `deps` con
// vitest.fn() y no necesitemos un mock stateful. El job real
// (src/jobs/echo-process-lemlist-event.ts) construye `deps`
// wrapeando el service client.
//
// Garantías:
//   - Un fallo controlado (lead no encontrado, tipo desconocido)
//     termina con processed_at + processing_error. NO lanza.
//   - Un fallo transitorio (BD caída) sí lanza — el caller debe
//     decidir si libera el claim o deja la fila en limbo (hoy: el
//     caller NO limpia claimed_at al throw, el sweep del siguiente
//     run lo recuperará tras staleMs).
//   - Idempotencia:
//       - replies.lemlist_event_id es UNIQUE parcial → segundo
//         insert devuelve { duplicate: true } sin fallo.
//       - nextOutcome(current, incoming) devuelve null si no cambia
//         → updateCampaignLeadOutcome no se llama.
//       - outreach_exclusions con upsert ignoreDuplicates.

import { dispatchLemlistEvent } from "./lemlist-event-dispatch";
import {
  nextOutcome,
  type CampaignLeadOutcome,
} from "./outcome-transition";

export type LemlistEventRow = {
  id: string;                             // uuid de lemlist_events
  tenant_id: string;
  type: string;
  event_external_id: string;              // act_...
  campaign_external_id: string | null;
  lead_external_id: string | null;        // lea_...
  event_created_at: string | null;        // ISO
  payload: unknown;                       // raw jsonb (sin secret)
};

export type FoundCampaignLead = {
  id: string;
  lead_id: string;
  outcome: CampaignLeadOutcome | null;
};

export type LemlistEventDeps = {
  findCampaignLead: (p: {
    tenantId: string;
    providerLeadId: string;
  }) => Promise<FoundCampaignLead | null>;

  getLeadEmail: (p: {
    tenantId: string;
    leadId: string;
  }) => Promise<string | null>;

  updateCampaignLeadOutcome: (p: {
    tenantId: string;
    campaignLeadId: string;
    outcome: CampaignLeadOutcome;
    outcomeAt: string;
  }) => Promise<void>;

  markLeadNeedsReview: (p: {
    tenantId: string;
    leadId: string;
  }) => Promise<void>;

  insertReply: (p: {
    tenantId: string;
    campaignLeadId: string;
    lemlistEventId: string;        // id (uuid) de lemlist_events, no act_...
    receivedAt: string;
    bodyText: string | null;
    bodyHtml: string | null;
  }) => Promise<{ duplicate: boolean }>;

  addOutreachExclusion: (p: {
    tenantId: string;
    email: string;                 // lowercased, trimmed
    reason: "unsubscribe" | "bounce";
    source: string;                // "lemlist_event:act_..."
  }) => Promise<void>;

  finalizeEvent: (p: {
    tenantId: string;
    eventId: string;
    processingError: string | null;
  }) => Promise<void>;
};

export type ProcessResult =
  | { kind: "processed"; outcomeChanged: boolean; replyInserted: boolean }
  | { kind: "unhandled_type" }
  | { kind: "lead_not_found" };

export async function processLemlistEvent(
  deps: LemlistEventDeps,
  event: LemlistEventRow,
): Promise<ProcessResult> {
  const dispatch = dispatchLemlistEvent(event.type, event.payload);
  if (dispatch.kind === "unhandled") {
    await deps.finalizeEvent({
      tenantId: event.tenant_id,
      eventId: event.id,
      processingError: "unhandled_type",
    });
    return { kind: "unhandled_type" };
  }

  if (!event.lead_external_id) {
    await deps.finalizeEvent({
      tenantId: event.tenant_id,
      eventId: event.id,
      processingError: "lead_not_found",
    });
    return { kind: "lead_not_found" };
  }

  const campaignLead = await deps.findCampaignLead({
    tenantId: event.tenant_id,
    providerLeadId: event.lead_external_id,
  });
  if (!campaignLead) {
    await deps.finalizeEvent({
      tenantId: event.tenant_id,
      eventId: event.id,
      processingError: "lead_not_found",
    });
    return { kind: "lead_not_found" };
  }

  // Timestamp del evento (preferido) o now si Lemlist no lo trajo.
  const outcomeAt =
    event.event_created_at ?? new Date().toISOString();

  // Transición monotónica. null = no cambia (el evento llegó tarde
  // o es un downgrade).
  const next = nextOutcome(campaignLead.outcome, dispatch.outcome);
  let outcomeChanged = false;
  if (next !== null) {
    await deps.updateCampaignLeadOutcome({
      tenantId: event.tenant_id,
      campaignLeadId: campaignLead.id,
      outcome: next,
      outcomeAt,
    });
    outcomeChanged = true;
  }

  let replyInserted = false;

  // Side effects específicos por tipo.
  switch (dispatch.kind) {
    case "outcome_only":
      // Nada adicional.
      break;

    case "outcome_and_reply": {
      const res = await deps.insertReply({
        tenantId: event.tenant_id,
        campaignLeadId: campaignLead.id,
        lemlistEventId: event.id,
        receivedAt: outcomeAt,
        bodyText: dispatch.bodyText,
        bodyHtml: dispatch.bodyHtml,
      });
      replyInserted = !res.duplicate;
      break;
    }

    case "outcome_and_bounce": {
      const email = await deps.getLeadEmail({
        tenantId: event.tenant_id,
        leadId: campaignLead.lead_id,
      });
      if (email) {
        await deps.addOutreachExclusion({
          tenantId: event.tenant_id,
          email,
          reason: "bounce",
          source: `lemlist_event:${event.event_external_id}`,
        });
      }
      await deps.markLeadNeedsReview({
        tenantId: event.tenant_id,
        leadId: campaignLead.lead_id,
      });
      break;
    }

    case "outcome_and_unsubscribe": {
      const email = await deps.getLeadEmail({
        tenantId: event.tenant_id,
        leadId: campaignLead.lead_id,
      });
      if (email) {
        await deps.addOutreachExclusion({
          tenantId: event.tenant_id,
          email,
          reason: "unsubscribe",
          source: `lemlist_event:${event.event_external_id}`,
        });
      }
      break;
    }
  }

  await deps.finalizeEvent({
    tenantId: event.tenant_id,
    eventId: event.id,
    processingError: null,
  });

  return { kind: "processed", outcomeChanged, replyInserted };
}
