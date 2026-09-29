// OUTPILOT v2 · Detector de name swap (T024 smoke 2026-09-29).
//
// Motivación (caso Ibarmia): el lead vino con first_name="Arandia" y
// last_name="Koldo", pero el email es "koldo.arandia@ibarmia.com" — el
// apellido va en el lugar del nombre. Si se envía así a Lemlist, el
// merge tag {{firstName}} escribe "Hola Arandia" y quema el lead.
//
// Este guard SOLO decide si un lead es "sospechoso". Es barato (una
// normalización + dos indexOf) y se corre antes de cualquier llamada
// externa. Cuando dispara → se marca `name_swapped_suspect: true` en
// campaign_leads.personalization y NO se sube a Lemlist. Corrección:
// humano revisa, ejecuta UPDATE en leads y vuelve a lanzar sync.
//
// Reglas — dispara si CUALQUIERA se cumple:
//
//   R1 (literal, pedido de Pere): firstName NO aparece en la parte
//      local del email Y lastName SÍ aparece. Captura el swap típico
//      donde el "firstName" es un apellido que no está en el email
//      (mala carga del CSV). Refinamiento: además el local NO puede
//      empezar con la primera letra del firstName — así el patrón
//      "inicial+apellido" (jgomez@ con first_name="Juan") no se
//      marca como suspect (la 'j' inicial es evidencia razonable).
//
//   R2 (posicional, extensión para Ibarmia): ambos aparecen PERO el
//      lastName aparece ANTES que el firstName en el local (indexOf
//      menor). En el formato corporativo estándar "nombre.apellido",
//      ver el apellido primero es el patrón inequívoco del swap.
//
// Falsos positivos previstos:
//   - Emails con prefijo tipo "info.arandia@" — mitigado por R2
//     porque "info" no matchea ni first ni last.
//   - Nombres muy cortos (1-2 chars: "T", "Al") o partículas ("de",
//     "la") — mitigado por el min-length 3.
//   - Segundos nombres/apellidos: si el local incluye ambos apellidos
//     ("koldo.arandia.perez"), R2 sigue funcionando porque compara
//     posiciones absolutas.
//   - Inicial + apellido ("jgomez@"): mitigado por la extensión de
//     R1 (initial-letter check).
//
// Falsos negativos previstos (los aceptamos):
//   - Emails que no reflejan el nombre (jefe@, marketing@, iniciales
//     sueltas "ka@"): R1 y R2 no disparan y el lead sube. No es peor
//     que el estado anterior — el problema es "swap detectable", no
//     "todos los emails opacos".

const DIACRITICS = /[̀-ͯ]/g;
const MIN_NAME_LENGTH = 3;

function normalize(value: string | null | undefined): string {
  if (!value) return "";
  return value.normalize("NFD").replace(DIACRITICS, "").toLowerCase().trim();
}

export type NameSwapReason =
  | "first_absent_last_present"
  | "last_precedes_first";

export type NameSwapDetection =
  | { suspect: false; reason: null }
  | { suspect: true; reason: NameSwapReason };

export type NameSwapInput = {
  first_name: string | null | undefined;
  last_name: string | null | undefined;
  email: string | null | undefined;
};

export function detectNameSwap(lead: NameSwapInput): NameSwapDetection {
  const fn = normalize(lead.first_name);
  const ln = normalize(lead.last_name);
  const email = typeof lead.email === "string" ? lead.email.trim() : "";

  // Guard-in: solo evaluamos si tenemos los tres datos con longitud
  // razonable. Faltar cualquiera → not suspect (otro sistema se
  // ocupará: si falta first_name, addLead ya explota; si falta email,
  // el lead no está en pending).
  if (fn.length < MIN_NAME_LENGTH || ln.length < MIN_NAME_LENGTH) {
    return { suspect: false, reason: null };
  }
  const atIdx = email.indexOf("@");
  if (atIdx <= 0) return { suspect: false, reason: null };

  const local = normalize(email.slice(0, atIdx));
  if (local.length === 0) return { suspect: false, reason: null };

  const fnIdx = local.indexOf(fn);
  const lnIdx = local.indexOf(ln);

  // R1 literal + refinamiento inicial. Solo dispara si además el
  // local NO empieza con la primera letra del firstName — así el
  // patrón "jgomez@" (inicial + apellido, first="Juan") no cuenta
  // como swap, pero "garcia@" con first="Ramirez" sí.
  if (fnIdx < 0 && lnIdx >= 0 && local[0] !== fn[0]) {
    return { suspect: true, reason: "first_absent_last_present" };
  }
  // R2 posicional
  if (fnIdx >= 0 && lnIdx >= 0 && lnIdx < fnIdx) {
    return { suspect: true, reason: "last_precedes_first" };
  }
  return { suspect: false, reason: null };
}
