-- OUTPILOT v2 — Migration 009a: campaigns.provider_status
-- Fase 2 · T025 (bloque D — sync-campaign-status)
--
-- Añade dos columnas a `campaigns` para que el cron
-- volt-sync-campaign-status (horario) refleje el estado que reporta
-- Lemlist en GET /api/campaigns/:cid sin pisar el `status` interno.
--
-- Rationale:
--   El `status` de `campaigns` es un lifecycle NUESTRO (draft →
--   smoke_test → active → paused → done) controlado por humano. El
--   provider puede estar en "running" mientras internamente seguimos
--   en "smoke_test" (caso real 2026-10-01). Transicionar
--   automáticamente perdería la semántica del smoke. Por eso:
--
--     - `provider_status`: el string crudo que devuelve Lemlist. Si
--       no cuadra con nuestros estados mapeados, se guarda igual
--       para que un humano lo vea.
--     - `provider_status_synced_at`: timestamp de la última
--       sincronización OK (independiente de si hubo drift).
--
--   Si el mapper detecta drift, se escribe un evento
--   `campaigns.status_drift` en `events` — no se toca `status`.
--
-- Decisión de numeración (009a): esta columna es una extensión del
-- bloque D de T025, aún con 010 reservada para replies+outcomes. El
-- sufijo "a" mantiene la relación con T025 sin saltarse el 010
-- planificado. Pattern consistente con 001a / 003a / 004a-b-c.

set search_path = public;

alter table campaigns
  add column if not exists provider_status            text,
  add column if not exists provider_status_synced_at  timestamptz;

comment on column campaigns.provider_status is
  'Estado crudo del provider (Lemlist GET /campaigns/:cid). Reflejado '
  'por el cron volt-sync-campaign-status (T025 bloque D). No pisa '
  '`status`, que es el lifecycle interno controlado por humano.';

comment on column campaigns.provider_status_synced_at is
  'Última sincronización OK del provider_status. Permite detectar '
  'campañas sin pulso (cron horario parado) comparando con now().';

-- Índice útil para "dame campañas que llevan rato sin sincronizar"
-- (observabilidad desde SQL / dashboard futuro).
create index if not exists campaigns_provider_sync_idx
  on campaigns(provider_status_synced_at)
  where provider_external_id is not null;
