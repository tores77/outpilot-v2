-- OUTPILOT v2 · scripts / release_stuck_scoring_claims.sql
--
-- Post-mortem 2026-09-25 (run 01M3CJ4MBAY12EJQ1B2TH4KHKW): 20 leads
-- quedaron con scoring_claimed_at seteado después de que Pere
-- cancelase a mano el bucle infinito de nova-score. La causa raíz
-- (max_tokens=3000 truncaba el JSON) queda arreglada en el mismo
-- commit; los leads necesitan volver a "pendiente" para que el
-- próximo click los reclame de nuevo — esta vez con max_tokens=16000
-- + el guard scoring_error que rompe el bucle si vuelve a fallar.
--
-- Este script libera SOLO los claims stuck cuyo icp_score sigue NULL
-- (no toca leads ya puntuados ni marcados con scoring_error). Idempotente:
-- correr N veces = mismo resultado. Verificar el RETURNING antes de
-- ejecutar en prod.

update leads
set scoring_claimed_at = null
where scoring_claimed_at is not null
  and icp_score is null
  and scoring_error is null
returning id, first_name, company, scoring_claimed_at;
