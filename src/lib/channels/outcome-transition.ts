// OUTPILOT v2 · campaign_lead outcome transition (T025 bloque B)
//
// Función pura que decide el próximo outcome de un campaign_lead
// dado el outcome actual y el evento entrante. Monotónico: nunca
// degrada; unsubscribed es terminal especial.
//
// Devuelve `null` si no hay cambio (el caller NO escribe en BD).
//
// Reglas (según T025-plan.md §1.4 y pedido Pere 2026-10-02):
//
//   Rank (banda monotónica):
//     1 = sent
//     2 = bounced | replied        (eventos "finales" neutros)
//     3 = interested | not_interested
//
//   unsubscribed: fuera de la escala, TERMINAL ESPECIAL.
//     - incoming=unsubscribed → siempre promueve a unsubscribed.
//     - current=unsubscribed → nunca cambia, aunque llegue reply o
//       interested tardíos.
//
//   Dentro del mismo rank, replied > bounced (si un lead rebotó
//   primero y luego respondió, la respuesta vale más).
//
//   Si incoming no mejora el rank actual → null (no cambio).

export type CampaignLeadOutcome =
  | "sent"
  | "bounced"
  | "replied"
  | "unsubscribed"
  | "interested"
  | "not_interested";

const RANK: Record<CampaignLeadOutcome, number> = {
  sent: 1,
  bounced: 2,
  replied: 2,
  unsubscribed: 99, // fuera de la escala; TERMINAL
  interested: 3,
  not_interested: 3,
};

export function nextOutcome(
  current: CampaignLeadOutcome | null,
  incoming: CampaignLeadOutcome,
): CampaignLeadOutcome | null {
  // Terminal: unsubscribed no se mueve, incluso ante replied tardío.
  if (current === "unsubscribed") return null;

  // Promoción directa a unsubscribed desde cualquier estado.
  if (incoming === "unsubscribed") return "unsubscribed";

  // Primer evento del lead.
  if (current === null) return incoming;

  const currentRank = RANK[current];
  const incomingRank = RANK[incoming];

  // Mejora de rank → promueve.
  if (incomingRank > currentRank) return incoming;

  // Mismo rank: replied > bounced (resto de empates no cambian).
  if (incomingRank === currentRank) {
    if (current === "bounced" && incoming === "replied") return "replied";
  }

  // Rank inferior o igual sin regla especial → no cambia.
  return null;
}
