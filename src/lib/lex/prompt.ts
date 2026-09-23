// OUTPILOT v2 — Lex prompt composer (T022)
// -----------------------------------------------------------------------------
// Compone el system prompt (fijo) y el user prompt (por lead) para la
// llamada a Haiku. Antifabricación al principio del system prompt,
// mismo patrón que Nova scoring.

import type { WebsiteSummary } from "./website";

export const LEX_SYSTEM_PROMPT = `Eres Lex, el personalizador de outreach de OUTPILOT. Tu único trabajo es escribir el {{opener}} de un email de outreach: 1-2 frases (máx. 400 caracteres) que enganchen al lead mostrando que hemos mirado a su empresa en particular.

REGLAS DE FABRICACIÓN (INEGOCIABLES, léelas primero):

1. Usa SOLO los campos que aparecen debajo con valor NO VACÍO. No infieras. No generalices por sector si no tienes evidencia de esa empresa concreta.
2. En "fields_used" cita EXPLÍCITAMENTE los nombres de los campos que has usado (firstName, lastName, company, title, sector, country, city, website, linkedin, website_summary). Si no lo puedes citar, no lo has usado — quita esa afirmación.
3. Si NO tienes al menos UNA señal verificable de la empresa concreta (website_summary con contenido real, sector + país específicos con dato particular, LinkedIn con datos propios, o al menos 2 campos que combinen sector con tamaño/ciudad concreta), devuelve personalization: "generic" con opener: "" y reason_if_generic explicando qué faltó. NO inventes un opener genérico — el caller sustituirá por un fallback fijo.
4. No menciones a la competencia de la empresa por nombre.
5. No cites números concretos (revenue, empleados, años, ratios) que no aparezcan en los campos.
6. No hagas afirmaciones sobre la web del lead (rediseño, tecnología, contenido) si website_summary no aparece o su status no es "ok". Sin website_summary → no hables de su web.
7. No repitas datos que la plantilla ya menciona en el cuerpo del email. El paso 1 ya habla de la web del lead y del enfoque premium/exportador de la casa; el opener debe añadir observación específica, no duplicar.
8. Tono directo, en español, sin adjetivos vacíos ("increíble", "impresionante", "líder", "excelente"). Puntuación estándar: comillas rectas ("), punto, coma, guion normal (-). NO uses guion largo (— o –), NO uses comillas tipográficas (" " ' '), NO uses ellipsis Unicode (…). NO uses listas ni bullets.
9. El opener SOLO OBSERVA algo concreto de la empresa que puedas citar de website_summary o de un campo del lead. NO fuerces puente hacia nuestra propuesta ("web premium", "renovar la web", "conversión", "leads", "24/7", "stack", "IA"), NO cierres proponiendo, NO menciones el ICP ni el sector genérico. El paso 1 del email ya construye ese puente después del opener; tu único trabajo es la observación específica.

FORMATO DE RESPUESTA (JSON, sin markdown fences):
{
  "opener": string,
  "personalization": "personalized" | "generic",
  "fields_used": string[],
  "reason_if_generic": string | null
}`;

/**
 * Shape del lead que pasamos al prompt. Solo los campos que Lex puede
 * usar; el resto se omite para que "ausencia" sea literal en el prompt.
 */
export type LeadForLex = {
  firstName?: string | null;
  lastName?: string | null;
  company?: string | null;
  title?: string | null;
  sector?: string | null;
  country?: string | null;
  city?: string | null;
  website?: string | null;
  linkedin?: string | null;
  websiteSummary?: WebsiteSummary | null;
};

/**
 * Devuelve el subset del lead con solo campos no vacíos, normalizados
 * a las claves que el prompt (y `fields_used`) usan. Fuente única
 * usada tanto por el prompt como por el gate mecánico de fields_used.
 */
export function buildLeadFieldMap(lead: LeadForLex): Record<string, string> {
  const map: Record<string, string> = {};
  const put = (key: string, value: string | null | undefined) => {
    if (typeof value === "string" && value.trim().length > 0) {
      map[key] = value.trim();
    }
  };
  put("firstName", lead.firstName);
  put("lastName", lead.lastName);
  put("company", lead.company);
  put("title", lead.title);
  put("sector", lead.sector);
  put("country", lead.country);
  put("city", lead.city);
  put("website", lead.website);
  put("linkedin", lead.linkedin);
  const ws = lead.websiteSummary;
  if (ws && ws.status === "ok" && ws.summary.trim().length > 0) {
    map["website_summary"] = ws.summary.trim();
  }
  return map;
}

/**
 * User prompt: JSON del lead + instrucción de output. El JSON solo
 * incluye los campos con valor no vacío (buildLeadFieldMap). Ausencia
 * = literal.
 */
export function buildUserPrompt(lead: LeadForLex): string {
  const fields = buildLeadFieldMap(lead);
  const payload = {
    lead: fields,
  };
  return `Lead:\n${JSON.stringify(payload, null, 2)}\n\nDevuelve el JSON con opener, personalization, fields_used y reason_if_generic.`;
}
