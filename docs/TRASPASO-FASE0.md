# Traspaso Fase 0 → Fase 1

**De:** sesión Fase 0 (T001–T010)
**Para:** próxima sesión de Fase 1 (T011+)
**Fecha:** 2026-07-28
**HEAD:** `10f874e` en `origin/main` · Vercel green · CI green
**Contrato vivo:** `docs/OUTPILOT_v2_Spec_INTERNA.md` (UL-2026-OUTPILOT-V2-SPEC-R2)

---

## 1. Qué se construyó

### Infraestructura

- **Next 16.2.11** App Router + TS + Tailwind v4 + ESLint 9, `src/`.
- **Supabase EU** (proyecto `outpilot-v2`). Cliente browser/server/service en `src/lib/supabase/`.
  Tipos generados en `src/lib/supabase/database.types.ts` (regen con `npm run gen-types`).
- **Inngest v4** en `src/lib/inngest.ts`, serve endpoint en `src/app/api/inngest/route.ts`,
  funciones en `src/jobs/**`.
- **Anthropic wrapper** en `src/lib/ai/claude.ts` con routing haiku/sonnet desde
  `src/config/models.ts` y registro en `api_costs`. Import restringido a `/jobs/**`.
- **Vercel** deploy conectado a `main`. Envs configuradas (7 runtime, sensitive según tabla del gate T006).
- **Inngest Cloud** app sincronizada con el endpoint del deploy. Cron horario `healthcheck`
  ejecutándose. Probe `dev-probe-claude` disponible para invoke manual.

### Rutas actuales

```
/                       (dashboard) home — placeholder
/radar                  placeholder Nova (Fase 1)
/campaigns              placeholder Volt+Lex (Fase 2)
/inbox                  placeholder Echo (Fase 3)
/settings               placeholder Volt/Twenty (Fase 2/3)
/login                  auth
/auth/callback          OAuth callback + gate allowlist
/api/inngest            serve endpoint
```

Gate de allowlist en `src/app/(dashboard)/layout.tsx` y en `src/app/auth/callback/route.ts`.

### Migraciones aplicadas (en orden lexicográfico)

- `001_tenancy.sql` — `tenants`, `allowed_users` + RLS con patrón inline.
- `001a_rls_helper.sql` — **hotfix**: función `public.current_user_tenant_id()` `SECURITY DEFINER`
  con `search_path` fijado; policies de `tenants` y `allowed_users` recreadas usando el helper.
  Razón: la subquery inline sobre `allowed_users` disparaba `infinite recursion detected in
  policy`.
- `002_leads.sql` — enum `lead_estado` (12 estados literales de la spec de junio) + enum
  `lead_source`, tabla `leads` con columnas tipadas de Vibe Prospecting (`email`, `first_name`,
  `last_name`, `company`, `title`, `phone`, `linkedin_url`, `website`, `sector`, `country`,
  `city`) + `icp_score` + `custom_fields jsonb`. Trigger reutilizable `set_updated_at()`.
- `006_events_costs_sync.sql` — `events`, `api_costs` (con `cost_usd numeric(10,6)` precomputado
  + `latency_ms`), `twenty_sync` literal de spec §3.

**Todas con RLS activa** usando el patrón `tenant_id = public.current_user_tenant_id()`.
Test de aislamiento verificado (allowlisted ve filas, intruso ve 0, sin recursión).

### Convenciones no negociables

- `snake_case` en Supabase, tipos generados, `service_role` **solo** en `/jobs/**`.
- `@/lib/supabase/service` y `@/lib/ai/claude` **solo** importables desde `src/jobs/**`
  (ESLint `no-restricted-imports` con excepción única para el propio `claude.ts`).
- Toda query dentro de `src/jobs/**` debe incluir `.eq('tenant_id', ...)` o `.match({ tenant_id: ... })`.
  `insert`/`upsert` bypasean el check y descansan en el tipo `Insert` de la fila
  (revisa payload en review).
- El wrapper Claude registra siempre en `api_costs` (fire-and-forget: si el insert falla,
  loguea pero devuelve la respuesta del modelo igual).
- Modelos: `claude-haiku-4-5-20251001` volumen, `claude-sonnet-4-6` calidad.
  Routing por tarea en `src/config/models.ts` (`TASK_MODEL`).

### CI (.github/workflows/ci.yml)

Steps: `npm ci` → `lint` → `tsc --noEmit` → `next build` (envs placeholder)
→ `supabase gen types` (envs reales) → `git diff --exit-code database.types.ts`.

Secrets del repo `tores77/outpilot-v2`:
- `NEXT_PUBLIC_SUPABASE_URL`
- `SUPABASE_ACCESS_TOKEN`

