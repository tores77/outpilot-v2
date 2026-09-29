// OUTPILOT v2 · scripts / patch-opener.mjs
//
// Parche manual del OPENER de un campaign_lead ya personalizado.
// Solo toca el campo `opener` dentro de personalization; preserva
// fields_used, company_display, reason_if_generic, lex_attempts, y
// cualquier otra key.
//
// Casos de uso (T024 eval smoke 2026-09-29):
//   - Corregir un error tipográfico ("dominéis" → "domináis")
//   - Reescribir un opener completo cuando Lex no dio en el clavo
//   - Ajustar mayúsculas en siglas ("cnc" → "CNC")
//
// Marca patched_by_human: true + patched_at: <iso> en el
// personalization para que el histórico deje claro que la fila
// no viene 100% del modelo.
//
// Pasa el texto nuevo por sanitizeOpenerStyle + guardOpenerContent
// (mismos que Lex) antes de guardar. Si el guard rechaza → error,
// no se escribe.
//
// Modos:
//   --replace <before> --with <after>   sustitución textual global
//   --file <path>                       reemplaza opener por el
//                                       contenido del file (trim)
//
// Dry-run por defecto (muestra diff + resultado del guard).
// EXECUTE=1 escribe.
//
// Usage:
//   # Sustitución simple
//   node --env-file-if-exists=.env.local scripts/patch-opener.mjs \
//     8ec1cd98-2da6-4b09-8f3b-b7a179435f81 \
//     --replace dominéis --with domináis
//
//   # Reemplazo total
//   node --env-file-if-exists=.env.local scripts/patch-opener.mjs \
//     904e2a34-82fc-4983-afe8-d2016917025e \
//     --file tmp/opener-fluytec.txt
//
//   # Escritura
//   EXECUTE=1 node --env-file-if-exists=.env.local scripts/patch-opener.mjs ...

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
    console.error(`[patch-opener] falta env var ${name}`);
    process.exit(1);
  }
  return v;
}

function usage() {
  console.error(
    "usage:\n" +
      "  node scripts/patch-opener.mjs <uuid> --replace <before> --with <after>\n" +
      "  node scripts/patch-opener.mjs <uuid> --file <path>",
  );
  process.exit(1);
}

const args = process.argv.slice(2);
const uuid = args[0];
if (!uuid || !/^[0-9a-f-]{36}$/i.test(uuid)) usage();

let mode = null; // "file" | "replace"
let filePath = null;
let replaceBefore = null;
let replaceAfter = null;
for (let i = 1; i < args.length; i++) {
  const a = args[i];
  if (a === "--file") {
    mode = "file";
    filePath = args[++i];
  } else if (a === "--replace") {
    mode = mode ?? "replace";
    replaceBefore = args[++i];
  } else if (a === "--with") {
    replaceAfter = args[++i];
  } else {
    console.error(`[patch-opener] arg desconocido: ${a}`);
    usage();
  }
}
if (!mode) usage();
if (mode === "file" && !filePath) usage();
if (mode === "replace" && (replaceBefore == null || replaceAfter == null)) {
  console.error("[patch-opener] --replace requiere también --with");
  usage();
}

const execute = process.env.EXECUTE === "1";

// ============================================================
// DUPLICADO INLINE de src/lib/lex/response.ts:
//   sanitizeOpenerStyle + guardOpenerContent + FORBIDDEN_PATTERN.
// Los tests unitarios de la versión TS son la fuente de verdad.
// Si el guard cambia allí, sincronizar aquí a mano.
// ============================================================
function sanitizeOpenerStyle(opener) {
  return opener
    .replace(/\s*[—–]\s*(?=[A-ZÁÉÍÓÚÑ¿¡])/g, ". ")
    .replace(/\s*[—–]\s*/g, ", ")
    .replace(/[“”„‟]/g, '"')
    .replace(/[‘’‚‛]/g, "'")
    .replace(/…/g, "...")
    .replace(/ {2,}/g, " ")
    .trim();
}
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
// ============================================================

