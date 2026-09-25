// Contract probe: PATCH /campaigns/:cid con body { tracking: { trackOpens } }.
//
// Fase 2 · T024 — verifica en la campaña REAL cam_Kd5FFwoW4amQGdky8
// (Smoke 50 vigente, se archiva después) que Lemlist acepta el body
// preferido y que la config queda persistida. Si falla aquí (400, form
// distinto), lo descubrimos antes del smoke real y no en producción.
//
// Flujo:
//   1. GET  /campaigns/:cid                      → baseline tracking
//   2. PATCH /campaigns/:cid { tracking: {..} }  → aplica el cambio
//   3. GET  /campaigns/:cid                      → verifica persistencia
//
// Solo lee/actualiza CONFIG (no envía emails, no toca leads). Cambio
// reversible por flip inverso o por reset desde la UI.
//
// Usage:
//   node --env-file-if-exists=.env.local scripts/probe-lemlist-patch-tracking.mjs
//
// Vars requeridas: LEMLIST_API_KEY.
// No imprime la API key ni el cuerpo completo — solo los campos de
// tracking + status HTTP + latencia.

const BASE = "https://api.lemlist.com/api";
const CID = "cam_Kd5FFwoW4amQGdky8";

const key = process.env.LEMLIST_API_KEY;
if (!key || key.trim() === "") {
  console.error("[probe] LEMLIST_API_KEY no está configurada en .env.local");
  process.exit(1);
}
const basic = Buffer.from(`:${key}`, "utf8").toString("base64");
const authHeader = { authorization: `Basic ${basic}`, accept: "application/json" };

function pickTracking(obj) {
  if (!obj || typeof obj !== "object") return null;
  // Devuelve TODAS las claves relacionadas con tracking (nested o flat)
  // para no perdernos formatos alternativos.
  const out = {};
  if ("tracking" in obj) out.tracking = obj.tracking;
  for (const k of Object.keys(obj)) {
    if (/track/i.test(k)) out[k] = obj[k];
  }
  return out;
}

async function get(step) {
  const url = `${BASE}/campaigns/${CID}`;
  const t0 = Date.now();
  const res = await fetch(url, { headers: authHeader });
  const text = await res.text();
  const ms = Date.now() - t0;
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  console.log(`\n[${step}] GET ${url} → ${res.status} (${ms}ms)`);
  if (!res.ok) {
    console.error(`[${step}] body (truncado 400b): ${text.slice(0, 400)}`);
    process.exit(2);
  }
  console.log(`[${step}] tracking-related fields:`);
  console.log(JSON.stringify(pickTracking(json), null, 2));
  return json;
}

async function patch() {
  const url = `${BASE}/campaigns/${CID}`;
  const body = { tracking: { trackOpens: false } };
  const t0 = Date.now();
  const res = await fetch(url, {
    method: "PATCH",
    headers: { ...authHeader, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const ms = Date.now() - t0;
  console.log(`\n[patch] PATCH ${url} → ${res.status} (${ms}ms)`);
  console.log(`[patch] body enviado: ${JSON.stringify(body)}`);
  if (!res.ok) {
    console.error(`[patch] body respuesta (truncado 800b): ${text.slice(0, 800)}`);
    process.exit(3);
  }
  console.log(`[patch] respuesta (truncado 400b): ${text.slice(0, 400)}`);
}

console.log(`[probe] campaign: ${CID}`);
await get("baseline");
await patch();
await get("verify");
console.log("\n[probe] OK — Lemlist aceptó tracking:{trackOpens:false}. Pere verifica por conector.");
