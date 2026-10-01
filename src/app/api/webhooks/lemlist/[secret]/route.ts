// OUTPILOT v2 · POST /api/webhooks/lemlist/[secret] (T025 bloque A)
//
// Receptor de webhooks de Lemlist.
//
// ===== Autenticación: DOS CAPAS =====
//
// Lemlist NO firma los webhooks con HMAC ni usa cabeceras custom.
// Hallazgo verificado contra la doc oficial 2026-10-01
// (https://developer.lemlist.com/api-reference/endpoints/webhooks/add-webhook.md):
//
//   El campo "Secret" del POST /hooks es:
//   - "Stored encrypted at rest. Never returned by GET /hooks or
//      any other endpoint. Immutable — it cannot be changed after
//      creation."
//   - "Sent back to your endpoint as a `secret` field in the JSON
//      body of every webhook call, so you can verify the request
//      originated from lemlist."
//
// Es decir: valor en claro, dentro del BODY (no en cabecera, no
// HMAC). TLS lo protege en tránsito; a diferencia de la URL, los
// proxys/CDN típicamente no loguean el body.
//
// Capa 1 (ruta): secret compartido en la URL
//   /api/webhooks/lemlist/<LEMLIST_WEBHOOK_SECRET>.
//   Primera defensa; secret mismatch → 404.
//
// Capa 2 (body): verificación de payload.secret contra el MISMO
//   LEMLIST_WEBHOOK_SECRET (decisión Pere 2026-10-01: una sola var
//   por ahora; el campo Secret de Lemlist es inmutable y separar
//   requiere recrear el webhook — se separará en la próxima rotación).
//
//   Modo controlado por LEMLIST_WEBHOOK_BODY_CHECK:
//     "observe" (default) — mismatch NO bloquea. Se persiste el
//        evento con processing_error = body_secret_missing |
//        body_secret_mismatch y se responde 200. Permite medir
//        cuántos eventos reales llegan con el secret correcto antes
//        de pasar a enforce.
//     "enforce" — mismatch → 404 silencioso.
//
// ===== Contrato de respuesta =====
//   - 200 si el URL secret es válido y (modo observe) incluso con
//     mismatch del body secret. Lemlist no reintenta ante 200;
//     cualquier mismatch queda registrado en processing_error.
//   - 500 si hay error real de BD. Lemlist reintenta; la unique
//     sobre event_external_id absorbe duplicados.
//   - 404 si URL secret falla (siempre) o si body secret falla y el
//     modo es "enforce". No filtramos la existencia del endpoint.
//
// ===== Logs y consola =====
// SOLO event_external_id, type y email_hash (primeros 12 chars).
// Nunca payload crudo, nunca email en claro, nunca el valor del
// secret (ni en logs de errores). Pere lo pidió explícito.
//
// ===== Payload persistido =====
// Se persiste el body TAL CUAL excepto el campo `secret`, que se
// strip con stripBodySecret() antes del insert. El resto del body
// es raw crudo (regla "toda API de pago persiste raw"); el secret
// no aporta nada downstream y es superficie de ataque innecesaria
// aunque RLS la proteja.
//
// ===== Procesado real =====
// NO ocurre aquí. Este endpoint solo persiste raw. El job
// `echo-process-lemlist-event` (bloque B, pendiente) lee filas con
// processed_at IS NULL AND processing_error IS NULL y aplica la
// lógica de campaign_leads / replies / outreach_exclusions.

import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { createSupabaseServiceClient } from "@/lib/supabase/service";
import type { Database } from "@/lib/supabase/database.types";
import {
  parseLemlistWebhook,
  stripBodySecret,
} from "@/lib/lemlist/webhook-parser";
import {
  checkBodySecret,
  parseBodySecretMode,
} from "@/lib/lemlist/webhook-secret";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ secret: string }>;
};

/**
 * Compara dos strings en tiempo constante. Longitudes distintas →
 * false sin comparar (timing-safe-equal exige igual longitud y
 * expondríamos la longitud al reintentar; no es un vector real pero
 * es gratis prevenirlo).
 */
