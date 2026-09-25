-- OUTPILOT v2 — Cierra la campaña de prueba "Industrial Premium ES · Smoke 50"
-- Fase 2 · T024
--
-- Decisión (2026-09-25): no reutilizamos la campaña vigente para el
-- smoke real. La marcamos `done` en BD (Pere la archiva en Lemlist UI
-- aparte). Los 2 campaign_leads (Jose y Ana) permanecen linkeados a
-- la campaña `done` como registro histórico — NO se borran leads.
--
-- La nueva campaña "Industrial Premium ES · Smoke 50 · Oct 2026" la
-- crea Pere desde /campaigns/new con el nuevo copy (step 1 doctrina +
-- pie legal en legalFooter del template) cuando llegue en la próxima
-- iteración.
--
-- Aplicar:
--   psql "$SUPABASE_DB_URL" -f supabase/scripts/t024_mark_smoke50_done.sql

update campaigns
set status = 'done'
where name = 'Industrial Premium ES · Smoke 50'
  and status = 'draft'
returning
  id,
  name,
  status,
  provider_external_id,
  (
    select count(*)
    from campaign_leads
    where campaign_id = campaigns.id
      and removed_at is null
  ) as active_leads_frozen,
  case
    when status = 'done' then 'OK: marcada done'
    else 'FAIL: status inesperado'
  end as verdict;
