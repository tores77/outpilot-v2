// OUTPILOT v2 · Guardarraíles de entregabilidad (T025 bloque C)
//
// Función pura que decide si una campaña debe pausarse por métricas
// de 24h. Umbrales fijados por Pere 2026-10-02:
//
//   bounce rate   > 2 %     → pause reason=bounce_rate_exceeded
//   complaint rate > 0,1 %  → pause reason=complaint_rate_exceeded
//
// Ambos solo se evalúan cuando sent ≥ 20 en la ventana (evita
// falsos positivos de las primeras horas; 1 bounce sobre 10 enviados
// no es señal fiable).
//
// La función no lee BD ni Lemlist; el caller (job B) pasa los
// contadores. Esto permite tests deterministas y añadir ventanas
// alternativas (horas vs días) sin tocar el núcleo.
//
// Nota sobre "complaints": Lemlist no documenta un `type` separado
// para FBL/queja. De momento el caller pasa `complaints: 0`; cuando
// identifiquemos la señal (type nuevo o campo en emailsBounced) se
// actualiza SOLO el caller — esta función sigue igual.

export type GuardrailMetrics = {
  sent: number;
  bounced: number;
  complaints: number;
  windowHours: number;
};

export type GuardrailReason =
  | "bounce_rate_exceeded"
  | "complaint_rate_exceeded";

export type GuardrailResult =
  | { action: "none"; reason: null }
  | {
      action: "pause";
      reason: GuardrailReason;
      rate: number;
      threshold: number;
    };

export const GUARDRAIL_BOUNCE_RATE_THRESHOLD = 0.02;
export const GUARDRAIL_COMPLAINT_RATE_THRESHOLD = 0.001;
export const GUARDRAIL_MIN_SENT = 20;
export const GUARDRAIL_WINDOW_HOURS = 24;

export function evaluateGuardrails(
  m: GuardrailMetrics,
): GuardrailResult {
  if (m.sent < GUARDRAIL_MIN_SENT) {
    return { action: "none", reason: null };
  }

  const bounceRate = m.bounced / m.sent;
  if (bounceRate > GUARDRAIL_BOUNCE_RATE_THRESHOLD) {
    return {
      action: "pause",
      reason: "bounce_rate_exceeded",
      rate: bounceRate,
      threshold: GUARDRAIL_BOUNCE_RATE_THRESHOLD,
    };
  }

  const complaintRate = m.complaints / m.sent;
  if (complaintRate > GUARDRAIL_COMPLAINT_RATE_THRESHOLD) {
    return {
      action: "pause",
      reason: "complaint_rate_exceeded",
      rate: complaintRate,
      threshold: GUARDRAIL_COMPLAINT_RATE_THRESHOLD,
    };
  }

  return { action: "none", reason: null };
}

/**
 * Modo del enforcement, mismo patrón que LEMLIST_WEBHOOK_BODY_CHECK:
 *   observe (default): sí registra alerta, NO llama Lemlist ni cambia
 *                      campaigns.status. Permite calibrar umbrales
 *                      antes de endurecer.
 *   enforce         : POST /pause + status = paused_guardrail + alerta.
 * Cualquier valor que no sea exactamente "enforce" → observe (típico:
 * typo no debe activar enforce accidentalmente).
 */
export type GuardrailsMode = "observe" | "enforce";
export function parseGuardrailsMode(raw: string | undefined): GuardrailsMode {
  return raw === "enforce" ? "enforce" : "observe";
}