Nada más. El build usa placeholders; los otros env vars viven en Vercel, no en CI.

### Comandos habituales

```
npm run env:check       # valida .env.local (7 runtime obligatorias + warn opcional)
npm run gen-types       # regenera database.types.ts desde el schema live
npm run lint            # ESLint (incluye boundary rules)
npm run build           # next build
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/migrations/00X_*.sql
```

### Histórico de commits Fase 0

```
10f874e feat(t010): dashboard chassis with Umania theme
59ceb79 feat(t009): jobs boundary lint + tenant_id rule + CI pipeline
17e6cef feat(t007): claude wrapper + task routing + api_costs telemetry
22aea50 feat(t008): leads + events/api_costs/twenty_sync + RLS + spec R2 enum literal
e4ce37f feat(t006): inngest client + healthcheck cron + serve endpoint
ec4336c feat(t005): typed supabase clients + gen-types script
c93fec7 chore(backlog): add Echo ACT-mode graduation plan
2e40a8a fix(rls): break recursion via SECURITY DEFINER helper
b326ba4 feat(auth): T003 tenancy + T004 Google OAuth + allowlist gate
48bbbaf chore: bootstrap Fase 0 (T001-T002)
```

---

## 2. Desviaciones vs spec

Todas negociadas en gate con el usuario y reflejadas en el R2 de la spec.

1. **Next 15 → Next 16**. `create-next-app@latest` instaló Next 16. Aceptado como cambio de
   contrato (proyecto greenfield, breaking 15→16 no aplican). Anotado en spec §2 y §7 T002.
   Efecto colateral: `middleware.ts` deprecado, renombrado a `proxy.ts` (Next 16 `Proxy`
   convention).
2. **Allowlist reducida a Pere**. La spec original decía Pere + Eli + María; María y Eli
   trabajan Twenty, no OUTPILOT. Anotado en spec §2 fila Auth. Ampliable con un `INSERT` en
   `allowed_users`.
3. **Orden T008 antes de T007**. La spec listaba T007 (wrapper) → T008 (migraciones), pero
   T007 depende de la tabla `api_costs` que crea T008. Reordenado para evitar TODO/flag
   provisional y doble commit.
4. **Numeración de migraciones con huecos**. Slots `003`, `004`, `005` intencionalmente vacíos
   para futuras migraciones (channels, campaigns, sage) que llegan en Fase 1/2. `006` respeta
   la numeración de la spec. Orden lexicográfico se mantiene coherente.

### Aclaraciones R2 (no cambios, completar referencia)

- **§3 002**: enum `lead_estado` literal recuperado de la spec de junio (12 valores). Los últimos
  5 (`REUNION_REALIZADA`, `NO_SHOW`, `PROPUESTA_ENVIADA`, `NEGOCIACION`, `CLIENTE`) viven en
  Twenty en v2.1 — no se conducen desde OUTPILOT pero se mantienen por compatibilidad con la
  migración v1→v2 (T036). `REVIEW` no es estado del enum: es flag decidido en T013.
- **§3 patrón RLS**: sustituido el patrón inline (`tenant_id in (select ...)`) por
  `tenant_id = public.current_user_tenant_id()` (función `SECURITY DEFINER` en 001a).

---

## 3. Pendientes vivos

### En código

- **Borrar `src/jobs/dev-probe-claude.ts`** con el commit que introduzca Nova (T015).
  Sirve como smoke E2E de la cadena Vercel → Inngest → Anthropic → Supabase hasta que Nova
  ejercite el wrapper de verdad. Borrarlo antes deja el flujo sin verificación end-to-end;
  después, se convierte en ruido.
- **Fixtures de Echo antes de T027**. Spec §8 riesgo: si hay <10 replies reales, se
  completan con sintéticos marcados. Exportar antes de T027:
  - replies de Lemlist (campaña "Industrial Premium ES")
  - conversaciones WhatsApp de Restaurantes 97, anonimizadas.
  Vive en `docs/echo-fixtures/` (crear cuando llegue Fase 3).

### En BACKLOG.md (revisar antes de Fase 4)

- **Vigilancia patch Next 16** (postcss + sharp `high` en `npm audit`). Plan A: esperar patch
  release + `npm update next`. Plan B: `overrides` con test manual de `next/image`.
  Ventana: 2-3 semanas desde T006 (2026-07-24). Si no hay patch, evaluar Plan B en Fase 1.
- **Verificar pricing Anthropic antes de T036/producción**. `MODEL_PRICES` en
  `src/config/models.ts` está hardcoded (haiku 1/5, sonnet 3/15 USD/1M). Contrastar con
  https://www.anthropic.com/pricing antes del primer tráfico real.
