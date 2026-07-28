# Traspaso Fase 1 → Fase 2

**De:** sesión Fase 1 (T011–T016) — Nova operativo
**Para:** próxima sesión de Fase 2 (T017+) — Volt + Lex
**Fecha:** 2026-07-28
**HEAD previsto:** post-T016 commit (feat(t016): vitest + traspaso)
**Contrato vivo:** `docs/OUTPILOT_v2_Spec_INTERNA.md` (UL-2026-OUTPILOT-V2-SPEC-R2)
**Traspaso anterior:** `docs/TRASPASO-FASE0.md`

---

## 1. Qué se construyó

### Infraestructura nueva

- **`channel_accounts` + `touchpoints`** (migración 003, T011). Enums separados
  `channel_kind` / `channel_provider` (spec §5: canal ≠ proveedor). Solo
  `email` / `lemlist` activos hoy; el schema tolera LinkedIn cuando entre.
- **`needs_review boolean`** en `leads` (migración 003a, T013). Índice parcial
  `WHERE needs_review = true`. Bandera del pipeline de limpieza.
- **Nova pipeline (`src/lib/nova/cleanup.ts`)**: dedupe por empresa
  normalizada + jerarquía de cargos, generic-email → REVIEW, normalización
  de tildes y formas legales. Reutilizable desde CSV y desde el fetch de
  Vibe.
- **Vibe/Explorium end-to-end** (`src/lib/vibe/*` + `src/jobs/nova-vibe-fetch.ts`,
  T014). Filtros server-side completos (country + job_level + company_size
  + linkedin_category), cleanup ANTES de enrich, bulk_enrich en lotes de 50,
  merge con validación de status. Contrato descubierto en 4 rondas de
  probes conservadas en `scripts/probe-vibe-*.mjs`.
- **Nova ICP scoring** (`src/lib/nova/scoring.ts` + `src/jobs/nova-score.ts`,
  T015). Batch de 20, haiku, gate anti-fabricación duro (score ≥ 70 exige
  señal verificable de empresa real). Thresholds en config
  (`src/config/scoring.ts`) — se tunean sin tocar código.

### Rutas de la UI

```
/                       (dashboard) home
/radar                  tabla + filtros + 3 botones (Puntuar N / Fetch Vibe / Importar CSV)
/radar/import           CSV upload con cleanup pipeline
/radar/vibe             estimate → confirm → execute Vibe con desglose de coste
/campaigns              placeholder Volt+Lex (Fase 2)
/inbox                  placeholder Echo (Fase 3)
/settings               placeholder
/login                  auth
/auth/callback          OAuth callback + gate allowlist
/api/inngest            serve endpoint
```

### Jobs Inngest registrados

```
healthcheck             (cron horario, T006)
nova-vibe-fetch         (evento manual `nova/vibe.fetch.requested`, T014)
nova-score              (evento manual `nova/score.requested`, T015)
```

`dev-probe-claude` eliminado en T015 — el flujo real de Nova ejercita
el wrapper Claude.

### Tests (T016)

**Vitest** con config en `vitest.config.ts` (alias `@` a `src/`).

- `tests/nova/cleanup.test.ts` — 13 tests: normalización (tildes/legal
  forms), generic-email, titleRank ES/EN, dedupe con tiebreaks,
  LeadDraft sin email.
- `tests/nova/scoring.test.ts` — 21 tests: `buildLeadPayload` no filtra
  ausencia como negativo, `parseScoringResponse` tolera fences y ruido
  y clampa scores 0-100, **state machine solo avanza** (NUEVO→EN_RADAR,
  nunca al revés; EN_SECUENCIA no vuelve a EN_RADAR), regresión
  Ana/Jose (gate anti-fabricación).
- `tests/vibe/mapper.test.ts` — 11 tests: `mapProspectToLeadDraft` con
  shape real (probes rondas 1-3), rechazo si `prospect_id` vacío,
  `mergeEnrichedContact` cubre los 4 outcomes (`ok`, `no_contact_block`,
  `no_email`, `invalid_status`).

45/45 verdes localmente + en CI (paso `Tests (vitest)` entre typecheck y
build). Fixtures reales anonimizados en `tests/fixtures/`:
- `leads.ts` — Ana/Jose/Carlos/Epsilon del primer batch de scoring.
- `scoring-responses.ts` — respuesta golden post-fix + variantes
  malformadas para el parser.
