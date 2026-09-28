// OUTPILOT v2 · scripts / repersonalize.mjs
//
// Re-ejecuta Lex sobre campaign_leads cuya personalización actual es
// insatisfactoria. Dos criterios de "insatisfactoria":
//   - personalization.personalization === "generic" (Haiku no pudo
//     personalizar, o el guard T024 rechazó el opener por contenido).
//   - personalization.reason_if_generic empieza por
//     "opener_rejected_by_guard" (guard determinista, regla 12).
//
// El script NO llama a Haiku directamente — resetea el
// campaign_leads.personalization a NULL para que el próximo click de
// "Personalizar" (o el próximo trigger de lex/personalize.requested)
// las procese como pendientes. Coste = 0 aquí; el coste del re-lex
// llega cuando Pere dispare el job después.
//
// Alternativa (--fire): además del reset, envía el evento Inngest
// lex/personalize.requested para que Lex las procese inmediatamente.
// Requiere INNGEST_EVENT_KEY.
//
// Usage:
//   # DRY-RUN (default): lista y coste estimado.
//   node --env-file-if-exists=.env.local scripts/repersonalize.mjs <campaign_id> --only-flagged
//
//   # EXECUTE: resetea personalization a NULL en los flagged.
//   EXECUTE=1 node --env-file-if-exists=.env.local scripts/repersonalize.mjs <campaign_id> --only-flagged
//
//   # EXECUTE + FIRE: además del reset, dispara Inngest.
//   EXECUTE=1 FIRE=1 node --env-file-if-exists=.env.local scripts/repersonalize.mjs <campaign_id> --only-flagged
//
// Coste estimado: haiku 4.5 ≈ $0.001 por lead re-personalizado
// (input prompt ~2500 tokens + output ~150 tokens).

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
    console.error(`[repersonalize] falta env var ${name}`);
    process.exit(1);
  }
  return v;
}

const campaignId = process.argv[2];
if (!campaignId || !/^[0-9a-f-]{36}$/i.test(campaignId)) {
  console.error(
    "[repersonalize] usage: node scripts/repersonalize.mjs <campaign_uuid> --only-flagged",
  );
  process.exit(1);
}
const onlyFlagged = process.argv.includes("--only-flagged");
if (!onlyFlagged) {
  console.error("[repersonalize] hoy solo se soporta --only-flagged");
  process.exit(1);
}
const execute = process.env.EXECUTE === "1";
const fire = process.env.FIRE === "1";