- **Echo → modo ACT por cubos**. Post-2 semanas en SUGERIR, activar por orden de riesgo:
  1) `pide_info` + `no_interesado`, 2) `derivación`, 3) `interesado` + `objeción`.

### Configuración externa (no tocar sin razón)

- **Supabase Auth Redirect URLs**: `http://localhost:3000/**` + `https://<vercel-domain>/**`.
  Google OAuth Client ID/Secret vive en el panel de Supabase (Authentication → Providers → Google),
  no en `.env`.
- **Inngest Cloud**: app sincronizada con `https://<vercel-domain>/api/inngest`. Auto-detecta
  nuevas funciones tras redeploy Vercel.
- **CI secrets** (`gh secret list --repo tores77/outpilot-v2`):
  `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_ACCESS_TOKEN`. Suficientes; no añadir más sin razón.
- **Vercel envs**: 7 runtime marcadas sensitive/no-sensitive según la tabla del gate T006.
  `SUPABASE_ACCESS_TOKEN` NO va en Vercel (solo tooling local + CI).

---

## 4. Arranque Fase 1

**Objetivo de fase (spec §7):** Nova operativo, del 2 al 10 de agosto de 2026.

**Tareas:**
- **T011** Migración 003 (`channel_accounts`, `touchpoints`) + RLS.
- **T012** UI Radar: tabla leads, filtros estado/score, import CSV.
- **T013** Pipeline limpieza CSV en código (dedupe jerarquía cargos, REVIEW, tildes).
- **T014** Integración Vibe Prospecting API (fetch + enrich → leads).
- **T015** Nova scoring (job Inngest, haiku batch 20) + vista pool `EN_RADAR`.
- **T016** Tests Nova (fixtures deterministas + aislamiento).

### T011 primero — qué mirar

Spec §3 pinta 003 como comentario:

> `channel_accounts` (channel enum solo `email` activo), `touchpoints`.

**Igual que pasó con 002 y 006, la spec no lista las columnas.** Repetir el patrón usado en
T008: parar antes de escribir SQL, proponer schemas basados en el flujo (Volt/Lex/Echo) y
esperar validación. Detalles a resolver:

- `channel_accounts`: probablemente `provider` (enum `'lemlist'` — con hueco para futuros),
  `external_id`, `email_address`, `display_name`, `health_score int`, `status`, `settings jsonb`.
- `touchpoints`: `lead_id` FK, `campaign_id` FK (llega en 004, T020 — cuidado con orden),
  `channel_account_id` FK, `direction` (`'outbound'|'inbound'`), `kind` (`'email_sent'`,
  `'email_opened'`, `'email_replied'`, `'email_bounced'`), `payload jsonb`, `sent_at`.

Ambas con `tenant_id`, RLS con helper `current_user_tenant_id()`, índices por
`(tenant_id, created_at desc)` mínimo. Confirmar antes de escribir.

### Después de T011

- Regenerar `database.types.ts` (`npm run gen-types` → CI drift check exigirá el commit).
- Aplicar migración con `psql -f`.
- Test de aislamiento como en T008 (allowlisted vs intruso).

### Riesgos anticipados para Fase 1

- **T014 Vibe Prospecting API**: si aprieta el calendario, la spec §8 permite degradar a
  "solo CSV" sin bloquear nada. Priorizar T013 (limpieza) sobre T014 en ese caso.
- **T015 scoring haiku batch 20**: primer uso real del wrapper. `dev-probe-claude` deja
  de tener valor; borrarlo en el mismo commit.
- **Nova cleanup "email genérico → REVIEW"**: T013 decide implementación. Opciones:
  columna `is_generic_email boolean` o key `custom_fields.generic_email`. Argumentos por
  columna: indexable, queryable, tipada. Recomendación: **columna**, con ALTER en la
  misma migración 003 o en una 003a si se detecta más tarde.

---

## Notas de disciplina heredadas de Fase 0

- **HITL tarea por tarea**: al terminar cada T, resumen + archivos tocados + cómo verificar,
  esperar OK antes de la siguiente. No encadenar.
- **Validar antes de automatizar**: si la spec no dicta un detalle (columnas, listas, precios),
  parar y pedir. Fase 0 lo hizo dos veces (los 12 estados de `lead_estado`, las columnas
  Vibe de `leads`); ambas veces evitó deuda.
- **Coherencia interna del R2**: si detectas menciones huérfanas de decisiones ya revisadas
  en la spec, corrígelas y repórtalas.
- **Historia honesta**: si un patrón dictado por la spec rompe en la práctica (como el
  RLS recursivo), documentar como riesgo primero, refactorizar después con commit propio.
  No amend commits ya pushed.
