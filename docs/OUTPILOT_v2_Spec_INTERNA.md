# OUTPILOT v2 — Spec v2.1-INTERNA

**Documento:** UL-2026-OUTPILOT-V2-SPEC-R2
**Fecha:** 22 de julio de 2026 (revisa y sustituye a UL-2026-OUTPILOT-V2-SPEC del 6 de junio)
**Estado:** CERRADO — ejecución inmediata
**Alcance:** Herramienta INTERNA de Umania Labs. Un solo objetivo: generar flujo de leads cualificados de webs premium (studio.umanialabs.com) y entregarlos a María en el CRM Twenty para cierre R1→R2.
**Fuera de alcance explícito:** SaaS multi-tenant público, billing/Stripe, planes, onboarding self-service, landing pública de producto, LinkedIn. Todo eso queda en backlog "pivote futuro" y NO se construye ahora.

---

## 0. Constitución (revisada)

1. **Herramienta interna primero.** Cada feature se justifica por una pregunta: ¿acerca un lead cualificado a María esta semana? Si no, fuera.
2. **Optionalidad barata, no arquitectura especulativa.** `tenant_id` se mantiene en el schema (coste ~cero) para no cerrar el pivote SaaS futuro, pero NO se construye nada de la maquinaria multi-tenant: sin quotas, sin planes, sin signup público. Un solo tenant seed: `umania`.
3. **OUTPILOT no es el CRM. Twenty es el CRM.** OUTPILOT hace radar → personalización → envío → clasificación de respuestas. En cuanto un lead responde, vive en Twenty y María trabaja allí. No se construye Kanban propio (lección v1: Atlas duplicaba lo que un CRM hace mejor).
4. **Sage nunca borra datos de forma autónoma.** Hard-lock en código, igual que en la spec original.
5. **Canal ≠ Proveedor.** La interfaz `ChannelProvider` se mantiene aunque v2.1 solo implemente email/Lemlist. Añadir LinkedIn después será añadir un provider, no refactorizar.
6. **snake_case en Supabase, tipos generados, service_role solo en jobs.** Sin cambios.
7. **Validar antes de automatizar.** Echo y Sage arrancan en SUGERIR. ACTUAR solo tras 2 semanas de aciertos verificados.
8. **Costes medibles.** Cada llamada IA registrada en `api_costs`. Con un solo tenant sigue importando: es el dato que fijará precios si algún día se vende.
9. **Simplicidad agresiva.** v2.1 recorta ~40% de las tareas de la spec de junio. El recorte ES la feature.

---

## 1. Visión y flujo de negocio

```
   OUTBOUND                                      INBOUND (SEO)
   Vibe Prospecting / CSV                        studio.umanialabs.com
        │                                        (formulario contacto)
        ▼                                              │
   ┌─────────┐   ┌─────────┐   ┌─────────┐             │
   │  NOVA   │──▶│   LEX   │──▶│  VOLT   │             │
   │ radar + │   │personal.│   │ envío   │             │
   │ scoring │   │ (haiku) │   │ Lemlist │             │
   └─────────┘   └─────────┘   └────┬────┘             │
                                    │ reply            │ webhook
                                    ▼                  ▼
                              ┌──────────┐      ┌────────────┐
                              │   ECHO   │      │ /api/inbound│
                              │clasifica │      │   studio    │
                              │ + draft  │      └──────┬──────┘
                              └────┬─────┘             │
                                   │ RESPONDIO+        │ inmediato
                                   ▼                   ▼
                              ┌─────────────────────────────┐
                              │      TWENTY CRM             │
                              │  Company + Person + Deal    │
                              │  pipeline "Webs Premium"    │
                              │  ← MARÍA trabaja aquí →     │
                              │      R1 → R2 → cierre       │
                              └─────────────────────────────┘
                                   │
                              ┌────┴─────┐
                              │   SAGE   │  Daily Brief 8:00 (Pere+María)
                              │ watchdog │  salud mailboxes + pendientes
                              └──────────┘
```

