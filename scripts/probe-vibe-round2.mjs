// Round 2 of Vibe/Explorium contract discovery. Zero-cost run.
//
// Phase A — refine what we already found:
//   A1. Industry filter family (google_category, linkedin_category,
//       naics, sic_code, ...). None of the first-round candidates
//       (industry / company_industry / sector / company_sector /
//       linkedin_industry) were accepted; try the "category" family.
//   A2. job_level enum values. Learn which canonical strings the API
//       accepts by running one stats call per candidate value.
//   A3. company_size enum values. The round-1 422 reported the enum
//       (1-10, 11-50, ..., 10001+); verify each returns a valid stats
//       response now that the format is known.
//
// Phase B — enrich endpoint DISCOVERY only (no body iteration):
//   POST candidate paths with an INTENTIONALLY empty body. Explorium
//   should return 404 (endpoint does not exist) or 422 (endpoint exists
//   but the body is invalid). Neither consumes credits. This lets us
//   learn the endpoint names without spending anything. Once we know the
//   endpoint, the *body* iteration (which will produce 422s that reveal
//   the required fields) is the next round, and the first 200 (which
//   costs) is the user's gate.
//
// Usage:
//   npm run probe:vibe-round2

const BASE_URL = "https://api.explorium.ai/v1";

const key = process.env.VIBE_API_KEY;
if (!key || key.trim() === "") {
  console.error(
    "[probe:round2] VIBE_API_KEY is not set. Add it to .env.local (see .env.example).",
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
  return { ok: response.ok, status: response.status, text, latencyMs: Date.now() - startedAt };
}

function excerpt(text, max = 250) {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

async function pause(ms = 150) {
  await new Promise((r) => setTimeout(r, ms));
}

// ================== Phase A1: industry filter family ==================

const INDUSTRY_CANDIDATES = [
  "google_category",
  "linkedin_category",
  "company_google_category",
  "company_linkedin_category",
  "google_business_category",
  "linkedin_business_category",
  "naics",
  "naics_code",
  "sic",
  "sic_code",
];

console.log("=== Phase A1: industry filter family (via /prospects/stats) ===\n");

const industryDummy = ["software"];
for (const field of INDUSTRY_CANDIDATES) {
  const body = {
    filters: {
      country_code: { values: ["ES"] },
      [field]: { values: industryDummy },
    },
  };
  const result = await call("/prospects/stats", body);
  if (result.ok) {
    let totalResults = null;
    try {
      const parsed = JSON.parse(result.text);
      totalResults = typeof parsed.total_results === "number" ? parsed.total_results : null;
    } catch {}
    console.log(
      `  ${field.padEnd(32)} 200 (${result.latencyMs}ms) ✓ accepted` +
        (totalResults !== null ? `  total_results=${totalResults}` : ""),
    );
  } else {
    console.log(`  ${field.padEnd(32)} ${result.status} (${result.latencyMs}ms) ✗`);
    console.log(`      ${excerpt(result.text, 220)}`);
  }
  await pause();
}
console.log("");

// ================== Phase A2: job_level enum values ==================

const JOB_LEVEL_CANDIDATES = [
  "director",
  "vp",
  "c-suite",
  "c_suite",
  "csuite",
  "cxo",
  "board member",
  "board_member",
  "senior",
  "manager",
  "owner",
  "partner",
];

console.log("=== Phase A2: job_level enum values (via /prospects/stats) ===\n");

for (const value of JOB_LEVEL_CANDIDATES) {
  const body = {
    filters: {
      country_code: { values: ["ES"] },
      job_level: { values: [value] },
    },
  };
  const result = await call("/prospects/stats", body);
  if (result.ok) {
    let totalResults = null;
    try {
      const parsed = JSON.parse(result.text);
      totalResults = typeof parsed.total_results === "number" ? parsed.total_results : null;
    } catch {}
    console.log(
      `  ${JSON.stringify(value).padEnd(20)} 200 (${result.latencyMs}ms) ✓` +
        (totalResults !== null ? `  total_results=${totalResults}` : ""),
    );
  } else {
    console.log(`  ${JSON.stringify(value).padEnd(20)} ${result.status} (${result.latencyMs}ms) ✗`);
    console.log(`      ${excerpt(result.text, 220)}`);
  }
  await pause();
}
console.log("");

// ================== Phase A3: company_size enum values ==================

const COMPANY_SIZE_VALUES = [
  "1-10",
  "11-50",
  "51-200",
  "201-500",
  "501-1000",
  "1001-5000",
  "5001-10000",
  "10001+",
];

console.log("=== Phase A3: company_size enum values (via /prospects/stats) ===\n");

for (const value of COMPANY_SIZE_VALUES) {
  const body = {
    filters: {
      country_code: { values: ["ES"] },
      company_size: { values: [value] },
    },
  };
  const result = await call("/prospects/stats", body);
  if (result.ok) {
    let totalResults = null;
    try {
      const parsed = JSON.parse(result.text);
      totalResults = typeof parsed.total_results === "number" ? parsed.total_results : null;
    } catch {}
    console.log(
      `  ${value.padEnd(14)} 200 (${result.latencyMs}ms) ✓` +
        (totalResults !== null ? `  total_results=${totalResults}` : ""),
    );
  } else {
    console.log(`  ${value.padEnd(14)} ${result.status} (${result.latencyMs}ms) ✗`);
    console.log(`      ${excerpt(result.text, 220)}`);
  }
  await pause();
}
console.log("");

// ================== Phase B: enrich endpoint discovery ==================
//
// SAFETY: every call in this phase sends an intentionally invalid body
// (empty {} or minimal), so the API can only respond with:
//   404 (endpoint does not exist)
//   422 (endpoint exists, body invalid)
//   401/403 (auth issue — same key that stats accepts, so unlikely)
// No 200 possible with these bodies -> zero credit risk.

const ENRICH_ENDPOINTS = [
  "/prospects/enrich_contacts",
  "/prospects/enrich_contact_information",
  "/prospects/enrich_contact",
  "/prospects/enrich_professional_email",
  "/prospects/enrich_professional_emails",
  "/prospects/enrich_email",
  "/prospects/enrich_emails",
  "/prospects/emails",
  "/prospects/contacts",
  "/prospects/enrich",
  "/enrichments/prospects",
  "/enrichments/prospects/contact",
  "/enrichments/prospects/emails",
  "/enrichments/prospects/professional_email",
];

console.log("=== Phase B: enrich endpoint discovery (empty body -> 422/404 only) ===\n");

for (const path of ENRICH_ENDPOINTS) {
  const result = await call(path, {});
  if (result.ok) {
    // Should never happen with an empty body — flag loudly if it does.
    console.log(
      `  ${path.padEnd(48)} !! 200 (${result.latencyMs}ms) — UNEXPECTED, stop and inspect`,
    );
    console.log(`      ${excerpt(result.text, 400)}`);
  } else if (result.status === 404) {
    console.log(`  ${path.padEnd(48)} 404 (${result.latencyMs}ms) — not found`);
  } else if (result.status === 422 || result.status === 400) {
    console.log(
      `  ${path.padEnd(48)} ${result.status} (${result.latencyMs}ms) ✓ EXISTS`,
    );
    console.log(`      required fields (from body): ${excerpt(result.text, 400)}`);
  } else {
    console.log(
      `  ${path.padEnd(48)} ${result.status} (${result.latencyMs}ms) — other`,
    );
    console.log(`      ${excerpt(result.text, 220)}`);
  }
  await pause();
}
console.log("");

console.log("[probe:round2] done — all calls in this run were stats or intentionally-invalid bodies. Zero credits.");
