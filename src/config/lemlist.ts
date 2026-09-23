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

// Schedule por defecto de las campanas Volt. Spec §4: ventanas M-X-J
// 9-11 y 15-17 Madrid. Se fuerza al crear la campana en upsertCampaign.
// Cambiar aqui, no en el codigo del provider.
export type LemlistSchedule = {
  name: string;
  timezone: string;
  weekdays: number[]; // 1..7, ISO (lun..dom)
  windows: ReadonlyArray<{ start: string; end: string }>; // HH:MM
  secondsBetweenSends: number;
};

export const VOLT_DEFAULT_SCHEDULE: LemlistSchedule = {
  name: "Volt M-X-J 9-11 / 15-17 Madrid",
  timezone: "Europe/Madrid",
  weekdays: [2, 3, 4], // martes, miercoles, jueves (ISO 1=lun..7=dom)
  windows: [
    { start: "09:00", end: "11:00" },
    { start: "15:00", end: "17:00" },
  ],
  secondsBetweenSends: 1200, // 20 min, mismo default que la campana real observada
};