- `vibe.ts` — prospect + enrich items derivados de los probes.

### Convenciones que se consolidan

- **Two-step budget lock** para APIs de pago (Vibe): estimate (gratis) →
  token HMAC → execute con verificación. Patrón replicable si aparecen
  otras APIs por consumo.
- **Cleanup ANTES de enrich** siempre que el enrich cueste — no pagas
  contacto de leads que iban a caer por dedupe.
- **State machine de `estado` sólo avanza** (encapsulado en
  `computeScoreUpdate`). Un score bajo tras un scoring nuevo NO revierte
  un lead que ya estaba en EN_SECUENCIA o RESPONDIO.
- **Prompt anti-fabricación**: reglas duras al PRINCIPIO del system
  prompt, gate operativo antes del umbral crítico. Aprendido a fuego en
  el batch Ana Acme.
- **Probes como registro histórico**: los 5 scripts `scripts/probe-vibe-*.mjs`
  quedan en el repo. Documentan cómo llegamos al contrato real y
  permiten re-verificar si Explorium cambia la API.

### Comandos habituales (delta vs Fase 0)

```
npm test                  # vitest (nuevo T016)
npm run probe:vibe        # stats endpoint (free)
npm run probe:vibe-fetch  # fetch + filter discovery (free)
npm run probe:vibe-round2 # filter enum discovery (free)
npm run probe:vibe-round3 # linkedin_category + enrich endpoint (free)
npm run probe:vibe-enrich-first  # PAID, 1 prospect_id, ~2-4 credits
```

### Histórico de commits Fase 1

```
<T016>  feat(t016): vitest tests + TRASPASO-FASE1
089f4c5 fix(t015): hard gate — score >= 70 requires a verifiable company signal
32cf032 feat(t015): nova ICP scoring (haiku, batch 20, thresholds in config)
3e7b3ba fix(t014): calibrate credit heuristic + BACKLOG entry
325c11d feat(t014): vibe fetch — full contract, real prices, cleanup-before-enrich
69ab4f5 feat(t014): vibe/explorium bulk fetch with two-step budget lock
8c50d19 feat(t013): nova cleanup pipeline — dedupe + generic-email REVIEW + tildes
7bfa91a feat(t012): radar UI — leads table, filters, CSV import (raw)
975c6a9 feat(t011): channel_accounts + touchpoints + RLS
```

---

## 2. Desviaciones vs spec

Todas negociadas en gate con el usuario. Ninguna en `spec.md` sin
correspondencia aquí — el R2 sigue siendo el contrato válido.

1. **`campaign_id` en `touchpoints` sin FK** (T011). La tabla `campaigns`
   llega en migración 004 (T020). Se documenta con `COMMENT ON COLUMN`.
   La FK real se añade con `ALTER TABLE` en 004. Motivo: `touchpoints`
   debe funcionar para eventos previos a campaña (p.ej. inbound studio).
2. **Cleanup-before-enrich** en el pipeline Vibe (T014). La spec §4 Nova
   describe "dedupe por empresa con jerarquía de cargos" sin fijar el
   orden respecto al enrichment. Elegimos dedupe primero para no pagar
   contactos de leads que iban a caer.
3. **`api_costs.cost_usd` guarda créditos para Vibe**, no dólares (T014).
   La columna se llama `cost_usd` (herencia de Claude-only en T006) pero
   ahora acepta filas con `model='vibe_prospecting'` donde el número
   representa créditos de Vibe. El Daily Brief (T035, Fase 4) debe
   distinguir por `model` para no sumar peras y manzanas.
