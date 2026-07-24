// Generates src/lib/supabase/database.types.ts by asking the Supabase
// Management API for the current schema. Invoked via `npm run gen-types`.
//
// Uses `supabase gen types --project-id <ref>` (remote API call) instead of
// `--db-url` (which shells out to a local podman/docker container running
// postgres-meta AND puts the DB password in a subprocess argv). Neither
// price is worth paying: we don't have Docker locally, and we don't want
// the DB URL surfacing in process listings or CLI debug output.
//
// The project ref is extracted from NEXT_PUBLIC_SUPABASE_URL (which is
// safe to expose) so we don't need a second env var.

import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const DEST = "src/lib/supabase/database.types.ts";

const accessToken = process.env.SUPABASE_ACCESS_TOKEN;
if (!accessToken) {
  console.error(
    "[gen-types] SUPABASE_ACCESS_TOKEN is missing. Generate one at",
  );
  console.error("  https://supabase.com/dashboard/account/tokens");
  console.error("and add it to .env.local (see .env.example).");
  process.exit(1);
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
if (!url) {
  console.error("[gen-types] NEXT_PUBLIC_SUPABASE_URL is missing.");
  process.exit(1);
}

const match = url.match(/^https:\/\/([a-z0-9]+)\.supabase\.co\/?$/);
if (!match) {
  console.error(
    `[gen-types] Cannot extract project ref from NEXT_PUBLIC_SUPABASE_URL. Expected https://<ref>.supabase.co, got: ${url}`,
  );
  process.exit(1);
}
const projectRef = match[1];

const result = spawnSync(
  "supabase",
  [
    "gen",
    "types",
    "--lang",
    "typescript",
    "--project-id",
    projectRef,
    "--schema",
    "public",
  ],
  {
    encoding: "utf8",
    env: { ...process.env, SUPABASE_ACCESS_TOKEN: accessToken },
  },
);

if (result.error) {
  console.error(
    `[gen-types] Failed to run supabase CLI: ${result.error.message}`,
  );
  console.error("Install it with: brew install supabase/tap/supabase");
  process.exit(1);
}

if (result.status !== 0) {
  console.error(
    `[gen-types] supabase gen types exited with code ${result.status}`,
  );
  if (result.stderr) console.error(result.stderr);
  process.exit(result.status ?? 1);
}

writeFileSync(DEST, result.stdout);
console.log(`[gen-types] Wrote ${DEST} (${result.stdout.length} bytes).`);
