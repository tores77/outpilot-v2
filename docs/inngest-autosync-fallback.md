# Inngest auto-sync fallback — GitHub Action

**Estado (2026-09-23):** preparado, sin activar. Ver `BACKLOG.md` para el contexto de la investigación.

## Cuándo activar

Si el próximo deploy con funciones Inngest nuevas (previsiblemente el de T023, cuando Volt añada `volt.orchestrate`, `volt.step`, etc.) **no** sincroniza solo el panel de Inngest — es decir, el panel sigue mostrando las funciones anteriores tras el deploy — activamos este workflow. La activación es copiar el fichero a `.github/workflows/inngest-sync.yml` y hacer commit.

## Precondiciones antes de activar

1. **Secretos en GitHub** (Settings → Secrets and variables → Actions):
   - `INNGEST_SIGNING_KEY` — el mismo que usa el runtime en Vercel.
   - `PRODUCTION_URL` — la URL de producción de la app (por ejemplo `https://outpilot-v2.vercel.app`). Alternativamente, hardcodear en el YAML.
2. Confirmar que el endpoint `/api/inngest` responde a `PUT` con la firma correcta (comportamiento por defecto del `serve()` de Inngest).

## Fichero listo para copiar a `.github/workflows/inngest-sync.yml`

```yaml
name: Inngest sync

on:
  # Se dispara después de que CI (build + tests + drift check) pase en main.
  workflow_run:
    workflows: ["CI"]
    types: [completed]
    branches: [main]

concurrency:
  group: inngest-sync-${{ github.ref }}
  cancel-in-progress: true

jobs:
  sync:
    # Solo si el CI que lo dispara terminó verde.
    if: ${{ github.event.workflow_run.conclusion == 'success' }}
    runs-on: ubuntu-latest
    steps:
      - name: Poke Inngest serve endpoint
        env:
          PRODUCTION_URL: ${{ secrets.PRODUCTION_URL }}
        run: |
          # PUT to /api/inngest triggers Inngest's own re-registration flow.
          # The signing key is verified server-side by the serve() handler
          # and by Inngest cloud; no key travels in this request.
          set -euo pipefail
          echo "Poking ${PRODUCTION_URL}/api/inngest"
          # Retry a few times because Vercel deploys can take ~30-90s to be
          # live after CI turns green.
          for i in 1 2 3 4 5; do
            code=$(curl -sS -o /tmp/inngest-body -w "%{http_code}" \
              -X PUT "${PRODUCTION_URL}/api/inngest" \
              -H "content-type: application/json" \
              -d '{}' || echo "curl-fail")
            echo "attempt ${i}: http ${code}"
            cat /tmp/inngest-body || true
            echo
            if [ "${code}" = "200" ] || [ "${code}" = "204" ]; then
              exit 0
            fi
            sleep 15
          done
          echo "PUT /api/inngest never returned 2xx"
          exit 1
```

## Alternativa si el `workflow_run` da fricción

`workflow_run` requiere que el CI corra en `main`. Si por algún motivo queremos disparar sin ese acoplamiento, cambiar `on:` por:

```yaml
on:
  push:
    branches: [main]
```

Y añadir un `sleep 60` inicial para dar tiempo a que Vercel ponga el deploy en Ready. Menos elegante — sólo si `workflow_run` falla.

## Por qué NO se activa ahora

- Si la causa del fallo era **"proyecto no vinculado" en la integración de Inngest**, linkearlo desde el panel resuelve el problema sin CI extra. Pere lo marcó (bracket sin rellenar en el gate de T018 — pendiente de confirmar).
- Si la causa era otra (integración vinculada pero silenciosa), este fallback es la solución.
- Prematuramente activarlo mete un job de CI en cada push que puede solaparse con el auto-sync nativo — no rompe nada pero es ruido.

Regla del checklist en juego: `Tras un deploy con funciones Inngest nuevas, confirmar sync y versión de SDK en el panel`. Si esa confirmación falla en el deploy de T023, se activa.
