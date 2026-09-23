-- OUTPILOT v2 — Isolation test para 004_campaigns
-- Fase 2 · T020
--
-- Verifica RLS en campaigns y campaign_leads con dos JWTs simulados.
-- Todo va en un BEGIN/ROLLBACK, así que la BD queda intacta.
--
-- Ejecución:
--   psql "$SUPABASE_DB_URL" -f supabase/tests/004_campaigns_isolation.sql
--
-- Salida esperada (resumen):
--   [A] campaigns visibles: 1     campaign_leads visibles: 1
--   [A] insert cross-tenant bloqueado por RLS: OK
--   [B] campaigns visibles: 1     campaign_leads visibles: 1
--   [B] tenant_id de la campaña visible = tenant B
--   Test superado.
--
-- Si alguna línea imprime FAIL, la RLS está rota.

begin;

-- ============================================================
-- SETUP (como owner de la sesión, RLS off)
-- ============================================================

insert into tenants (id, name, slug) values
  ('a0000000-0000-0000-0000-000000000004', 'T020 Isolation Tenant A', 't020-a'),
  ('b0000000-0000-0000-0000-000000000004', 'T020 Isolation Tenant B', 't020-b');

insert into allowed_users (email, tenant_id) values
  ('t020-user-a@isolation.local', 'a0000000-0000-0000-0000-000000000004'),
  ('t020-user-b@isolation.local', 'b0000000-0000-0000-0000-000000000004');

-- Leads reales (uno por tenant). El unique(tenant_id, email) permite
-- reusar 'lead@example.com' en ambos porque el tenant difiere.
insert into leads (id, tenant_id, email, source) values
  ('a1111111-0000-0000-0000-000000000004', 'a0000000-0000-0000-0000-000000000004', 't020-lead@example.com', 'manual'),
  ('b1111111-0000-0000-0000-000000000004', 'b0000000-0000-0000-0000-000000000004', 't020-lead@example.com', 'manual');

-- Campañas (una por tenant).
insert into campaigns (id, tenant_id, name, channel, provider) values
  ('a2222222-0000-0000-0000-000000000004', 'a0000000-0000-0000-0000-000000000004', 'T020 Campaign A', 'email', 'lemlist'),
  ('b2222222-0000-0000-0000-000000000004', 'b0000000-0000-0000-0000-000000000004', 'T020 Campaign B', 'email', 'lemlist');

-- campaign_leads (uno por tenant), con provider_lead_id para verificar
-- que el índice parcial no rompe la inserción.
insert into campaign_leads (tenant_id, campaign_id, lead_id, provider_lead_id, provider_contact_id) values
  ('a0000000-0000-0000-0000-000000000004', 'a2222222-0000-0000-0000-000000000004', 'a1111111-0000-0000-0000-000000000004', 'lea_test_a_004', 'ctc_test_a_004'),
  ('b0000000-0000-0000-0000-000000000004', 'b2222222-0000-0000-0000-000000000004', 'b1111111-0000-0000-0000-000000000004', 'lea_test_b_004', 'ctc_test_b_004');

-- ============================================================
-- TEST bajo JWT de user-a (tenant A)
-- ============================================================

set local role authenticated;
select set_config(
  'request.jwt.claims',
  json_build_object('email', 't020-user-a@isolation.local')::text,
  true
);

-- Debe ver EXACTAMENTE 1 campaña y 1 campaign_lead (los del tenant A).
select
  '[A] campaigns visibles' as check,
  count(*) as visible,
  case when count(*) = 1 then 'OK' else 'FAIL' end as verdict
from campaigns;

select
  '[A] campaign_leads visibles' as check,
  count(*) as visible,
  case when count(*) = 1 then 'OK' else 'FAIL' end as verdict
from campaign_leads;

select
  '[A] tenant_id de la campaña visible' as check,
  case when tenant_id = 'a0000000-0000-0000-0000-000000000004' then 'OK (A)' else 'FAIL' end as verdict
from campaigns limit 1;

-- Intento de insert cross-tenant: RLS with check DEBE bloquearlo.
savepoint before_cross_insert;
do $$
begin
  insert into campaigns (tenant_id, name, channel, provider)
    values ('b0000000-0000-0000-0000-000000000004', 'A intenta insertar en B', 'email', 'lemlist');
  raise notice '[A] insert cross-tenant bloqueado por RLS: FAIL (no lanzó)';
exception
  when insufficient_privilege or check_violation then
    raise notice '[A] insert cross-tenant bloqueado por RLS: OK (%)', sqlstate;
  when others then
    raise notice '[A] insert cross-tenant bloqueado por RLS: OK (error esperado: %)', sqlerrm;
end$$;
rollback to savepoint before_cross_insert;

-- ============================================================
-- TEST bajo JWT de user-b (tenant B) — mismo rol, cambio de claim
-- ============================================================

select set_config(
  'request.jwt.claims',
  json_build_object('email', 't020-user-b@isolation.local')::text,
  true
);

select
  '[B] campaigns visibles' as check,
  count(*) as visible,
  case when count(*) = 1 then 'OK' else 'FAIL' end as verdict
from campaigns;

select
  '[B] campaign_leads visibles' as check,
  count(*) as visible,
  case when count(*) = 1 then 'OK' else 'FAIL' end as verdict
from campaign_leads;

select
  '[B] tenant_id de la campaña visible' as check,
  case when tenant_id = 'b0000000-0000-0000-0000-000000000004' then 'OK (B)' else 'FAIL' end as verdict
from campaigns limit 1;

-- ============================================================
-- Cleanup (rollback: la BD vuelve al estado previo)
-- ============================================================

reset role;
rollback;

-- Mensaje final (fuera del rollback ya no hay contexto de test)
select 'Test 004 aislamiento: revisa que ninguna fila diga FAIL en las columnas verdict de arriba.' as summary;
