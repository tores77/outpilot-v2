// OUTPILOT v2 — Lex response parser (T022 · +T024 company_display)
// -----------------------------------------------------------------------------
// Parseo tolerante del JSON de vuelta de Haiku + gate mecánico
// anti-fabricación sobre `fields_used`.
//
// Contrato con el modelo (ver prompt.ts):
//   {
//     "opener": string,
//     "personalization": "personalized" | "generic",
//     "fields_used": string[],
//     "company_display": string | null,   // T024
//     "reason_if_generic": string | null
//   }
//
// Gate mecánico: cada campo en `fields_used` DEBE existir con valor
// no vacío en el mapa del lead (buildLeadFieldMap). Si el modelo cita
// un campo vacío o inventado, degradamos a "generic" con reason
// "cited_empty_field: <field>" — regla anti-fabricación NO solo por
// prompt.
//
// company_display es independiente del gate: representa la
// capitalización correcta que Lex leyó del website (título, H1) o
// copió literal del campo `company`. Se preserva incluso en degrade
// a generic, porque el consumidor (Volt) lo usa para el {{companyName}}
// enviado a Lemlist y no depende del opener.

import { z } from "zod";

export const lexResponseSchema = z.object({
  opener: z.string(),
  personalization: z.enum(["personalized", "generic"]),
  fields_used: z.array(z.string()),
  // Tolerante a respuestas legacy o modelos que omiten el campo.
  // Nullish (null | undefined | string) + transform a `string | null`
  // para simplificar los consumidores. El caller (Volt) trata null
  // como fallback a lead.company.
  company_display: z
    .string()
    .nullish()
    .transform((v) => v ?? null),
  reason_if_generic: z.string().nullable(),
});

export type LexResponse = z.infer<typeof lexResponseSchema>;

/**
 * Sanitizador determinista de estilo. Se aplica al opener ANTES del
 * gate mecánico porque las reglas de estilo del prompt (regla 8) NO
 * son de fiar: en el smoke real de T022 Haiku metió un guion largo
 * pese a la prohibición explícita. El sanitizador NO decide semántica
 * (no toca palabras, no cambia registro), solo forma tipográfica:
 *
 *   — / –      →  ". " si le sigue mayúscula, ", " en otro caso
 *   " " " "    →  " (comilla recta doble)
 *   ' ' ' '    →  ' (comilla recta simple)
 *   …          →  ...
 *   dobles+ espacios → un espacio
 *
 * Idempotente: aplicar N veces produce el mismo resultado.
 */
export function sanitizeOpenerStyle(opener: string): string {
  return opener
    // Em-dash / en-dash con posibles espacios alrededor: si le sigue
    // mayúscula → punto + espacio; en otro caso → coma + espacio.
    .replace(/\s*[—–]\s*(?=[A-ZÁÉÍÓÚÑ¿¡])/g, ". ")
    .replace(/\s*[—–]\s*/g, ", ")
    // Comillas tipográficas dobles y simples → rectas.
    .replace(/[“”„‟]/g, '"')
    .replace(/[‘’‚‛]/g, "'")
    // Ellipsis Unicode → tres puntos ASCII.
    .replace(/…/g, "...")
    // Colapsar 2+ espacios a uno.
    .replace(/ {2,}/g, " ")
    .trim();
}

/**
 * Intenta parsear el JSON crudo devuelto por Haiku. Tolera fences
 * markdown (```json ... ```), texto antes/después y variantes de
 * espacios. Si nada encaja, devuelve un LexResponse "generic" con
 * reason "parse_failed" para que un lead roto no tumbe el batch.
 */
export function parseLexResponse(raw: string): LexResponse {
  const stripped = stripMarkdownFences(raw);
  const candidate = extractJsonObject(stripped) ?? extractJsonObject(raw);
  if (!candidate) return failGeneric("parse_failed_no_json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return failGeneric("parse_failed_invalid_json");
  }
  const check = lexResponseSchema.safeParse(parsed);
  if (!check.success) {
    return failGeneric(
      `parse_failed_schema: ${check.error.issues[0]?.message ?? "unknown"}`,
    );
  }
  // Sanitiza el opener antes de devolver: cualquier caller (incluido
  // applyFieldGate) opera sobre la versión canónica sin tics.
  return { ...check.data, opener: sanitizeOpenerStyle(check.data.opener) };
}

function stripMarkdownFences(text: string): string {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return fence ? fence[1].trim() : text.trim();
}

function extractJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  return text.slice(start, end + 1);
}

function failGeneric(reason: string): LexResponse {
  return {
    opener: "",
    personalization: "generic",
    fields_used: [],
    company_display: null,
    reason_if_generic: reason,
  };
}

/**
 * Gate mecánico: valida que todos los campos en `fields_used` existían
 * con valor no vacío en el input (el mapa que le pasamos al prompt).
 * Si el modelo cita algo vacío/inventado, degrada a "generic".
 *
 * También degrada si personalization === "personalized" pero:
 *   - opener está vacío o trim === ""
 *   - opener supera 400 caracteres
 *   - fields_used está vacío (imposible haber personalizado sin campos)
 */
export function applyFieldGate(
  response: LexResponse,
  leadFieldMap: Record<string, string>,
): LexResponse {
  if (response.personalization === "generic") {
    // Nada que verificar: ya es fallback.
    return response;
  }

  // Longitud del opener.
  const openerTrimmed = response.opener.trim();
  if (openerTrimmed.length === 0) {
    return degrade(response, "personalized_but_empty_opener");
  }
  if (openerTrimmed.length > 400) {
    return degrade(response, "opener_too_long");
  }

  // fields_used no vacío.
  if (response.fields_used.length === 0) {
    return degrade(response, "personalized_without_fields_used");
  }

  // Cada field citado debe existir con valor no vacío.
  for (const field of response.fields_used) {
    const value = leadFieldMap[field];
    if (typeof value !== "string" || value.length === 0) {
      return degrade(response, `cited_empty_field: ${field}`);
    }
  }

  return response;
}

function degrade(response: LexResponse, reason: string): LexResponse {
  return {
    opener: "",
    personalization: "generic",
    fields_used: response.fields_used,
    // Preservamos company_display: es info independiente del opener
    // (capitalización de la empresa) y Volt la sigue usando para
    // {{companyName}} incluso cuando degradamos a generic.
    company_display: response.company_display,
    reason_if_generic: reason,
  };
}
