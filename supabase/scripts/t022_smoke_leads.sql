-- OUTPILOT v2 — Inserta campaign_leads en "Industrial Premium ES · Smoke 50"
-- para el test end-to-end de T022 (Lex).
--
-- Fix del 2026-09-23: la versión anterior filtraba por estado='EN_RADAR'
-- y Ana García está en NUEVO, por lo que no se insertó y el SELECT final
-- devolvía 0. Lex trabaja sobre campaign_leads directamente y no exige
-- estado del lead (esa gate es de Volt/T023, no de Lex). Se elimina el
-- filtro; se añade l.estado al SELECT final para visibilidad.
--
-- Objetivos:
--   - Jose Pérez (con website)  → Lex hará fetch + intento de personalizar.
--   - Ana García (sin website)  → Lex degrada a "generic" con
--     reason_if_generic (por reglas del prompt / gate mecánico).
--
-- Aplicar:
--   psql "$SUPABASE_DB_URL" -f supabase/scripts/t022_smoke_leads.sql
--
-- Idempotente: ON CONFLICT DO NOTHING contra el unique parcial
-- (campaign_id, lead_id) WHERE removed_at IS NULL.

with camp as (
  select id, tenant_id
  from campaigns
  where name = 'Industrial Premium ES · Smoke 50'
    and status = 'draft'
  order by created_at desc
  limit 1
),
targets as (
  -- Jose Pérez y Ana García del mismo tenant.
  -- Sin filtro de estado: Lex no lo exige (Volt sí, en T023).
  -- Match por first_name + inicial de last_name para tolerar variantes
  -- (Pérez/Perez, García/Garcia).
  select id, first_name, last_name, website, estado
  from leads
  where tenant_id = (select tenant_id from camp)
    and (
      (first_name ilike 'jose%' and last_name ilike 'p%')
      or (first_name ilike 'ana%' and last_name ilike 'g%')
    )
),
inserted as (
  insert into campaign_leads (tenant_id, campaign_id, lead_id, added_at)
  select c.tenant_id, c.id, t.id, now()
  from camp c cross join targets t
  on conflict do nothing
  returning id
)
-- Reporte final: SIEMPRE muestra lo que hay en la campaña, con estado
-- del lead para diagnosticar si un lead esperado no aparece.
select
  cl.id as campaign_lead_id,
  l.first_name || ' ' || l.last_name as lead_name,
  l.estado,
  coalesce(l.website, '(sin website)') as website,
  case
    when cl.personalization is null then 'pending'
    when cl.personalization->>'state' = 'processing' then 'processing (' || (cl.personalization->>'started_at') || ')'
    else 'done (' || (cl.personalization->>'personalization') || ')'
  end as personalization_state,
  cl.added_at
from campaign_leads cl
join leads l on l.id = cl.lead_id
where cl.campaign_id = (select id from camp)
  and cl.removed_at is null
order by l.first_name;
