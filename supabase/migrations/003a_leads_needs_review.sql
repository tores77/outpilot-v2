-- OUTPILOT v2 — Migration 003a: needs_review flag on leads
-- Fase 1 · T013
--
-- Adds a boolean flag the cleanup pipeline sets when a lead should be
-- audited by a human before entering a sequence. Trigger de referencia:
-- prefijo genérico del email (info@, hello@, sales@, ...). REVIEW no es
-- valor del enum lead_estado — decisión ya tomada en spec §3 aclaración
-- R2 y confirmada en T008.
--
-- Índice parcial: solo cubre las filas pendientes de revisión, que son
-- una minoría, así que el overhead de escritura es mínimo y la lectura
-- para "cola de REVIEW" es directa.

set search_path = public;

alter table leads
  add column needs_review boolean not null default false;

comment on column leads.needs_review is
  'Set by Nova cleanup (T013) when the lead needs human review before '
  'entering a sequence. Typical trigger: generic email prefix '
  '(info@, hello@, sales@, ...). REVIEW is not a lead_estado value.';

create index leads_tenant_needs_review_idx
  on leads(tenant_id, needs_review)
  where needs_review = true;
