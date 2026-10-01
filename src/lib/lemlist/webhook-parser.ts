// OUTPILOT v2 · Lemlist webhook parser (T025 bloque A)
//
// Función pura que convierte un body de webhook de Lemlist en el shape
// que lemlist_events quiere persistir. Separa:
//   - Validación mínima (_id y type obligatorios).
//   - Extracción canónica (campaignId, leadId, email).
//   - Hash determinista del email (SHA-256, lowercased).
//   - Normalización de la fecha del evento (payload.createdAt → Date).
//
// NO escribe en BD, NO llama a Lemlist. Es testeable sin mocks.
//
// Shape de referencia (probe /api/activities?version=v2 2026-10-01):
//   {
//     "_id": "act_...",
//     "type": "emailsSent" | "emailsBounced" | "emailsReplied" | ...
//     "campaignId": "cam_...",
//     "leadId": "lea_...",
//     "leadEmail": "person@domain.com",
//     "to": [{ "address": "...", "name": "..." }],
//     "createdAt": "ISO-8601",
//     ... + mucho PII en claro
//   }
//
// Pere ha pedido explícitamente: logs/consola/scripts solo imprimen
// event_external_id, type y email_hash. Nunca el payload crudo ni el
// email en claro. Este parser devuelve ambos (email_hash para
// idempotencia + consola, email para que el caller lo meta en la fila
// cuando corresponda), pero el consumidor es responsable de redactar.

import { createHash } from "node:crypto";

export type LemlistWebhookPayload = {
  _id?: unknown;
  type?: unknown;
  campaignId?: unknown;
  leadId?: unknown;
  leadEmail?: unknown;
  to?: unknown;
  createdAt?: unknown;
  [key: string]: unknown;
};

export type ParsedLemlistEvent = {
  eventExternalId: string;
  type: string;
  campaignExternalId: string | null;
  leadExternalId: string | null;
  email: string | null;            // lowercased, trimmed; null si no viene
  emailHash: string | null;        // sha256 hex de email; null si no viene
  eventCreatedAt: Date | null;     // payload.createdAt parseado
};

export type ParseResult =
  | { ok: true; event: ParsedLemlistEvent }
  | { ok: false; error: "missing_id" | "missing_type" | "not_an_object" };

/**
 * SHA-256 hex del email lowercased trimmed. Sin sal: el objetivo es
 * enlazar un evento con `leads.email` sin exponer el email en logs
 * (los logs solo imprimen el hash), no proteger contra lookup si
 * alguien dumpea la BD.
 */
export function hashEmail(email: string): string {
  return createHash("sha256").update(email.toLowerCase().trim()).digest("hex");
}

function asStringOrNull(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
}

/**
 * Extrae el email del payload: primero `leadEmail`, luego
 * `to[0].address`. Devuelve lowercased+trimmed o null.
 */
function extractEmail(payload: LemlistWebhookPayload): string | null {
  const direct = asStringOrNull(payload.leadEmail);
  if (direct) return direct.toLowerCase();
  const to = payload.to;
  if (Array.isArray(to) && to.length > 0) {
    const first = to[0] as { address?: unknown } | undefined;
    const addr = asStringOrNull(first?.address);
    if (addr) return addr.toLowerCase();
  }
  return null;
}

function extractDate(v: unknown): Date | null {
  if (typeof v !== "string") return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

export function parseLemlistWebhook(body: unknown): ParseResult {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "not_an_object" };
  }
  const p = body as LemlistWebhookPayload;

  const eventExternalId = asStringOrNull(p._id);
  if (!eventExternalId) return { ok: false, error: "missing_id" };

  const type = asStringOrNull(p.type);
  if (!type) return { ok: false, error: "missing_type" };

  const email = extractEmail(p);

  return {
    ok: true,
    event: {
      eventExternalId,
      type,
      campaignExternalId: asStringOrNull(p.campaignId),
      leadExternalId: asStringOrNull(p.leadId),
      email,
      emailHash: email ? hashEmail(email) : null,
      eventCreatedAt: extractDate(p.createdAt),
    },
  };
}
