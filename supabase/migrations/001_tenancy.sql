-- OUTPILOT v2 — Migration 001: tenancy
-- Fase 0 · T003
--
-- Creates the two tenancy tables (tenants + allowed_users), enables RLS
-- with the canonical policy pattern from spec §3, and seeds the single
-- `umania` tenant plus the sole operator (Pere).
--
-- The allowlist starts with one email on purpose (R2): Eli and María operate
-- Twenty (spec §5.1), not OUTPILOT. To grant OUTPILOT access to another
-- teammate, INSERT a new row in allowed_users; no schema change required.

set search_path = public;

-- ===== Tables =====

create table tenants (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  slug       text unique not null,
  settings   jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table allowed_users (
  email        text primary key,
  tenant_id    uuid not null references tenants(id),
  display_name text,
  role         text not null default 'member'  -- owner | member
);

create index allowed_users_tenant_id_idx on allowed_users(tenant_id);

-- ===== RLS =====
--
-- Canonical pattern (spec §3): a business row is visible iff the caller's
-- JWT email appears in allowed_users for the same tenant_id. `tenants` has
-- no tenant_id column, so we compare against its own `id`.
--
-- The `to authenticated` clause restricts these policies to logged-in
-- Supabase Auth callers; the service_role bypasses RLS entirely and is
-- reserved for /jobs/** (see T009 lint rule).

alter table tenants       enable row level security;
alter table allowed_users enable row level security;

create policy tenants_allowlisted on tenants
  for all
  to authenticated
  using      (id in (select tenant_id from allowed_users where email = auth.jwt()->>'email'))
  with check (id in (select tenant_id from allowed_users where email = auth.jwt()->>'email'));

create policy allowed_users_same_tenant on allowed_users
  for all
  to authenticated
  using      (tenant_id in (select tenant_id from allowed_users where email = auth.jwt()->>'email'))
  with check (tenant_id in (select tenant_id from allowed_users where email = auth.jwt()->>'email'));

-- ===== Seed =====
--
-- Single tenant + single operator. Idempotent so re-runs (e.g. during a
-- fresh reset) do not explode.

insert into tenants (name, slug)
  values ('Umania Labs', 'umania')
  on conflict (slug) do nothing;

insert into allowed_users (email, tenant_id, display_name, role)
  select 'peremiquel77@gmail.com', id, 'Pere', 'owner'
  from tenants
  where slug = 'umania'
  on conflict (email) do nothing;
