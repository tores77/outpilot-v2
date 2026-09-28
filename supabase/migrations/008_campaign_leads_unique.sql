-- OUTPILOT v2 — Migration 008: campaign_leads unique (campaign_id, lead_id)
-- Fase 2 · T024 (post-mortem volt-smoke-prepare 2026-09-28)
--
-- volt-smoke-prepare falló con:
--   "there is no unique or exclusion constraint matching the
--    ON CONFLICT specification"
--
-- Causa: el step insert-campaign-leads hace
--   .upsert(rows, { onConflict: "campaign_id,lead_id",
--                    ignoreDuplicates: true })
-- que requiere un UNIQUE constraint (o unique index total) sobre
-- exactamente esas dos columnas EN ESE ORDEN. En BD sólo existe el
-- índice PARCIAL campaign_leads_active_uniq
-- (WHERE removed_at IS NULL). Postgres NO acepta índices parciales
-- para ON CONFLICT — habría que replicar la WHERE en el UPSERT,
-- cosa que PostgREST/supabase-js no expone.
--
-- Fix: añadir un UNIQUE constraint TOTAL sobre (campaign_id, lead_id).
--
-- IMPLICACIÓN semántica (validada por Pere al pedir "unique
-- (campaign_id, lead_id)" sin más matices): el schema original
-- permitía dos filas para el mismo par si la primera tenía
-- removed_at != NULL (histórico + reañadido). Con este constraint,
-- si un lead se retira, la fila existente se marca con
-- removed_at != NULL y para reañadirlo hay que UPDATE removed_at→NULL
-- en la misma fila, NO INSERT una nueva. El índice parcial
-- campaign_leads_active_uniq se conserva (útil para queries sobre
-- activos) pero queda redundante en cuanto a garantía de unicidad
-- entre activos.
--
-- Pre-check: si ya hay duplicados existentes (par (campaign_id, lead_id)
-- repetido en > 1 fila), el script LANZA excepción y aborta la
-- transacción. NO se borran filas automáticamente — el humano
-- decide qué hacer con esos duplicados antes de re-intentar.

set search_path = public;

-- Pre-check: si hay pares (campaign_id, lead_id) con > 1 fila, aborta.
do $$
declare
  dup_count int;
begin
  select count(*)
  into dup_count
  from (
    select campaign_id, lead_id
    from campaign_leads
    group by campaign_id, lead_id
    having count(*) > 1
  ) as dups;

  if dup_count > 0 then
    raise exception
      'campaign_leads tiene % pares (campaign_id, lead_id) duplicados. Investigar y resolver a mano antes de aplicar. NO se borra nada automáticamente.',
      dup_count;
  end if;
end $$;

-- Constraint UNIQUE total sobre (campaign_id, lead_id).
-- Nombre consistente con el patrón del proyecto
-- (campaigns_tenant_provider_external_uniq, etc.).
alter table campaign_leads
  add constraint campaign_leads_campaign_lead_uniq
  unique (campaign_id, lead_id);

comment on constraint campaign_leads_campaign_lead_uniq on campaign_leads is
  'T024: satisface el ON CONFLICT (campaign_id, lead_id) de '
  'volt-smoke-prepare. Reemplaza semánticamente al índice parcial '
  'campaign_leads_active_uniq — ahora un par (campaign_id, lead_id) '
  'es único absoluto, no solo entre activos.';
