-- OUTPILOT v2 — Migration 004a: campaign_leads.personalization
-- Fase 2 · T022
--
-- Añade la columna donde Lex escribe el opener generado. jsonb null =
-- aún no personalizado. Shape esperado (validado en aplicación, no en
-- BD; ver src/lib/lex/response.ts):
--   {
--     "version": 1,
--     "opener": string,
--     "personalization": "personalized" | "generic",
--     "fields_used": string[],
--     "reason_if_generic": string | null,
--     "model": string,
--     "generated_at": timestamptz-string
--   }
--
-- Volt (T023) leerá esta columna al invocar addLead: si personalization
-- es "generic", sustituye {{opener}} por sequence.openerFallback en
-- lugar de por opener.
--
-- No añade índice: siempre se lee por (campaign_id, id) que ya está
-- indexado. El índice hot-path por provider_lead_id (004) se mantiene
-- para T025.

set search_path = public;

alter table campaign_leads
  add column personalization jsonb;

comment on column campaign_leads.personalization is
  'Opener personalizado generado por Lex (T022). NULL hasta que el job '
  'corre. Shape validado en app; ver src/lib/lex/response.ts. '
  'Volt sustituye {{opener}} por personalization.opener si '
  'personalization="personalized", por sequence.openerFallback si '
  '"generic".';
