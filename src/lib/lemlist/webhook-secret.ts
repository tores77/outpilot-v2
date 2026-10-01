// OUTPILOT v2 · Lemlist webhook body-secret check (T025 bloque A)
//
// Hallazgo doc oficial Lemlist (2026-10-01): el campo "Secret
// (optional)" del formulario de webhook se devuelve como campo
// `secret` del body JSON, no en cabecera ni como HMAC del body. Cita
// (ver también header de route.ts):
//
//   "Sent back to your endpoint as a `secret` field in the JSON
//    body of every webhook call, so you can verify the request
//    originated from lemlist."
//
// Decisión Pere 2026-10-01:
//   - Reusar LEMLIST_WEBHOOK_SECRET para ambas capas (URL + body).
//     El campo Secret de Lemlist es inmutable; separar en dos vars
//     exigiría borrar y recrear el webhook. Se separará en la
//     próxima rotación.
//   - Modo observe / enforce controlado por LEMLIST_WEBHOOK_BODY_CHECK:
//     observe (default) → mismatch no bloquea; se persiste el evento
//     con processing_error = 'body_secret_mismatch' | 'body_secret_missing'
//     y se responde 200. Permite medir cuántos eventos reales llegan
//     con el secret correcto antes de pasar a enforce.
//     enforce → 404 silencioso ante mismatch.
//
// La comprobación va DESPUÉS del secret de la ruta y DESPUÉS del
// parse del body (necesitamos el body para extraer payload.secret).

import { timingSafeEqual } from "node:crypto";

export type BodySecretMode = "observe" | "enforce";

export type BodySecretCheckResult =
  | { ok: true }
  | { ok: false; reason: "body_secret_missing" | "body_secret_mismatch" };

/**
 * Lee LEMLIST_WEBHOOK_BODY_CHECK y la normaliza. Default: "observe".
 * Cualquier valor que no sea exactamente "enforce" cae a "observe"
 * por seguridad operativa — un typo en la var NUNCA activa enforce
 * accidentalmente, pero sí lo contrario (olvidar config → modo
 * permisivo). El operador tiene que escribir "enforce" exacto.
 */
export function parseBodySecretMode(raw: string | undefined): BodySecretMode {
  return raw === "enforce" ? "enforce" : "observe";
}

/**
 * Comparación en tiempo constante del secret del body con el valor
 * esperado. Longitudes distintas → no match sin pasar por
 * timingSafeEqual (que exige igual longitud y lanzaría RangeError).
 */
export function checkBodySecret(
  provided: string | null,
  expected: string,
): BodySecretCheckResult {
  if (!provided || provided.length === 0) {
    return { ok: false, reason: "body_secret_missing" };
  }
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) {
    return { ok: false, reason: "body_secret_mismatch" };
  }
  return timingSafeEqual(a, b)
    ? { ok: true }
    : { ok: false, reason: "body_secret_mismatch" };
}
