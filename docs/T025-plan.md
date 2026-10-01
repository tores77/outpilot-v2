# T025 — Plan de migración 010 (replies + outcomes + alerts)

Documento vivo. Propuesta de esquema para bloques B (procesado) y
C (guardarraíles). **No es migración todavía** — Pere lo revisa, se
discute por partes, luego se escribe el .sql y se aplica.

Fuentes:
- Pedido original de T025 (chat 2026-09-30).
- Hallazgo sobre payload.secret (Lemlist doc oficial 2026-10-01).
- Shape real del probe `/api/activities` para `emailsSent`
  (`/tmp/activities-probe.json`, no persistido).
- Documentación oficial de "Available event types" en
  `developer.lemlist.com/api-reference/endpoints/webhooks/add-webhook`
  (campos comunes vs específicos por tipo).

## Semántica de columnas vs. eventos

Lemlist entrega **eventos puntuales** (`emailsSent`, `emailsBounced`,
...). Nuestras tablas los agregan en **estado derivado** por
`campaign_lead`. La separación clave:

| Nivel                       | Fuente de verdad                    |
|-----------------------------|-------------------------------------|
| Eventos crudos              | `lemlist_events` (ya existe, 009)   |
| Estado agregado del lead    | `campaign_leads.outcome` (nuevo)    |
| Replies con texto           | `replies` (nueva tabla)             |
| Alertas / incidencias       | `alerts` (nueva tabla)              |

El job `echo-process-lemlist-event` lee de `lemlist_events` y escribe
en los agregados. Un evento procesado puede escribir en 0, 1 o 2
agregados (ej. un `emailsReplied` toca `campaign_leads.outcome` **y**
inserta en `replies`).

## 1 · `campaign_leads.outcome` (nueva columna)

### Propuesta de enum

```sql
create type campaign_lead_outcome as enum (
  'pending',       -- aún no se envió (default)
  'sent',          -- al menos un emailsSent
  'bounced',       -- emailsBounced (soft o hard — ver nota)
  'unsubscribed',  -- emailsUnsubscribed / entityUnsubscribed
  'replied',       -- emailsReplied (al menos uno)
  'interested',    -- labelado como interesado (humano o Lemlist)
  'not_interested' -- labelado como no interesado
);
```

### Columnas nuevas sobre `campaign_leads`

| Columna              | Tipo                              | Default | Nulable |
|----------------------|-----------------------------------|---------|---------|
| `outcome`            | `campaign_lead_outcome`           | pending | NO      |
| `outcome_set_at`     | `timestamptz`                     | null    | SÍ      |
| `last_event_at`      | `timestamptz`                     | null    | SÍ      |
| `label`              | `text`                            | null    | SÍ      |
| `labeled_by`         | `text`                            | null    | SÍ      |
| `labeled_at`         | `timestamptz`                     | null    | SÍ      |

### Reglas de transición (monotónicas, nunca degradan)

Idéntico a `review_reason`: solo se avanza. Un lead en `replied` no
degrada a `sent` si llega otro `emailsSent` tardío.

Orden terminal:
`pending < sent < {bounced, unsubscribed, replied} < {interested, not_interested}`

La lógica vive en una función pura
`src/lib/channels/outcome-transition.ts` para que sea testeable sin
BD.

### `label` vs. `outcome`

