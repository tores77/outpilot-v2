-- OUTPILOT v2 — Migration 004c: outreach_exclusions
-- Fase 2 · T024
--
-- Lista de emails que NUNCA deben entrar en un candidato de smoke ni
-- de campaña normal. Fuentes iniciales:
--   - Emails ya contactados en campañas Lemlist previas al arranque
--     de OUTPILOT (Pere pasa export CSV).
--   - Unsubscribes globales de Lemlist (Pere pasa export CSV).
--
-- Se importan via script (scripts/import-outreach-exclusions.mjs cuando
-- exista) o INSERT directo. La tabla es append-only en la práctica; no
-- se borra un unsubscribe. Si se quiere re-habilitar un email, se elimina
-- la fila con SQL manual explícito.
--
-- Comparación case-insensitive: enforced via CHECK constraint
-- (email = lower(email)) porque Postgres no admite expresiones en la
-- PK. El caller (import script + inserts manuales) normaliza a
-- lowercase antes de guardar.
--
-- Además de imported_at (auditoría del import), created_at estándar
-- (default now()) por consistencia con el resto de tablas.

set search_path = public;

create table outreach_exclusions (
  tenant_id   uuid not null references tenants(id),
  email       text not null check (email = lower(email)),
  reason      text not null,  -- 'unsubscribed' | 'previous_campaign:<cam_id>' | otros
  source      text,           -- string libre: nombre del script, fecha, etc.
  imported_at timestamptz not null default now(),
  created_at  timestamptz not null default now(),
  notes       text,
  primary key (tenant_id, email)
);

comment on table outreach_exclusions is
  'Emails que Volt excluye al seleccionar candidatos (T024+). Fuentes: '
  'export Lemlist de contactados históricos + unsubscribes globales. '
  'Append-only en la práctica.';

comment on column outreach_exclusions.reason is
  'Motivo de exclusión. Valores esperados: unsubscribed | '
  'previous_campaign:<cam_id>. Text libre para no bloquear futuras '
  'fuentes.';

comment on column outreach_exclusions.source is
  'Trazabilidad del import: nombre del script, fecha, quién lo pasó.';

-- Index para lookups: la query de candidatos hace lookup por
-- tenant_id + email (ya normalizado a lowercase en escritura). La PK
-- (tenant_id, email) es el índice; no hace falta uno extra.

alter table outreach_exclusions enable row level security;

create policy outreach_exclusions_tenant_isolation on outreach_exclusions
  for all
  to authenticated
  using      (tenant_id = public.current_user_tenant_id())
  with check (tenant_id = public.current_user_tenant_id());
