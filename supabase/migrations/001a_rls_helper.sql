-- OUTPILOT v2 — Migration 001a: RLS helper (hotfix over 001)
-- Fase 0 · T004 (aplicado post T003)
--
-- Rationale
-- ---------
-- The policies created in 001 encoded the canonical spec pattern
--     tenant_id in (select tenant_id from allowed_users where email = auth.jwt()->>'email')
-- directly inline. That works logically but is self-referential when applied
-- to allowed_users itself, and transitively when applied to tenants (the
-- subquery reads allowed_users, whose policy reads allowed_users again).
-- Postgres detects the cycle and aborts:
--     ERROR: infinite recursion detected in policy for relation "allowed_users"
--
-- Fix: extract the subquery into a SECURITY DEFINER function. The function
-- runs as its owner (which bypasses RLS for its own reads), so the policy
-- lookup no longer triggers the very policy it is trying to evaluate.
-- search_path is pinned to prevent search-path hijack attacks — this is the
-- standard hardening for SECURITY DEFINER functions.
--
-- Scope: rewrites the two policies from 001. Same semantics, no recursion.
-- Callback code (auth/callback/route.ts) needs no changes: it still queries
-- allowed_users with the caller's JWT and gets either the row (allowed) or
-- an empty result (rejected).

set search_path = public;

-- ===== SECURITY DEFINER helper =====

create function public.current_user_tenant_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select tenant_id
  from allowed_users
  where email = auth.jwt() ->> 'email'
  limit 1;
$$;

revoke execute on function public.current_user_tenant_id() from public;
grant  execute on function public.current_user_tenant_id() to authenticated;

-- ===== Recreate policies without recursion =====

drop policy if exists tenants_allowlisted       on tenants;
drop policy if exists allowed_users_same_tenant on allowed_users;

create policy tenants_allowlisted on tenants
  for all
  to authenticated
  using      (id = public.current_user_tenant_id())
  with check (id = public.current_user_tenant_id());

create policy allowed_users_same_tenant on allowed_users
  for all
  to authenticated
  using      (tenant_id = public.current_user_tenant_id())
  with check (tenant_id = public.current_user_tenant_id());
