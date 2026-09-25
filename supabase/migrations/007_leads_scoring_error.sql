-- OUTPILOT v2 — Migration 007: leads.scoring_error
-- Fase 2 · T024 harness (fix bucle infinito nova-score)
--
-- Un batch cuya respuesta de Haiku no parsea (JSON truncado, fence
-- roto irrecuperable, etc.) NO debe volver a reclamarse en el mismo
-- run. El fix anterior (005 + release-on-parse-error) liberaba los
-- claims a NULL, pero el bucle "un click procesa todos los pendientes"
-- volvía a coger los MISMOS 20 leads → mismo prompt → mismo fallo →
-- infinito (observado run 01M3CJ4MBAY12EJQ1B2TH4KHKW, cancelado a los
-- 10 min tras ~15 llamadas a Haiku desperdiciadas).
--
-- Modelo:
--   icp_score IS NULL, scoring_claimed_at IS NULL, scoring_error IS NULL
--     → pendiente
--   icp_score IS NULL, scoring_claimed_at = <ts>, scoring_error IS NULL
--     → reclamado por un run
--   icp_score IS NULL, scoring_claimed_at IS NULL, scoring_error != NULL
--     → excluido del claim (fallo previo; humano investiga)
--   icp_score IS NOT NULL, scoring_claimed_at IS NULL, scoring_error IS NULL
--     → puntuado (fin)
--
-- El payload de scoring_error es JSONB para poder embeber el motivo,
-- un preview de la respuesta cruda (primeros 500 chars), stop_reason,
-- batch_index y timestamp del run que falló. Sin PII de leads.
--
-- Se limpia manualmente (SQL o BACKLOG "clear errors" UI) cuando el
-- humano decide reintentar. NO se auto-limpia: si Haiku fue
-- consistentemente incapaz de parsear estos leads, mejor que el
-- humano revise antes de re-gastar créditos.

set search_path = public;

alter table leads add column scoring_error jsonb null;

comment on column leads.scoring_error is
  'Payload del último batch fallido: {reason, response_preview, stop_reason, batch_index, timestamp}. '
  'NULL = sin error previo. Excluido del claim de scoring mientras esté seteado. '
  'Limpieza manual (SQL) cuando el humano decida reintentar.';

-- Índice parcial: solo indexa filas con error activo. Sirve para la
-- UI ("cuántos leads tienen scoring_error") sin escanear toda la
-- tabla. Las queries de claim usan el índice primario + el filtro
-- .is("scoring_error", null).
create index leads_scoring_error_idx
  on leads(tenant_id, scoring_error)
  where scoring_error is not null;
