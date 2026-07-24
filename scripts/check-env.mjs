// Verifies that .env.local defines the 7 variables the app needs at runtime.
// Invoked via `npm run env:check`. Reads .env.local through Node's
// --env-file-if-exists flag, so a missing file surfaces as a clear "missing
// variables" report instead of a Node crash.
//
// Next.js reads .env.local with the same semantics: if this script passes,
// process.env inside the app will see the same values.

const REQUIRED = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_DB_URL",
  "ANTHROPIC_API_KEY",
  "INNGEST_EVENT_KEY",
  "INNGEST_SIGNING_KEY",
];

// Dev tooling only; not read at runtime. Warn but don't fail if missing.
const OPTIONAL = ["SUPABASE_ACCESS_TOKEN"];

const missing = REQUIRED.filter((key) => !process.env[key]);

if (missing.length > 0) {
  console.error(
    `\n[env:check] Missing or empty (${missing.length}/${REQUIRED.length}):`,
  );
  for (const key of missing) console.error(`  - ${key}`);
  console.error(
    `\nCreate .env.local from .env.example and fill each value, then retry.\n`,
  );
  process.exit(1);
}

console.log(
  `[env:check] OK — ${REQUIRED.length} required variables present in process.env.`,
);
for (const key of REQUIRED) {
  const value = process.env[key];
  const masked =
    value.length <= 8
      ? "****"
      : `${value.slice(0, 4)}…${value.slice(-4)} (${value.length}ch)`;
  console.log(`  ${key.padEnd(32)} ${masked}`);
}

const missingOptional = OPTIONAL.filter((key) => !process.env[key]);
if (missingOptional.length > 0) {
  console.warn(
    `\n[env:check] Optional dev tooling variables not set (not a failure):`,
  );
  for (const key of missingOptional) console.warn(`  - ${key}`);
  console.warn(
    "  These are only needed by dev scripts (e.g. npm run gen-types).",
  );
}
