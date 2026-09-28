// OUTPILOT v2 · scripts / reverify-firmographics-domain.mjs
//
// Re-comprueba el guard de coherencia de dominio SIN llamar a Vibe.
// Depende de que el enrich previo haya persistido
// custom_fields.firmographics_vibe_website (lección T024 §Integraciones
// aplicada tras el post-mortem del backfill 2026-09-28: hay que
// persistir todo campo de una API de pago aunque no se use hoy).
//
// Comportamiento:
//   Para cada lead con source='vibe_prospecting' y
//   custom_fields.firmographics_vibe_website != null:
//     leadDomain  = leadDomainForGuard(website, email)
//     vibeDomain  = rootDomain(custom_fields.firmographics_vibe_website)
//     ambos != null y iguales → firmographics_domain_verified='true'
//                                (limpia mismatch/data_mismatch previos
//                                 si existían).
//     ambos != null y != igual → firmographics_mismatch = {vibe_domain,
//                                lead_domain},
//                                firmographics_domain_verified='false',
//                                review_reason='data_mismatch',
//                                needs_review=true.
//     alguno nulo               → firmographics_domain_verified='false'
//                                (no verificable, señal débil).
//
//   Leads sin firmographics_vibe_website persistido: se cuentan
//   aparte como "requiere re-enrich" y NO se tocan.
//
// Usage:
//   node --env-file-if-exists=.env.local scripts/reverify-firmographics-domain.mjs
//   EXECUTE=1 node --env-file-if-exists=.env.local scripts/reverify-firmographics-domain.mjs
//
// Vars: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
// SIN Vibe API — sin coste.

import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "node:fs";

if (existsSync(".env.local")) {
  const raw = readFileSync(".env.local", "utf8");
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    const [, key, val] = m;
    if (!process.env[key]) process.env[key] = val.replace(/^"|"$/g, "");
  }
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v || v.trim() === "") {
    console.error(`[reverify] falta env var ${name}`);
    process.exit(1);
  }
  return v;
}