4. **Gate anti-fabricación** añadido al prompt de scoring tras el primer
   batch real (T015). Score ≥ 70 requiere al menos UNA señal verificable
   de empresa real (website propio, linkedin_category, tamaño, o
   ciudad+sector coherentes). Cargo+sector solos topan en 69. No es un
   cambio de la spec — es materializar la constitución §7 ("validar
   antes de automatizar") en el prompt operativo.
5. **`LeadDraft.email` opcional** en `src/lib/nova/cleanup.ts` (T014).
   El pipeline se refactorizó para poder dedupar leads Vibe SIN email
   antes del enrich. CSV import añade un filtro `filter(...email is
   string)` antes del upsert (el `unique(tenant_id,email)` en BD sigue
   siendo el gate final).

### Aclaraciones R2 acumuladas

- **Coste Vibe recalibrado a 2/4 cr por lead** tras el primer real
  (isolated probes decían 1/2 = 3 cr, primer end-to-end deducó 6).
  `VIBE_CREDITS_PER_LEAD_*` en `src/config/vibe.ts` — la ConfirmView
  no promete cifras exactas, solo "orientativo". Recalibración en
  BACKLOG (Deps y hardening).
- **Auto-sync Inngest ↔ Vercel funcionando (ruta A)**. La integración
  oficial del Vercel Marketplace hace auto-descubrimiento de funciones
  tras cada deploy. Verificado tras el commit `32cf032` sin Resync
  manual. Ya no hay que preocuparse por deploys con jobs nuevos.

---

## 3. Pendientes vivos

### En código

- **Calibrar heurística de coste Vibe con 3-5 fetches reales**
  (BACKLOG → Deps y hardening). El job ya escribe `credits_estimated`
  vs `credits_charged` en el output; comparar con el descuento real de
  Vibe y ajustar `VIBE_CREDITS_PER_LEAD_FETCH`/`_ENRICH`. Si sigue
  siendo ~2x, dejarlo. Si diverge por sector, extraer modelo por
  dimensión.
- **Añadir FK `touchpoints.campaign_id → campaigns.id`** en la
  migración 004 (T020) con `ALTER TABLE`. Limpiar antes cualquier valor
  huérfano si lo hubiera (no debería, el lint rule vigila `.eq('tenant_id',
  ...)` en `/jobs/**` y nadie mete campaign_id todavía).
- **Distinción de moneda en `api_costs`** para Daily Brief (T035): el
  reporte debe agregar por `model` y no mezclar créditos Vibe con USD
  Claude. Anotar cuando toque T035.
- **Segunda pasada de aprendizaje del prompt de scoring**: con 3-5
  batches reales sobre leads de Vibe, revisar los sub_scores para
  ajustar los pesos que Haiku implícitamente aplica al score global.
- **Fixtures de Echo antes de T027** (heredado del traspaso de Fase 0
  y sigue vivo). Exportar antes de que arranque Fase 3:
  - replies de Lemlist de la campaña "Industrial Premium ES",
  - conversaciones WhatsApp de Restaurantes 97,
  ambas anonimizadas, como few-shots del clasificador de Echo. Tarea
  manual de Pere, fecha límite ~finales de agosto. Si hay <10 ejemplos
  reales, completar con sintéticos marcados como tales (spec §8). Vive
  en `docs/echo-fixtures/` cuando toque crearlo.

### En BACKLOG.md (revisar antes de Fase 4)

- **Vigilancia patch Next 16 + ESLint** (postcss / sharp /
  brace-expansion). Deadline concreto **2026-08-10** para evaluar
  Plan B (`overrides` en package.json + test manual de `next/image`).
- **Verificar pricing Anthropic pre-T036/producción**.
- **Echo → modo ACT por cubos** post-2 semanas SUGERIR.
- **Ideas**: enrich individual Vibe, consolidación cross-import por
  empresa.

### Configuración externa (no tocar sin razón)

- **`VIBE_API_KEY`** ya en Vercel como Sensitive.
- **Integración Inngest en Vercel Marketplace** instalada — auto-sync
  funcionando. No desinstalar.
- **Supabase Auth Redirect URLs** siguen igual que Fase 0.
- **CI secrets** (`NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_ACCESS_TOKEN`)
  suficientes; el nuevo paso `npm test` no requiere secretos.

---

## 4. Arranque Fase 2 — Volt + Lex (11 → 24 ago 2026)

**Objetivo de fase (spec §7):** builder de secuencias, envío por Lemlist
con ventanas M-X-J, Lex personaliza pre-envío, smoke test 50 leads con
evaluación 48h.

**Tareas:**
- **T017** Interfaz `ChannelProvider` + registry (email only, LinkedIn
  como stub tipado).
- **T018** `LemlistEmailProvider` (upsertCampaign, add lead, webhook
  replies). **Ojo**: verificar los `touchpoint_kind` reales de Lemlist
  contra la doc oficial de webhooks; ampliar el enum con `ALTER TYPE`
  si aparecen tipos no cubiertos por los 8 actuales (warmup,
  spam_report, etc.). El TODO está en el header de
  `supabase/migrations/003_channels_touchpoints.sql`.
- **T019** UI conexión Lemlist + mailboxes con health score.
- **T020** Migración 004 (`campaigns`, `campaign_leads`) + RLS. **Añadir
  aquí** la FK `touchpoints.campaign_id → campaigns.id` con `ALTER TABLE`.
- **T021** Builder de secuencias con plantillas precargadas (ICPs
  validados; restaurantes si aplica al calendario).
- **T022** Lex: job de personalización pre-envío (haiku vía el wrapper
  `lib/ai/claude.ts` con task `lex.personalize` — ya está en el
  routing).
- **T023** Volt: orquestador Inngest (`step.sleepUntil`, ventanas
  M-X-J 9-11 / 15-17 Madrid, límites por mailbox, rotación).
- **T024** Smoke test nativo (50 leads Nova → Lex → Volt → esperar 48h
  → clasificar respuestas manualmente antes de que llegue Echo).
- **T025** Webhook Lemlist → `touchpoints` (con `provider_event_id`
  para idempotencia — el UNIQUE parcial ya está en 003) + transiciones
  de estado en `leads`.
- **T026** Tests Volt (secuencia completa con provider mock).

### Piezas ya en el repo que Fase 2 reusará sin refactor

- **Wrapper Claude** (`src/lib/ai/claude.ts`) con task `lex.personalize`
  ya en `TASK_MODEL` (Haiku). Registro en `api_costs` automático.
- **Channels registry**: `touchpoints` y `channel_accounts` con enums
  `channel_kind`/`channel_provider` esperando `lemlist` como valor
  activo. El schema soporta LinkedIn cuando entre.
- **Cleanup pipeline**: para leads del CSV que Volt use, ya vienen
  deduplicados y con flag REVIEW.
- **Scoring de Nova**: EN_RADAR ya es un pool queryable — Volt puede
  filtrar `WHERE tenant_id = ... AND estado='EN_RADAR' AND
  needs_review=false ORDER BY icp_score DESC` para armar batches.
- **State machine `computeScoreUpdate`**: Volt tendrá su propio update
  (NUEVO → EN_SECUENCIA cuando entra en campaña, etc.). Reusar patrón
  puro-función testable en `src/lib/volt/`.

### Riesgos anticipados para Fase 2

- **Ventanas M-X-J** con `step.sleepUntil` en Inngest funcionará limpio
  pero requiere que la app esté servida en la zona horaria Madrid.
  Vercel devuelve UTC por defecto; construir siempre las fechas
  objetivo con `Europe/Madrid` explícito.
- **Rate limits de Lemlist**: no confirmados. Aplicar el patrón de
  timeouts + backoff que ya usa `src/lib/vibe/client.ts`.
- **Personalización Lex**: la constitución §7 exige "si no hay datos →
  template genérico marcado, jamás inventar". Copiar la disciplina del
  gate anti-fabricación de scoring: reglas duras al inicio del prompt,
  citación de campos usados en el output.

---

## Notas de disciplina heredadas de Fase 0 y Fase 1

- **HITL tarea por tarea**: resumen + archivos + cómo verificar, esperar
  OK. Se cumplió el 100% en Fase 1.
- **Validar antes de automatizar**: cuando la spec no dicta un detalle
  (columnas, enums, filtros, precios, prompts), parar y pedir. En Fase 1
  esta disciplina evitó: escribir un mapper con field names inventados
  para Vibe (5 rondas de probe ↔ 5 rondas de refactor sin probar), y
  puso el gate anti-fabricación en el prompt sólo después de que la
  realidad lo forzase.
- **Coherencia interna del R2**: seguir corrigiendo menciones huérfanas
  si aparecen. Este traspaso deja la spec R2 sin desviaciones no
  documentadas.
- **Historia honesta**: cada bug se documenta como fix commit con
  reasoning propio (`fix(t014):` calibración, `fix(t015):` gate
  anti-fabricación). No amend commits ya pushed.
- **Probes con coste real requieren gate explícito del humano**. Fue el
  patrón de la ronda de enrich-first en Vibe y debería replicarse
  cuando toque el smoke real de Lemlist (T024, 50 emails de verdad
  saliendo).
