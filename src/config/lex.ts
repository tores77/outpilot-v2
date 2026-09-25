// OUTPILOT v2 — Lex config
// Fase 2 · T022

// Cuántos campaign_leads procesa un solo trigger. Cada Inngest step
// procesa hasta LEX_BATCH_SIZE llamadas per-lead a Haiku; el trigger
// llena varios batches hasta LEX_MAX_PER_TRIGGER. Volver a pulsar el
// botón procesa los siguientes. Mismo patrón que Nova scoring.
export const LEX_BATCH_SIZE = 20;
export const LEX_MAX_PER_TRIGGER = 100;

// Cache del website summary en leads.custom_fields.website_summary.
// Se refresca si el fetched_at es más viejo que este TTL.
export const LEX_WEBSITE_CACHE_TTL_DAYS = 30;

// Fetch del website del lead. Timeout duro; el fetch fallado degrada
// a personalization "generic" con reason "website_fetch_failed"
// (o "website_disallowed_by_robots").
export const LEX_WEBSITE_FETCH_TIMEOUT_MS = 5_000;
export const LEX_WEBSITE_MAX_CHARS = 1500;

// UA descriptivo. Nada de anonimato: si un webmaster nos ve en logs,
// puede contactarnos.
export const LEX_WEBSITE_UA =
  "Umania-Labs-Outpilot/2.0 (+https://umanialabs.com)";

// Anthropic max_tokens del opener call. El opener + envoltura JSON
// cabe holgado en 400.
export const LEX_MAX_TOKENS = 400;

// Versión del shape de campaign_leads.personalization. Bump si el
// schema en response.ts cambia.
//   v1 (T022): opener, personalization, fields_used, reason_if_generic
//   v2 (T024): + company_display: string | null (capitalización correcta)
export const LEX_PERSONALIZATION_VERSION = 2;

// TTL para claims stuck en state='processing'. Un run que muere a
// medias deja el lead marcado como processing sin escribir el resultado
// final; tras este TTL, sweepStaleClaims lo devuelve a NULL para que
// el siguiente trigger lo pueda reclamar. 10 min es holgado:
// 2s/lead × 100 leads = ~200s, con margen 3×. Sin cron dedicado — el
// sweep corre al principio de cada claim (opportunistic).
export const LEX_STALE_CLAIM_MS = 10 * 60 * 1000;
