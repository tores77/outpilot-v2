// Round 3 of Vibe/Explorium contract discovery. Zero-cost run.
//
// Phase 3A — industry mapping via linkedin_category (validated in round 2
//            as the accepted filter field). One /prospects/stats per
//            candidate category so we see real ES volume per label.
//
// Phase 3B — bulk_enrich contract shape, using the endpoint disclosed by
//            the docs:
//              POST /v1/prospects/contacts_information/bulk_enrich
//              POST /v1/prospects/contacts_information/enrich  (individual)
//            Both are probed with INTENTIONALLY invalid bodies so the API
//            can only return 4xx. Zero credit risk.
//
// The first VALID enrich body is NOT sent by this script. When round 3B
// nails the required shape, the run prints a candidate body for the
// user's explicit gate and stops.
//
// Usage:
//   npm run probe:vibe-round3

const BASE_URL = "https://api.explorium.ai/v1";

const key = process.env.VIBE_API_KEY;
if (!key || key.trim() === "") {
  console.error(
    "[probe:round3] VIBE_API_KEY is not set. Add it to .env.local (see .env.example).",
  );
  process.exit(1);
}

const HEADERS = {
  accept: "application/json",
  "content-type": "application/json",
  api_key: key,
};

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
    };
  }
  const text = redact(await response.text());
  return {
    ok: response.ok,
    status: response.status,
    text,
    latencyMs: Date.now() - startedAt,
  };
}

function excerpt(text, max = 400) {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

async function pause(ms = 150) {
  await new Promise((r) => setTimeout(r, ms));
}

// ===== Phase 3A: LinkedIn category discovery for our 4 UI sectors =====

const CATEGORY_CANDIDATES = [
  // SaaS / tech
  "software development",
  "technology, information and internet",
  "it services and it consulting",
  "computer software",
  "internet",

  // Digital agency / marketing
  "marketing services",
  "advertising services",
  "digital marketing",
  "public relations and communications services",

  // E-commerce
  "retail",
  "e-commerce",
  "consumer goods",
  "retail online",

  // Producción audiovisual
  "media production",
  "broadcast media",
  "movies, videos, and sound",
  "entertainment providers",

  // Cross-reference sanity: professional services (broad)
  "professional services",
];

console.log("=== Phase 3A: linkedin_category discovery (via /prospects/stats) ===\n");

for (const category of CATEGORY_CANDIDATES) {
  const body = {
    filters: {
      country_code: { values: ["ES"] },
      linkedin_category: { values: [category] },
    },
  };
  const result = await call("/prospects/stats", body);
  if (result.ok) {
    let total = null;
    try {
      const parsed = JSON.parse(result.text);
      total = typeof parsed.total_results === "number" ? parsed.total_results : null;
    } catch {}
    const totalStr = total !== null ? `total_results=${total.toLocaleString("en-US")}` : "";
    console.log(`  ${JSON.stringify(category).padEnd(56)} 200 (${result.latencyMs}ms) ✓  ${totalStr}`);
  } else {
    console.log(`  ${JSON.stringify(category).padEnd(56)} ${result.status} (${result.latencyMs}ms) ✗`);
    console.log(`      ${excerpt(result.text, 260)}`);
  }
  await pause();
}
console.log("");

// ===== Phase 3B: bulk_enrich contract discovery (empty / invalid bodies) =====
//
// Both endpoints are probed with:
//   1. {}                       — completely empty
//   2. { "prospect_ids": [] }   — array present but empty
//   3. { "prospect_ids": ["not-a-real-id"] }
//                                — invalid id format
// None of these can produce a valid 200; all should be 400/422/404.
// If any returns 200 we STOP LOUDLY.

const ENRICH_ENDPOINTS = [
  "/prospects/contacts_information/bulk_enrich",
  "/prospects/contacts_information/enrich",
];

const INVALID_BODIES = [
  { name: "empty",               body: {} },
  { name: "empty array",         body: { prospect_ids: [] } },
  { name: "invalid id format",   body: { prospect_ids: ["not-a-real-id"] } },
];

console.log("=== Phase 3B: bulk_enrich contract discovery (invalid bodies only, zero cost) ===\n");

for (const path of ENRICH_ENDPOINTS) {
  console.log(`-- ${path} --`);
  for (const attempt of INVALID_BODIES) {
    const result = await call(path, attempt.body);
    if (result.ok) {
      console.log(
        `  ${attempt.name.padEnd(22)} !! 200 (${result.latencyMs}ms) — UNEXPECTED, stop and inspect`,
      );
      console.log(`      body: ${excerpt(result.text, 500)}`);
      console.error("\n[probe:round3] Unexpected 200 with an invalid body. Aborting to avoid further calls.");
      process.exit(1);
    } else if (result.status === 404) {
      console.log(`  ${attempt.name.padEnd(22)} 404 (${result.latencyMs}ms) — endpoint does not exist at this path`);
      break; // no point trying more bodies against a 404
    } else if (result.status === 400 || result.status === 422) {
      console.log(
        `  ${attempt.name.padEnd(22)} ${result.status} (${result.latencyMs}ms) ✓  contract hint below`,
      );
      console.log(`      ${excerpt(result.text, 500)}`);
    } else {
      console.log(
        `  ${attempt.name.padEnd(22)} ${result.status} (${result.latencyMs}ms)  — other`,
      );
      console.log(`      ${excerpt(result.text, 300)}`);
    }
    await pause();
  }
  console.log("");
}

console.log(
  "[probe:round3] done — every call in this run was stats or an intentionally-invalid enrich body. Zero credits.\n",
);
console.log(
  "Next: paste the output. Once the required enrich field names are clear from the 422 details above, I'll draft the FIRST valid enrich body (1 prospect_id) as a candidate for your explicit gate. That call is where credits start.",
);
