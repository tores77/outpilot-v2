// OUTPILOT v2 · scripts / probe-lemlist-webhook.mjs
//
// Probe local del endpoint POST /api/webhooks/lemlist/[secret].
// Envía una fixture (emailsSent sintética, sin PII real) al endpoint
// y comprueba:
//   1. Status 200.
//   2. Dedup: enviar el mismo evento 2 veces → el segundo responde
//      { ok: true, dedup: true }.
//   3. Secret inválido → 404.
//
// Uso típico tras un deploy nuevo (no gasta créditos; es tráfico
// contra NUESTRO endpoint):
//
//   # Local (next dev en :3000):
//   node --env-file-if-exists=.env.local scripts/probe-lemlist-webhook.mjs
//
//   # Producción (con el secret real en LEMLIST_WEBHOOK_SECRET):
//   BASE_URL=https://outpilot-v2.vercel.app \
//     node --env-file-if-exists=.env.local scripts/probe-lemlist-webhook.mjs
//
// Reglas de redacción (Pere, T025):
//   - El probe imprime SOLO event_external_id, type y email_hash.
//   - El payload de la fixture no contiene emails reales de leads;
//     usa dominios de probe (probe.outpilot.local).

import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";

if (existsSync(".env.local")) {
  const raw = readFileSync(".env.local", "utf8");
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    if (!process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
  }
}

const secret = process.env.LEMLIST_WEBHOOK_SECRET;
if (!secret) {
  console.error("[probe-webhook] falta LEMLIST_WEBHOOK_SECRET en env");
  process.exit(1);
}
const baseUrl = process.env.BASE_URL ?? "http://localhost:3000";
const endpoint = `${baseUrl}/api/webhooks/lemlist/${encodeURIComponent(secret)}`;

// Fixture: emailsSent sintético. Mismo shape que /api/activities v2
// (ver probe de T025 contra Lemlist real). Email de probe que NO
// corresponde a ningún lead real para evitar enlazar accidentalmente.
const probeId = `act_probe_${Date.now().toString(36)}`;
const fixture = {
  _id: probeId,
  type: "emailsSent",
  campaignId: "cam_probe_webhook",
  leadId: "lea_probe_webhook",
  leadEmail: "probe@probe.outpilot.local",
  to: [{ address: "probe@probe.outpilot.local", name: "Probe Lead" }],
  createdAt: new Date().toISOString(),
  subject: "probe webhook",
  messagePreview: "probe body preview",
  teamId: "tea_probe",
};

const emailHash = createHash("sha256")
  .update(fixture.leadEmail.toLowerCase().trim())
  .digest("hex");

console.log(`[probe-webhook] endpoint=${endpoint.replace(secret, "<secret>")}`);
console.log(
  `[probe-webhook] fixture: id=${probeId} type=${fixture.type} email_hash=${emailHash.slice(0, 12)}…`,
);

async function postJson(url, body) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text.slice(0, 200);
  }
  return { status: r.status, body: parsed };
}

// 1. Primer envío
console.log(`\n[probe-webhook] 1/3 — enviar fixture…`);
const r1 = await postJson(endpoint, fixture);
console.log(`[probe-webhook]   status=${r1.status} body=${JSON.stringify(r1.body)}`);
if (r1.status !== 200) {
  console.error(`[probe-webhook] ESPERABA 200, obtuve ${r1.status}`);
  process.exit(2);
}

// 2. Reenvío (idempotencia). Debe aceptarse igual (200) con
//    dedup=true. Si NO lo marca como dedup, la unique constraint no
//    se aplica — fallo del guard.
console.log(`\n[probe-webhook] 2/3 — reenviar fixture (idempotencia)…`);
const r2 = await postJson(endpoint, fixture);
console.log(`[probe-webhook]   status=${r2.status} body=${JSON.stringify(r2.body)}`);
if (r2.status !== 200) {
  console.error(`[probe-webhook] ESPERABA 200 en reenvío, obtuve ${r2.status}`);
  process.exit(3);
}
if (!r2.body?.dedup) {
  console.error(
    `[probe-webhook] ESPERABA dedup=true en reenvío. body=${JSON.stringify(r2.body)}`,
  );
  process.exit(4);
}

// 3. Secret inválido → 404.
console.log(`\n[probe-webhook] 3/3 — secret inválido…`);
const badEndpoint = `${baseUrl}/api/webhooks/lemlist/not-the-real-secret-${Date.now()}`;
const r3 = await postJson(badEndpoint, fixture);
console.log(`[probe-webhook]   status=${r3.status}`);
if (r3.status !== 404) {
  console.error(`[probe-webhook] ESPERABA 404, obtuve ${r3.status}`);
  process.exit(5);
}

console.log(`\n[probe-webhook] ✓ todas las comprobaciones OK.`);
console.log(
  `[probe-webhook] Para verificar en BD, Pere corre:\n` +
    `  select type, event_external_id, email_hash, received_at, processing_error\n` +
    `  from lemlist_events where event_external_id = '${probeId}';\n` +
    `  -- debe devolver 1 fila con processing_error = 'tenant_lookup_failed'\n` +
    `  -- (campaignId=cam_probe_webhook no corresponde a ninguna campaña real).`,
);
