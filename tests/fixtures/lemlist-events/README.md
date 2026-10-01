# Fixtures sintéticos de webhooks Lemlist (T025)

Payloads de ejemplo para los tipos de evento que el bloque B
procesará. Son SINTÉTICOS — no corresponden a leads reales, usan
dominio `example.test` y nombres de prueba.

Fuentes:
- **Documentado**: campo listado explícitamente en
  `developer.lemlist.com/api-reference/endpoints/webhooks/add-webhook`
  (section "Available event types" y "Common fields") o verificado en
  probe real de `/api/activities` (T025 2026-10-01).
- **Supuesto**: campo que la doc no enumera pero que creemos probable
  por analogía con `emailsSent` (verificado en probe) o por sentido
  común. El bloque B debe tratar estos campos con parser defensivo.

## Campos comunes a TODOS los eventos (doc oficial)

| Campo         | Tipo       | Fuente       |
|---------------|------------|--------------|
| `_id`         | string     | documentado  |
| `type`        | string     | documentado  |
| `teamId`      | string     | documentado  |
| `createdAt`   | ISO date   | documentado  |
| `contactId`   | string     | documentado  |
| `secret`      | string     | documentado (si configurado) |
| `campaignId`  | string     | documentado (opcional según contexto) |
| `campaignName`| string     | documentado (opcional) |
| `sequenceId`  | string     | documentado (opcional) |
| `sequenceStep`| number     | documentado (opcional) |
| `stepId`      | string     | documentado (opcional) |
| `sendUserId`  | string     | documentado (opcional) |
| `sendUserEmail`| string    | documentado (opcional) |
| `sendUserName`| string     | documentado (opcional) |
| `leadId`      | string     | observado en probe (opcional, omitido en `isThirdPartyReply`) |
| `leadEmail`   | string     | observado en probe |

## Específicos de emails (doc oficial)

| Campo       | Tipo                                | Fuente       |
|-------------|-------------------------------------|--------------|
| `to`        | `[{address, name}]`                 | documentado  |
| `cc`        | `[{address, name}]`                 | documentado  |
| `bcc`       | `[{address, name}]` (solo outbound) | documentado  |
| `subject`   | string                              | documentado  |

## Fichas por fixture

### `emailsBounced.json`

Documentados: todos los comunes + `to`, `subject`.

Supuestos (no en doc, pero necesarios para B):
- `bounceReason`: motivo del rebote (soft/hard, SMTP code). La doc
  NO lo lista. Lo asumimos porque sin él no distinguimos un bounce
  temporal de uno permanente — ambos se tratan por ahora como
  `outcome=bounced` (ver T025-plan.md §1).
- `bounceCategory`: idem (p.ej. "mailbox_full", "domain_not_found").

El parser del bloque B debe aceptar que estos campos no estén y
caer a `outcome=bounced` genérico; el detalle queda en el raw.

### `emailsUnsubscribed.json`

Documentados: todos los comunes + `leadEmail`.

Supuestos:
- `unsubscribeReason`: por si Lemlist entrega el motivo cuando el
  lead usó el link con razón. Puede no venir.
- `source`: cómo se desuscribió (link, manual, importado). No está
  en doc; el parser lo trata como opcional.

### `emailsReplied.json`

Documentados: todos los comunes + `to`, `subject`,
`isThirdPartyReply: boolean`. La doc indica que
`isThirdPartyReply=true` omite `campaignId`, `leadId`, `sequenceId`.

Supuestos (necesarios para la tabla `replies`):
- `bodyText`: texto plano del reply. **CRÍTICO** — sin él no
  podemos guardar el reply ni leerlo en `/inbox`. Si Lemlist no lo
  envía por webhook, habrá que llamar a GET /activities después
  (bloque B debería contemplar ese fallback).
- `bodyHtml`: HTML del reply si viene.
- `messageId`: identificador SMTP; útil para threading si en el
  futuro queremos agrupar replies.
- `inReplyTo`: Message-ID del email al que responde.

Si `bodyText` NO viene en el webhook (dato real pendiente — primer
reply real nos lo dirá), el bloque B tendrá que hacer
`GET /api/activities?type=emailsReplied&contactId=...` para
recuperarlo. Alternativa: dejar `body_text=null` en `replies` y
rellenar con un backfill job.

### `emailsSent.json` (referencia, YA verificado)

Shape REAL del probe T025 contra `/api/activities?version=v2`
(2026-10-01, campaign cam_6jKax2A8y9tKKZPse). Guardado como
referencia de lo que SÍ sabemos del webhook. Todos los campos
listados aquí son observados en respuesta real; se consideran
"documentados por verificación en vivo".
