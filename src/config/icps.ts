// OUTPILOT v2 — ICP templates
// Fase 2 · T021
//
// Plantillas de secuencia por ICP. Cargadas desde codigo (no BD): son
// contenido "de la casa" que evoluciona con el tiempo pero no cambia
// entre tenants (v2.1 tiene un solo tenant). Cada campaña que se crea
// desde el builder toma un template como punto de partida y lo copia a
// campaigns.sequence — a partir de ahi el sequence de la campaña es
// independiente del template (editable por campaña).
//
// Variables permitidas: firstName, lastName, companyName (de leads),
// signature (passthrough a Lemlist mailbox) y opener (reservada para
// Lex T022). Cualquier otra variable {{X}} en subject o bodyHtml es
// rechazada por el validador.
//
// bodyHtml: HTML plano con <p> y <br>. URLs desde BRAND. Copy y bylines
// inline (cambian por iteracion editorial, no por rebrand).

import { BRAND } from "./brand";
import type { VibeApiFilters } from "@/lib/vibe/types";

// Variables permitidas en subject/bodyHtml/openerFallback.
//
// - firstName, lastName, companyName: variables Lemlist (per-lead).
// - opener: nuestra variable, Lex la genera; Volt sustituye por
//   openerFallback si viene "generic".
// - signature: variable Lemlist (mailbox signature). Su USO se
//   restringe por canal desde sequenceSchema (prohibida en email_cold).
// - unsubscribeUrl: variable Lemlist (per-campaign). Va dentro del
//   pie legal LSSI/RGPD; Lemlist genera el href per-lead con el token
//   de baja de la campaña.
// - legalFooter: marcador de plantilla; sequenceFromTemplate y la
//   server action lo sustituyen por template.legalFooter antes de
//   persistir. Aparece SOLO en templates y en el form pre-fill; una
//   sequence persistida ya no lo contiene.
export type IcpVariable =
  | "firstName"
  | "lastName"
  | "companyName"
  | "signature"
  | "opener"
  | "unsubscribeUrl"
  | "legalFooter";

export const ALLOWED_VARIABLES: readonly IcpVariable[] = [
  "firstName",
  "lastName",
  "companyName",
  "signature",
  "opener",
  "unsubscribeUrl",
  "legalFooter",
];

export type IcpStep = {
  index: number; // 1-based
  delayDays: number; // dias desde el paso anterior; 0 para el primero
  // subject OPCIONAL: solo obligatorio en el step 1. Los steps 2+ se
  // omiten para que Lemlist los envíe como respuesta en el hilo del
  // step 1 (comportamiento documentado: "omit for follow-ups to send
  // as reply thread"). Ver
  // https://developer.lemlist.com/api-reference/objects-definitions/step.md
  subject?: string;
  bodyHtml: string;
};

// Canal de la secuencia. Determina reglas legales/estilísticas:
//   - "email_cold" → legalFooter obligatorio (LSSI/RGPD), sin
//     {{signature}} en ningún step (en frío la firma va como texto
//     dentro del bodyHtml, no como variable de mailbox).
export type IcpChannel = "email_cold";

export type IcpTemplate = {
  slug: string;
  name: string;
  description: string;
  channel: IcpChannel;
  // Frase(s) que Volt sustituye por {{opener}} cuando Lex devuelve
  // personalization: "generic". Texto plano (sin HTML): va dentro
  // del <p>{{opener}}</p> del step 1 al renderizar.
  openerFallback: string;
  // Pie legal (LSSI/RGPD): identificación del remitente y línea de
  // baja. sequenceFromTemplate lo sustituye en el marcador
  // `{{legalFooter}}` presente al final del bodyHtml de cada step.
  // Obligatorio para channel "email_cold" (validado por sequenceSchema).
  legalFooter?: string;
  // T024: filtros que Nova envía a la API de Vibe para poblar el
  // pool de este ICP. Estructura literal (nombres + values verificados
  // con autocomplete + fetch-entities-statistics — NO se "arreglan"
  // los strings). Los países se pueden sobreescribir en /radar/vibe;
  // el resto es solo-lectura. Opcional para ICPs que no cargan desde
  // Vibe (no aplica en v2.1).
  vibeFilters?: VibeApiFilters;
  steps: readonly IcpStep[];
};

// ===== Industrial Premium ES =====
// Copy T024 (v2): sin {{signature}}, firma como texto en frío.
// {{legalFooter}} se sustituye en sequenceFromTemplate por el HTML
// de `legalFooter`. UNSUB_LINK dentro del footer es un placeholder
// literal que Pere reemplazará con el marcado exacto de Lemlist tras
// descubrirlo en la UI y leerlo por GET /sequences.

const industrialPremiumEs_step1 = `
<p>Hola {{firstName}},</p>
<p>{{opener}}</p>
<p>Pero un comprador alemán que os compara con un italiano decide en treinta segundos, y vuestra web no se lo pone fácil.</p>
<p>El problema no es la web. Es que el producto vale más de lo que la web cuenta.</p>
<p>¿Te va bien que te proponga dos huecos de veinte minutos para enseñarte qué haría yo con la vuestra? Solo criterio, sin compromiso.</p>
<p>Pau Torres<br>Umania Labs · Mallorca</p>
{{legalFooter}}
`.trim();