- `outcome` es el ESTADO del lead (automático, derivado de eventos).
- `label` es el JUICIO HUMANO sobre el reply ("interesado", "no
  ahora", "no interesado", "fuera de ICP", "baja"). Lo pone Pere en
  `/inbox` (bloque E) o automáticamente si Lemlist envía
  `emailsInterested`/`emailsNotInterested`.
- `labeled_by`: `"human"` | `"lemlist"` | `"system"`.
- `labeled_at`: cuándo se puso el label (independiente de
  `outcome_set_at`).

### Nota sobre `bounced` soft vs hard

Lemlist no distingue soft/hard en el type `emailsBounced` (observado
en los campos documentados). Dos opciones:

- (a) Un solo `outcome=bounced`; el detalle (código SMTP, razón) se
  conserva en `lemlist_events.payload`. Si en el futuro necesitamos
  distinguir, se añade una columna derivada.
- (b) Dos outcomes `bounced_soft` / `bounced_hard` desde el día 1 y
  mapping en el job. Riesgo: no sabemos el shape del campo "reason"
  hasta ver un bounce real.

**Recomendación: (a)** — YAGNI; el detalle vive en el raw.

## 2 · `replies` (nueva tabla)

Almacena el TEXTO de cada reply recibido vía webhook. Un reply = una
fila. Si el mismo lead responde dos veces, dos filas.

```sql
create table replies (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references tenants(id),
  campaign_lead_id   uuid not null references campaign_leads(id),
  lemlist_event_id   uuid references lemlist_events(id),  -- traza al raw
  received_at        timestamptz not null,                -- payload.createdAt
  from_email_hash    text,                                -- SHA-256
  subject            text,
  body_text          text,
  body_html          text,
  is_third_party     boolean not null default false,      -- Lemlist flag
  label              text,                                -- interesado | no_ahora | no_interesado | fuera_de_icp | baja
  labeled_by         text,                                -- human | lemlist | system
  labeled_at         timestamptz,
  created_at         timestamptz not null default now()
);
```

### Decisiones

- `campaign_lead_id` NOT NULL: un reply siempre pertenece a un
  campaign_lead. Si Lemlist envía un reply sin match (improbable
  con el `isThirdPartyReply=true`), el job lo deja en
  `lemlist_events` con `processing_error = reply_lead_not_found` y
  no inserta en `replies`.
- `lemlist_event_id` nullable: por si en el futuro añadimos replies
  manuales desde Gmail/Unipile sin pasar por Lemlist.
- `is_third_party`: la doc oficial dice que
  `isThirdPartyReply: true` **omite** `campaignId`/`leadId`/`sequenceId`.
  Si llega así, procesar es ambiguo — probablemente también cae a
  cuarentena en `lemlist_events`.
- RLS tenant-isolation estándar.

### Transición de `campaign_leads.outcome` al recibir reply

- `pending` → `replied`.
- `sent` → `replied`.
- `bounced` → `replied` (raro pero posible: SMTP rebotó la primera,
  mailbox llegó a la segunda).
- `unsubscribed` → **no** transiciona (regla: unsubscribed es
  terminal; el reply queda en `replies` para auditoría pero el
  outcome no cambia).

## 3 · `alerts` (nueva tabla)

Mensajes para que Pere vea algo que requiere su atención en
`/campaigns` (bloque E, pendiente). Vida corta: se marcan `read_at`
cuando Pere los descarta.

```sql
create table alerts (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id),
  kind          text not null,                       -- bounce_rate_exceeded | complaint_rate_exceeded | campaign_status_drift | ...
  severity      text not null default 'info',        -- info | warning | critical
  campaign_id   uuid references campaigns(id),       -- null si no es por campaña
  payload       jsonb not null,                      -- detalle estructurado
  created_at    timestamptz not null default now(),
  read_at       timestamptz,
  resolved_at   timestamptz                          -- distinto de read: el humano lo marcó resuelto
);

create index alerts_tenant_unread_idx
  on alerts(tenant_id, created_at desc)
  where read_at is null;
```

### Fuentes previstas

- `kind=bounce_rate_exceeded`: emitido por bloque C cuando
  `bounced / sent > 0.02` con `sent >= 20` en 24h. Payload incluye
  los números.
- `kind=complaint_rate_exceeded`: igual, umbral `> 0.001` (Lemlist
  no reporta complaints como type separado; probablemente deriva de
  `emailsBounced` con razón "complaint" o similar — pendiente de
  verificar con el primer bounce real).
- `kind=campaign_status_drift`: alternativa a los eventos
  `campaigns.status_drift` ya emitidos por el bloque D. **Decisión
  pendiente**: ¿los movemos a `alerts` o los dejamos en `events`?
  Mi recomendación: dejar en `events` como está (son informativos,
  no urgentes); `alerts` reservado para cosas que requieren acción
  humana.

### Severity

- `info`: Pere lo verá si abre la bandeja, no urge.
- `warning`: Pere debería mirarlo hoy.
- `critical`: Pere lo mira ya (idealmente ping Slack / email,
  bloque futuro).

## 4 · Orden de aplicación

1. **010a** o `010_outcomes_and_replies.sql`: enum + columnas en
   `campaign_leads` + tabla `replies`.
2. **010b** o `010_alerts.sql`: tabla `alerts`. Puede ir aparte si
   queremos ir por partes.
3. `gen-types` después de cada aplicación.

Mi recomendación: **una sola migración 010** con las tres cosas,
porque:
- El job de B necesita las tres a la vez (toca outcome en
  campaign_leads al mismo tiempo que inserta en replies).
- El guardarraíl de C (bloque C, pendiente) usa `alerts`.

## 5 · Pendiente de confirmar con Pere

1. **Enum `campaign_lead_outcome`** (vs text libre). Mi recomendación:
   enum, para que el gate humano sepa que no hay valores sorpresa en
   SQL. Si quieres mantener text libre (como ya hace `review_reason`),
   lo cambio.
2. **Hard vs soft bounce**: ir con `outcome=bounced` único (opción
   a) o distinguir desde el día 1 (opción b). Mi recomendación: (a),
   YAGNI, el detalle vive en el raw.
3. **`campaigns.status_drift` → `alerts` o `events`**: hoy va en
   `events` (bloque D). ¿Lo mantenemos o lo migramos a `alerts` para
   que Pere lo vea en la bandeja? Mi recomendación: `events` como
   está — los drifts son informativos; `alerts` para acción urgente.
4. **Columna `labeled_by`**: ¿usamos un enum o text libre? Mi
   recomendación: text libre con valores conocidos
   (`human`|`lemlist`|`system`), más fácil de ampliar.
5. **Separación en dos migraciones (010a + 010b)**: ¿preferís una
   sola o dos? Mi recomendación: una sola (las tres cosas se usan
   juntas por B+C).

## Resumen de superficie nueva

- 1 enum nuevo: `campaign_lead_outcome`.
- 6 columnas nuevas en `campaign_leads`: outcome, outcome_set_at,
  last_event_at, label, labeled_by, labeled_at.
- 2 tablas nuevas: `replies`, `alerts`.
- 2 índices nuevos: `alerts_tenant_unread_idx`,
  `replies_tenant_received_idx` (lookup para /inbox).