const supaUrl = requireEnv("NEXT_PUBLIC_SUPABASE_URL");
const supaKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
const supabase = createClient(supaUrl, supaKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

console.log(`[patch-opener] campaign_lead: ${uuid}`);
console.log(`[patch-opener] mode: ${mode} · ${execute ? "EXECUTE" : "DRY-RUN"}`);

// 1. Cargar campaign_lead + personalization. Sin PII (no email/nombre).
const { data: cl, error } = await supabase
  .from("campaign_leads")
  .select("id, personalization, lead:leads!inner(company, custom_fields)")
  .eq("id", uuid)
  .maybeSingle();
if (error) throw new Error(`select failed: ${error.message}`);
if (!cl) {
  console.error(`[patch-opener] campaign_lead ${uuid} no existe`);
  process.exit(2);
}

const currentPers =
  cl.personalization && typeof cl.personalization === "object"
    ? cl.personalization
    : null;
if (!currentPers) {
  console.error(
    `[patch-opener] campaign_lead ${uuid} sin personalization. Ejecuta "Personalizar" antes.`,
  );
  process.exit(3);
}
const currentOpener =
  typeof currentPers.opener === "string" ? currentPers.opener : "";

// company_display para el log (sin PII).
const companyDisplay =
  (typeof currentPers.company_display === "string" && currentPers.company_display) ||
  (typeof cl.lead?.custom_fields?.company_display === "string" &&
    cl.lead.custom_fields.company_display) ||
  cl.lead?.company ||
  "?";
console.log(`[patch-opener] company_display: ${companyDisplay}`);

// 2. Componer opener nuevo según el modo.
let newOpener;
if (mode === "file") {
  if (!existsSync(filePath)) {
    console.error(`[patch-opener] file no existe: ${filePath}`);
    process.exit(4);
  }
  newOpener = readFileSync(filePath, "utf8").trim();
  if (newOpener.length === 0) {
    console.error(`[patch-opener] file vacío: ${filePath}`);
    process.exit(4);
  }
} else {
  // replace: substitución global (todas las apariciones)
  newOpener = currentOpener.split(replaceBefore).join(replaceAfter);
  if (newOpener === currentOpener) {
    console.error(
      `[patch-opener] --replace '${replaceBefore}' no aparece en el opener actual. Sin cambios.`,
    );
    process.exit(5);
  }
}

// 3. Sanitize + guard.
const sanitized = sanitizeOpenerStyle(newOpener);
const guarded = guardOpenerContent(sanitized);

console.log(`\n--- ANTES (${currentOpener.length} chars) ---`);
console.log(currentOpener);
console.log(`\n--- DESPUÉS (${sanitized.length} chars, pre-guard) ---`);
console.log(sanitized);

if (guarded.rejected) {
  console.error(`\n[patch-opener] GUARD RECHAZA el opener nuevo: ${guarded.reason}`);
  console.error(`[patch-opener] no se escribe. Corrige el texto y reintenta.`);
  process.exit(6);
}
if (guarded.trimmed) {
  console.log(`\n[patch-opener] AVISO: el guard recortó la segunda cláusula.`);
  console.log(`--- RESULTADO POST-GUARD (${guarded.opener.length} chars) ---`);
  console.log(guarded.opener);
}

const finalOpener = guarded.opener;

if (!execute) {
  console.log(`\n[patch-opener] DRY-RUN — sin escribir. Ejecuta con EXECUTE=1.`);
  process.exit(0);
}

// 4. Guardar: preservar TODO el resto de personalization; solo tocar
//    opener + patched_by_human + patched_at.
const newPers = {
  ...currentPers,
  opener: finalOpener,
  patched_by_human: true,
  patched_at: new Date().toISOString(),
};
const { error: upErr } = await supabase
  .from("campaign_leads")
  .update({ personalization: newPers })
  .eq("id", uuid);
if (upErr) throw new Error(`update failed: ${upErr.message}`);
console.log(`\n[patch-opener] escrito. patched_at=${newPers.patched_at}`);