// Fallback text que sustituye {{opener}} si Lex devuelve
// personalization: "generic". Reproduce la frase original del paso 1
// para que el email se lea completo sin depender de la IA. Puede usar
// las mismas variables permitidas que el resto.
const industrialPremiumEs_openerFallback =
  "He estado viendo {{companyName}} y se nota el nivel del producto que tenéis. Cuando uno compite con italianos y franceses en vuestra categoría, eso solo se consigue con años de oficio detrás.";

const industrialPremiumEs_step2 = `
<p>{{firstName}},</p>
<p>Un dato: la última web que entregamos, para un negocio que vende a clientes extranjeros, salió en catorce días y lleva un agente que responde a los compradores a cualquier hora.</p>
<p>No digo que sea vuestro caso. Digo que si un comprador entra a las once de la noche desde Múnich, alguien tiene que atenderle.</p>
<p>Si quieres verlo aplicado a {{companyName}}, aquí tienes mi agenda: <a href="${BRAND.CALENDLY_URL}">reservar veinte minutos</a></p>
<p>Pau</p>
{{legalFooter}}
`.trim();

const industrialPremiumEs_step3 = `
<p>{{firstName}},</p>
<p>No insisto más. Si en algún momento decidís revisar la web, escríbeme y lo retomamos.</p>
<p>Suerte con la temporada.</p>
<p>Pau</p>
{{legalFooter}}
`.trim();

// Pie legal LSSI/RGPD. {{unsubscribeUrl}} es variable Lemlist estándar
// (per-campaign, un token único de baja por lead). Marcado verificado
// por GET /sequences tras añadirlo en la UI de Lemlist.
const industrialPremiumEs_legalFooter = `<p style="font-size:12px;color:#6B6B6B">Te escribo a tu dirección profesional por interés legítimo, porque creo que esto puede ser relevante para {{companyName}}. Si prefieres no recibir más mensajes, puedes <a href="{{unsubscribeUrl}}">darte de baja aquí</a>. Umanialabs SL · Quarta Volta 4027, 07200 Felanitx, Mallorca.</p>`;

// T024: filtros Vibe verificados por Pere el 2026-09-25 con
// autocomplete + fetch-entities-statistics (gratis): 1.785 prospects
// con email disponibles con este set. NO se normalizan los valores de
// linkedin_category — son literales de la taxonomía LinkedIn.
//
// prospect_country_code se eliminó tras un 422 real: es del conector
// MCP, no de la API cruda de Explorium (ver VibeApiFilters).
const industrialPremiumEs_vibeFilters: VibeApiFilters = {
  company_country_code: { values: ["ES"] },
  linkedin_category: {
    values: [
      "machinery manufacturing",
      "industrial machinery manufacturing",
      "furniture and home furnishings manufacturing",
      "household and institutional furniture manufacturing",
      "office furniture and fixtures manufacturing",
      "apparel manufacturing",
      "sporting goods manufacturing",
      "construction hardware manufacturing",
      "building materials",
    ],
  },
  company_size: { values: ["11-50", "51-200", "201-500"] },
  job_level: {
    values: [
      "c-suite",
      "owner",
      "founder",
      "president",
      "director",
      "partner",
    ],
  },
  has_contact_details: { value: "email" },
};

const industrialPremiumEs: IcpTemplate = {
  slug: "industrial_premium_es",
  name: "Industrial Premium ES",
  description:
    "Fabricantes industriales españoles con producto premium que compiten con italianos y franceses en export. Web actual como cuello de botella comercial.",
  channel: "email_cold",
  openerFallback: industrialPremiumEs_openerFallback,
  legalFooter: industrialPremiumEs_legalFooter,
  vibeFilters: industrialPremiumEs_vibeFilters,
  steps: [
    {
      index: 1,
      delayDays: 0,
      subject: "{{firstName}}, vuestra web y el comprador alemán",
      bodyHtml: industrialPremiumEs_step1,
    },
    {
      // Sin subject → Lemlist lo envía como respuesta en el hilo del
      // step 1 (mejor tasa de apertura, hilo continuo).
      index: 2,
      delayDays: 4,
      bodyHtml: industrialPremiumEs_step2,
    },
    {
      // Idem: sigue el hilo.
      index: 3,
      delayDays: 1,
      bodyHtml: industrialPremiumEs_step3,
    },
  ],
};

export const ICPS: readonly IcpTemplate[] = [industrialPremiumEs];

export function getIcpBySlug(slug: string): IcpTemplate | null {
  return ICPS.find((t) => t.slug === slug) ?? null;
}

// ===== Validador de variables =====

const VARIABLE_PATTERN = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;
const ALLOWED_SET: ReadonlySet<string> = new Set(ALLOWED_VARIABLES);

/**
 * Extrae los nombres de variables {{X}} presentes en un texto, en
 * orden de aparicion, sin duplicados.
 */
export function extractVariables(text: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const match of text.matchAll(VARIABLE_PATTERN)) {
    const name = match[1];
    if (!seen.has(name)) {
      seen.add(name);
      result.push(name);
    }
  }
  return result;
}

export type VariableCheck =
  | { ok: true }
  | { ok: false; unknownVariables: string[] };

/**
 * Valida que todas las variables {{X}} de un texto esten en
 * ALLOWED_VARIABLES. Si hay alguna desconocida, devuelve la lista.
 */
export function validateVariables(text: string): VariableCheck {
  const unknown = extractVariables(text).filter((v) => !ALLOWED_SET.has(v));
  return unknown.length === 0
    ? { ok: true }
    : { ok: false, unknownVariables: unknown };
}
