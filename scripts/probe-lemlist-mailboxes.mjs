// Contract probe: Lemlist team users / mailboxes.
// Dev-only, GET only. NO WRITE OPERATIONS.
//
// Descubre el endpoint que expone los "senders" (mailboxes) del team. En
// Lemlist, cada user de la cuenta es un mailbox potencial de envio.
// Probamos GET /api/team/users primero (convencion); si 404, caemos a
// iterar los userIds del team con GET /api/users/:id.
//
// Reporta: status, headers de rate limit, shape del primer usuario,
// numero de usuarios, con campos sensibles (email en claro) redactados
// al presentar en chat — el body crudo sale por stdout para inspeccion.
//
// Usage:
//   npm run probe:lemlist-mailboxes

const BASE = "https://api.lemlist.com/api";

const key = process.env.LEMLIST_API_KEY;
if (!key || key.trim() === "") {
  console.error(
    "[probe:lemlist-mailboxes] LEMLIST_API_KEY is not set. Add it to .env.local.",
  );
  process.exit(1);
}

const basic = Buffer.from(`:${key}`, "utf8").toString("base64");
const headers = {
  accept: "application/json",
  authorization: `Basic ${basic}`,
};

const RELEVANT_HEADERS = [
  "content-type",
  "content-length",
  "x-request-id",
  "retry-after",
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "x-ratelimit-reset",
];

async function probeUrl(url) {
  console.log(`[probe:lemlist-mailboxes] GET ${url}`);
  const startedAt = Date.now();
  const res = await fetch(url, { method: "GET", headers });
  const latencyMs = Date.now() - startedAt;
  console.log(
    `[probe:lemlist-mailboxes] status: ${res.status} ${res.statusText} (${latencyMs}ms)`,
  );
  console.log("[probe:lemlist-mailboxes] headers of interest:");
  for (const name of RELEVANT_HEADERS) {
    const value = res.headers.get(name);
    if (value !== null) console.log(`    ${name}: ${value}`);
  }
  const rawText = await res.text();
  const redacted = rawText.split(key).join("<LEMLIST_API_KEY_REDACTED>");
  const preview =
    redacted.length > 4096
      ? `${redacted.slice(0, 4096)}\n… [truncated, ${redacted.length}B total]`
      : redacted;
  console.log("[probe:lemlist-mailboxes] body:");
  console.log(preview);
  return { res, rawText };
}

// Un 200 con content-type text/html significa que la ruta cae al SPA de
// Lemlist y no existe como endpoint API. Tratamos eso igual que un 404.
function looksLikeApiFail(attempt) {
  if (!attempt.res.ok) return true;
  const ct = attempt.res.headers.get("content-type") || "";
  return !ct.includes("application/json");
}

// Ruta correcta descubierta en T018: GET /users/:id. El array de
// mailboxes por user vive dentro del objeto user, no en un endpoint
// separado. Cascada de fallbacks conservada por si Lemlist reorganiza.
const team = await probeUrl(`${BASE}/team`);
let attempt = team;

try {
  const teamJson = JSON.parse(team.rawText);
  const userIds = Array.isArray(teamJson.userIds) ? teamJson.userIds : [];
  console.log(
    `[probe:lemlist-mailboxes] team tiene ${userIds.length} userIds. Leo el primero via /users/:id.`,
  );
  if (userIds.length > 0) {
    attempt = await probeUrl(`${BASE}/users/${userIds[0]}`);
  }
} catch (err) {
  console.error(
    `[probe:lemlist-mailboxes] no pude parsear team para userIds: ${err instanceof Error ? err.message : String(err)}`,
  );
}

if (looksLikeApiFail(attempt)) {
  console.log(
    "[probe:lemlist-mailboxes] /users/:id no devolvio JSON; probando /team/users y /users como fallback historico.",
  );
  for (const url of [`${BASE}/team/users`, `${BASE}/users`]) {
    const next = await probeUrl(url);
    if (!looksLikeApiFail(next)) {
      attempt = next;
      break;
    }
  }
}

if (!attempt.res.ok) {
  console.error(
    `[probe:lemlist-mailboxes] no consegui una respuesta 2xx en ninguna variante — anota los shapes para el gate.`,
  );
  process.exit(1);
}

try {
  const parsed = JSON.parse(attempt.rawText);
  if (Array.isArray(parsed)) {
    console.log(
      `[probe:lemlist-mailboxes] shape: Array<${parsed.length}>, item0 keys = ${parsed[0] ? Object.keys(parsed[0]).join(",") : "(empty)"}`,
    );
  } else {
    console.log(
      `[probe:lemlist-mailboxes] shape: object keys = ${Object.keys(parsed).join(",") || "(none)"}`,
    );
  }
} catch {
  console.warn("[probe:lemlist-mailboxes] response is not valid JSON.");
}

console.log("[probe:lemlist-mailboxes] OK.");