function secretMatches(provided: string, expected: string): boolean {
  if (provided.length !== expected.length) return false;
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function POST(req: Request, ctx: RouteContext) {
  const { secret: provided } = await ctx.params;
  const expected = process.env.LEMLIST_WEBHOOK_SECRET;

  if (!expected || expected.trim() === "") {
    // Config missing en el entorno. No filtramos qué pasa a quien
    // intente adivinar — 404 silencioso. En producción esto es un
    // bug operacional; se detecta porque Lemlist no entrega eventos.
    console.error("[lemlist-webhook] LEMLIST_WEBHOOK_SECRET no configurado");
    return new NextResponse(null, { status: 404 });
  }
  if (!secretMatches(provided, expected)) {
    return new NextResponse(null, { status: 404 });
  }

  // ===== Body parse =====
  // Lemlist envía JSON. Si falla el parse, 200 silencioso (reintentar
  // no arregla un body corrupto); loguear sin exponer el body.
  let body: unknown;
  try {
    body = await req.json();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[lemlist-webhook] body no es JSON: ${msg}`);
    return NextResponse.json({ ok: true, skipped: "invalid_json" });
  }

  const parse = parseLemlistWebhook(body);
  if (!parse.ok) {
    console.error(`[lemlist-webhook] parser fail: ${parse.error}`);
    return NextResponse.json({ ok: true, skipped: parse.error });
  }
  const ev = parse.event;

  // ===== Capa 2: verificación de payload.secret =====
  // Modo observe (default): mismatch no bloquea; queda registrado en
  //   processing_error. Permite calibrar antes de enforce.
  // Modo enforce: mismatch → 404 silencioso (misma política que
  //   URL secret, no filtramos qué paso falló).
  // El valor del secret NUNCA se imprime, ni siquiera en errors.
  const bodyCheckMode = parseBodySecretMode(process.env.LEMLIST_WEBHOOK_BODY_CHECK);
  const bodyCheck = checkBodySecret(ev.secretFromBody, expected);
  let bodySecretError: "body_secret_missing" | "body_secret_mismatch" | null = null;
  if (!bodyCheck.ok) {
    if (bodyCheckMode === "enforce") {
      console.error(
        `[lemlist-webhook] ${ev.eventExternalId} ${ev.type} body-secret ${bodyCheck.reason} (enforce) → 404`,
      );
      return new NextResponse(null, { status: 404 });
    }
    bodySecretError = bodyCheck.reason;
    console.warn(
      `[lemlist-webhook] ${ev.eventExternalId} ${ev.type} body-secret ${bodyCheck.reason} (observe) → persist`,
    );
  }

  // ===== Lookup tenant por campaign_external_id =====
  // El lookup NO filtra por tenant: el cam_ identifica unívocamente
  // la campaña (unique index parcial campaigns_tenant_provider_external_uniq).
  // Si no match → persistimos con tenant_id NULL + processing_error.
  const supabase = createSupabaseServiceClient();

  let tenantId: string | null = null;
  let tenantError: "tenant_lookup_failed" | "missing_campaign_id" | null = null;
  if (ev.campaignExternalId) {
    const { data: campaign, error: lookupErr } = await supabase
      .from("campaigns")
      .select("tenant_id")
      .eq("provider_external_id", ev.campaignExternalId)
      .maybeSingle();
    if (lookupErr) {
      // Error real de BD en el lookup: devolvemos 5xx para que
      // Lemlist reintente. La unique constraint protege contra
      // duplicados en el eventual segundo intento exitoso.
      console.error(
        `[lemlist-webhook] campaigns lookup error: ${lookupErr.message}`,
      );
      return new NextResponse(null, { status: 500 });
    }
    if (campaign?.tenant_id) {
      tenantId = campaign.tenant_id;
    } else {
      tenantError = "tenant_lookup_failed";
    }
  } else {
    tenantError = "missing_campaign_id";
  }

  // Prioridad del processing_error: el fallo del body secret pesa
  // más que el fallo de tenant (si el body secret no cuadra, no
  // debemos procesar aunque el tenant resuelva). El job de B
  // filtra por `processing_error IS NULL`, así que cualquier error
  // deja el evento en cuarentena.
  const processingError: string | null = bodySecretError ?? tenantError;

  // ===== Insert en lemlist_events =====
  //
  // El payload (sin el campo secret, strip abajo) se persiste raw
  // en la columna jsonb `payload`. event_external_id se mantiene en
  // columna propia para unique constraint y lookup rápido del job
  // de B (futuro).
  //
  // Idempotencia: la unique parcial lemlist_events_event_ext_uniq
  // sobre event_external_id absorbe reintentos. supabase-js no
  // expone ON CONFLICT DO NOTHING directo; usamos .insert() y
  // detectamos 23505 como duplicado conocido (OK, no error).
  //
  // Strip del campo `secret` antes de persistir: ya lo validamos
  // arriba; dejarlo en jsonb es superficie innecesaria aunque RLS
  // proteja la tabla.
  const sanitizedPayload = stripBodySecret(body);

  const insertRow = {
    tenant_id: tenantId,
    type: ev.type,
    event_external_id: ev.eventExternalId,
    campaign_external_id: ev.campaignExternalId,
    lead_external_id: ev.leadExternalId,
    email_hash: ev.emailHash,
    event_created_at: ev.eventCreatedAt?.toISOString() ?? null,
    payload: sanitizedPayload as Database["public"]["Tables"]["lemlist_events"]["Insert"]["payload"],
    processing_error: processingError,
  };

  const { error: insertErr } = await supabase
    .from("lemlist_events")
    .insert(insertRow);

  if (insertErr) {
    // 23505 = unique_violation. Idempotencia: ya recibimos este
    // evento, respondemos OK silenciosamente.
    const code = (insertErr as { code?: string }).code;
    if (code === "23505") {
      console.log(
        `[lemlist-webhook] ${ev.eventExternalId} ${ev.type} ${
          ev.emailHash?.slice(0, 12) ?? "no_hash"
        }… duplicate`,
      );
      return NextResponse.json({ ok: true, dedup: true });
    }
    // Error real: 5xx para que Lemlist reintente.
    console.error(
      `[lemlist-webhook] insert error (${code ?? "unknown"}): ${insertErr.message}`,
    );
    return new NextResponse(null, { status: 500 });
  }

  console.log(
    `[lemlist-webhook] ${ev.eventExternalId} ${ev.type} ${
      ev.emailHash?.slice(0, 12) ?? "no_hash"
    }…${processingError ? ` err=${processingError}` : ""}`,
  );
  return NextResponse.json({ ok: true });
}
