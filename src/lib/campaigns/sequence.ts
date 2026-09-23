// OUTPILOT v2 — Campaign sequence schema + helpers
// Fase 2 · T021
//
// Zod schema para el jsonb `campaigns.sequence`. Es la fuente unica
// del shape: la BD lo guarda sin validar, y este schema lo verifica
// tanto al escribir (server action de /campaigns/new) como al leer
// (T023 cuando Volt orqueste).

import { z } from "zod";
import {
  ALLOWED_VARIABLES,
  getIcpBySlug,
  validateVariables,
  type IcpTemplate,
} from "@/config/icps";

const variableCheck = (fieldName: string) => (value: string) => {
  const check = validateVariables(value);
  return check.ok
    ? true
    : {
        message: `${fieldName} contiene variables no permitidas: ${check.unknownVariables
          .map((v) => `{{${v}}}`)
          .join(", ")}. Permitidas: ${ALLOWED_VARIABLES.map((v) => `{{${v}}}`).join(", ")}`,
      };
};

export const sequenceStepSchema = z.object({
  index: z.number().int().positive(),
  delayDays: z.number().int().min(0),
  subject: z
    .string()
    .min(1, "subject requerido")
    .superRefine((value, ctx) => {
      const result = variableCheck("subject")(value);
      if (result !== true) ctx.addIssue({ code: "custom", message: result.message });
    }),
  bodyHtml: z
    .string()
    .min(1, "bodyHtml requerido")
    .superRefine((value, ctx) => {
      const result = variableCheck("bodyHtml")(value);
      if (result !== true) ctx.addIssue({ code: "custom", message: result.message });
    }),
});

export const sequenceSchema = z.object({
  version: z.literal(1),
  templateSlug: z.string().min(1),
  // Texto plano (sin HTML) que Volt sustituye por {{opener}} cuando
  // Lex devuelve personalization: "generic". Regla T022: NUNCA se
  // sustituye por string vacío — el email debe leerse completo.
  openerFallback: z
    .string()
    .min(1, "openerFallback requerido")
    .superRefine((value, ctx) => {
      const result = variableCheck("openerFallback")(value);
      if (result !== true) ctx.addIssue({ code: "custom", message: result.message });
    }),
  steps: z.array(sequenceStepSchema).min(1),
});

export type SequenceStep = z.infer<typeof sequenceStepSchema>;
export type Sequence = z.infer<typeof sequenceSchema>;

/**
 * Copia un template a un sequence listo para persistir. No muta el
 * template (readonly), devuelve un objeto plano indexable por Zod.
 */
export function sequenceFromTemplate(template: IcpTemplate): Sequence {
  return {
    version: 1,
    templateSlug: template.slug,
    openerFallback: template.openerFallback,
    steps: template.steps.map((s) => ({
      index: s.index,
      delayDays: s.delayDays,
      subject: s.subject,
      bodyHtml: s.bodyHtml,
    })),
  };
}

/**
 * Atajo para construir un sequence desde un slug conocido. Devuelve
 * null si el slug no matchea ningun template.
 */
export function sequenceFromSlug(slug: string): Sequence | null {
  const template = getIcpBySlug(slug);
  return template ? sequenceFromTemplate(template) : null;
}
