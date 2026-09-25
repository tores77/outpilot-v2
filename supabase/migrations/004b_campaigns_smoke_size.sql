-- OUTPILOT v2 — Migration 004b: campaigns.smoke_size
-- Fase 2 · T024
--
-- Tamaño del smoke fijado por volt-smoke-prepare cuando transiciona
-- una campaña de draft a smoke_test. NULL mientras no se haya
-- iniciado ningún smoke sobre esa campaña. Nunca se decrementa: si
-- una campaña se promueve a active tras el smoke, mantiene el
-- smoke_size del arranque como registro histórico.
--
-- Consulta típica en la UI (label del botón / progreso del smoke):
--   SELECT smoke_size, (SELECT count(*) FROM campaign_leads WHERE ...)
--
-- Se prefiere columna a custom_fields porque smoke_size es decisión
-- estable del ciclo de vida, no experimento.

set search_path = public;

alter table campaigns
  add column smoke_size int;

comment on column campaigns.smoke_size is
  'Tamaño del smoke fijado en T024 al pasar de draft a smoke_test. '
  'NULL hasta que se inicia el smoke. Mantiene el valor histórico si '
  'la campaña se promueve a active después.';
