// OUTPILOT v2 · POST /api/webhooks/lemlist/[secret] (T025 bloque A)
//
// Receptor de webhooks de Lemlist. Lemlist NO firma los webhooks: la
// autenticación se hace por un secret compartido en la propia URL
// (LEMLIST_WEBHOOK_SECRET). Esto es consistente con la práctica de
// Lemlist (su panel acepta cualquier URL destino) y evita cabeceras
// opacas de verificar.
//
// Contrato:
//   - Si el secret coincide → responde 200 pase lo que pase después
//     (parse malo, insert malo, campaña huérfana). Lemlist reintenta
//     ante 5xx y no queremos duplicados ni bucles — la unique
//     constraint sobre event_external_id absorbe los pocos duplicados
//     que puedan colarse si por lo que sea respondemos 5xx y Lemlist
//     reintenta más tarde.
//   - Si el secret NO coincide → 404 (no 401). No filtramos la
//     existencia del endpoint a quien no lleva el secret.
//
// Logs y consola: SOLO imprimen event_external_id, type y email_hash.
// NUNCA payload crudo ni email en claro — Pere lo pidió explícito.
// Pattern:
//   console.log(`[lemlist-webhook] ${event_external_id} ${type} ${email_hash?.slice(0,12)}…`);
//
// Procesado real: NO ocurre aquí. Este endpoint solo persiste raw.
// El job `echo-process-lemlist-event` (bloque B, pendiente) lee
// filas con processed_at IS NULL y aplica la lógica de campaign_leads
// / replies / outreach_exclusions.

import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { createSupabaseServiceClient } from "@/lib/supabase/service";
import { parseLemlistWebhook } from "@/lib/lemlist/webhook-parser";

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

  // ===== Lookup tenant por campaign_external_id =====
  // El lookup NO filtra por tenant: el cam_ identifica unívocamente
  // la campaña (unique index parcial campaigns_tenant_provider_external_uniq).
  // Si no match → persistimos con tenant_id NULL + processing_error.
  const supabase = createSupabaseServiceClient();

  let tenantId: string | null = null;
  let processingError: string | null = null;
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
      processingError = "tenant_lookup_failed";
    }
  } else {
    processingError = "missing_campaign_id";
  }

  // ===== Insert en lemlist_events =====
  // Nota: hasta que Pere aplique la migración 009 y regeneremos
  // database.types.ts, el nombre de tabla "lemlist_events" no está
  // en el union tipado de `from`. Hacemos cast local; el commit
  // post-aplicación limpia el cast.
  //
  // El payload se persiste en `payload` como jsonb. Mantener la
  // columna separada `event_external_id` (= payload._id) permite el
  // unique constraint de BD y lookup rápido en el job de B.
  //
  // ON CONFLICT: la unique constraint lemlist_events_event_ext_uniq
  // garantiza idempotencia. supabase-js no expone ON CONFLICT DO
  // NOTHING directamente; usamos .insert() y detectamos 23505 como
  // duplicado conocido (idempotente, no es error).
  //
  // Nota de tipos (temporal, pre-gen-types): el service client está
  // tipado contra Database, que todavía no conoce lemlist_events.
  // Usamos `as never` en el nombre de tabla para forzar un `any`
  // controlado — es el patrón menos malo hasta que Pere regenere.
  //
  //
  const insertRow = {
    tenant_id: tenantId,
    type: ev.type,
    event_external_id: ev.eventExternalId,
    campaign_external_id: ev.campaignExternalId,
    lead_external_id: ev.leadExternalId,
    email_hash: ev.emailHash,
    event_created_at: ev.eventCreatedAt?.toISOString() ?? null,
    payload: body as never,
    processing_error: processingError,
  };

  const { error: insertErr } = await supabase
    .from("lemlist_events" as never)
    .insert(insertRow as never);

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
