// Backfill de sector + business_description + tamaño para leads
// existentes de source='vibe_prospecting' cuyo scoring se hizo a
// ciegas (sin sector). Motivación: /prospects NO devolvió
// linkedin_category, así que los 114 leads llegaron con sector NULL
// y Nova puntuó inventando sector (caso Linq).
//
// Estrategia: por cada lead sin sector, POST /businesses/firmographics/enrich
// con su custom_fields.business_id → obtiene sector +
// business_description + number_of_employees_range + yearly_revenue_range.
// COSTE: 1 crédito por business_id único. Con dedupe por empresa,
// típicamente 60-80% del total de leads.
//
// Usage:
//   # DRY-RUN: solo enumera cuántos leads y qué credits gastaría.
//   node --env-file-if-exists=.env.local scripts/backfill-vibe-firmographics.mjs
//
//   # EXECUTE: llama a Vibe y actualiza BD.
//   EXECUTE=1 node --env-file-if-exists=.env.local scripts/backfill-vibe-firmographics.mjs

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
    console.error(`[backfill] falta env var ${name}`);
    process.exit(1);
  }
  return v;
}

const supaUrl = requireEnv("NEXT_PUBLIC_SUPABASE_URL");
const supaKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
const vibeKey = requireEnv("VIBE_API_KEY");
const supabase = createClient(supaUrl, supaKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const execute = process.env.EXECUTE === "1";

console.log(`[backfill] mode: ${execute ? "EXECUTE (writes to BD + gasta créditos Vibe)" : "DRY-RUN"}`);

// 1. Saldo actual
const balBefore = await (
  await fetch("https://api.explorium.ai/v1/credits", {
    headers: { api_key: vibeKey },
  })
).json();
console.log(`[backfill] saldo Vibe: ${balBefore.remaining_credits} de ${balBefore.allocated_credits}`);

// 2. Leads sin sector con business_id
const { data: leads, error } = await supabase
  .from("leads")
  .select("id, company, sector, custom_fields")
  .eq("source", "vibe_prospecting")
  .is("sector", null);
if (error) throw new Error(`select failed: ${error.message}`);

console.log(`[backfill] leads vibe_prospecting con sector NULL: ${leads?.length ?? 0}`);

// 3. Business_ids únicos
const leadsByBid = new Map();
let sinBusinessId = 0;
for (const l of leads ?? []) {
  const bid = l.custom_fields?.business_id;
  if (typeof bid !== "string" || bid.length === 0) {
    sinBusinessId += 1;
    continue;
  }
  const arr = leadsByBid.get(bid) ?? [];
  arr.push(l);
  leadsByBid.set(bid, arr);
}
console.log(`[backfill] business_ids únicos: ${leadsByBid.size}`);
console.log(`[backfill] leads sin business_id (no backfilleables): ${sinBusinessId}`);
console.log(`[backfill] créditos que se gastarían: ${leadsByBid.size}`);

if (leadsByBid.size > balBefore.remaining_credits) {
  console.error(
    `[backfill] ABORTA: no hay saldo (${balBefore.remaining_credits} < ${leadsByBid.size})`,
  );
  process.exit(2);
}

if (!execute) {
  console.log(`\n[backfill] DRY-RUN — sin llamar a Vibe. Ejecuta con EXECUTE=1.`);
  process.exit(0);
}

// 4. Enrich + update por lead único
console.log(`\n[backfill] ejecutando...`);
let updatedLeads = 0;
let failedBids = 0;
let sectorFromApi = 0;
let sectorEmpty = 0;
for (const [bid, ls] of leadsByBid) {
  try {
    const r = await fetch(
      "https://api.explorium.ai/v1/businesses/firmographics/enrich",
      {
        method: "POST",
        headers: {
          api_key: vibeKey,
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({ business_id: bid }),
      },
    );
    if (!r.ok) {
      failedBids += 1;
      console.error(`  ${bid}: ${r.status} ${await r.text()}`);
      continue;
    }
    const j = await r.json();
    const business = j.data ?? {};
    const sector = business.linkedin_industry_category ?? null;
    const description = business.business_description ?? null;
    const size = business.number_of_employees_range ?? null;
    const revenue = business.yearly_revenue_range ?? null;
    const naicsDesc = business.naics_description ?? null;
    if (sector) sectorFromApi += 1;
    else sectorEmpty += 1;

    // Update cada lead con este business_id.
    for (const lead of ls) {
      const newCustom = { ...(lead.custom_fields ?? {}) };
      if (description) newCustom.company_description = description;
      if (size) newCustom.company_size = size;
      if (revenue) newCustom.company_revenue = revenue;
      if (naicsDesc) newCustom.naics_description = naicsDesc;
      const { error: upErr } = await supabase
        .from("leads")
        .update({
          sector,
          custom_fields: newCustom,
        })
        .eq("id", lead.id);
      if (upErr) {
        console.error(`  update ${lead.id}: ${upErr.message}`);
      } else {
        updatedLeads += 1;
      }
    }
  } catch (err) {
    failedBids += 1;
    console.error(`  ${bid}: ${err.message}`);
  }
}

// 5. Saldo final
const balAfter = await (
  await fetch("https://api.explorium.ai/v1/credits", {
    headers: { api_key: vibeKey },
  })
).json();
console.log(`\n[backfill] resumen:`);
console.log(`  business_ids procesados: ${leadsByBid.size}`);
console.log(`  business_ids fallidos: ${failedBids}`);
console.log(`  con sector devuelto: ${sectorFromApi}`);
console.log(`  sin sector devuelto: ${sectorEmpty}`);
console.log(`  leads actualizados: ${updatedLeads}`);
console.log(
  `  saldo Vibe: ${balBefore.remaining_credits} → ${balAfter.remaining_credits} (delta ${balBefore.remaining_credits - balAfter.remaining_credits})`,
);
