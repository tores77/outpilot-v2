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

### Retención del contenido de replies en `touchpoints.payload`

Decisión de T018: el provider de Lemlist strippea de `NormalizedEvent.raw`
los campos de identidad (email, firstName, lastName, linkedinUrl,
companyName…) EXCEPTO en `emailsReplied`, donde el `subject`/`body`/`text`
de la respuesta entrante SÍ se conserva. Es lo que Echo (T027) clasificará
en cubos.

Pendiente para Fase 3 (T027-T029):

- Cuánto tiempo se retiene el contenido de las respuestas en
  `touchpoints.payload` sin fingerprinting/hashing.
- Si tras la clasificación de Echo se persiste solo la etiqueta + un
  resumen redactado, y el cuerpo original se purga o se archiva fuera
  de BD.
- Política diferente para leads que llegan a `CLIENTE` vs los que caen
  a `PERDIDO`.

Sin decisión ahora bloquea T027 lo justo: Echo puede leer el payload
tal cual mientras la retención se define en Fase 3.

### Normalizar saltos de línea en `sequence.steps[].bodyHtml`

Al aplicar `t022_smoke50_opener.sql` sobre la campaña "Industrial
Premium ES · Smoke 50" observamos que el `bodyHtml` guardado en BD
mezcla `\r\n` y `\n` (probable normalización del textarea del form
por navegador/OS). El script se defendió con dos `replace()` pero es
señal de que valdría la pena normalizar a `\n` en el schema Zod de
`src/lib/campaigns/sequence.ts` — un `.transform(v => v.replace(/\r\n/g, "\n"))`
sobre `subject` y `bodyHtml` en el momento del `safeParse` del server
action. Prevendría que futuros scripts de patch tengan que preocuparse
por dos variantes.

Barato de implementar; no bloquea nada. Anotar por si un futuro
script de patch se pega con lo mismo.

### Capitalización de `leads.company` (Vibe vs Lex discrepan)

Vibe devuelve valores como `"Product hackers"` (minúscula en la
segunda palabra). Lex lee el website_summary y en su opener escribe
`"Product Hackers"` (Title Case, casi seguro por el `<title>` de la
web). Resultado: el subject expandido usa "Product hackers" (BD) y
el opener usa "Product Hackers" (Lex) → mismo email, misma frase,
capitalización distinta. Chirría.

Propuestas (a decidir antes del smoke real de T024):

- **A.** Normalizar al guardar el lead: pipeline de import (Vibe, CSV,
  manual) aplica Title Case respetando siglas conocidas (BBVA, S.L.,
  S.A., etc.). Simple pero heurístico; puede fallar con marcas
  intencionadamente en minúscula (p.ej. "amazon", "figma").
- **B.** Lex devuelve `company_display` extraído del `<title>` o
  metadata de la web y Volt lo usa como `companyName` en el
  personalization map (fallback a `leads.company` si Lex no lo pobló).
  Respetuoso con marcas irregulares; obliga a extender el prompt de
  Lex y el gate mecánico.
- **C.** Mixto: guardar como venga en BD, pero en el pipeline de
  addLead usar `company_display` (Lex) si existe, si no `leads.company`
  literal.

Decisión pospuesta a antes del smoke real. Anotar en el reporte del
gate T024 con recomendación.

### Firma manual + `{{signature}}` en el copy del template industrial_premium_es

El body de los 3 pasos actualmente lleva `Pau · Umania Labs` como
byline literal (después del CTA de Calendly) AND `{{signature}}` al
final del párrafo. Podría ser:

- Intencional (byline en el CTA + block de firma completo abajo).
- Redundante (dos firmas en un email de 3 líneas).

Decisión de Pere antes del smoke real. Si se quita una:
- Quitar `{{signature}}` → el mailbox de Lemlist no añade nada
  autogenerado (más control sobre el copy final).
- Quitar `Pau · Umania Labs` → depender de `{{signature}}` que
  Lemlist expande desde la config del mailbox (más consistente si se
  rota entre mailboxes).

No urgente; anotar para el gate T024.

### Guardarraíles de entregabilidad → T025

Cuando lleguen los primeros webhooks reales de Lemlist
(`emailsSent`, `emailsBounced`, `emailsUnsubscribed`, etc.), añadir
en el pipeline de touchpoints (T025) o en Sage (T035):

- **Alerta si bounce rate > 2% en ventana móvil de 24h.** Si supera
  → pausar campaña automáticamente (delegar al provider vía
  `PATCH /campaigns/:cid` o `POST /campaigns/:cid/pause` — verificar
  endpoint antes) y notificar en el Daily Brief.
- **Auto-exclusión de dominio** si un dominio produce ≥3 hard
  bounces en una campaña: añadir todos los leads con ese dominio a
  `outreach_exclusions` con `reason='lemlist_bounced_domain'`.
- **Rate limit por mailbox**: verificar que se respeta el
  `emailLimit` de cada mailbox visto en `/settings`. Si Lemlist se
  pasa (visto en histórico), aplicar cap client-side en Volt.
- **Detección de queja formal** (`emailsUnsubscribed` con `reason='complaint'`
  o similar) → excluir + alerta inmediata.

