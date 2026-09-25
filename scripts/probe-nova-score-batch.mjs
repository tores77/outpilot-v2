// Probe local del batch de scoring de Nova (T024 debug).
//
// Motivación (2026-09-25): un lote de 20 leads rompió el parser en
// bucle infinito. El fix del parser previo no cubrió el modo real de
// Haiku. Este probe carga leads reales de BD (SIN escribir icp_score
// ni tocar el claim), construye el mismo payload que el job y llama
// a Haiku una vez para ver la respuesta cruda ANTES de tocar código.
//
// Coste: 1 llamada a Haiku por run (~1 céntimo). Escribe en api_costs
// (el wrapper callClaude lo hace por diseño).
//
// Usage (elige fuente de leads):
//   # Los 20 stuck (con scoring_claimed_at, sin icp_score) — reproduce
//   # la respuesta que rompió el job:
//   node --env-file-if-exists=.env.local scripts/probe-nova-score-batch.mjs
//
//   # DRY-RUN: solo imprime el payload que se enviaría, no llama a Haiku:
//   DRY_RUN=1 node --env-file-if-exists=.env.local scripts/probe-nova-score-batch.mjs
//
//   # 20 pending fresh (sin claim) en vez de los stuck:
//   SOURCE=fresh node --env-file-if-exists=.env.local scripts/probe-nova-score-batch.mjs

import { createClient } from "@supabase/supabase-js";
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, existsSync } from "node:fs";
// Imports puros (sin server-only): safe desde script Node.
import {
  applyScoreMechanicalGates,
  buildLeadPayload,
  parseScoringResponse,
} from "../src/lib/nova/scoring.ts";
import {
  buildScoringSystemPrompt,
  NOVA_ACTIVE_ICP_SLUG,
  NOVA_SCORE_BATCH_SIZE,
  NOVA_SCORE_MAX_TOKENS,
  NOVA_SCORE_THRESHOLD_REVIEW,
} from "../src/config/scoring.ts";
import { getIcpBySlug } from "../src/config/icps.ts";
import { mergeBusinessFirmographics } from "../src/lib/vibe/mapper.ts";

// Carga .env.local manual (tsx no honra --env-file de Node).
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
    console.error(`[probe] falta env var ${name}`);
    process.exit(1);
  }
  return v;
}

