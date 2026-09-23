# BACKLOG

Mejoras y planes de activación post-Fase 0. NO es el destino de items de
pivote a SaaS — esos viven en `BACKLOG-PIVOTE.md` (constitución §1 de la spec).

---

## Agentes

### Echo — graduación a modo ACT por cubos

Constitución §7: los agentes arrancan en SUGERIR; ACT solo tras 2 semanas de
aciertos verificados en SUGERIR.

Orden de activación (menor riesgo → mayor valor):

1. `pide_info` y `no_interesado` — bajo riesgo, activar primero.
2. `derivación` — medio.
3. `interesado` y `objeción` — alto valor, permanecen en SUGERIR hasta
   evidencia sólida.

El cierre de cita ya es automático vía link Calendly + webhook (T030), así que
en ese camino no hay trabajo de modo ACT pendiente.

---

## Deps y hardening

### Vigilancia patch Next 16 + ESLint (postcss / sharp / brace-expansion)

**Estado 2026-09-23:** Plan A ejecutado en el chore de deps de arranque de
Fase 2. `next` y `eslint-config-next` a 16.3.6 (in-range, no-major); resuelve
la crítica de Next (unauth RCE Windows + AVIF Image Optimization RCE),
postcss y sharp. Audit residual: 2 highs.

- **brace-expansion (high, DoS)** — 3 caminos: (1) `eslint-config-next` →
  typescript-eslint → minimatch@10 (dev), (2) `eslint` → minimatch@3 (dev),
  (3) `inngest` → @opentelemetry/auto-instrumentations-node → gcp-metadata
  → gaxios → rimraf → glob → minimatch (potencialmente runtime en servidor
  si OTEL boota; superficie práctica nula porque nadie alimenta patterns
  hostiles al `glob` interno de rimraf en init).
- **js-yaml (high, quadratic CPU)** — `eslint` → @eslint/eslintrc (dev-only,
  no toca runtime).

Runtime real afectado: cero. Fase 2 arranca sin bloqueo. Revisar cuando el
propio inngest publique una minor que rebaje la cadena OTEL, o cuando ESLint
10 (major) sea la vía.

### Version pin de la CLI de Supabase en CI

La CLI de Supabase en CI va **fijada** (`supabase/setup-cli@v3` con
`version: 2.109.1`), no `latest`. El paso `Regenerate types` genera
`database.types.ts` a partir del schema vivo y el drift check compara
contra lo commiteado — si la CLI cambia el formato del output (p. ej.
2.109.1 añadió paréntesis en los helpers genéricos `Tables`,
`TablesInsert`, `TablesUpdate`, `Enums`, `CompositeTypes`), el drift
salta como falso positivo aunque el schema no haya cambiado.

**Regla de mantenimiento:** cuando actualices la CLI local, sube la del
CI a la misma versión en el mismo commit y regenera los tipos ahí
mismo (`chore(types): regen with supabase CLI <version>`).

**PAT (`SUPABASE_ACCESS_TOKEN`):** creado sin caducidad tras la rotación
de 2026-09-23 (el anterior había caducado en el parón de 2 meses,
disparó "Unauthorized" en el primer CI de Fase 2). Si se rota otra vez,
actualizar `.env.local` y el secret de GitHub a la vez.

### `email_delivered` muerto en el enum `touchpoint_kind`

Confirmado en T018 (probe de auth + doc oficial): Lemlist no emite un
evento `delivered`. El valor `email_delivered` en el enum de la
migración 003 queda como dead value. Coste de mantenerlo: cero. No
ejecutar `ALTER TYPE ... DROP VALUE` porque los enum drops en Postgres
son costosos (bloqueo + reescritura de columnas dependientes) y no hay
razón operativa. Si en el futuro entra otro provider (LinkedIn/Unipile,
otra plataforma email) que sí emita `delivered`, el valor está listo
sin migración.

### Out-of-range dep bumps (sin fecha)

Fuera del rango del `chore(deps)` de arranque de Fase 2. Cada uno se evalúa
cuando el trabajo lo demande, con test delante:

- `@anthropic-ai/sdk 0.115 → 0.128` (revisar si en T022 Lex necesita algo de
  la versión nueva).
- `typescript 5 → 7`, `eslint 9 → 10`, `react 19.2.4 → 19.3`.

### Verificar pricing Anthropic antes de T036/producción

`config/models.ts` tiene precios hardcoded (haiku 1/5, sonnet 3/15 USD por
1M tokens). Verificar contra https://www.anthropic.com/pricing antes de la
migración v1→v2 (T036) y del primer tráfico real. Si cambian los precios
o aparecen nuevos SKUs, editar `MODEL_PRICES` (más `ClaudeModel` unión si
hace falta) y regenerar cálculos si algún reporte histórico depende del
valor exacto.

---

### Calibrar heurística de coste Vibe con 3-5 fetches reales

Los probes aislados vieron 1 cr/fetch + 2 cr/enrich = 3 cr por lead.
El primer end-to-end real deducó **6 cr por lead** (2x lo probado). La
config actual pone la heurística a `VIBE_CREDITS_PER_LEAD_FETCH=2` y
`VIBE_CREDITS_PER_LEAD_ENRICH=4` para no subestimar la estimación de la
ConfirmView. Cada run del job escribe `credits_estimated` en el output;
tras 3-5 fetches reales, comparar contra los descuentos observados en el
panel de Vibe y ajustar los constantes.

Signal para reevaluar: si el ratio `(descuento real) / (credits_charged
del job)` estabiliza entorno a 1.0, la heurística está bien. Si oscila
mucho (p. ej. según sector o tamaño), extraer un modelo por dimensión.

---

## Ideas (sin deadline)

### Enrich individual de leads existentes vía Vibe/Explorium

T014 solo cubre bulk-fetch (buscar y traer prospects nuevos). Un caso natural
es enriquecer un lead que ya existe en `leads` (llegado por CSV o studio
inbound) con datos de Vibe: LinkedIn, sector, tamaño empresa, etc. Requiere
UX aparte (botón "Enrich" en la ficha del lead), rate-limit por lead, coste
por operación y persistencia en `custom_fields` o columnas nuevas. No es
urgente para el pipeline de Fase 1; se activa cuando aparezca un caso real
(p. ej. inbound de studio sin datos suficientes para scoring en T015).

### Consolidación cross-import de leads por empresa

El dedupe de Nova (T013) trabaja intra-batch: dentro del mismo CSV o lote
de Vibe Prospecting, se queda con el cargo más senior por empresa y
descarta el resto. Si en dos imports sucesivos entran leads de la misma
empresa con distintos rangos, ambos quedan en BD — solo el
`unique(tenant_id, email)` de 002 impide duplicados exactos por email.

Cuándo activar: si en Fase 1/2 vemos leads redundantes de la misma empresa
compitiendo por atención en Radar. Diseño posible: job Inngest opt-in que
tras cada import corre `cleanupLeadBatch` sobre el estado persistido y
marca los "perdedores" como `needs_review` con reasoning en
`custom_fields`. No borrar filas — solo señalizar.
