-- OUTPILOT v2 · scripts / nova_rescore_all.sql
--
-- T024 post-mortem: los 119 leads Vibe puntuados con el prompt viejo
-- (que traía un ICP genérico cosido) están mal valorados. Fabricantes
-- industriales (Intarcon, Keyter, Prodesa) quedaron en 42-45 cuando
-- son fit; e-commerces D2C (Sklum, Gandia Blasco) subieron a 72
-- cuando NO son fit. Además el caso Linq (72 por sector inventado)
-- muestra que el gate anti-fabricación de sector es imprescindible.
--
-- Este script resetea:
--   - icp_score → NULL
--   - scoring_claimed_at → NULL (por si algún claim quedó stuck)
--   - scoring_error → NULL (borrar marcas de batches fallidos)
--   - estado → 'NUEVO' si estaba EN_RADAR (para que la promoción se
--     recalcule con el prompt nuevo)
--
-- Alcance: leads de source='vibe_prospecting' que NO estén en campañas
-- activas (campaign_leads con removed_at IS NULL). Los que ya están
-- sincronizados a Lemlist NO se tocan.
--
-- Coste aproximado del re-scoring: 119 leads × $0.08/batch de 20 =
-- ~$0.48. Se registra en api_costs por batch (nova.score).
--
-- Idempotente: correr varias veces = mismo resultado en filas que
-- cumplen las condiciones. Verificar el RETURNING antes de ejecutar.

set search_path = public;

update leads
set icp_score = null,
    scoring_claimed_at = null,
    scoring_error = null,
    estado = case when estado = 'EN_RADAR' then 'NUEVO' else estado end
where source = 'vibe_prospecting'
  and icp_score is not null
  and id not in (
    select lead_id from campaign_leads where removed_at is null
  )
returning id, company, sector, estado;
