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

### Vigilancia patch Next 16 (postcss + sharp)

`npm audit` en Fase 0 reporta 3 vulnerabilidades high, todas transitivas de
Next 16 (`postcss <=8.5.11` con XSS y file read; `sharp <0.35.0` con vulns de
libvips). `npm audit fix --force` regresa a `next@9` — inaceptable.

Plan A (activo): esperar la siguiente patch release de Next 16 (`npm update next`).
Riesgo real en OUTPILOT: mínimo (no procesamos CSS ni imágenes de terceros).

Plan B (si en 2–3 semanas no hay patch): `overrides` en `package.json` forzando
`postcss@latest` y `sharp@^0.35.0`, con test manual de `next/image` — sharp tiene
ABI específico y forzar la versión puede romper la optimización de imágenes.

Revisar durante Fase 0/1 el changelog de Next 16 antes de decidir bump manual.

### Verificar pricing Anthropic antes de T036/producción

`config/models.ts` tiene precios hardcoded (haiku 1/5, sonnet 3/15 USD por
1M tokens). Verificar contra https://www.anthropic.com/pricing antes de la
migración v1→v2 (T036) y del primer tráfico real. Si cambian los precios
o aparecen nuevos SKUs, editar `MODEL_PRICES` (más `ClaudeModel` unión si
hace falta) y regenerar cálculos si algún reporte histórico depende del
valor exacto.
