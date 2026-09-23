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

export type IcpVariable =
  | "firstName"
  | "lastName"
  | "companyName"
  | "signature"
  | "opener";

export const ALLOWED_VARIABLES: readonly IcpVariable[] = [
  "firstName",
  "lastName",
  "companyName",
  "signature",
  "opener",
];

export type IcpStep = {
  index: number; // 1-based
  delayDays: number; // dias desde el paso anterior; 0 para el primero
  subject: string;
  bodyHtml: string;
};

export type IcpTemplate = {
  slug: string;
  name: string;
  description: string;
  // Frase(s) que Volt sustituye por {{opener}} cuando Lex devuelve
  // personalization: "generic". Texto plano (sin HTML): va dentro
  // del <p>{{opener}}</p> del step 1 al renderizar.
  openerFallback: string;
  steps: readonly IcpStep[];
};

// ===== Industrial Premium ES =====
// Secuencia real de Lemlist seq_CX6SQC5Hyoz8DG2fy, tres pasos.
// Convertida a <p>/<br> tras leerla limpia del provider (Pere).

const industrialPremiumEs_step1 = `
<p>Hola {{firstName}},</p>
<p>{{opener}}</p>
<p>Pero he visitado vuestra web y os va a costar mucho convencer a un comprador internacional con la web actual. Está pidiendo a gritos un nivel acorde al producto.<br>Acabamos de entregar la web de Our Moment Charter (Mallorca) con un stack que combina Three.js, scroll cinematográfico y un agente IA embebido que cualifica leads 24/7.<br>La inversión equivale a ~0,3% del revenue anual de empresas como la vuestra.</p>
<p>¿20 minutos esta semana para enseñarte cómo quedaría algo así para {{companyName}}?</p>
<p><a href="${BRAND.CALENDLY_URL}">Calendly: Reservar 20 minutos</a><br>Pau · Umania Labs<br><a href="${BRAND.STUDIO_URL}">umanialabs.com</a></p>
<p>{{signature}}</p>
`.trim();

// Fallback text que sustituye {{opener}} si Lex devuelve
// personalization: "generic". Reproduce la frase original del paso 1
// para que el email se lea completo sin depender de la IA. Puede usar
// las mismas variables permitidas que el resto.
const industrialPremiumEs_openerFallback =
  "He estado viendo {{companyName}} y se nota el nivel del producto que tenéis. Cuando uno compite con italianos y franceses en vuestra categoría, eso solo se consigue con años de oficio detrás.";

const industrialPremiumEs_step2 = `
<p>{{firstName}},</p>
<p>Una matemática que casi ninguna empresa industrial hace:</p>
<p>El benchmark internacional dice que una web deficiente cuesta de media el 3-5% del revenue capturable. Para empresas vuestro tamaño eso son cientos de miles de € al año en oportunidades que llegan, miran y se van sin contactar.</p>
<p>Web premium con nuestro stack: 14 días, 25-35k€. Si solo recuperáis el 5% de esa pérdida anual, se paga sola en 9-12 meses.</p>
<p>¿Hablamos 20 minutos? Mi agenda está <a href="${BRAND.CALENDLY_URL}">aquí</a>.</p>
<p>Pau<br><a href="${BRAND.STUDIO_URL}">umanialabs.com</a></p>
<p>{{signature}}</p>
`.trim();

const industrialPremiumEs_step3 = `
<p>{{firstName}},</p>
<p>No insisto más.</p>
<p>Si en algún momento decidís renovar la web, escríbeme a <a href="mailto:${BRAND.CONTACT_EMAIL}">${BRAND.CONTACT_EMAIL}</a> y lo retomamos.</p>
<p>Y si quieres echar un ojo al trabajo antes: <a href="${BRAND.STUDIO_URL}">umanialabs.com</a></p>
<p>Suerte con la temporada.</p>
<p>Pau<br><a href="${BRAND.STUDIO_URL}">umanialabs.com</a></p>
<p>{{signature}}</p>
`.trim();

const industrialPremiumEs: IcpTemplate = {
  slug: "industrial_premium_es",
  name: "Industrial Premium ES",
  description:
    "Fabricantes industriales españoles con producto premium que compiten con italianos y franceses en export. Web actual como cuello de botella comercial.",
  openerFallback: industrialPremiumEs_openerFallback,
  steps: [
    {
      index: 1,
      delayDays: 0,
      subject: "{{firstName}}, una observación sobre {{companyName}}",
      bodyHtml: industrialPremiumEs_step1,
    },
    {
      index: 2,
      delayDays: 4,
      subject: "Una cuenta rápida sobre vuestra web",
      bodyHtml: industrialPremiumEs_step2,
    },
    {
      index: 3,
      delayDays: 1,
      subject: "Cierro este hilo",
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
