-- OUTPILOT v2 · scripts / clear_stale_low_score_flags.sql
--
-- Post-mortem 2026-09-28: tras el primer rescore, aparecieron leads
-- con icp_score alto (p.ej. Stulz 82) pero review_reason='low_score:32'
-- del scoring anterior. El fix de nova-score (isScoringReviewReason)
-- + de nova_rescore_all.sql evita que el problema vuelva a aparecer
-- en re-runs, pero hay que limpiar los stale que quedaron atrapados.
--
-- Este script identifica leads con:
--   - needs_review = true
--   - review_reason que empieza por "low_score:"
--   - el número embebido en el motivo NO coincide con icp_score actual
-- y les limpia needs_review + borra review_reason. Los motivos de
-- pipeline (generic_email, data_mismatch) NO se tocan (el LIKE
-- 'low_score:%' filtra solo motivos del scoring).
--
-- === PASO 1: DRY-RUN (conteo + preview) ===
-- Ejecutar SOLO este bloque primero; verificar los números antes de
-- descomentar el UPDATE.

select count(*) as leads_to_clear
from leads
where needs_review = true
  and (custom_fields->>'review_reason') like 'low_score:%'
  and icp_score is not null
  and (
    nullif(
      substring((custom_fields->>'review_reason') from 'low_score:(\d+)'),
      ''
    )::int is distinct from icp_score
  );

-- Muestra los 10 primeros para revisión visual (empresa + score
-- nuevo vs número embebido en el motivo stale).
select id,
       company,
       icp_score as score_actual,
       custom_fields->>'review_reason' as motivo_stale,
       nullif(
         substring((custom_fields->>'review_reason') from 'low_score:(\d+)'),
         ''
       )::int as score_del_motivo
from leads
where needs_review = true
  and (custom_fields->>'review_reason') like 'low_score:%'
  and icp_score is not null
  and (
    nullif(
      substring((custom_fields->>'review_reason') from 'low_score:(\d+)'),
      ''
    )::int is distinct from icp_score
  )
order by icp_score desc
limit 10;

-- === PASO 2: APLICAR ===
-- Verifica el conteo del paso 1. Si te cuadra, descomenta el bloque
-- de abajo (quita el /* y el */) y vuelve a ejecutar el script.

/*
update leads
set needs_review = false,
    custom_fields = custom_fields - 'review_reason'
where needs_review = true
  and (custom_fields->>'review_reason') like 'low_score:%'
  and icp_score is not null
  and (
    nullif(
      substring((custom_fields->>'review_reason') from 'low_score:(\d+)'),
      ''
    )::int is distinct from icp_score
  )
returning id, company, icp_score, needs_review;
*/
