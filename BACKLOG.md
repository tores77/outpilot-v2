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

`npm audit` reporta 16 high tras T012, todas transitivas de dev deps y de Next:

- `postcss <=8.5.17` — 3 CVEs (XSS via `</style>`, arbitrary file read via
  attacker-controlled `sourceMappingURL`, path traversal en source map
  auto-loading GHSA-r28c-9q8g-f849). Cascadea desde `next`.
- `sharp <0.35.0` — libvips vulns (CVE-2026-33327/33328/35590/35591). Cascadea
  desde `next`.
- `brace-expansion` (GHSA-mh99-v99m-4gvg, publicado 2026-07) — DoS por
  consumo de memoria en patterns adversariales. Cascadea a `minimatch`,
  `@eslint/*`, `eslint-plugin-*`, `eslint-config-next`, `glob`, `rimraf` y
  `gaxios`/`gcp-metadata` (deps de Supabase CLI).

`npm audit fix --force` regresa a `next@9.3.3`, inaceptable. Riesgo real en
OUTPILOT: bajo (no procesamos CSS ni imágenes ni patterns de fuente externa).

**Plan A (activo)**: `npm update next && npm update eslint eslint-config-next`
cuando ambos publiquen patches. Ventana: hasta **2026-08-10** (cierre Fase 1).

**Plan B** (a evaluar el 2026-08-10 si Plan A no basta): `overrides` en
`package.json` forzando `postcss@latest`, `sharp@^0.35.0` y
`brace-expansion@^2.0.2`, con test manual de `next/image` (sharp tiene ABI
específico) y de `npm run lint` (por si eslint-config-next se rompe).

### Verificar pricing Anthropic antes de T036/producción

`config/models.ts` tiene precios hardcoded (haiku 1/5, sonnet 3/15 USD por
1M tokens). Verificar contra https://www.anthropic.com/pricing antes de la
migración v1→v2 (T036) y del primer tráfico real. Si cambian los precios
o aparecen nuevos SKUs, editar `MODEL_PRICES` (más `ClaudeModel` unión si
hace falta) y regenerar cálculos si algún reporte histórico depende del
valor exacto.

---

## Ideas (sin deadline)

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
