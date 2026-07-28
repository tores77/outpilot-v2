// Iterative contract probe for the Vibe/Explorium prospect API.
// Two phases in a single run:
//
//   Phase 1 (FREE): discover the real filter taxonomy by calling
//   /v1/prospects/stats with candidate field names. Stats calls are free
//   and 422s from validation cost nothing. Each candidate is reported as
//   "accepted", "unknown field" or "field exists but value invalid".
//
//   Phase 2 (~1 credit IF 200): a single POST /v1/prospects with
//   mode:"full" + country ES + page_size:1. Any 4xx (including 422)
//   costs nothing — only a 200 consumes a credit. Reports the array key,
//   the first prospect's field names, and any rate-limit headers.
//
// Usage:
//   npm run probe:vibe-fetch
//
// After every 4xx we log the response body so Pydantic's own hint drives
// the next iteration. Iterate the CANDIDATES / FETCH_BODY objects below
// until phase 2 returns 200.

const BASE_URL = "https://api.explorium.ai/v1";

const key = process.env.VIBE_API_KEY;
if (!key || key.trim() === "") {
  console.error(
    "[probe:vibe-fetch] VIBE_API_KEY is not set. Add it to .env.local (see .env.example).",
  );
  process.exit(1);
}

const HEADERS = {
  accept: "application/json",
  "content-type": "application/json",
  api_key: key,
};

const RELEVANT_HEADERS = [
  "content-type",
  "x-request-id",
  "retry-after",
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "x-ratelimit-reset",
  "ratelimit-limit",
  "ratelimit-remaining",
  "ratelimit-reset",
];

function redact(text) {
  return text.split(key).join("<VIBE_API_KEY_REDACTED>");
}

async function call(path, body) {
  const startedAt = Date.now();
  let response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify(body),
    });
  } catch (err) {
    return {
      ok: false,
      status: 0,
      text: `fetch threw: ${err instanceof Error ? err.message : String(err)}`,
      latencyMs: Date.now() - startedAt,
      headers: null,
    };
  }
  const text = redact(await response.text());
  return {
    ok: response.ok,
    status: response.status,
    text,
    latencyMs: Date.now() - startedAt,
    headers: response.headers,
  };
}

function classifyValidationError(text, field) {
  const lower = text.toLowerCase();
  if (
    lower.includes("extra") ||
    lower.includes("not permitted") ||
    lower.includes("unknown") ||
    lower.includes("no such filter")
  ) {
    return "unknown field";
  }
  if (
    lower.includes("value is not a valid") ||
    lower.includes("enumeration") ||
    lower.includes("literal_error") ||
    lower.includes(`"${field}"`)
  ) {
    return "field exists, value invalid";
  }
  return "other 4xx";
}

// ===== Phase 1 candidates =====
// Dummy values are placeholders. The point is to learn the field name;
// specific values can be probed in a follow-up run once the field is known.

const CANDIDATES = {
  seniority: {
    values: ["director"],
    fields: [
      "job_level",
      "seniority",
      "level",
      "job_seniority",
      "role_level",
      "management_level",
    ],
  },
  companySize: {
    values: ["10-50"],
    fields: [
      "company_size",
      "employee_count",
      "headcount",
      "size",
      "company_size_range",
      "company_headcount",
      "employees",
    ],
  },
  industry: {
    values: ["software"],
    fields: [
      "industry",
      "company_industry",
      "sector",
      "company_sector",
      "linkedin_industry",
    ],
  },
};

console.log("=== Phase 1: filter taxonomy discovery via /prospects/stats (free) ===\n");

const acceptedByDimension = {};

for (const [dim, spec] of Object.entries(CANDIDATES)) {
  console.log(`-- dimension: ${dim} --`);
  const accepted = [];
  for (const field of spec.fields) {
    const body = {
      filters: {
        country_code: { values: ["ES"] },
        [field]: { values: spec.values },
      },
    };
    const result = await call("/prospects/stats", body);
    if (result.ok) {
      console.log(`  ${field.padEnd(28)} 200 (${result.latencyMs}ms) ✓ accepted`);
      accepted.push(field);
      // Extract total_results from the response for insight
      try {
        const parsed = JSON.parse(result.text);
        if (typeof parsed.total_results === "number") {
          console.log(`      total_results with value=${JSON.stringify(spec.values)}: ${parsed.total_results}`);
        }
      } catch {}
    } else {
      const classification = classifyValidationError(result.text, field);
      console.log(`  ${field.padEnd(28)} ${result.status} (${result.latencyMs}ms) ✗ ${classification}`);
      // Short excerpt of the body for Pydantic hints
      const excerpt = result.text.length > 300 ? `${result.text.slice(0, 300)}...` : result.text;
      console.log(`      body: ${excerpt}`);
    }
    // small pause to be polite
    await new Promise((r) => setTimeout(r, 150));
  }
  acceptedByDimension[dim] = accepted;
  console.log("");
}

console.log("--- Phase 1 summary ---");
for (const [dim, accepted] of Object.entries(acceptedByDimension)) {
  console.log(`  ${dim.padEnd(14)} accepted fields: ${accepted.length > 0 ? accepted.join(", ") : "(none)"}`);
}
console.log("");

// ===== Phase 2: fetch with mode:"full" =====

const FETCH_BODY = {
  mode: "full",
  filters: {
    country_code: { values: ["ES"] },
  },
  page: 1,
  page_size: 1,
};

console.log("=== Phase 2: /prospects fetch (mode:full, page_size:1) ===");
console.log(`body: ${JSON.stringify(FETCH_BODY)}`);
console.log("(4xx = free, 200 = 1 credit)\n");

const fetchResult = await call("/prospects", FETCH_BODY);
console.log(`status: ${fetchResult.status} (${fetchResult.latencyMs}ms)`);
if (fetchResult.headers) {
  const rate = [];
  for (const name of RELEVANT_HEADERS) {
    const value = fetchResult.headers.get(name);
    if (value !== null) rate.push(`${name}: ${value}`);
  }
  if (rate.length > 0) {
    console.log("headers of interest:");
    for (const line of rate) console.log(`  ${line}`);
  }
}
console.log("body:");
const preview =
  fetchResult.text.length > 8192
    ? `${fetchResult.text.slice(0, 8192)}\n… [truncated, ${fetchResult.text.length}B total]`
    : fetchResult.text;
console.log(preview);

if (!fetchResult.ok) {
  console.error("\n[probe:vibe-fetch] fetch failed validation; iterate FETCH_BODY based on the Pydantic detail above.");
  process.exit(1);
}

try {
  const parsed = JSON.parse(fetchResult.text);
  console.log(`\ntop-level keys: ${Object.keys(parsed).join(", ")}`);
  for (const arrayKey of ["data", "results", "prospects", "items"]) {
    const arr = parsed[arrayKey];
    if (Array.isArray(arr)) {
      console.log(`prospect array key: "${arrayKey}" (length=${arr.length})`);
      if (arr.length > 0) {
        console.log(`first prospect keys: ${Object.keys(arr[0]).join(", ")}`);
        console.log(`first prospect (redacted if needed):`);
        console.log(JSON.stringify(arr[0], null, 2));
      }
      break;
    }
  }
} catch {
  console.warn("[probe:vibe-fetch] response is not valid JSON.");
}

console.log("\n[probe:vibe-fetch] OK — phase 2 returned 200.");
