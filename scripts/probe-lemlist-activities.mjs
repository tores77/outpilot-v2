// Contract probe: Lemlist campaign detail + activities catalog.
// Dev-only, GET only. NO WRITE OPERATIONS.
//
// Toma un LEMLIST_CAMPAIGN_ID del entorno (obligatorio) y:
//   1. GET /api/campaigns/:id            → shape del sequence
//   2. GET /api/activities?campaignId=X  → catalogo de tipos de evento
//      (fallback: /api/campaigns/:id/activities si el primero 404)
//
// La salida NO incluye datos de leads: enmascaramos email/firstName/
// lastName con <PII_REDACTED> antes de imprimir; solo se muestra el
// shape (keys) y los tipos de evento (agregados por type + count).
//
// Usage:
//   LEMLIST_CAMPAIGN_ID=cam_xxx npm run probe:lemlist-activities

const BASE = "https://api.lemlist.com/api";

const key = process.env.LEMLIST_API_KEY;
const campaignId = process.env.LEMLIST_CAMPAIGN_ID;
if (!key || key.trim() === "") {
  console.error(
    "[probe:lemlist-activities] LEMLIST_API_KEY is not set. Add it to .env.local.",
  );
  process.exit(1);
}
if (!campaignId || campaignId.trim() === "") {
  console.error(
    "[probe:lemlist-activities] LEMLIST_CAMPAIGN_ID is not set. Usage: LEMLIST_CAMPAIGN_ID=cam_xxx npm run probe:lemlist-activities",
  );
  process.exit(1);
}

const basic = Buffer.from(`:${key}`, "utf8").toString("base64");
const headers = {
  accept: "application/json",
  authorization: `Basic ${basic}`,
};

const PII_FIELDS = new Set([
  "email",
  "firstName",
  "lastName",
  "phone",
  "linkedinUrl",
  "companyName",
  "leadEmail",
  "to",
  "recipient",
]);

function scrubPII(value) {
  if (Array.isArray(value)) return value.map(scrubPII);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = PII_FIELDS.has(k) && typeof v === "string" ? "<PII_REDACTED>" : scrubPII(v);
    }
    return out;
  }
  return value;
}

function redactKey(text) {
  return text.split(key).join("<LEMLIST_API_KEY_REDACTED>");
}

async function fetchJson(url, label) {
  console.log(`[${label}] GET ${url}`);
  const startedAt = Date.now();
  const res = await fetch(url, { method: "GET", headers });
  const latencyMs = Date.now() - startedAt;
  console.log(`[${label}] status: ${res.status} ${res.statusText} (${latencyMs}ms)`);
  const rateLimitHeaders = ["retry-after", "x-ratelimit-remaining"];
  for (const h of rateLimitHeaders) {
    const v = res.headers.get(h);
    if (v !== null) console.log(`    ${h}: ${v}`);
  }
  const raw = await res.text();
  if (!res.ok) {
    console.error(`[${label}] non-2xx body:`);
    console.error(redactKey(raw).slice(0, 2048));
    return { res, parsed: null, raw };
  }
  try {
    return { res, parsed: JSON.parse(raw), raw };
  } catch {
    console.warn(`[${label}] no es JSON valido.`);
    return { res, parsed: null, raw };
  }
}

// ===== 1. Detalle de campana para sequence shape =====
const detail = await fetchJson(
  `${BASE}/campaigns/${campaignId}`,
  "probe:lemlist-activities:detail",
);
if (detail.parsed) {
  const top = Object.keys(detail.parsed);
  console.log("[detail] top-level keys:", top.join(","));
  const sequence = detail.parsed.sequence || detail.parsed.steps || detail.parsed.messages;
  if (Array.isArray(sequence)) {
    console.log(`[detail] sequence: Array<${sequence.length}> steps`);
    if (sequence[0]) {
      const step0Keys = Object.keys(sequence[0]).join(",");
      console.log(`[detail] step0 keys: ${step0Keys}`);
      // Print step0 con PII scrubbed y body truncado
      const step0Scrubbed = scrubPII(sequence[0]);
      const step0Json = JSON.stringify(step0Scrubbed, null, 2);
      const truncated =
        step0Json.length > 3072 ? `${step0Json.slice(0, 3072)}\n… [truncated]` : step0Json;
      console.log("[detail] step0 (PII scrubbed):");
      console.log(truncated);
    }
  } else if (sequence !== undefined) {
    console.log(`[detail] sequence field encontrado pero no es array; typeof=${typeof sequence}`);
  } else {
    console.log("[detail] no encontrado sequence/steps/messages en top-level; keys arriba.");
    // Dump top-level keys con PII scrub para no perder info
    const scrubbed = scrubPII(detail.parsed);
    const compact = JSON.stringify(scrubbed, null, 2);
    console.log(
      "[detail] full body (PII scrubbed, truncado a 4KB):",
      compact.length > 4096 ? `${compact.slice(0, 4096)}\n… [truncated]` : compact,
    );
  }
}

// ===== 2. Catalogo de tipos de evento =====
let activities = await fetchJson(
  `${BASE}/activities?campaignId=${encodeURIComponent(campaignId)}&limit=500`,
  "probe:lemlist-activities:list",
);
if (activities.res.status === 404) {
  console.log("[list] /activities?campaignId 404; fallback a /campaigns/:id/activities");
  activities = await fetchJson(
    `${BASE}/campaigns/${campaignId}/activities?limit=500`,
    "probe:lemlist-activities:list-fallback",
  );
}
if (!activities.parsed) {
  console.error("[list] no obtuve actividades — no puedo catalogar eventos.");
  process.exit(0);
}

const items = Array.isArray(activities.parsed)
  ? activities.parsed
  : activities.parsed.activities || activities.parsed.items || [];
if (!Array.isArray(items)) {
  console.warn(
    "[list] respuesta no array; keys:",
    Object.keys(activities.parsed).join(","),
  );
  process.exit(0);
}

console.log(`\n[list] ${items.length} actividades recibidas.`);
if (items[0]) {
  console.log("[list] item0 keys:", Object.keys(items[0]).join(","));
}

// Contar por type
const typeCounts = new Map();
for (const item of items) {
  const t = item.type || item.eventType || item.kind || "(sin type)";
  typeCounts.set(t, (typeCounts.get(t) || 0) + 1);
}
const sorted = [...typeCounts.entries()].sort((a, b) => b[1] - a[1]);
console.log("\n[list] catalogo de tipos observados:");
for (const [t, n] of sorted) {
  console.log(`  ${String(n).padStart(5)}  ${t}`);
}

console.log("\n[probe:lemlist-activities] OK.");
