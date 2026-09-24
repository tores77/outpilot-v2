-- OUTPILOT v2 — Ajusta "Industrial Premium ES · Smoke 50" para que los
-- steps 2 y 3 se envíen como respuesta en el hilo del step 1 (T023 fix).
--
-- Comportamiento documentado de Lemlist: si un step de tipo email se
-- envía sin subject, Lemlist lo manda como reply del step anterior
-- (mismo Message-ID / In-Reply-To). Mejora la tasa de apertura de los
-- follow-ups y mantiene el hilo continuo en la bandeja del lead.
--
-- Cambio: elimina la clave `subject` del jsonb de los steps 2 y 3.
-- Usa el operador `-` de jsonb (quita la clave), NO SET '' (empty).
-- El schema Zod de sequence.ts trata undefined y "" como equivalentes,
-- pero el mapper de Volt (composeAddStepBody) OMITE la clave subject
-- cuando la ve vacía, así que ambos resultados serían idempotentes al
-- enviar a Lemlist. Aun así preferimos "sin clave" por limpieza del
-- jsonb persistido.
--
-- Aplicar (dollar-quotes requieren -f, no -c):
--   psql "$SUPABASE_DB_URL" -f supabase/scripts/t023_smoke50_thread.sql
--
-- RETURNING valida con dos checks (step 2 y step 3 sin subject) más
-- el subject del step 1 (que sigue siendo obligatorio).

update campaigns
set sequence = jsonb_set(
  jsonb_set(
    sequence,
    '{steps,1}',
    (sequence->'steps'->1) - 'subject'
  ),
  '{steps,2}',
  (sequence->'steps'->2) - 'subject'
)
where name = 'Industrial Premium ES · Smoke 50'
  and status = 'draft'
returning
  id,
  name,
  sequence->'steps'->0->>'subject' as step1_subject_still_required,
  case
    when sequence->'steps'->1 ? 'subject'
      then 'FAIL: step 2 aún tiene clave subject'
    else 'OK: step 2 sin subject (reply-thread)'
  end as step2_thread_check,
  case
    when sequence->'steps'->2 ? 'subject'
      then 'FAIL: step 3 aún tiene clave subject'
    else 'OK: step 3 sin subject (reply-thread)'
  end as step3_thread_check;
