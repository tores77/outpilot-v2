# Traspaso Fase 2 → siguiente sesión (parcial)

**De:** sesión Fase 2 (T017–T022) — Volt/Lex en curso, corte del 2026-09-23
**Para:** próxima sesión de Fase 2 (retomar T023 o cerrar la reprueba de T022 pendiente)
**Fecha:** 2026-09-23
**HEAD:** `b520d43` (fix(t022): anti fan-out)
**Contrato vivo:** `docs/OUTPILOT_v2_Spec_INTERNA.md` (UL-2026-OUTPILOT-V2-SPEC-R2)
**Traspaso anterior:** `docs/TRASPASO-FASE1.md`

Este documento es **PARCIAL**: T017–T022 cerrados (T022 con reprueba
pendiente), T023–T026 no arrancados. Se ampliará al cerrar la fase.

---

## 1. Qué se construyó (T017–T022)

### T017 — Interfaz `ChannelProvider` + registry

- `src/channels/types.ts` — interfaz `ChannelProvider` con `upsertCampaign`,
  `addLead`, `parseWebhookEvent`. Enums (`ChannelKind`, `ActiveProviderId`,
  `TouchpointKind`, `TouchpointDirection`) importados de
  `database.types.ts` para eliminar drift entre TS y el enum SQL.
  `KnownProviderId = ActiveProviderId | 'linkedin'` como stub tipado.
  Contratos documentados: idempotencia de `addLead`, verificación de
  autenticidad del webhook fuera del parser (en la ruta), null vs
  throw en `parseWebhookEvent`, y (contrato #4 añadido durante T018)
  secret en body → constant-time compare + strip antes de persistir.
- `src/channels/registry.ts` — `registerProvider` (fail-loud en doble
  registro), `getProvider`, `resetRegistry` (solo tests).
- Tests: `tests/channels/registry.test.ts` (5).

### T018 — LemlistEmailProvider + probes de contrato

- Probes de solo-lectura conservados en `scripts/probe-lemlist-*.mjs`
  (auth, mailboxes, campaigns, activities). Contrato con Lemlist
  descubierto ronda a ronda; hallazgos consolidados en el código.
- **Probe de escritura controlado** (`probe:lemlist-write`,
  `probe:lemlist-write-schedule`) con dry-run por defecto, `EXECUTE=1`
  para ejecutar. Aprendido:
  - `POST /campaigns` acepta body mínimo. El schedule embebido se
    **ignora en silencio**; Lemlist crea un "Default schedule" propio
    (Europe/Paris L-V 9-18).
  - `senderStrategy: "random"` acepta.
  - Los schedules son **per-campaña** (`_id` distinto por campaña).
    `PATCH /schedules/:id` acepta cambio de timezone/weekdays/start/end.
    `POST /schedules` crea uno nuevo; `POST /campaigns/:cid/schedules/:sid`
    lo asocia. **Dos schedules conviven** en la misma campaña, así que
    la spec §4 M-X-J 9-11 + 15-17 se preserva.
  - `addLead` duplicado devuelve `400` con body plano
    `"Lead already in the campaign"`. La heurística
    `isAlreadyAddedError` matchea via `/already/i` y `status===400`.
  - Response de `POST /campaigns/:id/leads/:email` trae `_id` (`lea_...`)
    y `contactId` (`ctc_...`), ambos guardados en `campaign_leads`.
  - **`state` vs `status`**: la respuesta de `POST /campaigns` trae
    `state: "running"` que NO refleja el estado operativo. El real vive
    en `status` del `GET /campaigns/:id` (`draft`, `paused`, `ended`).
    Nunca confundir; validaciones siempre contra `status`.
- Cliente HTTP (`src/channels/lemlist/client.ts`): HTTP Basic, timeout
  15s (AbortController), retries con `Retry-After` como fuente primaria
  y `x-ratelimit-reset` como respaldo, fail-fast en 4xx no-429, un
  `200 text/html` se trata como 404 sintético (bug real en
  `/api/team/users`).
- Provider (`src/channels/lemlist/provider.ts`):
  - `upsertCampaign` CREATE en 5 pasos: `POST /campaigns` body slim
    → `GET /campaigns/:cid/schedules` → `PATCH` del default con
    window 1 → `POST /schedules` window 2 → `POST` associate w2.
  - `upsertCampaign` UPDATE: solo `PATCH /campaigns/:id` con `name`.
    No reconciliamos schedules (spec §4 fuente única en v2.1).
  - `addLead` devuelve `AddLeadResult { providerLeadId?, providerContactId? }`.
    Swallow 400/409 con "already" → `{}` (contrato #1).
  - `parseWebhookEvent`: mapping de 7 eventos + `emailsInterested/NotInterested`
    → `null` (Echo T027 clasifica). Type desconocido → throw.
    PII stripping defensivo en `NormalizedEvent.raw` excepto en
    `email_replied` (Echo necesita subject+body).
- `computeWeeklyCapacity(emailLimits[])`: suma per-mailbox de
  `min(emailLimit, VOLT_SCHEDULE_DAILY_CAP)` × `VOLT_ACTIVE_DAYS_PER_WEEK`.
  Con el schedule default (2 ventanas de 2h, `secondsToWait=1200`):
  cap = 12/día. 4 mailboxes con emailLimit=30 → 4 × 12 × 3 = **144/semana**
  (no 360).
- Tests: `tests/channels/lemlist/{client,provider,mailboxes}.test.ts`
  (48+).

### T019 — Settings: mailboxes de Lemlist

- `/settings` como Server Component `force-dynamic` (Lemlist rate limit
  20/2s da margen enorme para 1 usuario). Tabla email/estado/provider/
  límite/warmup/health. Health placeholder hasta Sage (T035).
- Bloque de capacidad usando `computeWeeklyCapacity(emailLimits)` con
  desglose "N mailboxes × D envíos/día (limitado por ventanas; límite
  Lemlist X) × 3 días = T/semana".
- `src/lib/lemlist/server-client.ts` marcado `server-only` — único
  punto donde `LEMLIST_API_KEY` entra al bundle.
- Bloque de error con Reintentar (nunca 500 en la página) si Lemlist
  falla o la key no está configurada.

### Rebrand Umania 2026 (chore, mid-fase)

- `@theme` tokens: background blanco `#FFFFFF`, foreground `#0D0D0D`,
  surface `#F5F5F4`, hairline `#E5E5E3`, muted `#6B6B6B`, accent rojo
  `#C0392B`, accent-hover `#A93226`, accent-soft `#FBEAE8`.
- Fuentes: Cormorant Garamond 500/600 para titulares + logotipo
  sidebar; DM Sans 400/500/600 para cuerpo. Ambas vía `next/font/google`.
- Sidebar blanca con item activo `bg-accent-soft text-accent`. Badges
  neutros salvo EN_RADAR (rojo suave) y REVIEW/NURTURING (ámbar).
  Verdes anteriores desaparecen; rojos residuales también pasan a
  neutro. Success flashes en gris (`bg-surface text-foreground`);
  rojo reservado a errores y acento de acción.
- Spec §2 con fila "Tema" nueva (R2 septiembre 2026); §7 T010 con
  nota cruzada.

### T020 — Migración 004: campaigns + campaign_leads + FK deferido

- Enum `campaign_status` = `draft|smoke_test|active|paused|done`
  (literal spec §3).
- `campaigns` con `provider_external_id` (`cam_...` de Lemlist,
  unique parcial), `icp_slug` (text libre, referencia a
  `config/icps.ts`), `sequence jsonb`.
- `campaign_leads` con `provider_lead_id`, `provider_contact_id`,
  `removed_at` (unique parcial `(campaign_id, lead_id) WHERE removed_at
  IS NULL` para tolerar re-add). Índice hot-path para T025:
  `(tenant_id, provider_lead_id) WHERE provider_lead_id IS NOT NULL`.
- Cierra la deuda de T011: FK `touchpoints.campaign_id → campaigns.id`
  con `ON DELETE SET NULL` (preserva historial de eventos) precedida
  de un `DO` block que aborta si detecta huérfanos.
- Test de aislamiento en `supabase/tests/004_campaigns_isolation.sql`
  con dos JWTs y BEGIN/ROLLBACK.

### T021 — Builder de secuencias + plantillas por ICP

- `src/config/brand.ts` — URLs de marca (Calendly, studio) y
  `CONTACT_EMAIL`. Solo URLs y direcciones; copy inline en templates.
- `src/config/icps.ts` — plantilla `industrial_premium_es` con los 3
  pasos reales del sequence de Lemlist convertidos a `<p>/<br>` limpio.
  `openerFallback` como campo nuevo del template (Volt sustituye
  `{{opener}}` por él en modo generic — **nunca por string vacío**).
  Validador `validateVariables` acota a `firstName/lastName/companyName/
  signature/opener`.
- `src/lib/campaigns/sequence.ts` — Zod schema del `sequence` jsonb
  con `superRefine` sobre subject, bodyHtml y openerFallback para vetar
  variables no permitidas.
- `/campaigns` — lista de BD con badges por status.
- `/campaigns/new` — picker (`?icp=`) o form editable con nombre + N
  fieldsets (subject + body HTML textarea). `SubmitButton` (Client
  Component con `useFormStatus`) para bloquear submit duplicado.
- `createCampaignAction` con:
  - Validación Zod del sequence recompuesto.
  - Dedupe server-side (rechaza otra draft con el mismo nombre).
  - Insert en status `draft`, channel `email`, provider `lemlist`,
    icp_slug del template, sequence + openerFallback.
- Tests: `tests/config/icps.test.ts` (17), `tests/lib/campaigns/sequence.test.ts`
  (17).

### T022 — Lex: personalización pre-envío

- Migración `004a` (aplicada): `ALTER TABLE campaign_leads ADD COLUMN
  personalization jsonb`.
- `src/config/lex.ts` — batch 20, max 100/trigger, TTL 30d website,
  fetch timeout 5s, UA `"Umania-Labs-Outpilot/2.0 (+https://umanialabs.com)"`,
  `LEX_STALE_CLAIM_MS = 10 min`, `LEX_PERSONALIZATION_VERSION = 1`.
- `src/lib/lex/website.ts` — fetch con timeout, robots.txt blanket
  check (`Disallow: /` bajo `*`/outpilot/umania — el granular queda en
  BACKLOG), `extractSummary` con title + meta description + body
  recortado a ~1500 chars. Nunca lanza.
- `src/lib/lex/prompt.ts` — system prompt con reglas anti-fabricación
  al principio (patrón Nova). Post-mortem añadió reglas 8 y 9:
  - Regla 8: prohíbe guion largo (— –), comillas tipográficas,
    ellipsis Unicode (…), listas y bullets.
  - Regla 9: opener SOLO OBSERVA algo concreto. NO fuerces puente
    hacia la propuesta ("web premium", "renovar", "conversión",
    "leads", "24/7", "stack", "IA"). El paso 1 del email ya lo hace
    después del opener.
- `src/lib/lex/response.ts` — Zod schema + parser tolerante (fences,
  ruido, texto around). `applyFieldGate` como **gate mecánico**:
  degrada a `generic` con `cited_empty_field: X` si el modelo cita
  un campo que no estaba en el mapa del lead. También detecta
  `opener_too_long`, `personalized_but_empty_opener`,
  `personalized_without_fields_used`, `parse_failed_*`.
- `src/lib/lex/claim.ts` — helpers de reserva atómica (ver §2
  post-mortem):
  - `sweepStaleClaims` — reset opportunistic de claims stuck > TTL.
  - `claimPendingLeads` — two-phase (SELECT candidatos + UPDATE
    atómico con `.is(personalization, null)` race guard).
  - `finalizePersonalization` — UPDATE del resultado final con doble
    guard: `personalization->>state = 'processing'` +
    `personalization->>started_at = claimStartedAt`.
  - `countPending` — cuenta NULL, processing_active y processing_stale
    para el botón UI.
- `src/jobs/lex-personalize.ts` — Inngest function con
  `concurrency: [{ limit: 1, key: "event.data.campaignId" }]`.
  Pipeline: `step.run("sweep-stale")` → `step.run("claim-pending")`
  → `step.run("process-{id}")` por lead (fetch website si no cache
  30d → Haiku → gate → finalize) → `step.run("record-event")`.
- `/campaigns` — columna "Personalización" con 3 estados de botón:
  - `activeProcessing > 0` → `"Procesando N…"` deshabilitado.
  - `activePending > 0` → `PersonalizeButton` con `useFormStatus`,
    label `"Personalizar min(N,100) de N"`, texto `"Encolando…"`
    mientras la action está en vuelo.
  - `activePending = 0 && activeProcessing = 0` → `"Sin pendientes"`.
- Scripts one-shot (`supabase/scripts/`):
  - `t022_smoke50_opener.sql` — patch in-place del sequence de
    Industrial Premium ES · Smoke 50: inserta `<p>{{opener}}</p>`
    tras el saludo del step 1 con `replace()` exacto (soporta `\n` y
    `\r\n`), quita del body el párrafo que ahora vive en
    `openerFallback`, añade `openerFallback` top-level.
  - `t022_smoke_leads.sql` — inserta los 2 leads del test end-to-end
    (uno con website, otro sin) como `campaign_leads` de Smoke 50.
    **Sin filtro por estado** (Lex trabaja sobre campaign_leads, no
    exige EN_RADAR; esa gate es de Volt). `ON CONFLICT DO NOTHING`
    idempotente. SELECT final muestra estado + `personalization_state`
    (`pending` / `processing (T)` / `done (kind)`).
- Tests: `tests/lib/lex/{prompt,response,website,claim}.test.ts`
  (50+, incluido el test determinista del race con mock atómico).

### Rutas de la UI (delta vs Fase 1)

```
/                       (dashboard) home
/radar                  (Fase 1)
/radar/import           (Fase 1)
/radar/vibe             (Fase 1)
/campaigns              lista de BD + botón "Personalizar N de M"
/campaigns/new          picker ICP + form editable
/settings               mailboxes de Lemlist + capacidad semanal
/inbox                  placeholder Echo (Fase 3)
```

### Jobs Inngest registrados (delta vs Fase 1)

```
healthcheck             (cron horario, T006)
nova-vibe-fetch         (evento manual, T014)
nova-score              (evento manual, T015)
lex-personalize         (evento manual `lex/personalize.requested`,
                         concurrency 1 por campaignId, T022)
```

### Tests (delta vs Fase 1)

45 → **181 tests verdes** al cierre de T022. Nuevos:
- `channels/registry` (5), `channels/lemlist/{client,provider,mailboxes}`
  (48), `config/icps` (17), `lib/campaigns/sequence` (17),
  `lib/lex/{prompt,response,website,claim}` (~50).

### Comandos habituales (delta vs Fase 1)

```
npm run probe:lemlist-auth           # (T018 setup)
npm run probe:lemlist-mailboxes
npm run probe:lemlist-campaigns
LEMLIST_CAMPAIGN_ID=... npm run probe:lemlist-activities
npm run probe:lemlist-write          # dry-run
EXECUTE=1 npm run probe:lemlist-write
npm run probe:lemlist-write-schedule
EXECUTE=1 npm run probe:lemlist-write-schedule

# Migraciones y scripts one-shot:
psql "$SUPABASE_DB_URL" -f supabase/migrations/004_campaigns.sql
psql "$SUPABASE_DB_URL" -f supabase/migrations/004a_campaign_leads_personalization.sql
psql "$SUPABASE_DB_URL" -f supabase/tests/004_campaigns_isolation.sql
psql "$SUPABASE_DB_URL" -f supabase/scripts/t022_smoke50_opener.sql
psql "$SUPABASE_DB_URL" -f supabase/scripts/t022_smoke_leads.sql
```

### Convenciones consolidadas (delta vs Fase 1)

- **Botones que disparan server actions**: siempre con Client
  Component + `useFormStatus` para bloquear submits duplicados.
  Extraído en `SubmitButton` (T021 `/campaigns/new`) y
  `PersonalizeButton` (T022 `/campaigns`).
- **Success flashes en gris** (`bg-surface text-foreground`); rojo
  reservado a errores y a los botones primarios de acción.
- **Migraciones**: siempre en `supabase/migrations/NNN_*.sql`. Tests
  de aislamiento en `supabase/tests/`. Scripts one-shot de patch/setup
  en `supabase/scripts/` (aplicar con `-f`, no `-c` — los dollar-quotes
  no pasan con `-c`).
- **Probes con coste real**: dry-run por defecto, `EXECUTE=1` o
  `--execute` para ejecutar. Bodies visibles antes de ejecutar.
- **Anti-fan-out en jobs manuales**: (1) UI que refleja estado
  (`processing` vs `pending`) y deshabilita durante el submit; (2)
  Inngest `concurrency: [{limit:1, key: "..."}]` por identificador
  del recurso; (3) claim atómico en BD antes de la operación cara;
  (4) `step.run` por unidad (no por lote) para retry aislado.
- **Anti-fabricación IA**: reglas duras al principio del system
  prompt + gate mecánico en código sobre `fields_used` que valida
  contra el input real. NUNCA solo por prompt.
- **Rebrand y tokens**: colores y fuentes en `@theme` de
  `globals.css`; ninguna clase asume fondo oscuro. Estados neutros
  por defecto; solo EN_RADAR (rojo suave) y REVIEW/NURTURING (ámbar)
  llevan color.

### Histórico de commits Fase 2 hasta el corte

```
b520d43 fix(t022): anti fan-out — concurrency + claim atómico + step por lead + UI con "Procesando"
5a088f3 feat(t022): lex — opener personalizado (haiku + website + gate mecánico) + migration 004a
f735894 fix(t021): disable submit on pending + dedupe draft name + success flashes to gray
2371af9 feat(t021): campaigns builder — icps template + zod schema + /campaigns[/new] + tests
89258d3 chore(types): regen tras migración 004 (campaigns + campaign_leads)
dc151c3 feat(t020): migration 004 — campaigns + campaign_leads + touchpoints.campaign_id FK
2a5a213 chore(theme): umania brand 2026
a70e075 feat(t019): settings — lemlist mailboxes + weekly capacity (con techo por ventanas)
6c0f3b4 docs: inngest auto-sync — causa identificada (Vercel Deployment Protection)
686e770 feat(t018): lemlist client + provider + tests (mocks + fixtures anonimizados)
95b30d2 feat(t017): channel provider interface + registry
0f22e70 docs: close inngest auto-sync entry (fix verified) + checklist +1
(chore/docs/probes intercalados omitidos por brevedad)
```

---

## 2. Post-mortem del 2026-09-23 — Lex fan-out

**Síntoma:** un solo click en "Personalizar 2 de 2" produjo 9 runs de
`lex-personalize` en Inngest (entre 18:55:30 y 18:55:41) y 3 filas en
`api_costs` con `tokens_in=690` para 2 leads. Logs de Vercel: 9 `POST
/campaigns` a cadencia ~1,5s.

**Causa raíz confirmada:** el botón no daba feedback y decía
"Personalizar 2 de 2" mientras Haiku procesaba. El usuario clicó 9
veces porque no vio nada moviéndose. Cada click envió UN evento (la
server action no duplicaba); cada evento generó UN run de Inngest;
los 9 runs corrieron en paralelo sin concurrency ni claim atómico.
Cada uno leyó los mismos 2 leads NULL y llamó a Haiku antes del
`.is(null)` guard del UPDATE. El guard protegió la ESCRITURA pero no
el bolsillo.

**Fix combinado (commit `b520d43`) con 4 capas:**

1. **UI (raíz del bug):** el botón cuenta NULL + processing_stale como
   "pendientes" y muestra `"Procesando N…"` deshabilitado mientras
   hay processing_active dentro del TTL. Nuevo `PersonalizeButton`
   con `useFormStatus` bloquea submits duplicados durante la action.
   **Sin esto, aunque tengamos las 3 capas de abajo, se acumulan
   events inútiles en cola.**
2. **Concurrency Inngest:** `concurrency: [{ limit: 1, key:
   "event.data.campaignId" }]`. Aunque llegaran N events por otra
   vía, se procesan uno detrás de otro por campaña.
3. **Claim atómico + finalize con doble guard** (`src/lib/lex/claim.ts`):
   sweepStaleClaims (opportunistic reset a NULL de processing >
   TTL) + claimPendingLeads (two-phase con `.is(null)` guard) +
   finalizePersonalization (guard sobre `state='processing'` +
   `started_at=claimStartedAt`). Runs concurrentes que llegaran no
   reclaman nada y salen limpios; no re-llaman a Haiku.
4. **`step.run` POR LEAD** (no por lote): un fallo puntual (5xx de
   Anthropic, timeout de fetch) reintenta ese lead, no re-llama a
   Haiku sobre los ya hechos. Inngest memoiza cada step. 100 leads
   caben de sobra.

**También en el mismo fix:** reglas 8 y 9 del prompt (prohibición de
tics tipográficos y "solo observa, sin puente hacia la propuesta"),
y arreglo del script `t022_smoke_leads.sql` (sin filtro por estado
`EN_RADAR` — Lex trabaja sobre campaign_leads, esa gate es de Volt).

**Test determinista del race** en `tests/lib/lex/claim.test.ts`:
`Promise.all([claim(), claim()])` sobre 1 lead con mock atómico → total
reclamado = 1. Verifica que el single-thread de JS + guard `IS NULL`
es suficiente para el race safety.

### Reprueba pendiente de T022 (pasos exactos)

1. **Reset del incidente anterior:**
   ```sql
   UPDATE campaign_leads
   SET personalization = NULL
   WHERE campaign_id = (
     SELECT id FROM campaigns
     WHERE name = 'Industrial Premium ES · Smoke 50' AND status = 'draft'
   ) AND removed_at IS NULL
   RETURNING id, lead_id;
   ```
2. **Inngest → Apps:** verifica que `lex-personalize` sale con
   `SDK 4.21` y con `concurrency` visible.
3. **Re-aplica `t022_smoke_leads.sql`** — ahora ambos leads entran
   aunque el segundo no esté en EN_RADAR. SELECT final muestra 2
   filas.
4. **Un solo click** en "Personalizar 2 de 2" en `/campaigns`.
   Observaciones:
   - El botón cambia a `"Encolando…"` al pulsar.
   - Refresca en unos segundos: pasa a `"Procesando 2…"` deshabilitado.
   - Tras ~30-60s: pasa a `"Sin pendientes"`.
5. **`api_costs` reciente:**
   ```sql
   SELECT tokens_in, tokens_out, cost_usd, created_at
   FROM api_costs
   WHERE model = 'claude-haiku-4-5-20251001'
     AND created_at > now() - interval '5 minutes'
   ORDER BY created_at DESC;
   ```
   Esperado: **EXACTAMENTE 2 filas** (una por lead). Si aparecen 3+,
   algo del claim falló y hay que investigar antes de cerrar T022.
6. **Personalizations finales:** leer `personalization` de las 2
   filas. Esperado:
   - Lead con website: `personalization = "personalized"`, opener
     corto sin em-dash ni bullets, `fields_used` con `website_summary`
     + un campo del lead.
   - Lead sin website: `personalization = "generic"`, `opener = ""`,
     `reason_if_generic` con el motivo (Haiku o gate mecánico).

Si los 6 pasos verdes → T022 cerrado y se pasa a T023.

---

## 3. Desviaciones vs spec (Fase 2)

Todas negociadas en gate. Ninguna en `spec.md` sin correspondencia
aquí — el R2 sigue siendo el contrato válido.

1. **Rotación entre mailboxes y límites diarios DELEGADOS al provider**
   (spec R2 §4 Volt, escrita durante T018). Lemlist expone
   `senderStrategy: "random"` y `emailLimit` por mailbox. Volt fuerza
   las ventanas M-X-J 9-11/15-17 al crear la campaña vía
   `upsertCampaign`; no reimplementa rotación ni caps. Sage vigila la
   salud y pausa mailboxes fuera de rango.
2. **`icp_slug` como text libre** en `campaigns` (T020). Referencia a
   `config/icps.ts`, sin tabla de ICPs. Overkill para un solo tenant.
3. **`sequence` jsonb opaco** validado en app (Zod), no en BD (T020,
   afinado en T021 con el schema real).
4. **Unique parcial en `campaign_leads(campaign_id, lead_id) WHERE
   removed_at IS NULL`** para tolerar re-add tras remove (T020, sin
   migrar histórico).
5. **`campaigns.provider_external_id` unique parcial** para evitar
   doble-sync de la misma campaña externa (T020).
6. **FK `touchpoints.campaign_id → campaigns.id` con `ON DELETE SET
   NULL`** (T020, cerrando la deuda de T011): preserva historial de
   eventos si una campaña se borra.
7. **`campaign_leads.personalization jsonb`** añadida vía 004a (T022).
   No estaba en spec §3 (spec no habla de Lex en detalle); shape en
   `src/lib/lex/response.ts`.
8. **Cache de website summary en `leads.custom_fields.website_summary`**
   (T022). Reversible sin migración. TTL 30d por defecto.
9. **`openerFallback` en templates + sequence jsonb** (T022): Volt
   sustituye `{{opener}}` por él si Lex devuelve `generic` — NUNCA
   por string vacío.
10. **Prompt de Lex con reglas 8 y 9 añadidas post-smoke real**
    (T022 fix): tics tipográficos + "solo observa, sin puente hacia
    la propuesta". Materializa lo aprendido del primer output real
    de Haiku sobre leads reales.

### Aclaraciones R2 acumuladas en Fase 2

- **Vercel Deployment Protection** bloquea integraciones que llaman a
  la URL única del deploy. Fix: configurar `Deployment Protection
  Bypass for Automation` + Custom Production Domain dentro de la
  integración. Cerrado y verificado. Lección añadida al checklist
  §Deploy y a §4 lecciones aprendidas.
- **Cliente Lemlist: `200 text/html` = 404 sintético** (endpoint SPA
  fallback). Bug real detectado en `/api/team/users` durante T018;
  cubierto en el cliente con detección de content-type.
- **Postgres jsonb `\r\n` vs `\n`** en textareas: el `bodyHtml`
  guardado en BD mezcla las dos variantes según el navegador/OS.
  Anotado en BACKLOG para normalizar en el Zod transform del schema
  de sequence.

---

## 4. Pendientes vivos al cierre parcial

### En código (no bloqueantes)

- **Reprueba de T022 en producción** (§2 post-mortem). Sin ella no se
  cierra T022 formalmente.
- **Normalizar `\r\n` → `\n` en `sequence.steps[].bodyHtml`** vía Zod
  transform (BACKLOG). Barato; no urgente.
- **Robots.txt granular en Lex website fetcher** (BACKLOG). El parser
  actual solo detecta blanket `Disallow: /`. Suficiente porque solo
  pedimos la home del lead; anotar si algún día reutilizamos el
  fetcher para páginas profundas.
- **Reset manual/cron de claims stuck** en `lex-personalize`. Por
  ahora el sweep opportunistic del siguiente trigger basta; si nadie
  triggerea la campaña, quedan colgados hasta el próximo click.
  Alternativa: cron cada 10 min que dispare `lex/sweep-stale`. Out
  of scope hasta que aparezca el caso real.
- **Reproceso forzado ("Volver a personalizar N ya done")**: fuera de
  scope. Borrar `personalization` en BD a mano y volver a pulsar es
  suficiente para el smoke.
- **`{{opener}}` en templates**: solo `industrial_premium_es` lo tiene
  hoy. Cuando se añada un segundo ICP, revisar que su body ponga
  `{{opener}}` en la posición correcta y defina su `openerFallback`.

### En BACKLOG (revisar antes de Fase 3)

- Vigilancia de deps y CVEs (heredado; brace-expansion y js-yaml
  residuales sin runtime real).
- Robots.txt granular en Lex.
- Normalizar saltos de línea en sequence.
- Retención del contenido de replies en `touchpoints.payload` (para
  Echo, Fase 3).
- Out-of-range dep bumps sin fecha (Anthropic SDK, TS 7, ESLint 10,
  React 19.3).

### Configuración externa (no tocar sin razón)

- `LEMLIST_API_KEY` en `.env.local` (dev) y Vercel Sensitive
  Production + Preview.
- Integración Inngest en Vercel Marketplace con Deployment Protection
  Bypass + Custom Production Domain. Verificado, auto-sync funcional.
- `SUPABASE_ACCESS_TOKEN` sin caducidad tras la rotación del
  arranque de Fase 2.
- CLI de Supabase pinneada a `2.109.1` en CI (evita drift del formato
  de tipos autogenerados).

---

## 5. Qué queda de Fase 2 (T023–T026)

Estos NO se han arrancado. Notas anticipadas:

### T023 — Volt: orquestador Inngest

- Objetivo: dado un `campaign_id`, orquestar el ciclo completo de
  envío usando `LemlistEmailProvider` (T018) + personalización de Lex
  (T022) + schedule ya forzado por `upsertCampaign`.
- Piezas ya listas para reusar sin refactor:
  - Provider Lemlist con `upsertCampaign` (crea campaña + schedules)
    y `addLead` (idempotente, devuelve ids).
  - `campaign_leads` con `provider_lead_id` y `provider_contact_id`.
  - Lex genera `personalization` por lead (o degrada a generic).
  - Lemlist maneja rotación (`senderStrategy: "random"`) y schedule
    (M-X-J 9-11/15-17) internamente.
- Trabajo T023:
  - Job Inngest `volt/campaign.launch.requested` (evento manual desde
    UI de campaña, mismo patrón que Lex).
  - Job Inngest `volt/campaign.add-leads.requested` para asignar leads
    del pool EN_RADAR a una campaña (INSERT en `campaign_leads` con
    personalization NULL).
  - Composición del payload que Lemlist espera para `addLead`: expandir
    `{{opener}}` con `personalization.opener` (o `openerFallback` si
    generic), `{{firstName}}/{{companyName}}` desde el lead, dejar
    `{{signature}}` a passthrough. **Ojo con `\r\n` vs `\n`**.
  - Concurrency 1 por campaignId (aprendizaje de T022).
  - `step.run` por lead para retries aislados.
  - Transiciones de estado: `campaigns.status draft → smoke_test → active`.
- Ventanas M-X-J con `step.sleepUntil` — traspaso F1 aviso: construir
  fechas con `Europe/Madrid` explícito, Vercel es UTC por defecto.
- Rate limits Lemlist ya cubiertos en el cliente (Retry-After + backoff).

### T024 — Smoke test nativo (50 leads, 48h evaluación)

- Requiere **gate humano explícito** para el primer POST real de
  envío (regla operativa Pere).
- Reusar `campaigns.status = 'smoke_test'` (enum ya existe).
- Volt (T023) debe respetar `smoke_size` (fuera de scope T020 —
  añadir vía ALTER TABLE cuando toque, o como campo en `sequence`
  jsonb).
- Fixtures reales de replies de Lemlist (Industrial Premium ES) →
  export para Echo T027. Traspaso F1 aviso: tarea manual de Pere,
  fecha límite ~finales de agosto (ya vencida; hacer antes de T027).

### T025 — Webhook Lemlist → touchpoints

- Endpoint `/api/webhooks/lemlist/route.ts` (o similar).
- **Contrato #4 de `ChannelProvider`**: la verificación del secret
  (que en Lemlist viaja DENTRO del body) va en la ruta receptora
  ANTES de llamar a `parseWebhookEvent`. Comparación en tiempo
  constante (no `===`). Strippear el campo secret del payload antes
  de persistir en `touchpoints.payload` o en cualquier log.
- `parseWebhookEvent` del provider ya normaliza a `NormalizedEvent`
  con `providerEventId` top-level (para el UNIQUE parcial de 003).
- Índice hot-path ya existe: `campaign_leads(tenant_id, provider_lead_id)
  WHERE provider_lead_id IS NOT NULL` (004). El webhook usa
  `lea_...` para resolver el `campaign_lead` afectado.
- Transiciones de estado en `leads` según `touchpoint_kind`:
  `email_replied` → `RESPONDIO`. Etc.
- PII: el content de las respuestas (`subject`, `body`, `text`,
  `html`) se preserva en `touchpoints.payload` para Echo (T027). El
  resto de PII (identity fields) se strippea en el provider.

### T026 — Tests Volt con provider mock

- Reusar el patrón de `tests/channels/lemlist/provider.test.ts` con
  mock del cliente HTTP.
- Cubrir el ciclo completo con mocks: `upsertCampaign` → addLead per
  lead → simulate webhook event → verificar transiciones.

---

## Notas de disciplina (heredadas de F0/F1 y consolidadas en F2)

- **HITL tarea a tarea**: se cumplió 100% durante Fase 2. El gate
  con formato §3 del checklist funciona; se usa antes de codear
  cualquier decisión estructural.
- **Probes antes que suposiciones**: en T018 fueron 4 rondas de
  probes de solo-lectura antes del write-probe con gate.
- **Diagnóstico antes de fix**: el post-mortem de T022 se hizo con
  gate §3 (causa raíz explicada antes de tocar código). Evita fixes
  al síntoma.
- **Cast temporal ↔ regen de tipos**: cuando una migración añade una
  columna que el código consume, se acepta un cast `as unknown as
  X` con comentario TODO hasta que Pere regenere los tipos. El
  commit combinado quita el cast al mismo tiempo. Sin CI rojo entre
  commits.
- **Coherencia visual del rebrand**: el chore(theme) se hizo mid-fase
  como interrupción priorizada (clase de Pere). Sin tocar lógica.
  Después se retomó T021 desde donde estaba en el WT.
- **Historia honesta**: los `fix(t0XX):` documentan cada bug con
  reasoning propio. El post-mortem de T022 vive en el mensaje de
  commit + en este traspaso, no en un doc separado.
