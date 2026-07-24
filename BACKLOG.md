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
