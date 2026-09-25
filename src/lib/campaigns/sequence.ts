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
  // subject OPCIONAL. Los steps 2+ se envían sin subject para que
  // Lemlist los mande como respuesta en el hilo del step 1. La regla
  // "step 1 requiere subject" se enforce a nivel de sequenceSchema
  // porque necesita ver el índice.
  subject: z
    .string()
    .optional()
    .superRefine((value, ctx) => {
      if (value === undefined || value.trim() === "") return;
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

const SIGNATURE_PATTERN = /\{\{\s*signature\s*\}\}/;

export const sequenceSchema = z
  .object({
    version: z.literal(1),
    templateSlug: z.string().min(1),
    // Canal del ICP. Rige reglas legales/estilísticas (ver superRefine).
    channel: z.enum(["email_cold"]),
    // Texto plano (sin HTML) que Volt sustituye por {{opener}} cuando
    // Lex devuelve personalization: "generic". Regla T022: NUNCA se
    // sustituye por string vacío — el email debe leerse completo.
    openerFallback: z
      .string()
      .min(1, "openerFallback requerido")
      .superRefine((value, ctx) => {
        const result = variableCheck("openerFallback")(value);
        if (result !== true)
          ctx.addIssue({ code: "custom", message: result.message });
      }),
    // Pie legal (LSSI/RGPD). Obligatorio para channel "email_cold"
    // (validado en superRefine). sequenceFromTemplate ya sustituyó el
    // marcador {{legalFooter}} en cada bodyHtml antes de este parse,
    // así que aquí solo verificamos que el string se guarda con la
    // sequence para trazabilidad (auditoría legal).
    legalFooter: z.string().min(1).optional(),
    steps: z.array(sequenceStepSchema).min(1),
  })
  .superRefine((data, ctx) => {
    // El primer step (posición 0 en el array) SIEMPRE requiere subject
    // — es el que abre el hilo. Los siguientes lo omiten para enviar
    // como respuesta.
    const first = data.steps[0];
    if (first && (!first.subject || first.subject.trim() === "")) {
      ctx.addIssue({
        code: "custom",
        path: ["steps", 0, "subject"],
        message:
          "El primer step requiere subject (los siguientes lo omiten para enviar como respuesta en el hilo)",
      });
    }

    // Reglas específicas del canal email_cold.
    if (data.channel === "email_cold") {
      if (!data.legalFooter || data.legalFooter.trim() === "") {
        ctx.addIssue({
          code: "custom",
          path: ["legalFooter"],
          message:
            "legalFooter obligatorio para channel 'email_cold' (LSSI/RGPD)",
        });
      }
      data.steps.forEach((step, i) => {
        if (step.subject && SIGNATURE_PATTERN.test(step.subject)) {
          ctx.addIssue({
            code: "custom",
            path: ["steps", i, "subject"],
            message:
              "{{signature}} prohibido en ICPs channel 'email_cold' (la firma va como texto en frío)",
          });
        }
        if (SIGNATURE_PATTERN.test(step.bodyHtml)) {
          ctx.addIssue({
            code: "custom",
            path: ["steps", i, "bodyHtml"],
            message:
              "{{signature}} prohibido en ICPs channel 'email_cold' (la firma va como texto en frío)",
          });
        }
      });
    }
  });

export type SequenceStep = z.infer<typeof sequenceStepSchema>;
export type Sequence = z.infer<typeof sequenceSchema>;

const LEGAL_FOOTER_PLACEHOLDER = /\{\{\s*legalFooter\s*\}\}/g;

/**
 * Copia un template a un sequence listo para persistir. No muta el
 * template (readonly), devuelve un objeto plano indexable por Zod.
 *
 * Sustituye el marcador `{{legalFooter}}` de cada bodyHtml por el
 * HTML de `template.legalFooter` (bake-at-copy-time). Si el template
 * no lleva legalFooter, el marcador queda como cadena vacía —
 * sequenceSchema lo rechazará para channel "email_cold".
 */
export function sequenceFromTemplate(template: IcpTemplate): Sequence {
  const footerHtml = template.legalFooter ?? "";
  return {
    version: 1,
    templateSlug: template.slug,
    channel: template.channel,
    openerFallback: template.openerFallback,
    ...(template.legalFooter ? { legalFooter: template.legalFooter } : {}),
    steps: template.steps.map((s) => ({
      index: s.index,
      delayDays: s.delayDays,
      subject: s.subject,
      bodyHtml: s.bodyHtml.replace(LEGAL_FOOTER_PLACEHOLDER, footerHtml),
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
