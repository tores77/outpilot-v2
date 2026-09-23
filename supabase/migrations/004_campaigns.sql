-- OUTPILOT v2 — Migration 004: campaigns + campaign_leads
-- Fase 2 · T020
--
-- Motivo:
--   Spec §3: campaigns con status draft|smoke_test|active|paused|done,
--   sequence jsonb, campaign_leads. Se añaden columnas para trazar
--   ida-vuelta con Lemlist descubiertas en T018:
--     - campaigns.provider_external_id = cam_... (upsertCampaign result)
--     - campaign_leads.provider_lead_id = lea_... (addLead result)
--     - campaign_leads.provider_contact_id = ctc_... (addLead result)
--   El sequence jsonb queda opaco hasta T021 (builder); no forzamos
--   shape ahora.
--
--   El FK diferido `touchpoints.campaign_id → campaigns.id` (deuda de
--   T011) se cierra al final de esta migración con ON DELETE SET NULL
--   para preservar historial de eventos si una campaña se borra.
--
-- Convenciones:
--   - RLS pattern único: tenant_id = public.current_user_tenant_id()
--     (helper 001a).
--   - Enums de canal/proveedor se reutilizan de 003 (channel_kind,
--     channel_provider).
--   - Índices con prefijo tenant para que las queries dashboard sean
--     satisfacibles por el índice compuesto.
--   - Unique parcial en (campaign_id, lead_id) WHERE removed_at IS
--     NULL para tolerar re-add tras remove sin migrar histórico.
--
-- Índice hot-path (T025):
--   campaign_leads(tenant_id, provider_lead_id) WHERE provider_lead_id
--   IS NOT NULL. Cada webhook de Lemlist trae el lea_...; T025 lo
--   resolverá a nuestro campaign_lead en cada evento.

set search_path = public;

-- ===== Enum =====

create type campaign_status as enum (
  'draft',
  'smoke_test',
  'active',
  'paused',
  'done'
);

-- ===== campaigns =====

create table campaigns (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references tenants(id),
  name                  text not null,
  status                campaign_status not null default 'draft',
  channel               channel_kind not null,
  provider              channel_provider not null,
  provider_external_id  text,                                -- cam_... de Lemlist; null hasta upsertCampaign
  icp_slug              text,                                -- referencia libre a config/icps.ts (T021)
  sequence              jsonb not null default '{}'::jsonb,  -- shape opaco; T021 (builder) lo fija
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

comment on column campaigns.provider_external_id is
  'ID de la campaña en el provider (Lemlist: cam_...). Null hasta que '
  'upsertCampaign sincroniza por primera vez. Unique parcial impide '
  'doble-sync de la misma campaña externa.';

comment on column campaigns.icp_slug is
  'Slug del ICP (ej. industrial_premium_es). Referencia libre a '
  'config/icps.ts en T021. Sin FK: no hay tabla de ICPs, las '
  'plantillas viven en código.';

comment on column campaigns.sequence is
  'Representación interna de la secuencia (steps, delays, refs a '
  'templates). Shape lo fija T021 (builder). El sequenceId de Lemlist '
  'vive en el provider, no aquí.';

create index campaigns_tenant_status_idx
  on campaigns(tenant_id, status);

-- Parcial: solo cuando ya hay sync con el provider. Impide doble-sync
-- de la misma campaña externa; tolera muchas campañas sin sincronizar.
create unique index campaigns_tenant_provider_external_uniq
  on campaigns(tenant_id, provider, provider_external_id)
  where provider_external_id is not null;

create trigger campaigns_set_updated_at
  before update on campaigns
  for each row execute function public.set_updated_at();

alter table campaigns enable row level security;

create policy campaigns_tenant_isolation on campaigns
  for all
  to authenticated
  using      (tenant_id = public.current_user_tenant_id())
  with check (tenant_id = public.current_user_tenant_id());

-- ===== campaign_leads =====

create table campaign_leads (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references tenants(id),
  campaign_id           uuid not null references campaigns(id) on delete cascade,
  lead_id               uuid not null references leads(id) on delete cascade,
  provider_lead_id      text,                                -- lea_... del addLead (T018)
  provider_contact_id   text,                                -- ctc_... del addLead (T018)
  added_at              timestamptz not null default now(),
  removed_at            timestamptz
);

comment on column campaign_leads.provider_lead_id is
  'ID del lead en el provider (Lemlist: lea_...). Rellenado por Volt '
  'tras addLead. Camino caliente de T025: los webhooks traen este ID.';

comment on column campaign_leads.provider_contact_id is
  'ID del contacto cross-campaña del provider (Lemlist: ctc_...). '
  'Preservado por si T025 lo necesita para cruzar eventos por contacto.';

comment on column campaign_leads.removed_at is
  'Timestamp cuando el lead sale de la campaña (unsubscribe, retirada '
  'manual). NULL = activo en la campaña. Unique parcial permite '
  're-add tras removed.';

-- Query dashboard: leads de una campaña.
create index campaign_leads_tenant_campaign_idx
  on campaign_leads(tenant_id, campaign_id);

-- Query inversa: en qué campañas está este lead.
create index campaign_leads_tenant_lead_idx
  on campaign_leads(tenant_id, lead_id);

-- Camino caliente T025: webhook trae lea_..., resolvemos a nuestro
-- campaign_lead. Parcial para no indexar filas sin sync (los primeros
-- momentos entre añadir a nuestra BD y llegar la respuesta de Lemlist).
create index campaign_leads_tenant_provider_lead_idx
  on campaign_leads(tenant_id, provider_lead_id)
  where provider_lead_id is not null;

-- Un lead ACTIVO solo puede estar una vez por campaña. Si removed,
-- puede re-añadirse (Lemlist admite el ciclo).
create unique index campaign_leads_active_uniq
  on campaign_leads(campaign_id, lead_id)
  where removed_at is null;

alter table campaign_leads enable row level security;

create policy campaign_leads_tenant_isolation on campaign_leads
  for all
  to authenticated
  using      (tenant_id = public.current_user_tenant_id())
  with check (tenant_id = public.current_user_tenant_id());

-- ===== FK diferido de 003: touchpoints.campaign_id → campaigns.id =====

-- Comprobación defensiva: si hay touchpoints con campaign_id no nulo
-- que no referencia ningún campaign (huérfanos), abortamos la migración
-- antes de crear el FK. En producción no debería haber ninguno porque
-- Volt aún no ha escrito touchpoints, pero la defensa es barata.
do $$
declare
  orphan_count int;
begin
  select count(*) into orphan_count
  from touchpoints t
  where t.campaign_id is not null
    and not exists (select 1 from campaigns c where c.id = t.campaign_id);
  if orphan_count > 0 then
    raise exception
      'touchpoints tiene % filas con campaign_id huérfano. Investigar y limpiar antes de aplicar 004.',
      orphan_count;
  end if;
end$$;

alter table touchpoints
  add constraint touchpoints_campaign_id_fk
  foreign key (campaign_id) references campaigns(id)
  on delete set null;

comment on column touchpoints.campaign_id is
  'FK a campaigns(id) añadida en migración 004 (T020) con ON DELETE '
  'SET NULL. Nullable a propósito: admite eventos previos a la '
  'asignación de campaña (p.ej. inbound studio).';
