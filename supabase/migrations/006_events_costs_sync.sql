-- OUTPILOT v2 — Migration 006: events, api_costs, twenty_sync
-- Fase 0 · T008
--
-- Migrations 003/004/005 (channels/touchpoints, campaigns, sage) belong to
-- later phases; those numeric slots are intentionally left free to preserve
-- the numbering from the spec. This migration only creates 006.
--
-- events    — cross-agent event log; used by the Daily Brief (T035).
-- api_costs — Anthropic cost tracking (T007 writes here from the wrapper).
--             cost_usd is precomputed at write time from config/models.ts
--             prices; latency_ms is captured too. cache_hit deferred until
--             we adopt prompt caching.
-- twenty_sync — schema copied verbatim from spec §3.
--
-- RLS pattern: `tenant_id = public.current_user_tenant_id()` from 001a.

set search_path = public;

-- ===== events =====

create table events (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id),
  kind        text not null,          -- e.g. 'lead.state_changed', 'echo.classified'
  actor       text,                   -- 'nova' | 'lex' | 'volt' | 'echo' | 'sage' | human email | null
  entity_type text,                   -- 'lead' | 'campaign' | 'touchpoint' | null
  entity_id   uuid,                   -- opaque reference, no FK on purpose
  payload     jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create index events_tenant_created_idx on events(tenant_id, created_at desc);

alter table events enable row level security;

create policy events_tenant_isolation on events
  for all
  to authenticated
  using      (tenant_id = public.current_user_tenant_id())
  with check (tenant_id = public.current_user_tenant_id());

-- ===== api_costs =====

create table api_costs (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants(id),
  task       text not null,           -- e.g. 'nova.score', 'lex.personalize', 'echo.classify'
  model      text not null,           -- 'claude-haiku-4-5-20251001' | 'claude-sonnet-4-6'
  tokens_in  int not null,
  tokens_out int not null,
  cost_usd   numeric(10, 6),          -- precomputed by lib/ai/claude.ts using config/models.ts prices
  latency_ms int,
  created_at timestamptz not null default now()
);

create index api_costs_tenant_created_idx on api_costs(tenant_id, created_at desc);

alter table api_costs enable row level security;

create policy api_costs_tenant_isolation on api_costs
  for all
  to authenticated
  using      (tenant_id = public.current_user_tenant_id())
  with check (tenant_id = public.current_user_tenant_id());

-- ===== twenty_sync (schema per spec §3, verbatim) =====

create table twenty_sync (
  lead_id               uuid primary key references leads(id) on delete cascade,
  tenant_id             uuid not null references tenants(id),
  twenty_person_id      text,
  twenty_company_id     text,
  twenty_opportunity_id text,
  last_synced_at        timestamptz,
  sync_status           text not null default 'pending', -- pending | synced | failed
  error                 text
);

create index twenty_sync_tenant_status_idx on twenty_sync(tenant_id, sync_status);

alter table twenty_sync enable row level security;

create policy twenty_sync_tenant_isolation on twenty_sync
  for all
  to authenticated
  using      (tenant_id = public.current_user_tenant_id())
  with check (tenant_id = public.current_user_tenant_id());
