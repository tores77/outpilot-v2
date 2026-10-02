// OUTPILOT v2 · scripts / reconcile-lemlist-activities.mjs
//
// Reconciliación one-off entre /api/activities (Lemlist) y
// lemlist_events (BD). Para una campaña dada:
//   1. GET /api/activities?version=v2&campaignId=<ext>&type=emailsSent
//      paginando con offset=100 hasta vaciar.
//   2. Diff: _id que no está en lemlist_events.event_external_id.
//   3. INSERT como si hubiera llegado por webhook (mismo shape que
//      /api/webhooks/lemlist/[secret]), con marca
//      `_outpilot_source: 'reconcile'` en el payload para que
//      queden distinguibles del tráfico real.
//
// El job echo-process-lemlist-event los recogerá en el siguiente
// cron (cada 5 min) exactamente igual que los webhooks reales.
//
// Dry-run por defecto. EXECUTE=1 para escribir.
//
// Sin PII en consola: solo contadores, event_external_id y hash
// (12 chars) del email cuando aplique. Nunca email crudo ni nombre.
//
// Uso:
//   # Dry-run
//   node --env-file-if-exists=.env.local \
//     scripts/reconcile-lemlist-activities.mjs <campaign_uuid>
//
//   # Ejecutar
//   EXECUTE=1 node --env-file-if-exists=.env.local \
//     scripts/reconcile-lemlist-activities.mjs <campaign_uuid>
//
// Pere lo lanza; Claude Code NO lo ejecuta.

import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";

if (existsSync(".env.local")) {
  const raw = readFileSync(".env.local", "utf8");
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    if (!process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
  }
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v || v.trim() === "") {
    console.error(`[reconcile] falta env var ${name}`);
    process.exit(1);
  }
  return v;
}

const campaignUuid = process.argv[2];
if (!campaignUuid || !/^[0-9a-f-]{36}$/i.test(campaignUuid)) {
  console.error(
    "[reconcile] usage: node scripts/reconcile-lemlist-activities.mjs <campaign_uuid>",
  );
  process.exit(1);
}

const execute = process.env.EXECUTE === "1";
const supaUrl = requireEnv("NEXT_PUBLIC_SUPABASE_URL");
const supaKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
const lemlistKey = requireEnv("LEMLIST_API_KEY");
const supabase = createClient(supaUrl, supaKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const auth = `Basic ${Buffer.from(`:${lemlistKey}`).toString("base64")}`;

console.log(`[reconcile] campaign=${campaignUuid} mode=${execute ? "EXECUTE" : "DRY-RUN"}`);

// 1. Cargar campaña: necesitamos provider_external_id + tenant_id.
const { data: campaign, error: cErr } = await supabase
  .from("campaigns")
  .select("id, tenant_id, name, provider_external_id")
  .eq("id", campaignUuid)
  .maybeSingle();
if (cErr) throw new Error(`load-campaign failed: ${cErr.message}`);
if (!campaign) {
  console.error(`[reconcile] campaign ${campaignUuid} no existe`);
  process.exit(2);
}
if (!campaign.provider_external_id) {
  console.error(`[reconcile] campaign ${campaignUuid} sin provider_external_id`);
  process.exit(3);
}
const providerExternalId = campaign.provider_external_id;
const tenantId = campaign.tenant_id;
console.log(`[reconcile] provider_external_id=${providerExternalId}`);

// ============================================================
// DUPLICADO INLINE (idéntico a src/lib/lemlist/webhook-parser.ts):
// hashEmail. El script .mjs no puede importar TS; si cambia allí,
// sincronizar aquí a mano.
// ============================================================
function hashEmail(email) {
  return createHash("sha256").update(email.toLowerCase().trim()).digest("hex");
}
function asStringOrNull(v) {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
}
function extractEmail(payload) {
  const direct = asStringOrNull(payload.leadEmail);
  if (direct) return direct.toLowerCase();
  if (Array.isArray(payload.to) && payload.to.length > 0) {
    const addr = asStringOrNull(payload.to[0]?.address);
    if (addr) return addr.toLowerCase();
  }
  return null;
}
// ============================================================

// 2. Paginación de /api/activities?type=emailsSent.
const PAGE_SIZE = 100;
const activities = [];
let offset = 0;
while (true) {
  const url =
    `https://api.lemlist.com/api/activities?version=v2` +
    `&campaignId=${encodeURIComponent(providerExternalId)}` +
    `&type=emailsSent&limit=${PAGE_SIZE}&offset=${offset}`;
  const r = await fetch(url, {
    headers: { authorization: auth, accept: "application/json" },
  });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    console.error(`[reconcile] fetch failed (${r.status}): ${body.slice(0, 200)}`);
    process.exit(4);
  }
  const j = await r.json();
  const page = Array.isArray(j) ? j : Object.values(j);
  activities.push(...page);
  console.log(`  page offset=${offset} filas=${page.length}`);
  if (page.length < PAGE_SIZE) break;
  offset += PAGE_SIZE;
}
console.log(`[reconcile] total emailsSent en Lemlist: ${activities.length}`);

