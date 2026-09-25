-- OUTPILOT v2 — Migration 005: leads.scoring_claimed_at
-- Fase 2 · T024 harness (fix nova-score fan-out)
--
-- Reserva atómica para el scoring de Nova. Antes de este marcador,
-- 6 clicks al botón "Puntuar N pendientes" generaban 6 runs que leían
-- los mismos leads sin score y llamaban a Haiku sobre la misma batch
-- 6 veces (mismo antipatrón que Lex fix-T022, pero sobre leads
-- directamente porque el scoring vive en la tabla leads).
--
-- Modelo:
--   icp_score IS NULL, scoring_claimed_at IS NULL       → pendiente
--   icp_score IS NULL, scoring_claimed_at = <ts>        → reclamado por un run
--   icp_score IS NOT NULL, scoring_claimed_at IS NULL   → puntuado (fin)
--
-- El finalize del job pone icp_score + resto de campos Y limpia
-- scoring_claimed_at a NULL en la misma UPDATE.
--
-- El sweep-stale (dentro del propio job, al principio de cada trigger)
-- resetea a NULL las filas con scoring_claimed_at más antiguo que
-- NOVA_SCORE_STALE_CLAIM_MS (10 min por defecto) para recuperar leads
-- que un run muerto dejó marcados.
--
-- Columna dedicada (no jsonb en custom_fields) para poder hacer
-- UPDATE con race guard atómico y sin merge del JSON completo — evita
-- la carrera "leer custom_fields, mergear, escribir" que podría pisar
-- una escritura concurrente de otro job (p.ej. Lex escribiendo
-- website_summary en custom_fields).

set search_path = public;

alter table leads add column scoring_claimed_at timestamptz null;

comment on column leads.scoring_claimed_at is
  'Reserva atómica del scoring de Nova. NULL = no reclamado. Timestamp = '
  'un run reclamó este lead. El finalize limpia a NULL al persistir icp_score. '
  'sweep-stale del job resetea claims más antiguos que NOVA_SCORE_STALE_CLAIM_MS.';

-- Índice parcial: solo indexa filas con claim activo. La query de
-- sweep-stale ("dame claims viejos") y la de count-processing lo usan.
-- Las filas pendientes (scoring_claimed_at IS NULL) usan el índice
-- primario + el filtro sobre icp_score IS NULL.
create index leads_scoring_claim_idx
  on leads(tenant_id, scoring_claimed_at)
  where scoring_claimed_at is not null;