const supaUrl = requireEnv("NEXT_PUBLIC_SUPABASE_URL");
const supaKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
const supabase = createClient(supaUrl, supaKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const execute = process.env.EXECUTE === "1";

// Helpers duplicados de src/lib/vibe/mapper.ts (script self-contained).
function rootDomain(url) {
  if (!url || typeof url !== "string" || url.trim() === "") return null;
  const raw = url.trim();
  const hasScheme = /^https?:\/\//i.test(raw);
  try {
    const u = new URL(hasScheme ? raw : `https://${raw}`);
    return u.hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return null;
  }
}
const GENERIC_EMAIL_DOMAINS = new Set([
  "gmail.com", "hotmail.com", "yahoo.com", "outlook.com", "live.com",
  "icloud.com", "me.com", "aol.com", "protonmail.com", "proton.me",
  "mail.com", "zoho.com", "yandex.com", "gmx.com",
]);
function emailDomain(email) {
  if (!email || typeof email !== "string") return null;
  const at = email.trim().toLowerCase().indexOf("@");
  if (at <= 0 || at === email.length - 1) return null;
  const domain = email.trim().toLowerCase().slice(at + 1);
  if (GENERIC_EMAIL_DOMAINS.has(domain)) return null;
  return domain;
}
function leadDomainForGuard(lead) {
  return rootDomain(lead.website) ?? emailDomain(lead.email);
}

console.log(`[reverify] mode: ${execute ? "EXECUTE (writes to BD)" : "DRY-RUN"}`);

// 1. Leer todos los vibe_prospecting.
const { data: leads, error } = await supabase
  .from("leads")
  .select("id, company, website, email, needs_review, custom_fields")
  .eq("source", "vibe_prospecting");
if (error) throw new Error(`select failed: ${error.message}`);
console.log(`[reverify] leads vibe_prospecting: ${leads?.length ?? 0}`);

let requiresReEnrich = 0;
let toVerified = 0;
let toMismatch = 0;
let toUnverifiable = 0;
let noChange = 0;
const updates = [];

for (const lead of leads ?? []) {
  const custom = lead.custom_fields ?? {};
  const vibeWebsiteRaw = custom.firmographics_vibe_website;
  if (!vibeWebsiteRaw) {
    requiresReEnrich += 1;
    continue;
  }
  const leadDomain = leadDomainForGuard({
    website: lead.website,
    email: lead.email,
  });
  const vibeDomain = rootDomain(vibeWebsiteRaw);

  let nextVerified;
  let nextMismatch = null;
  let addReviewReason = null;

  if (leadDomain && vibeDomain && leadDomain === vibeDomain) {
    nextVerified = "true";
  } else if (leadDomain && vibeDomain && leadDomain !== vibeDomain) {
    nextVerified = "false";
    nextMismatch = JSON.stringify({
      vibe_domain: vibeDomain,
      lead_domain: leadDomain,
    });
    addReviewReason = "data_mismatch";
  } else {
    // Alguno de los dos no parseable → sigue unverified.
    nextVerified = "false";
  }

  const prevVerified = custom.firmographics_domain_verified ?? null;
  const prevMismatch = custom.firmographics_mismatch ?? null;
  const prevReviewReason = custom.review_reason ?? null;

  // Detectar si hay cambio real
  const wouldChange =
    prevVerified !== nextVerified ||
    prevMismatch !== nextMismatch ||
    (addReviewReason && prevReviewReason !== addReviewReason);

  if (!wouldChange) {
    noChange += 1;
    continue;
  }

  const newCustom = { ...custom };
  newCustom.firmographics_domain_verified = nextVerified;
  if (nextMismatch) {
    newCustom.firmographics_mismatch = nextMismatch;
  } else {
    // Match limpio: si había mismatch previo, lo eliminamos.
    delete newCustom.firmographics_mismatch;
  }
  const patch = { custom_fields: newCustom };
  if (addReviewReason) {
    newCustom.review_reason = addReviewReason;
    patch.needs_review = true;
  }

  if (nextVerified === "true") toVerified += 1;
  else if (nextMismatch) toMismatch += 1;
  else toUnverifiable += 1;

  updates.push({ id: lead.id, company: lead.company, patch });
}

console.log(`\n[reverify] resumen:`);
console.log(`  requiere re-enrich (sin firmographics_vibe_website): ${requiresReEnrich}`);
console.log(`  sin cambios (ya coherente): ${noChange}`);
console.log(`  → verified: ${toVerified}`);
console.log(`  → mismatch (data_mismatch + needs_review): ${toMismatch}`);
console.log(`  → unverifiable (dominio no parseable): ${toUnverifiable}`);
console.log(`  total a actualizar: ${updates.length}`);

// Muestra hasta 5 ejemplos de mismatch para revisión visual.
const mismatchSamples = updates
  .filter((u) => u.patch.custom_fields.firmographics_mismatch)
  .slice(0, 5);
if (mismatchSamples.length > 0) {
  console.log(`\n[reverify] muestras de mismatch (primeros 5):`);
  for (const s of mismatchSamples) {
    const mm = JSON.parse(s.patch.custom_fields.firmographics_mismatch);
    console.log(`  ${s.company}: vibe=${mm.vibe_domain} vs lead=${mm.lead_domain}`);
  }
}

if (!execute) {
  console.log(`\n[reverify] DRY-RUN — sin escrituras. Repite con EXECUTE=1.`);
  process.exit(0);
}

console.log(`\n[reverify] escribiendo ${updates.length} updates...`);
let written = 0;
for (const u of updates) {
  const { error: upErr } = await supabase
    .from("leads")
    .update(u.patch)
    .eq("id", u.id);
  if (upErr) {
    console.error(`  update ${u.id} (${u.company}): ${upErr.message}`);
  } else {
    written += 1;
  }
}
console.log(`\n[reverify] escritos: ${written} de ${updates.length}`);
