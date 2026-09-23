-- OUTPILOT v2 — Actualiza in-place la campaña "Industrial Premium ES · Smoke 50"
-- para T022 sin reemplazar el body del step 1 (preserva las ediciones de Pere:
-- {{signature}} doble corregido, delay del paso 3 ajustado, etc.).
--
-- Cambios:
--   (a) Inserta <p>{{opener}}</p> justo tras el <p>Hola {{firstName}},</p>
--       del step 1 (replace exacto, no regex).
--   (b) Quita del step 1 el <p>He estado viendo {{companyName}}...</p> que
--       ahora vive en openerFallback (dos replaces por si el textarea
--       normalizó a \r\n en vez de \n).
--   (c) Añade openerFallback al top-level del sequence jsonb.
--
-- RETURNING valida los tres cambios.
--
-- Aplicar (dollar-quotes requieren -f, no -c):
--   psql "$SUPABASE_DB_URL" -f supabase/scripts/t022_smoke50_opener.sql

update campaigns
set sequence = jsonb_set(
  jsonb_set(
    sequence,
    '{steps,0,bodyHtml}',
    to_jsonb(
      -- (b) quita el párrafo "He estado viendo..." con su newline (soporta \n y \r\n).
      replace(
        replace(
          -- (a) inserta <p>{{opener}}</p> tras el saludo.
          replace(
            sequence->'steps'->0->>'bodyHtml',
            '<p>Hola {{firstName}},</p>',
            '<p>Hola {{firstName}},</p>' || E'\n' || '<p>{{opener}}</p>'
          ),
          '<p>He estado viendo {{companyName}} y se nota el nivel del producto que tenéis. Cuando uno compite con italianos y franceses en vuestra categoría, eso solo se consigue con años de oficio detrás.</p>' || E'\r\n',
          ''
        ),
        '<p>He estado viendo {{companyName}} y se nota el nivel del producto que tenéis. Cuando uno compite con italianos y franceses en vuestra categoría, eso solo se consigue con años de oficio detrás.</p>' || E'\n',
        ''
      )
    )
  ),
  '{openerFallback}',
  to_jsonb(
    $fb$He estado viendo {{companyName}} y se nota el nivel del producto que tenéis. Cuando uno compite con italianos y franceses en vuestra categoría, eso solo se consigue con años de oficio detrás.$fb$::text
  )
)
where name = 'Industrial Premium ES · Smoke 50'
  and status = 'draft'
returning
  id,
  name,
  sequence->>'openerFallback' as opener_fallback,
  case
    when sequence->'steps'->0->>'bodyHtml' like '%<p>{{opener}}</p>%'
      then 'OK: {{opener}} insertado'
    else 'FAIL: {{opener}} no aparece'
  end as opener_check,
  case
    when sequence->'steps'->0->>'bodyHtml' like '%He estado viendo%'
      then 'FAIL: la frase original sigue en el body'
    else 'OK: frase eliminada del body'
  end as fallback_extraction_check,
  left(sequence->'steps'->0->>'bodyHtml', 100) as step1_preview_head,
  right(sequence->'steps'->0->>'bodyHtml', 60) as step1_preview_tail;
