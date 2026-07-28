// AUTHORISED PAID PROBE — single call to bulk_enrich with 1 prospect_id.
// Estimated cost: ~5 credits (per Pere's Vibe UI experience).
// Prospect_id: Federico's, discovered in round 1's fetch response.
//
// This script exists as its own file so the exact body sent to Vibe is
// reviewable in git history — no argv, no environment-driven variants.
// Running the script IS the confirmation.
//
// Usage:
//   npm run probe:vibe-enrich-first

const ENDPOINT =
  "https://api.explorium.ai/v1/prospects/contacts_information/bulk_enrich";

const BODY = {
  prospect_ids: ["8c2455c2bcea6407caf430a34160e45641933896"],
};

const key = process.env.VIBE_API_KEY;
if (!key || key.trim() === "") {
  console.error(
    "[probe:enrich-first] VIBE_API_KEY is not set. Add it to .env.local (see .env.example).",
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

function redact(text) {
  return text.split(key).join("<VIBE_API_KEY_REDACTED>");
}

console.log("[probe:enrich-first] ⚠️  paid call — approx. 5 credits");
console.log(`[probe:enrich-first] POST ${ENDPOINT}`);
console.log(`[probe:enrich-first] body: ${JSON.stringify(BODY)}`);
console.log("");

const startedAt = Date.now();
let response;
try {
  response = await fetch(ENDPOINT, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify(BODY),
  });
} catch (err) {
  console.error(
    `[probe:enrich-first] fetch threw: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
}

const latencyMs = Date.now() - startedAt;
console.log(
  `[probe:enrich-first] status: ${response.status} ${response.statusText} (${latencyMs}ms)`,
);

const headerLines = [];
for (const name of RELEVANT_HEADERS) {
  const value = response.headers.get(name);
  if (value !== null) headerLines.push(`  ${name}: ${value}`);
}
if (headerLines.length > 0) {
  console.log("[probe:enrich-first] headers of interest:");
  for (const line of headerLines) console.log(line);
}

const rawText = await response.text();
const redacted = redact(rawText);

console.log("[probe:enrich-first] raw body:");
const preview =
  redacted.length > 16384
    ? `${redacted.slice(0, 16384)}\n… [truncated, ${redacted.length}B total]`
    : redacted;
console.log(preview);

if (!response.ok) {
  console.error("\n[probe:enrich-first] non-2xx. Contract not confirmed.");
  process.exit(1);
}

// Structured shape report — what the caller of the redesigned job needs to know.
try {
  const parsed = JSON.parse(rawText);
  console.log("\n[probe:enrich-first] top-level keys:", Object.keys(parsed).join(", "));

  const arrayKeyCandidates = ["data", "results", "prospects", "items", "enriched", "contacts"];
  let contactsArray = null;
  let arrayKey = null;
  for (const k of arrayKeyCandidates) {
    if (Array.isArray(parsed[k])) {
      arrayKey = k;
      contactsArray = parsed[k];
      break;
    }
  }
  if (contactsArray) {
    console.log(`[probe:enrich-first] contacts array key: "${arrayKey}" (length=${contactsArray.length})`);
    if (contactsArray.length > 0) {
      const first = contactsArray[0];
      console.log(`[probe:enrich-first] first contact keys: ${Object.keys(first).join(", ")}`);
      console.log("[probe:enrich-first] first contact (pretty-printed):");
      console.log(JSON.stringify(first, null, 2));

      // Highlight fields the mapper will care about the most
      const interesting = {
        "email (plaintext?)": first.email ?? first.professional_email ?? first.work_email ?? null,
        "phone": first.phone ?? first.phone_number ?? first.mobile ?? null,
        "linkedin": first.linkedin ?? first.linkedin_url ?? null,
        "prospect_id echo": first.prospect_id ?? first.id ?? null,
      };
      console.log("[probe:enrich-first] mapper-relevant fields:");
      for (const [label, value] of Object.entries(interesting)) {
        console.log(`  ${label.padEnd(24)} ${value === null ? "(missing)" : JSON.stringify(value).slice(0, 100)}`);
      }
    }
  } else {
    console.warn("[probe:enrich-first] no contact array found under known keys. Inspect raw body above.");
  }
} catch {
  console.warn("[probe:enrich-first] response is not valid JSON.");
}

console.log(
  "\n[probe:enrich-first] OK — 2xx received. Check Vibe dashboard for the exact credit deduction and paste it back with the output.",
);
