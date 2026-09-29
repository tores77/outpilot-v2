-- OUTPILOT v2 · scripts / fix_ibarmia_name_swap.sql
--
-- Ibarmia (lead a2242ed6-f571-4211-80b5-8a2fcea5dfcb) tiene first_name
-- y last_name intercambiados. Estado actual en BD:
--   first_name = 'Arandia'   (es el apellido)
--   last_name  = 'Koldo'     (es el nombre)
--   email      = 'koldo.arandia@ibarmia.com'
--
-- Si se sube así a Lemlist, el merge tag {{firstName}} escribiría
-- "Hola Arandia" en el email — quema el lead. Corrección manual antes
-- de que el guard detectNameSwap (volt-sync-leads) lo bloquee en el
-- próximo sync.
--
-- Guard de idempotencia en el WHERE: solo flippea si el estado sigue
-- siendo (Arandia, Koldo). Si alguien ya lo corrigió, no toca.

set search_path = public;

-- Pre-check: mostrar estado actual del lead + de cualquier
-- campaign_lead que lo apunte (puede haber marcas name_swapped_suspect
-- si ya se corrió un sync tras el deploy del guard).
select 'lead' as tipo, id, company, email, first_name, last_name,
       needs_review, custom_fields->>'review_reason' as motivo_actual
from leads
where id = 'a2242ed6-f571-4211-80b5-8a2fcea5dfcb';

select 'campaign_lead' as tipo, id, campaign_id, provider_lead_id,
       removed_at,
       personalization->>'name_swapped_suspect' as suspect_flag,
       personalization->>'name_swap_reason' as suspect_reason,
       personalization->>'name_swap_flagged_at' as flagged_at
from campaign_leads
where lead_id = 'a2242ed6-f571-4211-80b5-8a2fcea5dfcb';

-- 1. Flip first_name ↔ last_name. Guard idempotente en el WHERE.
update leads
set first_name = 'Koldo',
    last_name  = 'Arandia'
where id = 'a2242ed6-f571-4211-80b5-8a2fcea5dfcb'
  and first_name = 'Arandia'
  and last_name  = 'Koldo'
returning id, first_name, last_name, email;

-- 2. Limpiar las marcas name_swap_* del campaign_lead (si existen)
--    para que el próximo volt-sync-leads intente subirlo a Lemlist
--    ahora que el nombre está correcto. Mantiene el resto de
--    personalization (opener, fields_used, etc.) intacto.
update campaign_leads
set personalization = (
      (personalization::jsonb - 'name_swapped_suspect')
                             - 'name_swap_reason'
                             - 'name_swap_flagged_at'
    )
where lead_id = 'a2242ed6-f571-4211-80b5-8a2fcea5dfcb'
  and personalization ? 'name_swapped_suspect'
  and provider_lead_id is null
returning id, campaign_id,
          personalization->>'name_swapped_suspect' as suspect_flag_after;