Los dos orígenes de leads (outbound de OUTPILOT + inbound del SEO de studio) convergen en Twenty. María tiene UNA sola bandeja de trabajo.

---

## 2. Stack (decisiones cerradas, cambios vs junio marcados)

| Decisión | Elección | Cambio vs spec junio |
|---|---|---|
| Framework | Next.js 16 App Router + API Routes | **R2: Next 16 (proyecto greenfield; los breaking changes 15→16 no aplican al no migrar nada)** |
| Hosting app | Vercel | igual |
| BD | Supabase EU proyecto nuevo `outpilot-v2` | igual |
| Acceso datos | supabase-js v2 + tipos generados | igual |
| Jobs | Inngest | igual |
| IA | Anthropic SDK, routing por tarea (haiku volumen / sonnet calidad) en `config/models.ts` | igual |
| Email | Lemlist API (mailboxes ya calentados) | igual |
| **CRM** | **Twenty self-hosted en Railway (Docker: server + Postgres + Redis propios de Twenty)** | **NUEVO — sustituye a Atlas** |
| **Auth** | **Supabase Auth Google OAuth + allowlist de emails (Pere, Eli, María). Sin signup público.** | **Simplificado** |
| LinkedIn | — | **FUERA de v2.1** (interfaz preservada) |
| Stripe / planes / quotas | — | **FUERA de v2.1** |

Nota Twenty: se despliega con su propio docker-compose en Railway (imagen `twentycrm/twenty`). Su Postgres y su Redis son internos al deployment de Twenty y no tocan nuestro código — no viola la lección anti-Redis de v1 porque no lo operamos nosotros a nivel de código, solo como contenedor. Alternativa si Railway da fricción: Twenty Cloud de pago (decisión T031, gate de 1 día máximo).

---

## 3. Modelo de datos (migraciones 001-006)

Cambios vs junio: desaparecen `tenant_quotas`, y `agent_actions`/`sage_policies` se simplifican. Se añade `twenty_sync`.

```sql
-- ===== 001: tenancy mínima =====
create table tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text unique not null,
  settings jsonb not null default '{}',
  created_at timestamptz not null default now()
);
-- seed único: ('Umania Labs', 'umania')

create table allowed_users (
  email text primary key,                     -- allowlist login
  tenant_id uuid not null references tenants(id),
  display_name text,
  role text not null default 'member'         -- owner | member
);

-- ===== 002: leads (idéntica a spec junio) =====
-- enum lead_estado con los 12 estados, tabla leads con tenant_id,
-- icp_score, source ('vibe_prospecting'|'csv_import'|'manual'|'studio_inbound'),
-- custom_fields jsonb, unique(tenant_id,email), índices por estado y score.

-- ===== 003: canales y touchpoints (idéntica a junio) =====
-- channel_accounts (channel enum solo 'email' activo), touchpoints.

-- ===== 004: campañas (idéntica a junio) =====
-- campaigns con status draft|smoke_test|active|paused|done, sequence jsonb,
-- campaign_leads.

-- ===== 005: sage + acciones (simplificada) =====
create type sage_mode as enum ('observe','suggest','act');

create table agent_actions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  agent text not null,
  action_type text not null,
  level sage_mode not null,
  status text not null default 'suggested',   -- suggested|approved|rejected|executed|failed
  payload jsonb not null default '{}',
  reasoning text,
  decided_by text,                            -- email del humano, null si autónomo
  executed_at timestamptz,
  created_at timestamptz not null default now()
);
-- Las policies de Sage viven en config/sage-defaults.ts (archivo, no tabla).
-- Con un solo tenant no hay necesidad de policies por-tenant en BD.
-- Hard-locks (delete_*, *_billing) en la allowlist de executeSageAction().

-- ===== 006: eventos, costes, sync =====
-- events y api_costs idénticas a junio.

create table twenty_sync (
  lead_id uuid primary key references leads(id) on delete cascade,
  tenant_id uuid not null references tenants(id),
  twenty_person_id text,
  twenty_company_id text,
  twenty_opportunity_id text,
  last_synced_at timestamptz,
  sync_status text not null default 'pending', -- pending|synced|failed
  error text
);
```

