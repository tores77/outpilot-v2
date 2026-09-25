// OUTPILOT v2 — Export de openers para eval set (T024)
//
// Solo LECTURA. Vuelca a tmp/openers-<campaign_id>.csv una fila por
// campaign_lead con las columnas que Pere puntúa a mano antes de
// sincronizar a Lemlist. El fichero es el primer eval set (harness);
// tras puntuar, Pere lo promueve manualmente a docs/evals/ (baseline
// anonimizado que vive con el repo).
//
// Diseño de privacidad: la CSV NO contiene email ni nombre — el eval
// se hace sobre los TEXTOS (opener) y sobre el ATRIBUTO scrapeado
// (company_display). El campaign_lead_id es la única clave de cruce
// contra BD si Pere necesita ver el lead concreto.
//
// Columnas:
//   campaign_lead_id
//   company_display        ← T024: capitalización correcta de Lex
//   personalization        ← "personalized" | "generic"
//   opener                 ← texto que Volt enviará a Lemlist
//   fields_used            ← "field1;field2;..."
//   reason_if_generic      ← razón si degradó
//   verificable            ← 1-5, vacío hasta puntuar
//   especifico             ← 1-5
//   relevante              ← 1-5
//   no_invasivo            ← 1-5
//   nota                   ← comentario libre
//
// Usage:
//   node --env-file-if-exists=.env.local scripts/export-openers.mjs <campaign_id>
//
// Vars requeridas:
//   - NEXT_PUBLIC_SUPABASE_URL
//   - SUPABASE_SERVICE_ROLE_KEY
//
// Ejemplo:
//   node --env-file-if-exists=.env.local scripts/export-openers.mjs c1a2...

import { createClient } from "@supabase/supabase-js";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

// ==============================================================
// Args + env
// ==============================================================

const campaignId = process.argv[2];
if (!campaignId || campaignId.trim() === "") {
  console.error(
    "[export-openers] falta arg campaign_id.\n" +
      "  Usage: node --env-file-if-exists=.env.local scripts/export-openers.mjs <campaign_id>",
  );
  process.exit(1);
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v || v.trim() === "") {
    console.error(`[export-openers] falta env var ${name}`);
    process.exit(1);
  }
  return v;
}

const supaUrl = requireEnv("NEXT_PUBLIC_SUPABASE_URL");
const supaKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
const supabase = createClient(supaUrl, supaKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// ==============================================================
// Fetch
// ==============================================================

console.log(`[export-openers] campaign_id: ${campaignId}`);

const { data: rows, error } = await supabase
  .from("campaign_leads")
  .select("id, personalization, added_at")
  .eq("campaign_id", campaignId)
  .is("removed_at", null)
  .order("added_at", { ascending: true });

if (error) {
  console.error(`[export-openers] query failed: ${error.message}`);
  process.exit(2);
}
if (!rows || rows.length === 0) {
  console.error(
    `[export-openers] 0 campaign_leads activos para ${campaignId}. ` +
      "¿Ejecutaste 'Preparar smoke' primero?",
  );
  process.exit(3);
}

console.log(`[export-openers] campaign_leads activos: ${rows.length}`);

// ==============================================================
// CSV
// ==============================================================

// RFC 4180 minimal quoting: si el campo lleva comilla, coma o salto
// de línea → envolver en comillas dobles y duplicar comillas internas.
function csvCell(value) {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

const HEADERS = [
  "campaign_lead_id",
  "company_display",
  "personalization",
  "opener",
  "fields_used",
  "reason_if_generic",
  "verificable",
  "especifico",
  "relevante",
  "no_invasivo",
  "nota",
];

let personalizedCount = 0;
let genericCount = 0;
let missingCount = 0;

const lines = [HEADERS.join(",")];
for (const row of rows) {
  const p = row.personalization;
  if (!p || typeof p !== "object") {
    missingCount += 1;
    // Fila con placeholders para no perder el id del lead.
    lines.push(
      [
        csvCell(row.id),
        "", // company_display
        "sin_personalizar", // personalization
        "", // opener
        "", // fields_used
        "", // reason_if_generic
        "", "", "", "", "", // scores + nota
      ].join(","),
    );
    continue;
  }
  const personalization = p.personalization;
  if (personalization === "personalized") personalizedCount += 1;
  else if (personalization === "generic") genericCount += 1;

  const fieldsUsed = Array.isArray(p.fields_used) ? p.fields_used.join(";") : "";

  lines.push(
    [
      csvCell(row.id),
      csvCell(p.company_display ?? ""),
      csvCell(personalization ?? ""),
      csvCell(p.opener ?? ""),
      csvCell(fieldsUsed),
      csvCell(p.reason_if_generic ?? ""),
      "", "", "", "", "", // scores + nota vacíos
    ].join(","),
  );
}

// ==============================================================
// Write
// ==============================================================

const outDir = "tmp";
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, `openers-${campaignId}.csv`);
writeFileSync(outPath, lines.join("\n") + "\n", "utf8");

console.log(`\n[export-openers] resumen:`);
console.log(`  personalized:     ${personalizedCount}`);
console.log(`  generic:          ${genericCount}`);
console.log(`  sin_personalizar: ${missingCount}`);
console.log(`  total:            ${rows.length}`);
console.log(`\n[export-openers] escrito a ${outPath}`);
console.log(
  `[export-openers] cuando termines de puntuar, cópialo a docs/evals/openers-${campaignId}-baseline.csv`,
);