const supaUrl = requireEnv("NEXT_PUBLIC_SUPABASE_URL");
const supaKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
const supabase = createClient(supaUrl, supaKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// Fuente:
//   IDS=uuid1,uuid2,...            → lista literal de leads (para
//                                    gates §3 con casos concretos)
//   SOURCE=stuck (default)         → los que tienen claim colgado
//   SOURCE=fresh                   → 20 pendientes sin claim
//
// ENRICH=1 hace un business_enrich fresh contra Vibe para cada
// lead (SOLO si el lead tiene custom_fields.business_id). Coste
// 1 crédito por business_id único. Útil para probar el prompt
// con el sector RESUELTO (post-fix T024) sin correr backfill.
const source = process.env.SOURCE ?? "stuck";
const explicitIds =
  (process.env.IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const enrichFresh = process.env.ENRICH === "1";
const dryRun = process.env.DRY_RUN === "1";

// Resolver tenant (v2.1 tiene 1 solo).
const { data: tenants, error: tErr } = await supabase
  .from("tenants")
  .select("id, name")
  .limit(2);
if (tErr) throw new Error(`tenants: ${tErr.message}`);
if (!tenants || tenants.length === 0) throw new Error("no tenants");
if (tenants.length > 1) throw new Error("múltiples tenants — no soportado por el probe");
const tenantId = tenants[0].id;
console.log(`[probe] tenant: ${tenants[0].name} (${tenantId})`);

// Cargar leads.
const selectCols =
  "id, email, first_name, last_name, company, title, sector, country, city, website, linkedin_url, custom_fields";
let leads;
if (explicitIds.length > 0) {
  console.log(`[probe] source=IDS (${explicitIds.length} explícitos)`);
  const { data, error } = await supabase
    .from("leads")
    .select(selectCols)
    .eq("tenant_id", tenantId)
    .in("id", explicitIds);
  if (error) throw new Error(`leads: ${error.message}`);
  leads = data ?? [];
} else {
  let query = supabase
    .from("leads")
    .select(selectCols)
    .eq("tenant_id", tenantId)
    .is("icp_score", null)
    .order("created_at", { ascending: true })
    .limit(NOVA_SCORE_BATCH_SIZE);
  if (source === "stuck") {
    query = query.not("scoring_claimed_at", "is", null);
  } else if (source === "fresh") {
    query = query.is("scoring_claimed_at", null);
  }
  const { data, error } = await query;
  if (error) throw new Error(`leads: ${error.message}`);
  leads = data ?? [];
}
if (leads.length === 0) {
  console.error(`[probe] 0 leads seleccionados`);
  process.exit(2);
}
console.log(`[probe] leads: ${leads.length}`);
console.log(`[probe] ids: ${leads.map((l) => `${l.company}=${l.id.slice(0, 8)}`).join(", ")}`);

// ENRICH=1: business firmographics para todos los leads sin sector
// (o para todos si Pere quiere reevaluar). Coste = 1 cr por business_id
// único.
if (enrichFresh && !dryRun) {
  const vibeKey = process.env.VIBE_API_KEY;
  if (!vibeKey) {
    console.error(`[probe] ENRICH=1 requiere VIBE_API_KEY`);
    process.exit(2);
  }
  const bidByLead = new Map();
  const uniqueBids = new Set();
  for (const l of leads) {
    const bid = l.custom_fields?.business_id;
    if (typeof bid === "string" && bid.length > 0) {
      bidByLead.set(l.id, bid);
      uniqueBids.add(bid);
    }
  }
  console.log(`[probe] enrich fresh: ${uniqueBids.size} business_ids únicos (${uniqueBids.size} créditos Vibe)`);
  const businessData = new Map();
  for (const bid of uniqueBids) {
    const r = await fetch(
      "https://api.explorium.ai/v1/businesses/firmographics/enrich",
      {
        method: "POST",
        headers: {
          api_key: vibeKey,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({ business_id: bid }),
      },
    );
    if (!r.ok) {
      console.error(`  ${bid}: ${r.status}`);
      continue;
    }
    const j = await r.json();
    if (j.data) businessData.set(bid, j.data);
  }
  // Merge in-memory (NO se escribe a BD).
  let mismatches = 0;
  for (let i = 0; i < leads.length; i++) {
    const bid = bidByLead.get(leads[i].id);
    if (bid && businessData.has(bid)) {
      const outcome = mergeBusinessFirmographics(leads[i], businessData.get(bid));
      leads[i] = outcome.draft;
      if (outcome.mismatch) {
        mismatches += 1;
        console.log(
          `  MISMATCH ${leads[i].company}: vibe=${outcome.mismatch.vibe_domain} vs lead=${outcome.mismatch.lead_domain}`,
        );
      }
    }
  }
  if (mismatches > 0) console.log(`[probe] TOTAL mismatches: ${mismatches}`);
}

// Construir payload idéntico al del job.
const payload = leads.map((l) => buildLeadPayload(l));
const userMessage = JSON.stringify(payload, null, 2);
console.log(`\n[probe] payload size: ${userMessage.length} chars`);
console.log(`[probe] payload (primer lead):`);
console.log(JSON.stringify(payload[0], null, 2));

if (dryRun) {
  console.log(`\n[probe] DRY_RUN=1 — sin llamar a Haiku.`);
  process.exit(0);
}

// Llamar a Haiku (real). SDK directo — bypass el wrapper server-only
// (que arrastra el cliente supabase RLS-bypass y no puede vivir en un
// script Node). Modelo hardcoded al mismo del task nova.score
// (config/models.ts:TASK_MODEL).
const anthropicKey = requireEnv("ANTHROPIC_API_KEY");
const anthropic = new Anthropic({ apiKey: anthropicKey });
const MODEL = "claude-haiku-4-5-20251001";

// Prompt inyectado desde el ICP activo (mismo que el job en producción).
const activeIcp = getIcpBySlug(NOVA_ACTIVE_ICP_SLUG);
if (!activeIcp) {
  console.error(`[probe] ICP '${NOVA_ACTIVE_ICP_SLUG}' no existe`);
  process.exit(1);
}
const systemPrompt = buildScoringSystemPrompt(activeIcp.scoringCriteria);
console.log(`\n[probe] system prompt: ${systemPrompt.length} chars`);
console.log(`\n[probe] enviando a ${MODEL}...`);
const t0 = Date.now();
let resp;
try {
  resp = await anthropic.messages.create({
    model: MODEL,
    // Por defecto usa NOVA_SCORE_MAX_TOKENS del config (mismo que el
    // job en producción). Override con MAX_TOKENS=N para reproducir
    // el bug del 2026-09-25 (MAX_TOKENS=3000 → truncado).
    max_tokens: Number(process.env.MAX_TOKENS ?? String(NOVA_SCORE_MAX_TOKENS)),
    system: systemPrompt,
    messages: [{ role: "user", content: userMessage }],
  });
} catch (err) {
  console.error(`[probe] Anthropic call failed: ${err.message}`);
  process.exit(3);
}
const elapsedMs = Date.now() - t0;

const rawText = resp.content
  .filter((b) => b.type === "text")
  .map((b) => b.text)
  .join("");

console.log(
  `[probe] Haiku respondió en ${elapsedMs}ms | tokens in=${resp.usage.input_tokens} out=${resp.usage.output_tokens} · stop=${resp.stop_reason}`,
);
console.log(`\n=== RESPUESTA CRUDA (primeros 2000 chars) ===`);
console.log(rawText.slice(0, 2000));
if (rawText.length > 2000) {
  console.log(`\n[... truncado, total ${rawText.length} chars ...]`);
}
console.log(`=== FIN RESPUESTA CRUDA ===\n`);

// Parsear.
const parsed = parseScoringResponse(rawText);
if (!parsed.ok) {
  console.error(`[probe] parser FALLÓ: ${parsed.error}`);
  console.error(`[probe] preview: ${parsed.preview}`);
  process.exit(4);
}
console.log(`[probe] parser OK: ${parsed.scored.length} leads puntuados`);

// Sanity de correspondencia id
const inputIds = new Set(leads.map((l) => l.id));
const outputIds = new Set(parsed.scored.map((s) => s.id));
const missing = [...inputIds].filter((id) => !outputIds.has(id));
const unexpected = [...outputIds].filter((id) => !inputIds.has(id));
console.log(
  `[probe] correspondencia: input=${inputIds.size}, output=${outputIds.size}, missing=${missing.length}, unexpected=${unexpected.length}`,
);
if (missing.length > 0) console.log(`  missing:`, missing);
if (unexpected.length > 0) console.log(`  unexpected:`, unexpected);

// ===== Salida por lead (reproduce el flujo del job: parser +
// gates mecánicos + decisión needs_review) =====
console.log(`\n===== POR LEAD (score post-gates, mismo cálculo que job) =====`);
const leadById = new Map(leads.map((l) => [l.id, l]));
for (const scored of parsed.scored) {
  const lead = leadById.get(scored.id);
  if (!lead) continue;
  const gate = applyScoreMechanicalGates(
    scored,
    { title: lead.title ?? null },
    {
      secondaryMaxScore: activeIcp.scoringCriteria?.secondaryMaxScore ?? 100,
      primaryDeciders: activeIcp.scoringCriteria?.primaryDeciders ?? [],
      secondaryDeciders: activeIcp.scoringCriteria?.secondaryDeciders ?? [],
    },
  );
  const needsReview =
    gate.gated.length > 0 || gate.score < NOVA_SCORE_THRESHOLD_REVIEW;
  const reviewReasons =
    gate.needs_review_reasons.length > 0
      ? gate.needs_review_reasons.join(",")
      : needsReview
        ? `low_score:${gate.score}`
        : "-";
  console.log(
    `\n--- ${lead.company ?? "?"} (title: ${lead.title ?? "?"}) ---`,
  );
  console.log(`  sector: ${lead.sector ?? "(null)"}`);
  console.log(
    `  score raw: ${scored.score} · score final: ${gate.score}${gate.gated.length ? ` · gates: ${gate.gated.join(",")}` : ""}`,
  );
  console.log(
    `  sub_scores: sector=${scored.sub_scores.sector_fit} · seniority=${scored.sub_scores.seniority_fit} · brand=${scored.sub_scores.brand_signal} · budget=${scored.sub_scores.budget_signal}`,
  );
  console.log(`  fields_used: ${scored.reasoning_fields_used?.join(", ") ?? "(missing)"}`);
  console.log(`  needs_review: ${needsReview} · reasons: ${reviewReasons}`);
  console.log(`  reasoning: ${scored.reasoning}`);
}