RLS: patrón único `tenant_id in (select tenant_id from allowed_users where email = auth.jwt()->>'email')` en todas las tablas de negocio. Aunque hay un solo tenant, RLS + allowlist es la puerta de seguridad del tool completo. Jobs con service_role filtran `tenant_id` explícito (lint rule igual que en junio).

---

## 4. Los agentes en v2.1

**Nova (RADAR)** — sin cambios de fondo: Vibe Prospecting API + import CSV con el pipeline de limpieza (dedupe por empresa con jerarquía de cargos, emails genéricos → REVIEW, normalización de tildes — el SOP Gemini de junio hecho código) + scoring ICP con haiku (batch 20) + pool `EN_RADAR`.

**Lex (PERSONALIZER)** — sin cambios: personalización pre-envío con haiku, fetch+cache de resumen de website del lead, regla anti-fabricación (si no hay datos → template genérico marcado, jamás inventar).

**Volt (IGNITE)** — sin cambios de fondo: orquestación Inngest de secuencias email (ventanas M-X-J 9-11/15-17 Madrid, límites por mailbox, rotación), smoke test nativo 50 leads con evaluación a 48h.

**Echo (INBOX)** — clasificación 5 cubos (interesado / pide info / objeción / derivación / no interesado) con haiku + few-shots, draft con sonnet en SUGERIR, webhook Calendly/Cal.com → `REUNION_AGENDADA` + anti-no-show 24h/2h. **Cambio:** al clasificar cualquier reply, dispara el sync a Twenty (§5).

**~~Atlas~~ → Twenty Sync (nuevo módulo, sustituye al Kanban propio)** — ver §5.

**Sage (AUTOPILOT)** — versión reducida: watchdog de salud cada 2h (score mailboxes → pausar si <70, según policy en config), detector de bounce alto (>8% con ≥30 enviados → pausar campaña), y **Daily Brief 8:00 L-V por email (Resend) a Pere + María**: métricas del día anterior, acciones autónomas ejecutadas con reasoning, drafts de Echo pendientes de aprobar, leads nuevos en Twenty. Sin UI de policies (config file). El Brief es la interfaz principal de supervisión.

---

## 5. Integración Twenty (el corazón del cambio)

### 5.1 Despliegue
Twenty self-hosted en Railway como servicio independiente (docker `twentycrm/twenty` + su Postgres + su Redis). Subdominio: `crm.umanialabs.com`. Usuarios: Pere, Eli, María. API key de Twenty en env de OUTPILOT (`TWENTY_API_KEY`, `TWENTY_API_URL`).

### 5.2 Estructura en Twenty
- Pipeline de Opportunities: **"Webs Premium"** con stages: `Reply recibida` → `R1 agendada` → `R1 realizada` → `Propuesta (R2)` → `Negociación` → `Ganado` / `Perdido`.
- Objetos estándar: Company (name, domain, sector, país), Person (nombre, email, cargo, LinkedIn), Opportunity (importe estimado, stage), Notes.

