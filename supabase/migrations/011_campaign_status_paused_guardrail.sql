-- OUTPILOT v2 — Migration 011: campaign_status + 'paused_guardrail'
-- Fase 2 · T025 (bloque C — guardarraíles)
--
-- Añade el valor 'paused_guardrail' al enum campaign_status para
-- distinguir una pausa automática (bloque C: bounce o complaint
-- rate excedidos) de una pausa manual ('paused').
--
-- Semántica:
--   'paused'           — humano la pausó en /campaigns (o en Lemlist).
--                        Humano la reanuda cuando quiere.
--   'paused_guardrail' — el cron B detectó métricas por encima de
--                        umbral y la pausó automáticamente. Pere la
--                        revisa en /campaigns, decide por qué los
--                        números malos y, si quiere, la transiciona
--                        manualmente de vuelta a 'active'. El sistema
--                        NUNCA reanuda solo.
--
-- Reversibilidad: añadir un enum value es seguro (no requiere
-- backfill ni afecta a filas existentes). Quitarlo exigiría recrear
-- el enum, backfill de todas las columnas que lo usan y plan de datos.

set search_path = public;

alter type campaign_status add value if not exists 'paused_guardrail';
