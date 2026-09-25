// OUTPILOT v2 — Volt opener resolver (T023)
// -----------------------------------------------------------------------------
// Pure function que compone el valor del {{opener}} que Volt envía a
// Lemlist en cada addLead. Sin dependencias externas (no supabase, no
// http). Testeable en aislado.
//
// Reglas:
//   - personalization === "personalized" → opener = personalization.opener
//     (Lex ya lo sanitizó; se pasa literal).
//   - personalization === "generic"      → opener = openerFallback con
//     {{companyName}}, {{firstName}}, {{lastName}} sustituidos por los
//     valores de BD. {{signature}} SE DEJA (Lemlist lo expande al enviar
//     desde config del mailbox). {{opener}} recursivo se deja también
//     (fail-safe; no debería aparecer en openerFallback por design).
//   - Cualquier otro shape → throw. El caller decide si aborta el lead
//     o lo cuenta como error.
//
// El caller (job Volt) DEBE haber filtrado leads sin company antes de
// llegar aquí. Si un lead sin company llegase por error, el openerFallback
// substituye {{companyName}} por "" (string vacío), lo que degrada la
// calidad del email pero no rompe el envío. NO usamos fallback textual
// ("vuestra empresa") — instrucción explícita del gate.

export type LeadForOpener = {
  first_name: string | null;
  last_name: string | null;
  company: string | null;
};

export type PersonalizationSnapshot =
  | {
      personalization: "personalized";
      opener: string;
    }
  | {
      personalization: "generic";
      opener?: string;
      reason_if_generic?: string | null;
    }
  | {
      // Cualquier otro shape (resultado a medias, corrupto, o el propio
      // claim de {state:'processing'}). Volt debe filtrar antes.
      [k: string]: unknown;
    };

const VAR_PATTERN = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

/**
 * Sustituye {{firstName}}/{{lastName}}/{{companyName}} en `text` con
 * valores de `lead`. {{signature}} y {{opener}} se dejan intactos.
 * Cualquier otra variable se deja intacta también (defensivo; el
 * validador de sequence.ts ya rechaza vars no permitidas al persistir).
 * Sin fallback textual: campo null → string vacío en la sustitución.
 * NO trim, NO titlecase — valor literal de BD.
 */
export function substituteLeadVars(text: string, lead: LeadForOpener): string {
  return text.replace(VAR_PATTERN, (match, name: string) => {
    switch (name) {
      case "firstName":
        return lead.first_name ?? "";
      case "lastName":
        return lead.last_name ?? "";
      case "companyName":
        return lead.company ?? "";
      default:
        // signature, opener u otras: mantener el placeholder.
        return match;
    }
  });
}

/**
 * Compone el opener final para addLead. `openerFallback` viene del
 * sequence de BD (no del template; el sequence es la fuente de verdad
 * per-campaña).
 */
export function resolveOpener(args: {
  personalization: unknown;
  openerFallback: string;
  lead: LeadForOpener;
}): string {
  const { personalization, openerFallback, lead } = args;

  if (!personalization || typeof personalization !== "object") {
    throw new Error(
      "resolveOpener: personalization no es un objeto (¿el lead no pasó por Lex?)",
    );
  }

  const p = personalization as {
    personalization?: unknown;
    opener?: unknown;
  };

  if (p.personalization === "personalized") {
    const opener = typeof p.opener === "string" ? p.opener : "";
    if (opener.trim() === "") {
      throw new Error(
        "resolveOpener: personalization='personalized' pero opener vacío (Lex tenía que haber degradado a generic)",
      );
    }
    return opener;
  }

  if (p.personalization === "generic") {
    // Sustituye SOLO las vars de lead; deja {{signature}} y {{opener}}
    // para Lemlist / recursión (no debería existir).
    return substituteLeadVars(openerFallback, lead);
  }

  throw new Error(
    `resolveOpener: personalization "${String(p.personalization)}" desconocido (esperado "personalized" | "generic")`,
  );
}

/**
 * Tokeniza un nombre de empresa para el guard de company_display:
 * normaliza (lowercase + sin diacríticos), separa por caracteres no
 * alfanuméricos, y descarta tokens < 3 caracteres para no cazar
 * ruido tipo "s", "l", "de", "y" que aparecen en sufijos legales
 * ("S.L.", "S.A.", "y Cía"). El threshold 3 conserva palabras cortas
 * con contenido ("sur", "sky", "ibm") a costa de posibles falsos
 * positivos en preposiciones ("del", "the") — coste aceptable: el
 * guard busca detectar scrapes claramente erróneos, no ser perfecto.
 */
const COMBINING_DIACRITICS = /[̀-ͯ]/g;

function tokenizeCompany(s: string): Set<string> {
  return new Set(
    s
      .normalize("NFD")
      .replace(COMBINING_DIACRITICS, "")
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length >= 3),
  );
}

/**
 * T024 guard: `company_display` de Lex y `lead.company` deben
 * compartir al menos una palabra significativa (case-insensitive,
 * sin tildes). Si no, es porque Lex scrapeó la web equivocada
 * (dominio caducado, redirección, error de resolución) y renombraría
 * la empresa en el subject/body. En ese caso descartamos
 * company_display y volvemos a lead.company. Exportado para tests.
 */
export function shareAnyCompanyWord(a: string, b: string): boolean {
  const A = tokenizeCompany(a);
  if (A.size === 0) return false;
  const B = tokenizeCompany(b);
  for (const w of A) if (B.has(w)) return true;
  return false;
}

/**
 * Compone la personalization map completa que Volt envía a Lemlist
 * en addLead. Lemlist expande {{firstName}}, {{lastName}},
 * {{companyName}} y {{opener}} en el body del step al enviar el email;
 * nosotros SÍ resolvemos {{companyName}} DENTRO del opener (via
 * resolveOpener) porque no queremos depender de que Lemlist haga
 * substitución recursiva.
 *
 * T024: si el personalization payload de Lex trae `company_display`
 * (v2+), se prefiere sobre `lead.company` para el {{companyName}} que
 * Lemlist substituye — Vibe suele darnos el company en TODO MAYÚSCULAS
 * ("METALES DEL SUR S.L."), y el email debe leer "Metales del Sur"
 * si la web de la empresa lo capitaliza así. Fallback a lead.company
 * si Lex devolvió null (v1 sin campo, o no encontró capitalización)
 * O si el guard shareAnyCompanyWord detecta un scrape errado.
 */
export function buildAddLeadPersonalization(args: {
  personalization: unknown;
  openerFallback: string;
  lead: LeadForOpener;
}): Record<string, string> {
  const { lead, personalization } = args;
  const opener = resolveOpener(args);
  const p = (personalization ?? {}) as { company_display?: unknown };
  const rawDisplay =
    typeof p.company_display === "string" && p.company_display.trim() !== ""
      ? p.company_display.trim()
      : null;
  const leadCompany = lead.company ?? "";
  // Guard: si Lex propone un display que no comparte NINGUNA palabra
  // significativa con lead.company, descartamos el display (probable
  // scrape de web equivocada). Si el lead no tiene company o el
  // display no supera el guard → usamos lead.company literal.
  const companyDisplay =
    rawDisplay && leadCompany && shareAnyCompanyWord(rawDisplay, leadCompany)
      ? rawDisplay
      : null;
  return {
    firstName: lead.first_name ?? "",
    lastName: lead.last_name ?? "",
    companyName: companyDisplay ?? leadCompany,
    opener,
  };
}