### 5.3 Reglas de sincronización (una dirección: OUTPILOT → Twenty)
1. **Trigger principal:** lead pasa a `RESPONDIO` (Echo clasifica cualquier reply que no sea bounce) → upsert Company + Person + crear Opportunity en stage "Reply recibida" + Note con: clasificación del cubo, texto del reply, resumen del hilo, campaña de origen y link al timeline en OUTPILOT.
2. **Inbound studio:** POST al endpoint `/api/inbound/studio` (webhook desde el formulario de studio.umanialabs.com) → crea lead `source='studio_inbound'` + sync INMEDIATO a Twenty (stage "Reply recibida", Note "Inbound SEO studio") + aviso en el Daily Brief y notificación email instantánea a María.
3. **Actualizaciones:** `REUNION_AGENDADA` (webhook Calendly) → mueve Opportunity a "R1 agendada" + Note con fecha.
4. **Idempotencia:** tabla `twenty_sync` guarda los IDs de Twenty por lead; los upserts nunca duplican. Retries con backoff en Inngest; si falla 3 veces → `sync_status='failed'` + alerta en Daily Brief.
5. **NO se sincroniza de vuelta** (Twenty → OUTPILOT) en v2.1. María trabaja el cierre en Twenty; el estado final se refleja en OUTPILOT manualmente o no se refleja — no importa: OUTPILOT es el motor de generación, Twenty es la fuente de verdad comercial. (Backlog v2.2: webhook Twenty → OUTPILOT para cerrar el loop de métricas de conversión por campaña.)

---

## 6. Estructura de repositorio

```
outpilot-v2/
├── src/
│   ├── app/
│   │   ├── (auth)/login/               # Google OAuth + verificación allowlist
│   │   ├── (dashboard)/
│   │   │   ├── radar/                  # Nova: leads, import, scoring, pool
│   │   │   ├── campaigns/              # Volt: builder secuencias + métricas
│   │   │   ├── inbox/                  # Echo: replies, drafts, aprobar
│   │   │   └── settings/               # mailboxes, config Twenty, allowlist
│   │   └── api/
│   │       ├── inngest/route.ts
│   │       ├── webhooks/lemlist/route.ts
│   │       ├── webhooks/cal/route.ts
│   │       └── inbound/studio/route.ts # formulario studio → lead → Twenty
│   ├── agents/  (nova/ lex/ volt/ echo/ sage/)
│   ├── channels/ (types.ts, registry.ts, lemlist/)
│   ├── crm/twenty/                     # cliente API + mappers + sync jobs
│   ├── jobs/                           # funciones Inngest
│   ├── lib/ (supabase/, ai/, )
│   └── config/ (models.ts, sage-defaults.ts)
├── supabase/migrations/                # 001-006
└── tests/
```

---

## 7. Plan de tareas (36 tareas, 5 fases)

