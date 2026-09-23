// OUTPILOT v2 — Lemlist config
// Fase 2 · T018
//
// Constantes y defaults del provider Lemlist. Todo lo que "podria cambiar
// sin tocar codigo" vive aqui.

export const LEMLIST_BASE_URL = "https://api.lemlist.com/api";

// Rate limit oficial confirmado en probes de T018: 20 req / 2 s por key.
// El cliente honra Retry-After como fuente primaria de backoff y
// x-ratelimit-reset como respaldo (regla operativa de Pere).
export const LEMLIST_RATE_LIMIT_PER_2S = 20;

// Timeouts y reintentos.
export const LEMLIST_DEFAULT_TIMEOUT_MS = 15_000;
export const LEMLIST_MAX_RETRIES = 3;
// Fallback si un 429/5xx llega sin Retry-After (raro en Lemlist).
export const LEMLIST_FALLBACK_BACKOFF_MS = [500, 1500, 4000] as const;

/**
 * Shape de un schedule de Lemlist tal y como los espera POST /schedules
 * y PATCH /schedules/:id. Descubierto en el probe schedule-protocol de
 * T018: NO hay campo `windows` — cada ventana horaria es UN schedule
 * distinto con `start`/`end` propios.
 */
export type LemlistScheduleBody = {
  name: string;
  timezone: string;
  start: string; // "HH:MM"
  end: string; // "HH:MM"
  weekdays: number[]; // ISO 1..7 (lunes..domingo)
  secondsToWait: number;
};

/**
 * Ventanas M-X-J 9-11 y 15-17 Madrid (spec §4). Como Lemlist no soporta
 * multi-windows nativos, la spec se preserva creando DOS schedules por
 * campana. El probe verifico que ambos conviven asociados a la misma
 * campana (Path A per-campana).
 */
export const VOLT_DEFAULT_SCHEDULES: readonly LemlistScheduleBody[] = [
  {
    name: "Volt morning 09-11 (M-X-J)",
    timezone: "Europe/Madrid",
    start: "09:00",
    end: "11:00",
    weekdays: [2, 3, 4],
    secondsToWait: 1200,
  },
  {
    name: "Volt afternoon 15-17 (M-X-J)",
    timezone: "Europe/Madrid",
    start: "15:00",
    end: "17:00",
    weekdays: [2, 3, 4],
    secondsToWait: 1200,
  },
];

/**
 * Dias activos por semana en el schedule de Volt (M-X-J = 3). Ambas
 * ventanas comparten `weekdays`, asi que el count es igual en las dos.
 * Se expone como constante para que `computeWeeklyCapacity` no dependa
 * del indice del array.
 */
export const VOLT_ACTIVE_DAYS_PER_WEEK = VOLT_DEFAULT_SCHEDULES[0].weekdays.length;
