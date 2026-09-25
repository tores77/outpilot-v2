-- OUTPILOT v2 · scripts / backfill_review_reason.sql
--
-- T024 post-mortem: 61 leads con needs_review=true pero sin
-- custom_fields.review_reason (no se registraba en el pipeline de
-- limpieza previo). Este script infiere la razón cuando es
-- reconstruible desde los datos actuales.
--
-- Desglose del pool actual (61 needs_review sin razón):
--   60 con icp_score < 40 → low_score:<N> (razón: scoring anterior)
--    1 con local-part genérico (info@, hello@, etc.) → generic_email
--
-- Fuentes de review_reason reconstruibles:
--   - "low_score:<N>": scoring previo devolvió N < 40. Se conserva
--     el número exacto en la razón para trazabilidad.
--   - "generic_email": email cuyo local part coincide con la
--     blacklist de src/lib/nova/cleanup.ts (info@, hello@, sales@,
--     contact@, admin@, support@, hr@, jobs@, ...).
--   - Si no matchea nada conocido → review_reason='unknown_legacy',
--     para no perder la señal pero marcar que la razón es histórica.
--
-- Idempotente: solo escribe si review_reason no existe todavía.
-- Ejecutar antes: SELECT count(*) FROM leads WHERE needs_review
-- AND (custom_fields->>'review_reason') IS NULL;
-- Debe coincidir con la suma de las dos categorías.

set search_path = public;

-- 1) Genéricos (email local part conocido). Prioridad más alta:
--    aunque también tenga score bajo, el motivo dominante es
--    el mailbox genérico.
with generic_emails as (
  select id
  from leads
  where needs_review = true
    and (custom_fields->>'review_reason') is null
    and lower(split_part(email, '@', 1)) in (
      'info','hello','hi','hola','contact','contacto','contact-us',
      'contactus','sales','ventas','admin','office','oficina',
      'support','soporte','help','ayuda','team','equipo','mail',
      'correo','no-reply','noreply','notifications','marketing',
      'press','prensa','hr','rrhh','jobs','empleo','careers',
      'invoice','billing','facturacion'
    )
),
updated_generic as (
  update leads
  set custom_fields = coalesce(custom_fields, '{}'::jsonb)
    || jsonb_build_object('review_reason', 'generic_email')
  where id in (select id from generic_emails)
  returning id
),

-- 2) low_score: needs_review + icp_score < 40. Guarda el score
--    exacto en la razón (low_score:<N>) para trazabilidad.
low_score_rows as (
  select id, icp_score
  from leads
  where needs_review = true
    and (custom_fields->>'review_reason') is null
    and icp_score is not null
    and icp_score < 40
),
updated_low_score as (
  update leads
  set custom_fields = coalesce(leads.custom_fields, '{}'::jsonb)
    || jsonb_build_object('review_reason', 'low_score:' || ls.icp_score)
  from low_score_rows ls
  where leads.id = ls.id
  returning leads.id
),

-- 3) Resto: needs_review sin razón identificable → 'unknown_legacy'
remaining as (
  select id
  from leads
  where needs_review = true
    and (custom_fields->>'review_reason') is null
),
updated_unknown as (
  update leads
  set custom_fields = coalesce(custom_fields, '{}'::jsonb)
    || jsonb_build_object('review_reason', 'unknown_legacy')
  where id in (select id from remaining)
  returning id
)

select
  (select count(*) from updated_generic) as marked_generic_email,
  (select count(*) from updated_low_score) as marked_low_score,
  (select count(*) from updated_unknown) as marked_unknown_legacy;
