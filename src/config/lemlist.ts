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

function parseHHMMToMinutes(value: string): number {
  const [h, m] = value.split(":").map((s) => Number.parseInt(s, 10));
  if (!Number.isFinite(h) || !Number.isFinite(m)) return 0;
  return h * 60 + m;
}

/**
 * Envios por dia que caben dentro de las ventanas del schedule dado el
 * secondsToWait entre envios de cada ventana. Formula: para cada
 * ventana, `floor(duracionEnSegundos / secondsToWait)`. Suma total.
 *
 * Nota (T019): la cifra excluye el envio inicial en t=0 (el "+1" que
 * daria capacidad al filo del inicio); esto coincide con el conteo real
 * de Volt cuando `step.sleepUntil` calcula la primera ventana disponible
 * y encola desde ahi. Si el comportamiento observado en el smoke (T024)
 * pide +1, ajustamos aqui con evidencia.
 */
export function sendsPerDayFromSchedules(
  schedules: readonly LemlistScheduleBody[],
): number {
  return schedules.reduce((total, s) => {
    if (s.secondsToWait <= 0) return total;
    const windowMinutes = Math.max(
      0,
      parseHHMMToMinutes(s.end) - parseHHMMToMinutes(s.start),
    );
    const windowSeconds = windowMinutes * 60;
    return total + Math.floor(windowSeconds / s.secondsToWait);
  }, 0);
}

/**
 * Techo diario por mailbox impuesto por las ventanas del schedule Volt.
 * Con `VOLT_DEFAULT_SCHEDULES` (2 ventanas de 2h, secondsToWait 1200):
 *   floor(7200/1200) * 2 = 12 envios/dia.
 * Este techo es dominante frente a `emailLimit` tipicos de Lemlist (30):
 *   min(30, 12) = 12.
 */
export const VOLT_SCHEDULE_DAILY_CAP = sendsPerDayFromSchedules(VOLT_DEFAULT_SCHEDULES);
