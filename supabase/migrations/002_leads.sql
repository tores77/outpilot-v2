-- OUTPILOT v2 — Migration 002: leads
-- Fase 0 · T008
--
-- Enum `lead_estado` recovered from the June spec (12 states, literal).
-- The last 5 states (REUNION_REALIZADA, NO_SHOW, PROPUESTA_ENVIADA,
-- NEGOCIACION, CLIENTE) live in Twenty in v2.1 (spec §5.5) and are NOT
-- driven from OUTPILOT — they stay in the enum to keep the v1->v2
-- migration (T036) painless and to preserve optionality.
--
-- The "generic-email -> REVIEW" flag from Nova's cleanup pipeline is NOT
-- an enum state: it will be a separate column or a custom_fields key
-- (decision deferred to T013).
--
-- RLS pattern: `tenant_id = public.current_user_tenant_id()` from 001a.

set search_path = public;

-- ===== Enums =====

create type lead_estado as enum (
  'NUEVO','EN_SECUENCIA','RESPONDIO','REUNION_AGENDADA',
  'REUNION_REALIZADA','NO_SHOW','PROPUESTA_ENVIADA','NEGOCIACION',
  'CLIENTE','PERDIDO','NURTURING','EN_RADAR'
);

create type lead_source as enum (
  'vibe_prospecting','csv_import','manual','studio_inbound'
);

-- ===== Shared trigger helper (also usable by future tables) =====

create function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ===== Table =====

-- Columnas tipadas: email + los campos que Vibe Prospecting entrega y que
-- el mapper de Twenty (§5.2: Person con LinkedIn; Company con domain/
-- sector/país) necesita accesibles sin escarbar en custom_fields. Todo lo
-- que no encaje aquí sigue en custom_fields jsonb.
create table leads (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id),
  email         text not null,
  first_name    text,
  last_name     text,
  company       text,
  title         text,
  phone         text,
  linkedin_url  text,
  website       text,
  sector        text,
  country       text,
  city          text,
  icp_score     int,
  source        lead_source not null,
  estado        lead_estado not null default 'NUEVO',
  custom_fields jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (tenant_id, email)
);

create index leads_tenant_estado_idx on leads(tenant_id, estado);
create index leads_tenant_score_idx  on leads(tenant_id, icp_score desc nulls last);

create trigger leads_set_updated_at
  before update on leads
  for each row execute function public.set_updated_at();

-- ===== RLS =====

alter table leads enable row level security;

create policy leads_tenant_isolation on leads
  for all
  to authenticated
  using      (tenant_id = public.current_user_tenant_id())
  with check (tenant_id = public.current_user_tenant_id());