No implementar en T024. T024 hace el smoke; T025 procesa los
webhooks y decide qué guardarraíles necesitamos con evidencia real.

### Import de `outreach_exclusions` — ESCRITO (T024, pendiente EXECUTE)

`scripts/import-outreach-exclusions.mjs` lee de la API de Lemlist las
7 campañas históricas (list hardcoded) + unsubscribes globales, y
upserta a `outreach_exclusions` con `ON CONFLICT DO NOTHING`. Dry-run
por defecto; `EXECUTE=1` para escribir.

Sondeo (2026-09-25) sobre datos reales:
- 27 unsubscribes globales.
- 703 leads en 4 de 7 campañas (3 están vacías).
- Total 642 filas nuevas tras dedupe por email.

Pendiente:
- Aplicar migración 004c en la BD.
- Ejecutar con `EXECUTE=1` una vez validado que 004c está aplicada.
- Nunca vuelca emails por consola — solo conteos y 3 dominios de
  muestra por bucket.

### Cleanup pre-smoke T024 — RESUELTO (decisión sesión 2026-09-25)

La estrategia acordada NO borra a Jose ni a Ana:
- La campaña "Industrial Premium ES · Smoke 50" vigente se marca
  `status='done'` en BD (script
  `supabase/scripts/t024_mark_smoke50_done.sql`). Pere la archiva
  en Lemlist UI aparte.
- Sus 2 campaign_leads permanecen linkeados a la campaña `done` con
  `removed_at=NULL` — quedan como registro histórico.
- La nueva campaña "Industrial Premium ES · Smoke 50 · Oct 2026" se
  crea desde cero (Pere desde `/campaigns/new` con el template
  actualizado cuando llegue el copy).
- El filtro `NOT EXISTS (... WHERE removed_at IS NULL)` de
  `selectSmokeCandidates` (`src/lib/volt/candidates.ts`) excluye
  automáticamente a Jose y Ana de cualquier smoke futuro — no se les
  contactará dos veces aunque la campaña original esté `done`.

Sin acción manual pendiente para esta parte.

### Prevenir em-dash en el opener via prompt (no solo sanitizador)

El sanitizador de `src/lib/lex/response.ts` convierte `—` en `, `
cuando le sigue minúscula. Funciona pero deja una coma "de más" en
oraciones que ya venían con comas en serie (caso real del smoke:
"conectando datos, tecnología y negocio, no optimizáis…" queda con
un ritmo de comas denso).

Alternativa que preferimos como primera línea de defensa: instruir en
el prompt "dos frases cortas, máximo 30 palabras cada una". Si Haiku
compone dos frases con punto entre ellas, el em-dash nunca aparece.
El sanitizador queda como red de seguridad para casos residuales.

Trabajo: añadir la restricción a la regla 8 o crear regla 8b. Un
ciclo de smoke sobre un par de leads para verificar longitud + tono.

### Afinar regla 10: distinguir "su/sus" de 2ª persona vs 3ª persona

La regla 10 actual prohíbe `su/sus` "con sentido de segunda persona".
El matiz es correcto pero probablemente confuso para el modelo. Falla
posible: "su producto es líder" (descripción en 3ª persona sobre la
empresa) es OK; "su producto se vende bien" (dirigido al lead, 2ª
persona) NO. Reformular con ejemplos:

  OK  (3ª persona): "Su producto compite con italianos y franceses."
  NO  (2ª persona): "Su web actual pierde clientes." → debería ser
                    "Vuestra web actual pierde clientes."

Trabajo: reescribir la regla 10 con dos ejemplos contrastados.
Requiere una tanda de smoke para verificar que Haiku hace la
distinción.

### Registro (vosotros/ustedes) por ICP en Lex

El system prompt de Lex fija hoy el registro a español de España
(segunda persona del plural: vosotros, tenéis, diseñáis) para que
case con las plantillas actuales (Industrial Premium ES). La regla
10 lo hace explícito y hay test que lo verifica en `prompt.test.ts`.

Cuando entre un ICP LATAM u otro que use "usted"/"ustedes":
- Mover el registro del prompt global a un parámetro del ICP: nuevo
  campo `IcpTemplate.registerHint: "vosotros" | "ustedes" | ...`
  (o similar).
- Inyectar ese hint al componer el system prompt en
  `src/lib/lex/prompt.ts` (parametrizar la regla 10 según el
  template que dispara el trigger).
- El job `lex-personalize` ya recibe el `campaign_id`, y de ahí el
  `icp_slug`; el template es resoluble en el pipeline.
- Test paralelo: fixture con lead LATAM + template LATAM verifica que
  el prompt inyectado contiene "usted"/"ustedes" y NO "vosotros".

Trabajo pequeño; no urgente porque hoy solo hay un ICP ES.

### Robots.txt granular en Lex website fetcher

El parser de `src/lib/lex/website.ts` (T022) solo detecta blanket
disallow (`Disallow: /` bajo `User-agent: *`, `outpilot` o `umania`).
Reglas por path (`Disallow: /private`) NO se respetan. En T022 solo
pedimos la home del lead, así que en la práctica no importa; anotar
por si alguien reutiliza el fetcher para páginas profundas. Si toca:
implementar el matcher del RFC 9309 o pegar un package pequeño como
`robots-parser`.

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
