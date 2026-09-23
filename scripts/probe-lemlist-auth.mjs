// Contract probe for the Lemlist REST API — auth + team endpoint.
// Dev-only, run once before writing src/channels/lemlist/ (T018).
//
// Hits GET https://api.lemlist.com/api/team with HTTP Basic auth
// (empty user, LEMLIST_API_KEY as password) and dumps: status, rate-limit
// headers, content-type, and the raw response body (truncated at 4kB).
// GET only. NO WRITE OPERATIONS.
//
// Usage:
//   npm run probe:lemlist-auth
//
// The API key is read from LEMLIST_API_KEY in .env.local via Node's
// --env-file-if-exists flag. The key is never printed; if it accidentally
// echoes back in an error body, we redact it before logging.

const BASE = "https://api.lemlist.com/api";
const ENDPOINT = `${BASE}/team`;

const key = process.env.LEMLIST_API_KEY;
if (!key || key.trim() === "") {
  console.error(
    "[probe:lemlist-auth] LEMLIST_API_KEY is not set. Add it to .env.local (see .env.example).",
  );
  process.exit(1);
}

// HTTP Basic: user vacio, key como password.
const basic = Buffer.from(`:${key}`, "utf8").toString("base64");

console.log(`[probe:lemlist-auth] GET ${ENDPOINT}`);
console.log(`[probe:lemlist-auth] auth: Basic base64(":" + <LEMLIST_API_KEY>)`);

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
    `[probe:lemlist-auth] fetch threw: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
}

const latencyMs = Date.now() - startedAt;
console.log(
  `[probe:lemlist-auth] status: ${response.status} ${response.statusText} (${latencyMs}ms)`,
);

const RELEVANT_HEADERS = [
  "content-type",
  "content-length",
  "x-request-id",
  "retry-after",
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "x-ratelimit-reset",
  "ratelimit-limit",
  "ratelimit-remaining",
  "ratelimit-reset",
];
console.log("[probe:lemlist-auth] headers of interest:");
for (const name of RELEVANT_HEADERS) {
  const value = response.headers.get(name);
  if (value !== null) console.log(`    ${name}: ${value}`);
}

const rawText = await response.text();
const redacted = rawText.split(key).join("<LEMLIST_API_KEY_REDACTED>");
const preview =
  redacted.length > 4096
    ? `${redacted.slice(0, 4096)}\n… [truncated, ${redacted.length}B total]`
    : redacted;

console.log("[probe:lemlist-auth] body:");
console.log(preview);

if (!response.ok) {
  console.error(
    `[probe:lemlist-auth] non-2xx response; check the key + plan tier before building the client.`,
  );
  process.exit(1);
}

try {
  const parsed = JSON.parse(rawText);
  const keys = Array.isArray(parsed)
    ? `Array<${parsed.length}> item0=${parsed[0] ? Object.keys(parsed[0]).join(",") : "(empty)"}`
    : Object.keys(parsed).join(", ") || "(none)";
  console.log("[probe:lemlist-auth] top-level shape:", keys);
} catch {
  console.warn("[probe:lemlist-auth] response is not valid JSON.");
}

console.log("[probe:lemlist-auth] OK — auth accepted, endpoint reachable.");
