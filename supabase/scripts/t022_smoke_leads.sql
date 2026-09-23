-- OUTPILOT v2 — Inserta dos campaign_leads en "Industrial Premium ES · Smoke 50"
-- para el test end-to-end de T022 (Lex).
--
-- Objetivos:
--   - Jose Pérez (EN_RADAR, con website) → Lex hará fetch + intentará
--     personalizar. Si el website devuelve algo útil, personalization
--     debería salir "personalized".
--   - Ana García (EN_RADAR, sin website) → Lex no puede hablar de la web,
--     y sin otras señales fuertes debería degradar a "generic" con
--     reason "no signal" (o similar decidido por Lex).
--
-- Aplicar:
--   psql "$SUPABASE_DB_URL" -f supabase/scripts/t022_smoke_leads.sql
--
-- Idempotente: si ya se aplicó, el ON CONFLICT DO NOTHING no duplica
-- (unique parcial on (campaign_id, lead_id) where removed_at is null).

with camp as (
  select id, tenant_id
  from campaigns
  where name = 'Industrial Premium ES · Smoke 50'
    and status = 'draft'
  order by created_at desc
  limit 1
),
targets as (
  -- Jose Pérez y Ana García del pool EN_RADAR del mismo tenant.
  -- Match por first_name + inicial de last_name para tolerar variantes
  -- (Pérez / Perez, García / Garcia).
  select id, first_name, last_name, website
  from leads
  where tenant_id = (select tenant_id from camp)
    and estado = 'EN_RADAR'
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
  returning id, lead_id, campaign_id
)
-- Reporte final: qué leads están asignados a la campaña, con o sin website.
select
  cl.id as campaign_lead_id,
  l.first_name || ' ' || l.last_name as lead_name,
  coalesce(l.website, '(sin website)') as website,
  case when cl.personalization is null then 'pending' else 'done' end as personalization_state,
  cl.added_at
from campaign_leads cl
join leads l on l.id = cl.lead_id
where cl.campaign_id = (select id from camp)
  and cl.removed_at is null
order by l.first_name;