### Fase 0 — Fundaciones (22 jul → 1 ago)
- **T001** Proyecto Supabase EU `outpilot-v2` + credenciales a entorno
- **T002** create-next-app (Next 15, TS, Tailwind) + repo `tores77/outpilot-v2`
- **T003** Migración 001 (tenants + allowed_users) + RLS + seed tenant `umania` y allowlist
- **T004** Google OAuth + gate de allowlist (email fuera de lista → acceso denegado)
- **T005** Clientes supabase (browser/server/service) + `supabase gen types` + script
- **T006** Setup Inngest + healthcheck cron + deploy Vercel
- **T007** Wrapper `lib/ai/claude.ts` con routing por tarea + registro en `api_costs`
- **T008** Migraciones 002 (leads) y 006 (events, api_costs, twenty_sync) + RLS + test aislamiento
- **T009** Lint rule: queries en `/jobs/**` requieren `.eq('tenant_id', ...)` + CI GitHub Actions
- **T010** Layout dashboard (tema #13131F / #00E5A0, Syne + Space Grotesk)

### Fase 1 — Nova (2 → 10 ago)
- **T011** Migración 003 (channel_accounts, touchpoints) + RLS
- **T012** UI Radar: tabla leads, filtros estado/score, import CSV
- **T013** Pipeline limpieza CSV en código (dedupe jerarquía cargos, REVIEW, tildes)
- **T014** Integración Vibe Prospecting API (fetch + enrich → leads)
- **T015** Nova scoring (job Inngest, haiku batch 20) + vista pool `EN_RADAR`
- **T016** Tests Nova (fixtures deterministas + aislamiento)

### Fase 2 — Volt + Lex (11 → 24 ago)
- **T017** Interfaz `ChannelProvider` + registry (email only, LinkedIn como stub tipado)
- **T018** `LemlistEmailProvider` (upsertCampaign, add lead, webhook replies)
- **T019** UI conexión Lemlist + mailboxes con health score
- **T020** Migración 004 (campaigns, campaign_leads) + RLS
- **T021** Builder de secuencias con plantillas precargadas (ICPs validados + restaurantes si aplica)
- **T022** Lex: job personalización pre-envío (haiku) + fallback genérico
- **T023** Volt: orquestador Inngest (sleepUntil, ventanas, límites, rotación)
- **T024** Smoke test nativo (50 leads, evaluación 48h)
- **T025** Webhook Lemlist → touchpoints + transiciones de estado
- **T026** Tests Volt (secuencia completa con provider mock)

### Fase 3 — Echo + Twenty (25 ago → 7 sept)
- **T027** Clasificador Echo 5 cubos (haiku + few-shots con replies reales de Industrial Premium ES y WhatsApp Restaurantes 97, anonimizados)
- **T028** Echo drafts (sonnet) + cola de aprobación en agent_actions
- **T029** UI Inbox (hilos, draft editable, aprobar/enviar)
- **T030** Webhook Calendly → REUNION_AGENDADA + anti-no-show Inngest
- **T031** Deploy Twenty en Railway + pipeline "Webs Premium" + usuarios (GATE 1 día: si fricción → Twenty Cloud)
- **T032** Cliente Twenty API + mappers + job de sync idempotente (twenty_sync)
- **T033** Trigger RESPONDIO → sync completo (Company+Person+Opportunity+Note)
- **T034** Endpoint `/api/inbound/studio` + conexión con el formulario de studio.umanialabs.com + notificación inmediata a María

### Fase 4 — Sage + puesta en producción (8 → 18 sept)
- **T035** Sage: watchdog salud (cron 2h) + pausas automáticas por policy + hard-locks testeados + Daily Brief 8:00 (Resend, a Pere y María) con drafts pendientes y leads nuevos en Twenty
- **T036** Migración de leads útiles de v1 → v2 + primera campaña real corriendo ÍNTEGRA desde v2 (dogfooding = producción)

**→ OPERATIVO: ~18 de septiembre. Primera campaña gestionada 100% desde v2 alimentando a María en Twenty.**

---

## 8. Riesgos y gates

| Riesgo | Mitigación |
|---|---|
| Twenty self-host da guerra en Railway | Gate T031 de 1 día: si no está vivo en 1 jornada → Twenty Cloud de pago. El coste mensual vale menos que una semana de fricción. |
| Horas reales de Pere (Restaurantes 97 + inbound hostelería en paralelo) | Fases dimensionadas a ~10-12h/semana. Si se aprieta: T014 (Vibe API) puede degradarse a solo-CSV sin bloquear nada, y T030 (anti-no-show) es posponible. Nunca se recorta: RLS, hard-locks, sync Twenty. |
| Echo sin fixtures suficientes | Exportar replies de Lemlist (Industrial Premium ES) + conversaciones WhatsApp Restaurantes 97 antes de T027. Si hay <10 ejemplos reales, se completa con sintéticos marcados como tales. |
| Formulario de studio no controlado / sin webhook | T034 incluye tocar studio.umanialabs.com; si el form actual no soporta webhook, se sustituye por form propio apuntando a `/api/inbound/studio`. |
| Tentación de re-ampliar scope a SaaS a mitad de build | Esta spec es el contrato. Cualquier feature SaaS va a `BACKLOG-PIVOTE.md`, no al código. |

**Backlog pivote futuro (NO construir):** multi-tenant real con quotas y Stripe, LinkedIn/Unipile, onboarding self-service, landing pública, sync bidireccional Twenty, marketplace de plantillas.

---

*Próximo paso: T001 hoy mismo. Claude Code recibe este documento como spec única.*