const supaUrl = requireEnv("NEXT_PUBLIC_SUPABASE_URL");
const supaKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
const supabase = createClient(supaUrl, supaKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

console.log(`[repersonalize] campaign_id: ${campaignId}`);
console.log(`[repersonalize] mode: ${execute ? "EXECUTE" : "DRY-RUN"}${fire ? " + FIRE" : ""}`);

// 1. Cargar campaign_leads activos con su personalization.
//    NO cargamos email ni nombre — el listado NUNCA imprime PII.
//    company_display viene preferiblemente del personalization
//    (más fresco); si no, del custom_fields del lead. Fallback: "?".
const { data: cls, error } = await supabase
  .from("campaign_leads")
  .select(
    "id, lead_id, personalization, lead:leads!inner(company, custom_fields)",
  )
  .eq("campaign_id", campaignId)
  .is("removed_at", null);
if (error) throw new Error(`select failed: ${error.message}`);

console.log(`[repersonalize] campaign_leads activos: ${cls?.length ?? 0}`);

// ============================================================
// DUPLICADO INLINE de:
//   src/lib/lex/response.ts:guardOpenerContent
//   src/lib/lex/repersonalize-criteria.ts:classifyForRepersonalize
//   src/lib/lex/repersonalize-criteria.ts:isFlaggedForRepersonalize
//
// Motivación: script Node .mjs ejecutado con `node --env-file-if-exists`,
// sin tsx — no puede importar TS. Los tests unitarios de la versión
// TS son la fuente de verdad. Si cambia el guard o los criterios,
// sincronizar aquí a mano.
// ============================================================

const FORBIDDEN_PATTERN =
  /[?¿]|\b(web|visibilidad|imagino|requiere|debe ser|debe de ser)\b|\bme (preguntaba|pregunto|gustar[íi]a|interesa)\b/i;
const OPENER_GUARD_MIN_LENGTH = 60;

function guardOpenerContent(opener) {
  const raw = (opener ?? "").trim();
  if (!FORBIDDEN_PATTERN.test(raw)) {
    return { rejected: false, opener: raw, trimmed: false };
  }
  const firstBreak = raw.search(/[.;]/);
  const candidate = firstBreak >= 0 ? raw.slice(0, firstBreak + 1).trim() : raw;
  if (candidate.length < OPENER_GUARD_MIN_LENGTH) {
    return {
      rejected: true,
      reason: `opener_rejected_by_guard:too_short_after_trim(${candidate.length})`,
    };
  }
  if (FORBIDDEN_PATTERN.test(candidate)) {
    return {
      rejected: true,
      reason: "opener_rejected_by_guard:forbidden_pattern_persists",
    };
  }
  return {
    rejected: false,
    opener: candidate,
    trimmed: candidate.length < raw.length,
  };
}

function classifyForRepersonalize(p) {
  if (p === null || typeof p !== "object") {
    return { kind: "unpersonalized", reason: "no_personalization_yet" };
  }
  const status = p.personalization;
  if (status === "generic") {
    const reason = typeof p.reason_if_generic === "string" ? p.reason_if_generic : "";
    if (reason.startsWith("opener_rejected_by_guard")) {
      return { kind: "opener_rejected_by_guard", reason };
    }
    return { kind: "generic", reason: reason || "no_reason_recorded" };
  }
  if (status === "personalized") {
    const opener = typeof p.opener === "string" ? p.opener : "";
    if (opener.trim().length === 0) {
      return {
        kind: "opener_would_be_recut",
        reason: "personalized_empty_opener",
      };
    }
    const guard = guardOpenerContent(opener);
    if (guard.rejected) {
      return { kind: "opener_would_be_recut", reason: guard.reason };
    }
    if (guard.trimmed) {
      return { kind: "opener_would_be_recut", reason: "would_trim_second_clause" };
    }
    return { kind: "personalized_ok", reason: "opener_passes_guard" };
  }
  return { kind: "unpersonalized", reason: "unknown_status" };
}
const FLAGGED_KINDS = new Set([
  "generic",
  "opener_rejected_by_guard",
  "opener_would_be_recut",
]);

// ============================================================

function pickCompanyDisplay(cl) {
  // Preferir el company_display del personalization (más fresco:
  // lo puso Lex con la capitalización que devolvió Vibe/website).
  // Si no, custom_fields.company_display. Fallback: "?".
  const fromPers = cl.personalization?.company_display;
  if (typeof fromPers === "string" && fromPers.trim() !== "") return fromPers;
  const fromCustom = cl.lead?.custom_fields?.company_display;
  if (typeof fromCustom === "string" && fromCustom.trim() !== "") return fromCustom;
  const fromLead = cl.lead?.company;
  if (typeof fromLead === "string" && fromLead.trim() !== "") return fromLead;
  return "?";
}

// 2. Clasificar + filtrar los flagged (re-evaluando el guard sobre
//    el opener guardado, no confiando en un flag histórico).
const flagged = [];
const buckets = {
  personalized_ok: 0,
  unpersonalized: 0,
  generic: 0,
  opener_rejected_by_guard: 0,
  opener_would_be_recut: 0,
};
for (const cl of cls ?? []) {
  const c = classifyForRepersonalize(cl.personalization ?? null);
  buckets[c.kind] = (buckets[c.kind] ?? 0) + 1;
  if (FLAGGED_KINDS.has(c.kind)) {
    flagged.push({
      id: cl.id,
      company_display: pickCompanyDisplay(cl),
      kind: c.kind,
      reason: c.reason,
    });
  }
}

console.log(`\n[repersonalize] desglose:`);
console.log(`  personalized OK (no se toca):                      ${buckets.personalized_ok}`);
console.log(`  sin personalizar (personalization=null):           ${buckets.unpersonalized}`);
console.log(`  generic (Haiku no pudo):                           ${buckets.generic}`);
console.log(`  opener_rejected_by_guard (histórico):              ${buckets.opener_rejected_by_guard}`);
console.log(`  opener_would_be_recut (guard nuevo sobre existente): ${buckets.opener_would_be_recut}`);
console.log(`  total a repersonalizar:                            ${flagged.length}`);

if (flagged.length === 0) {
  console.log(`\n[repersonalize] nada que hacer.`);
  process.exit(0);
}

// 3. Preview SIN PII. Solo company_display + motivo truncado.
console.log(`\n[repersonalize] flagged (hasta 20, sin PII):`);
for (const f of flagged.slice(0, 20)) {
  console.log(`  ${f.company_display} · [${f.kind}] ${f.reason.slice(0, 80)}`);
}

// 4. Coste estimado
const costPerLead = 0.001; // Haiku 4.5 ≈ 2500 tokens in ($0.0025) + 150 out ($0.00075)
const estimatedCost = flagged.length * costPerLead;
console.log(
  `\n[repersonalize] coste estimado del re-lex: ~$${estimatedCost.toFixed(3)} (${flagged.length} × ~$${costPerLead})`,
);

if (!execute) {
  console.log(`\n[repersonalize] DRY-RUN — sin escribir. Ejecuta con EXECUTE=1.`);
  process.exit(0);
}

// 5. Reset personalization → NULL para que el próximo trigger de
// Lex los procese como pendientes.
const ids = flagged.map((f) => f.id);
const { error: upErr, count } = await supabase
  .from("campaign_leads")
  .update({ personalization: null }, { count: "exact" })
  .in("id", ids);
if (upErr) throw new Error(`update failed: ${upErr.message}`);
console.log(`\n[repersonalize] reset a personalization=NULL: ${count} filas.`);

if (fire) {
  const inngestKey = process.env.INNGEST_EVENT_KEY;
  if (!inngestKey) {
    console.error(
      `[repersonalize] FIRE=1 pero INNGEST_EVENT_KEY no está seteada. Los leads quedan como pendientes; dispara el job manualmente desde /campaigns.`,
    );
    process.exit(2);
  }
  const requestedBy = "scripts/repersonalize.mjs";
  const r = await fetch(`https://inn.gs/e/${inngestKey}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "lex/personalize.requested",
      data: {
        tenantId: null, // el job resuelve del campaignId
        campaignId,
        requestedBy,
      },
    }),
  });
  if (!r.ok) {
    console.error(`[repersonalize] Inngest event failed: ${r.status} ${await r.text()}`);
    process.exit(3);
  }
  console.log(`[repersonalize] Inngest event disparado.`);
} else {
  console.log(
    `\n[repersonalize] listos como pendientes. Dispara "Personalizar" desde /campaigns para que Lex los procese.`,
  );
}
