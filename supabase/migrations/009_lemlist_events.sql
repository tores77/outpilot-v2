-- OUTPILOT v2 — Migration 009: lemlist_events
-- Fase 2 · T025 (webhooks Lemlist, bloque A)
--
-- Tabla donde el endpoint POST /api/webhooks/lemlist/[secret] persiste
-- CRUDO cada webhook. El procesado (job echo-process-lemlist-event,
-- bloque B) lee de aquí, mapea a campaign_leads/replies/outcomes y
-- marca processed_at. Separar recepción de procesado es idempotencia
-- + resiliencia: Lemlist reintenta ante 5xx, nosotros respondemos 200
-- siempre (si el secret es válido) y la unique constraint absorbe los
-- duplicados.
--
-- Decisiones estructurales (confirmadas con Pere 2026-10-01):
--
--  D1 (idempotencia): unique sobre event_external_id SOLO. Lemlist
--      genera un _id globalmente único por evento ("act_...") — probe
--      /api/activities?version=v2&campaignId=…&limit=5 lo confirma.
--      Columna explícita (no generated), unique parcial
--      WHERE event_external_id IS NOT NULL por defensa (si alguna vez
--      Lemlist omite _id, lo persistimos sin aplicar la constraint y
--      el humano revisa).
--
--  D2 (tenant_id): nullable. El endpoint resuelve haciendo lookup
--      campaigns.provider_external_id → tenant_id. Si no match
--      (campaña ajena / huérfana), insert con tenant_id = NULL +
--      processing_error = 'tenant_lookup_failed'. El job de B ignora
--      filas con tenant_id null.
--
--  D4 (event_created_at): columna separada de received_at. received_at
--      es cuándo lo recibimos; event_created_at es cuándo Lemlist
--      registró el evento (payload.createdAt). El guardarraíl 24h del
--      bloque C mide sobre event_created_at para que un webhook
--      retrasado no distorsione las ventanas.
--
-- RLS:
--  Tenant isolation estándar vía public.current_user_tenant_id().
--  Las filas con tenant_id NULL quedan FUERA de cualquier lectura
--  authenticated — solo el service role las ve (y el job de B las
--  ignora por defensa adicional).
--
-- Taxonomía de type: no se enum-ea. Lemlist añade tipos nuevos sin
-- avisar y queremos que un tipo desconocido se persista crudo
-- (processing_error = 'unhandled_type') en vez de romper el insert.

set search_path = public;

create table lemlist_events (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid references tenants(id),             -- NULL permitido (D2)
  type                  text not null,
  event_external_id     text,                                     -- Lemlist _id (act_...). Nullable por defensa (D1).
  campaign_external_id  text,                                     -- payload.campaignId (cam_...)
  lead_external_id      text,                                     -- payload.leadId (lea_...)
  email_hash            text,                                     -- sha256 lower(leadEmail), hex (D3)
  event_created_at      timestamptz,                              -- payload.createdAt (D4)
  payload               jsonb not null,                           -- raw tal cual del webhook
  received_at           timestamptz not null default now(),
  processed_at          timestamptz,                              -- lo marca el job de B
  processing_error      text                                      -- 'tenant_lookup_failed' | 'unhandled_type' | ...
);

comment on table lemlist_events is
  'T025: raw de cada webhook de Lemlist. Separa recepción (endpoint, '
  'siempre 200) de procesado (job echo-process-lemlist-event, bloque '
  'B). Idempotencia por event_external_id.';

comment on column lemlist_events.tenant_id is
  'Resuelto en el endpoint via campaigns.provider_external_id. NULL '
  'si campaña huérfana (processing_error = tenant_lookup_failed).';

comment on column lemlist_events.event_external_id is
  'payload._id ("act_..."). Único globalmente en Lemlist según probe '
  'de /api/activities. Columna explícita para que la lookup/debugging '
  'no requiera jsonb->>.';

comment on column lemlist_events.email_hash is
  'sha256(leadEmail.toLowerCase().trim()) hex. Permite enlazar con '
  'leads sin exponer el email en claro en logs ni consola. El email '
  'real queda SOLO en payload (jsonb) y en el envío original a '
  'Lemlist; nada lo imprime en consola/logs/scripts.';

-- Idempotencia: unique parcial sobre event_external_id. Si alguna
-- vez Lemlist omite _id (defensa), ese evento se persiste sin aplicar
-- la constraint y el humano revisa manualmente.
create unique index lemlist_events_event_ext_uniq
  on lemlist_events(event_external_id)
  where event_external_id is not null;

-- Lookups típicos del job de procesado (B): "dame pendientes de este
-- tenant ordenados por recepción". Y lookups del dashboard (E):
-- "dame últimos N eventos de esta campaña por event_created_at".
create index lemlist_events_tenant_received_idx
  on lemlist_events(tenant_id, received_at desc)
  where tenant_id is not null;

create index lemlist_events_campaign_created_idx
  on lemlist_events(campaign_external_id, event_created_at desc);

create index lemlist_events_pending_idx
  on lemlist_events(processed_at)
  where processed_at is null;

-- ===== RLS =====

alter table lemlist_events enable row level security;

-- authenticated: solo filas del propio tenant. Filas con tenant_id
-- NULL quedan ocultas automáticamente (NULL != any uuid).
create policy lemlist_events_tenant_isolation on lemlist_events
  for all
  to authenticated
  using      (tenant_id = public.current_user_tenant_id())
  with check (tenant_id = public.current_user_tenant_id());

-- El service role bypasa RLS por defecto; no hace falta policy
-- explícita. Es el único que puede ver / escribir filas con tenant_id
-- NULL — pattern consistente con el resto del proyecto.