// 3. Diff contra lemlist_events por event_external_id.
const lemlistIds = activities.map((a) => a._id).filter(Boolean);
if (lemlistIds.length === 0) {
  console.log(`[reconcile] 0 actividades; nada que hacer.`);
  process.exit(0);
}

// Lee en bloques de 500 (postgrest limita el array literal).
const CHUNK = 500;
const existing = new Set();
for (let i = 0; i < lemlistIds.length; i += CHUNK) {
  const chunk = lemlistIds.slice(i, i + CHUNK);
  const { data, error } = await supabase
    .from("lemlist_events")
    .select("event_external_id")
    .eq("tenant_id", tenantId)
    .in("event_external_id", chunk);
  if (error) throw new Error(`select existing failed: ${error.message}`);
  for (const row of data ?? []) existing.add(row.event_external_id);
}
console.log(`[reconcile] ya en BD: ${existing.size} / ${lemlistIds.length}`);

const toInsert = activities.filter((a) => a._id && !existing.has(a._id));
console.log(`[reconcile] a insertar: ${toInsert.length}`);

if (toInsert.length === 0) {
  console.log(`[reconcile] nada que reconciliar. Fin.`);
  process.exit(0);
}

// 4. Preview sin PII.
console.log(`\n[reconcile] preview (hasta 10, sin PII):`);
for (const a of toInsert.slice(0, 10)) {
  const email = extractEmail(a);
  const hash = email ? hashEmail(email).slice(0, 12) : "no_hash";
  console.log(`  ${a._id} type=${a.type} email_hash=${hash}…`);
}

if (!execute) {
  console.log(`\n[reconcile] DRY-RUN — sin escribir. Ejecuta con EXECUTE=1.`);
  process.exit(0);
}

// 5. INSERT en lemlist_events con shape idéntico al endpoint. Marca
//    _outpilot_source: 'reconcile' en el payload para auditoría.
let inserted = 0;
let duplicates = 0;
let errors = 0;
for (const a of toInsert) {
  const email = extractEmail(a);
  const payloadWithMarker = { ...a, _outpilot_source: "reconcile" };
  const row = {
    tenant_id: tenantId,
    type: a.type,
    event_external_id: a._id,
    campaign_external_id: a.campaignId ?? null,
    lead_external_id: a.leadId ?? null,
    email_hash: email ? hashEmail(email) : null,
    event_created_at: a.createdAt ?? null,
    payload: payloadWithMarker,
    processing_error: null, // el job B lo procesará
  };
  const { error } = await supabase.from("lemlist_events").insert(row);
  if (error) {
    const code = error.code;
    if (code === "23505") {
      duplicates += 1;
      continue;
    }
    console.error(`  ${a._id} INSERT error: ${error.message}`);
    errors += 1;
    continue;
  }
  inserted += 1;
}

console.log(`\n[reconcile] resumen:`);
console.log(`  insertados: ${inserted}`);
console.log(`  duplicados (race contra webhook en el ínterin): ${duplicates}`);
console.log(`  errores:    ${errors}`);
console.log(`\n[reconcile] el próximo run del cron echo-process-lemlist-event (<=5min)`);
console.log(`[reconcile] los procesará igual que los webhooks reales.`);
