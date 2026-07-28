// Contract probe for the Vibe/Explorium REST API. Dev-only, run once
// before writing lib/vibe/client.ts (T014, step 1.5).
//
// Hits POST https://api.explorium.ai/v1/prospects/stats with a trivial
// filter (Spain only) and dumps: status, rate-limit headers, content-type,
// and the raw response body (truncated at 4kB). NO WRITE OPERATIONS.
//
// Usage:
//   npm run probe:vibe
//
// The API key is read from VIBE_API_KEY in .env.local via Node's
// --env-file-if-exists flag. The key is never printed; if it accidentally
// echoes back in an error body, we redact it before logging.

const ENDPOINT = "https://api.explorium.ai/v1/prospects/stats";

const key = process.env.VIBE_API_KEY;
if (!key || key.trim() === "") {
  console.error(
    "[probe:vibe] VIBE_API_KEY is not set. Add it to .env.local (see .env.example).",
  );
  process.exit(1);
}

const body = {
  filters: {
    country_code: { values: ["ES"] },
  },
};

console.log(`[probe:vibe] POST ${ENDPOINT}`);
console.log(`[probe:vibe] body: ${JSON.stringify(body)}`);

const startedAt = Date.now();
let response;
try {
  response = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      api_key: key,
    },
    body: JSON.stringify(body),
  });
} catch (err) {
  console.error(`[probe:vibe] fetch threw: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

const latencyMs = Date.now() - startedAt;
console.log(`[probe:vibe] status: ${response.status} ${response.statusText} (${latencyMs}ms)`);

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
console.log("[probe:vibe] headers of interest:");
for (const name of RELEVANT_HEADERS) {
  const value = response.headers.get(name);
  if (value !== null) console.log(`    ${name}: ${value}`);
}

const rawText = await response.text();
const redacted = rawText.split(key).join("<VIBE_API_KEY_REDACTED>");
const preview = redacted.length > 4096 ? `${redacted.slice(0, 4096)}\n… [truncated, ${redacted.length}B total]` : redacted;

console.log("[probe:vibe] body:");
console.log(preview);

if (!response.ok) {
  console.error(`[probe:vibe] non-2xx response; contract needs review before building the client.`);
  process.exit(1);
}

// Try JSON parse for shape inspection
try {
  const parsed = JSON.parse(rawText);
  console.log("[probe:vibe] top-level keys:", Object.keys(parsed).join(", ") || "(none)");
} catch {
  console.warn("[probe:vibe] response is not valid JSON.");
}

console.log("[probe:vibe] OK — endpoint reachable and returned 2xx.");
