-- OUTPILOT v2 — Migration 003: channel_accounts + touchpoints
-- Fase 1 · T011
--
-- Two enums for the sending side (channel vs provider) so that when
-- LinkedIn/Unipile eventually land, they add a new value to each enum
-- instead of forcing a rename or a compound-string refactor. This is
-- spec §5 ("Canal ≠ Proveedor") turned into schema.
--
-- touchpoint_kind covers the 8 email events we anticipate from Lemlist.
-- In T018 verify against the official Lemlist webhook docs; if Lemlist
-- emits any other type (warmup / spam-report / etc.) add it with ALTER
-- TYPE with real evidence, not by guessing here. The raw event payload
-- lives in touchpoints.payload jsonb, so we never lose anything.
--
-- RLS pattern: tenant_id = public.current_user_tenant_id() (helper from 001a).

set search_path = public;

-- ===== Enums =====

create type channel_kind     as enum ('email');
create type channel_provider as enum ('lemlist');

create type channel_account_status as enum ('active', 'paused', 'warming', 'disabled');

create type touchpoint_direction as enum ('outbound', 'inbound');

create type touchpoint_kind as enum (
  'email_sent',
  'email_delivered',
  'email_opened',
  'email_clicked',
  'email_replied',
  'email_bounced',
  'email_unsubscribed',
  'email_failed'
);

-- ===== channel_accounts =====

create table channel_accounts (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id),
  channel        channel_kind not null,
  provider       channel_provider not null,
  external_id    text not null,                              -- mailbox id in the provider
  email_address  text not null,                              -- visible address of the mailbox
  display_name   text,                                       -- e.g. "Pere Miquel <pere@umania.co>"
  status         channel_account_status not null default 'warming',
  health_score   int,                                        -- 0..100, updated by Sage (spec §4)
  settings       jsonb not null default '{}'::jsonb,         -- daily_send_limit, warmup, headers, rate limits
  last_health_at timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (tenant_id, provider, external_id)
);

create index channel_accounts_tenant_provider_idx on channel_accounts(tenant_id, provider);
create index channel_accounts_tenant_status_idx   on channel_accounts(tenant_id, status);

create trigger channel_accounts_set_updated_at
  before update on channel_accounts
  for each row execute function public.set_updated_at();

alter table channel_accounts enable row level security;

create policy channel_accounts_tenant_isolation on channel_accounts
  for all
  to authenticated
  using      (tenant_id = public.current_user_tenant_id())
  with check (tenant_id = public.current_user_tenant_id());

-- ===== touchpoints =====

create table touchpoints (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references tenants(id),
  lead_id             uuid not null references leads(id) on delete cascade,
  channel_account_id  uuid not null references channel_accounts(id),
  campaign_id         uuid,                                  -- FK a campaigns añadida en migración 004
  direction           touchpoint_direction not null,
  kind                touchpoint_kind not null,
  provider_event_id   text,                                  -- provider's event id, used for webhook idempotency
  payload             jsonb not null default '{}'::jsonb,    -- raw event body from the provider
  occurred_at         timestamptz not null,                  -- event timestamp reported by the provider
  created_at          timestamptz not null default now()
);

comment on column touchpoints.campaign_id is
  'FK a campaigns añadida en migración 004 (T020). Nullable a propósito: '
  'admite eventos previos a la asignación de campaña (p.ej. inbound studio).';

create index touchpoints_tenant_lead_idx    on touchpoints(tenant_id, lead_id, occurred_at desc);
create index touchpoints_tenant_channel_idx on touchpoints(tenant_id, channel_account_id, occurred_at desc);
create index touchpoints_tenant_kind_idx    on touchpoints(tenant_id, kind, occurred_at desc);

-- Webhooks del provider se reintentan; sin idempotencia insertaríamos
-- duplicados. Este unique parcial garantiza que el mismo provider_event_id
-- no entre dos veces por (tenant, mailbox).
create unique index touchpoints_provider_event_uniq
  on touchpoints(tenant_id, channel_account_id, provider_event_id)
  where provider_event_id is not null;

alter table touchpoints enable row level security;

create policy touchpoints_tenant_isolation on touchpoints
  for all
  to authenticated
  using      (tenant_id = public.current_user_tenant_id())
  with check (tenant_id = public.current_user_tenant_id());
