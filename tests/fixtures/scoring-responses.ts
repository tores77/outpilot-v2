// Golden Claude responses used by the parser + state-machine tests.
// Numbers here mirror the second (post-fix) real batch: Ana 69 stays
// NUEVO, Jose 78 promotes to EN_RADAR, Epsilon 28 -> needs_review.

export const RAW_JSON_ARRAY = `[
  {
    "id": "fixture-jose",
    "score": 78,
    "sub_scores": {
      "sector_fit": 90,
      "seniority_fit": 90,
      "brand_signal": 85,
      "budget_signal": 70
    },
    "reasoning": "Campos usados: company, title, sector, website, linkedin_url. Señal verificable CRÍTICA: dominio propio + linkedin_url. Sector marketing services + Partner/CMO."
  },
  {
    "id": "fixture-ana",
    "score": 69,
    "sub_scores": {
      "sector_fit": 85,
      "seniority_fit": 95,
      "brand_signal": 40,
      "budget_signal": 40
    },
    "reasoning": "Campos usados: title, sector, country, city. Prometedor por cargo+sector pero sin señales verificables de empresa real; el gate anti-fabricación impide superar 69."
  },
  {
    "id": "fixture-epsilon",
    "score": 28,
    "sub_scores": {
      "sector_fit": 40,
      "seniority_fit": 0,
      "brand_signal": 20,
      "budget_signal": 25
    },
    "reasoning": "Datos insuficientes: falta first_name, last_name, title. Sector 'Legal' sugiere despacho pero sin decisor identificable."
  }
]`;

export const FENCED_JSON = `\`\`\`json
${RAW_JSON_ARRAY}
\`\`\``;

export const NOISY_JSON = `Here is the analysis:\n\n${RAW_JSON_ARRAY}\n\nEnd of response.`;

// Regresión real del 2026-09-25 en producción: Haiku envolvió la
// respuesta en un fence "```" con "json" en línea propia (no como
// language marker inline). El parser original capturaba "json\n[...]"
// como interior del fence y JSON.parse fallaba con
// `Unexpected token '', "js..."` (el "js" era el prefijo "json\n"
// sin eliminar). Fixture anonimizado a partir del run real.
export const FENCED_JSON_LANG_ON_OWN_LINE = `\`\`\`
json
${RAW_JSON_ARRAY}
\`\`\``;

// Malformed puro: Haiku no devuelve JSON. Parser debe devolver
// { ok: false } sin lanzar, para que el caller pueda liberar los
// claims del lote sin tumbar el resto del run.
export const NOT_JSON_AT_ALL =
  "No he podido puntuar este lote por falta de datos coherentes.";

// Regresión real del 2026-09-25 tarde: bucle infinito nova-score
// (run 01M3CJ4MBAY12EJQ1B2TH4KHKW). Haiku alcanzó max_tokens=3000
// con un batch de 20 leads y devolvió el JSON TRUNCADO — array sin
// cerrar, última string sin cerrar. El parser fallaba con
// "Unterminated string in JSON at position X" y el harness liberaba
// los mismos leads → mismo prompt → mismo fallo → ~15 llamadas a
// Haiku desperdiciadas hasta cancelar a mano.
//
// Este fixture es una versión ANONIMIZADA (uuids, nombres y
// company_name inventados) pero fiel al patrón real: 2 entradas OK +
// 3ª truncada mid-reasoning. El fix (parser + guard) NO recupera el
// JSON, pero devuelve { ok: false, error: "not_valid_json: ..." } sin
// lanzar, y el harness marca scoring_error para no re-reclamar.
//
// Cura de raíz (paralela): NOVA_SCORE_MAX_TOKENS = 16000 evita que
// Haiku alcance el tope con batches de 20 (probe midió output real
// ~15 000 tokens con este prompt).
export const TRUNCATED_BY_MAX_TOKENS = `[
  {
    "id": "fixture-a",
    "score": 45,
    "sub_scores": {
      "sector_fit": 25,
      "seniority_fit": 95,
      "brand_signal": 60,
      "budget_signal": 40
    },
    "reasoning": "Founder en Company A. Seniority perfecta, dominio propio verificado, sector industrial commoditizado. Sector_fit bajo por modelo B2B tradicional."
  },
  {
    "id": "fixture-b",
    "score": 35,
    "sub_scores": {
      "sector_fit": 30,
      "seniority_fit": 65,
      "brand_signal": 40,
      "budget_signal": 35
    },
    "reasoning": "CFO en Company B. Seniority neutral-bajo (no es CEO/Founder). Sector agroindustrial no premium-web."
  },
  {
    "id": "fixture-c",
    "score": 42,
    "sub_scores": {
      "sector_fit": 35,
      "seniority_fit": 80,
      "brand_signal": 50,
      "budget_signal": 45
    },
    "reasoning": "Director General en Company C. Sector HVAC — neutral-bajo. Dominio propio pero web no es factor competitivo en B2B commodity. Budget_signal`;

export const MALFORMED_ENTRY = `[
  { "id": "fixture-good", "score": 55, "sub_scores": {"sector_fit": 50, "seniority_fit": 60, "brand_signal": 50, "budget_signal": 60}, "reasoning": "ok" },
  { "score": 90, "reasoning": "missing id — should be skipped" },
  "not an object either",
  { "id": "fixture-clamp-high", "score": 250, "sub_scores": {"sector_fit": 999, "seniority_fit": 60, "brand_signal": 50, "budget_signal": 60}, "reasoning": "over range" },
  { "id": "fixture-clamp-low", "score": -10, "sub_scores": {"sector_fit": -50, "seniority_fit": 60, "brand_signal": 50, "budget_signal": 60}, "reasoning": "under range" }
]`;
