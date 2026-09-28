-- OUTPILOT v2 · scripts / mark_frost_trol_website_mismatch.sql
--
-- Frost Trol (frost-trol.com, campaign_lead
-- 9198b76b-5ca7-45f3-8fce-5726827bc28c, lead
-- 11f18cc1-05d6-4ba8-b83d-33a303007dd4) tiene un caso nuevo de
-- taxonomía: dominio VIVO con contenido AJENO. Vibe le tenía la
-- descripción correcta (fabricantes de vitrinas refrigeradas) pero
-- el scrape del website devolvió una página de comparativas de
-- casinos online — el dominio está secuestrado / redirige a un
-- squatter. Lex ya lo detectó (personalization=generic con
-- reason_if_generic que menciona "casinos online").
--
-- Acción:
--   1. leads.needs_review = true + custom_fields.review_reason =
--      'website_mismatch' (nuevo motivo en la taxonomía).
--   2. campaign_leads.removed_at = now() para sacarlo del smoke
--      activo — el guard active_uniq lo permite (removed_at != NULL
--      liberará el par si algún día se re-añade con dominio limpio).
--
-- Nueva taxonomía review_reason (T024): añade 'website_mismatch'
-- al set conocido {generic_email, data_mismatch, low_score:*,
-- sector_unknown, secondary_decider_cap:*,
-- firmographics_domain_unverified:*, foreign_subsidiary, unknown_legacy}.
-- Semántica: el dominio del lead responde HTTP 200 pero el contenido
-- no pertenece a la empresa declarada.

set search_path = public;

-- Pre-check: verificar que el lead y el campaign_lead existen tal cual.
select 'lead' as tipo, id, company, email, website, needs_review,
       custom_fields->>'review_reason' as motivo_actual
from leads
where id = '11f18cc1-05d6-4ba8-b83d-33a303007dd4';

select 'campaign_lead' as tipo, id, campaign_id, lead_id, removed_at,
       personalization->>'personalization' as personalization_status,
       personalization->>'reason_if_generic' as reason_actual
from campaign_leads
where id = '9198b76b-5ca7-45f3-8fce-5726827bc28c';

-- 1. Marcar el lead needs_review + review_reason=website_mismatch.
update leads
set needs_review = true,
    custom_fields = coalesce(custom_fields, '{}'::jsonb)
      || jsonb_build_object('review_reason', 'website_mismatch')
where id = '11f18cc1-05d6-4ba8-b83d-33a303007dd4'
returning id, company, needs_review, custom_fields->>'review_reason' as motivo;

-- 2. Sacar el campaign_lead del smoke (removed_at = now()).
--    Guard: solo si sigue activo (removed_at IS NULL). Idempotente.
update campaign_leads
set removed_at = now()
where id = '9198b76b-5ca7-45f3-8fce-5726827bc28c'
  and removed_at is null
returning id, campaign_id, lead_id, removed_at;
