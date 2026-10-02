// OUTPILOT v2 · Lemlist event → action dispatcher (T025 bloque B)
//
// Mapea un evento de Lemlist (lemlist_events.type + payload) a la
// acción que debe ejecutar echo-process-lemlist-event. Función
// pura; sin BD ni red.
//
// Tipos soportados hoy (según pedido T025):
//
//   emailsSent          → outcome=sent
//   emailsBounced       → outcome=bounced + outreach_exclusion
//                           + leads.needs_review=true
//   emailsUnsubscribed  → outcome=unsubscribed + outreach_exclusion
//     (sinónimos: entityUnsubscribed, variableUnsubscribed —
//      documentados por Lemlist como "Unsubscribe activities")
//   emailsReplied       → outcome=replied + inserta en replies
//   emailsInterested    → outcome=interested
//   emailsNotInterested → outcome=not_interested
//
// Cualquier otro type → kind="unhandled". El caller marca
// processed_at + processing_error='unhandled_type' sin fallar.
//
// Nota sobre campos "supuestos" (fixtures T025):
//   bodyText / bodyHtml de emailsReplied vienen marcados como
//   "supuesto" porque Lemlist no documenta el payload del reply.
//   El dispatcher ya los lee como opcionales (null si faltan).
//   Si llegan null, el reply se crea con body vacío y Pere lo lee
//   en /inbox cuando el texto esté o pediremos backfill por
//   GET /api/activities.

import type { CampaignLeadOutcome } from "./outcome-transition";

export type DispatchResult =
  | { kind: "outcome_only"; outcome: CampaignLeadOutcome }
  | {
      kind: "outcome_and_bounce";
      outcome: "bounced";
      bounceReason: string | null;
    }
  | {
      kind: "outcome_and_unsubscribe";
      outcome: "unsubscribed";
      unsubscribeReason: string | null;
    }
  | {
      kind: "outcome_and_reply";
      outcome: "replied";
      bodyText: string | null;
      bodyHtml: string | null;
    }
  | { kind: "unhandled" };

function pickString(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
}

export function dispatchLemlistEvent(
  type: string,
  payload: unknown,
): DispatchResult {
  const p =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};

  switch (type) {
    case "emailsSent":
      return { kind: "outcome_only", outcome: "sent" };

    case "emailsBounced":
      return {
        kind: "outcome_and_bounce",
        outcome: "bounced",
        bounceReason: pickString(p.bounceReason),
      };

    case "emailsUnsubscribed":
    case "entityUnsubscribed":
    case "variableUnsubscribed":
      return {
        kind: "outcome_and_unsubscribe",
        outcome: "unsubscribed",
        unsubscribeReason: pickString(p.unsubscribeReason),
      };

    case "emailsReplied":
      return {
        kind: "outcome_and_reply",
        outcome: "replied",
        bodyText: pickString(p.bodyText),
        bodyHtml: pickString(p.bodyHtml),
      };

    case "emailsInterested":
      return { kind: "outcome_only", outcome: "interested" };

    case "emailsNotInterested":
      return { kind: "outcome_only", outcome: "not_interested" };

    default:
      return { kind: "unhandled" };
  }
}
