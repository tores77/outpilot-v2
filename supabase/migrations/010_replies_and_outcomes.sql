-- OUTPILOT v2 — Migration 010: replies + outcomes + alerts
-- Fase 2 · T025 (bloque B — procesado de webhooks + bloque C — guardarraíles)
--
-- Tres cambios cohesivos (los tres se usan juntos en el job
-- echo-process-lemlist-event):
--
-- 1. Enum campaign_lead_outcome + columnas en campaign_leads.
--    El job B escribe `outcome` según el tipo de evento recibido.
--    Reglas de transición (monotónicas) en src/lib/channels/
--    outcome-transition.ts — nunca degrada.
--
-- 2. Tabla `replies` para el texto de cada emailsReplied. Un reply
--    por fila. label / labeled_by / labeled_at quedan nullable
--    hasta que /inbox (bloque E) lo etiquete.
--
-- 3. Tabla `alerts` para la bandeja de Pere (bloque C+E).
--
-- 4. Columna `claimed_at` en lemlist_events para el claim atómico
--    con TTL que B necesita (mismo patrón que Nova / Lex).
--
-- Decisiones resueltas (ver docs/T025-plan.md §5):
--   D1 enum vs text        → ENUM (Pere lo pidió explícito).
--   D2 soft/hard bounce    → único `bounced`; detalle en payload raw.
--   D3 status_drift        → sigue en `events` (no en alerts).
--   D4 labeled_by          → text libre (human|lemlist|system|…).
--   D5 1 o 2 migraciones   → una sola (las tres cosas se usan juntas).

set search_path = public;

-- ============================================================
-- 1. Enum + columnas en campaign_leads
-- ============================================================

-- NOTE sobre reversibilidad del enum: añadir valores (`ALTER TYPE
-- … ADD VALUE`) es trivial y seguro. Quitarlos o renombrarlos
-- requiere migración completa (recrear enum + backfill de la
-- columna). El set {sent, bounced, replied, unsubscribed,
-- interested, not_interested} debe considerarse como "ampliable
-- pero no retráctil" sin plan de datos.
create type campaign_lead_outcome as enum (
  'sent',
  'bounced',
  'replied',
  'unsubscribed',
  'interested',
  'not_interested'
);

alter table campaign_leads
  add column if not exists outcome    campaign_lead_outcome,
  add column if not exists outcome_at timestamptz;

comment on column campaign_leads.outcome is
  'Estado derivado del campaign_lead según los eventos recibidos. '
  'Nullable: NULL = aún sin eventos. Monotónico: la lógica de '
  'transición en src/lib/channels/outcome-transition.ts solo avanza. '
  'unsubscribed es terminal (no se degrada ni promueve).';

comment on column campaign_leads.outcome_at is
  'Timestamp del evento que fijó el outcome actual (payload.createdAt '
  'del evento). Distinto de updated_at.';

-- Índice útil para /campaigns (resumen "N enviados · N rebotes · N respuestas").
create index if not exists campaign_leads_outcome_idx
  on campaign_leads(tenant_id, campaign_id, outcome)
  where outcome is not null;

-- ============================================================
-- 2. Tabla replies
-- ============================================================

create table replies (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references tenants(id),
  campaign_lead_id   uuid not null references campaign_leads(id) on delete cascade,
  lemlist_event_id   uuid references lemlist_events(id),  -- traza al raw
  received_at        timestamptz not null,                -- payload.createdAt
  body_text          text,
  body_html          text,
  label              text,                                -- interesado | no_ahora | no_interesado | fuera_de_icp | baja — nullable hasta que /inbox lo etiquete
  labeled_by         text,                                -- human | lemlist | system (text libre, D4)
  labeled_at         timestamptz,
  created_at         timestamptz not null default now()
);

comment on table replies is
  'T025: un reply = una fila. El job B escribe desde emailsReplied; '
  'el texto puede quedar vacío si Lemlist no lo envía por webhook '
  '(fallback: GET /api/activities).';

comment on column replies.lemlist_event_id is
  'Traza opcional al evento crudo. Null si el reply viene de otra '
  'fuente (Gmail directo, importado) en el futuro.';

comment on column replies.label is
  'Etiqueta humana puesta en /inbox (bloque E). Nullable: un reply '
  'nuevo entra sin etiquetar y espera a que Pere decida.';

-- Un lemlist_event_id (de replies) debería mapear a 0 o 1 reply.
-- Si llega dos veces el mismo webhook, el job absorbe el duplicado
-- vía esta unique parcial — idempotencia end-to-end incluso si
-- Lemlist reintenta.
create unique index if not exists replies_lemlist_event_uniq
  on replies(lemlist_event_id)
  where lemlist_event_id is not null;

create index if not exists replies_tenant_received_idx
  on replies(tenant_id, received_at desc);

create index if not exists replies_campaign_lead_idx
  on replies(tenant_id, campaign_lead_id, received_at desc);

alter table replies enable row level security;

create policy replies_tenant_isolation on replies
  for all
  to authenticated
  using      (tenant_id = public.current_user_tenant_id())
  with check (tenant_id = public.current_user_tenant_id());

-- ============================================================
-- 3. Tabla alerts
-- ============================================================

create table alerts (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id),
  kind            text not null,                        -- bounce_rate_exceeded | complaint_rate_exceeded | … (text libre para no cerrar la taxonomía)
  campaign_id     uuid references campaigns(id) on delete set null,
  payload         jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  acknowledged_at timestamptz                           -- Pere la vio en /campaigns y la descarta
);

comment on table alerts is
  'T025 bloque C+E: incidencias que requieren acción humana. Las '
  'alertas de guardarraíl las emite el bloque C tras cada evento. '
  'kind es text libre para no cerrar la taxonomía — reglas en código.';

create index if not exists alerts_tenant_unack_idx
  on alerts(tenant_id, created_at desc)
  where acknowledged_at is null;

alter table alerts enable row level security;

create policy alerts_tenant_isolation on alerts
  for all
  to authenticated
  using      (tenant_id = public.current_user_tenant_id())
  with check (tenant_id = public.current_user_tenant_id());

-- ============================================================
-- 4. Claim atómico en lemlist_events
-- ============================================================

-- Patrón idéntico a leads.scoring_claimed_at (migración 005). El
-- job B hace sweep al inicio del run (resetea claims muertos) y
-- luego UPDATE … .is("claimed_at", null) para race-safe atomic
-- reserve.
alter table lemlist_events
  add column if not exists claimed_at timestamptz;

comment on column lemlist_events.claimed_at is
  'T025 bloque B: timestamp del claim del job echo-process-lemlist-event. '
  'NULL = reclamable. Sweep al inicio del run resetea los más antiguos '
  'que staleMs (10 min). El finalize del step pone processed_at Y '
  'limpia claimed_at (en la misma UPDATE con race guard).';

-- Índice para el claim: pendientes = processed_at IS NULL +
-- processing_error IS NULL + claimed_at IS NULL + tenant_id IS NOT NULL.
-- La columna más selectiva es tenant_id (el cron itera por tenant),
-- luego el filtro de processed_at. Parcial para no indexar las
-- filas ya procesadas (99 % tras unos días de uso).
create index if not exists lemlist_events_claimable_idx
  on lemlist_events(tenant_id, received_at)
  where processed_at is null
    and processing_error is null
    and tenant_id is not null;
