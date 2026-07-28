// Contract probe for POST /v1/prospects (the fetch endpoint).
// Runs with page_size=1 to minimise credit consumption (~1 credit).
//
// Purpose: confirm the fetch response shape assumed in
// src/lib/vibe/types.ts and src/lib/vibe/mapper.ts. If field names differ
// (e.g. "prospects" vs "results", "name" vs "full_name"), we adjust the
// mapper before the first real production execute.
//
// Usage:
//   npm run probe:vibe-fetch
//
// WARNING: this call consumes credits. Run once, not in CI, not on every
// PR. The stats endpoint (probe:vibe) is the free counterpart.

const ENDPOINT = "https://api.explorium.ai/v1/prospects";

const key = process.env.VIBE_API_KEY;
if (!key || key.trim() === "") {
  console.error(
    "[probe:vibe-fetch] VIBE_API_KEY is not set. Add it to .env.local (see .env.example).",
  );
  process.exit(1);
}

const body = {
  filters: {
    country_code: { values: ["ES"] },
  },
  page: 1,
  page_size: 1,
};

console.log("[probe:vibe-fetch] WARNING: this call consumes ~1 credit.");
console.log(`[probe:vibe-fetch] POST ${ENDPOINT}`);
console.log(`[probe:vibe-fetch] body: ${JSON.stringify(body)}`);

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
  console.error(
    `[probe:vibe-fetch] fetch threw: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
}

const latencyMs = Date.now() - startedAt;
console.log(
  `[probe:vibe-fetch] status: ${response.status} ${response.statusText} (${latencyMs}ms)`,
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
console.log("[probe:vibe-fetch] headers of interest:");
for (const name of RELEVANT_HEADERS) {
  const value = response.headers.get(name);
  if (value !== null) console.log(`    ${name}: ${value}`);
}

const rawText = await response.text();
const redacted = rawText.split(key).join("<VIBE_API_KEY_REDACTED>");
const preview =
  redacted.length > 8192
    ? `${redacted.slice(0, 8192)}\n… [truncated, ${redacted.length}B total]`
    : redacted;

console.log("[probe:vibe-fetch] body:");
console.log(preview);

if (!response.ok) {
  console.error("[probe:vibe-fetch] non-2xx response; contract needs review.");
  process.exit(1);
}

try {
  const parsed = JSON.parse(rawText);
  console.log(
    "[probe:vibe-fetch] top-level keys:",
    Object.keys(parsed).join(", ") || "(none)",
  );
  for (const arrayKey of ["data", "results", "prospects"]) {
    const arr = parsed[arrayKey];
    if (Array.isArray(arr)) {
      console.log(
        `[probe:vibe-fetch] found prospect array at "${arrayKey}", length=${arr.length}`,
      );
      if (arr.length > 0) {
        console.log(
          `[probe:vibe-fetch] first prospect keys:`,
          Object.keys(arr[0]).join(", "),
        );
      }
      break;
    }
  }
} catch {
  console.warn("[probe:vibe-fetch] response is not valid JSON.");
}

console.log("[probe:vibe-fetch] OK — endpoint returned 2xx.");
