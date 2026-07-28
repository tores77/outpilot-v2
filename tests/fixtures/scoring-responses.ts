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

export const MALFORMED_ENTRY = `[
  { "id": "fixture-good", "score": 55, "sub_scores": {"sector_fit": 50, "seniority_fit": 60, "brand_signal": 50, "budget_signal": 60}, "reasoning": "ok" },
  { "score": 90, "reasoning": "missing id — should be skipped" },
  "not an object either",
  { "id": "fixture-clamp-high", "score": 250, "sub_scores": {"sector_fit": 999, "seniority_fit": 60, "brand_signal": 50, "budget_signal": 60}, "reasoning": "over range" },
  { "id": "fixture-clamp-low", "score": -10, "sub_scores": {"sector_fit": -50, "seniority_fit": 60, "brand_signal": 50, "budget_signal": 60}, "reasoning": "under range" }
]`;
