// Contract probe: Lemlist campaigns list.
// Dev-only, GET only. NO WRITE OPERATIONS.
//
// GET /api/campaigns con limit alto. Extrae solo campos de config
// (nombre, estado, fechas, id, contadores) — no toca leads. La salida en
// stdout es cruda para inspeccion; el resumen a chat va agregado.
//
// Usage:
//   npm run probe:lemlist-campaigns

const BASE = "https://api.lemlist.com/api";
const ENDPOINT = `${BASE}/campaigns?limit=100`;

const key = process.env.LEMLIST_API_KEY;
if (!key || key.trim() === "") {
  console.error(
    "[probe:lemlist-campaigns] LEMLIST_API_KEY is not set. Add it to .env.local.",
  );
  process.exit(1);
}

const basic = Buffer.from(`:${key}`, "utf8").toString("base64");

console.log(`[probe:lemlist-campaigns] GET ${ENDPOINT}`);

const startedAt = Date.now();
let response;
try {
  response = await fetch(ENDPOINT, {
    method: "GET",
    headers: {
      accept: "application/json",
      authorization: `Basic ${basic}`,
    },
  });
} catch (err) {
  console.error(
    `[probe:lemlist-campaigns] fetch threw: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
}

const latencyMs = Date.now() - startedAt;
console.log(
  `[probe:lemlist-campaigns] status: ${response.status} ${response.statusText} (${latencyMs}ms)`,
);

const RELEVANT_HEADERS = [
  "content-type",
  "content-length",
  "x-request-id",
  "retry-after",
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "x-ratelimit-reset",
];
console.log("[probe:lemlist-campaigns] headers of interest:");
for (const name of RELEVANT_HEADERS) {
  const value = response.headers.get(name);
  if (value !== null) console.log(`    ${name}: ${value}`);
}

const rawText = await response.text();
const redacted = rawText.split(key).join("<LEMLIST_API_KEY_REDACTED>");
const preview =
  redacted.length > 8192
    ? `${redacted.slice(0, 8192)}\n… [truncated, ${redacted.length}B total]`
    : redacted;

console.log("[probe:lemlist-campaigns] body (raw):");
console.log(preview);

if (!response.ok) {
  console.error(`[probe:lemlist-campaigns] non-2xx response.`);
  process.exit(1);
}

let parsed;
try {
  parsed = JSON.parse(rawText);
} catch {
  console.error("[probe:lemlist-campaigns] response is not valid JSON.");
  process.exit(1);
}

const list = Array.isArray(parsed) ? parsed : parsed.campaigns || [];
if (!Array.isArray(list)) {
  console.warn(
    "[probe:lemlist-campaigns] respuesta no es un array ni tiene .campaigns; keys:",
    Object.keys(parsed).join(","),
  );
  process.exit(0);
}

console.log(`\n[probe:lemlist-campaigns] resumen (${list.length} campanas):`);
console.log(
  "  campos observados en item0:",
  list[0] ? Object.keys(list[0]).join(",") : "(no items)",
);
console.log("");
console.log("  id                          | status   | name");
console.log("  ----------------------------|----------|------------------------------");
for (const c of list) {
  const id = String(c._id || c.id || "").padEnd(28).slice(0, 28);
  const status = String(c.status || c.state || "?").padEnd(9).slice(0, 9);
  const name = String(c.name || "(sin nombre)").slice(0, 60);
  console.log(`  ${id}| ${status}| ${name}`);
}

console.log("[probe:lemlist-campaigns] OK.");
