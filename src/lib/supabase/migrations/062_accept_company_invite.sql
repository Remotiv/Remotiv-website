-- ============================================================================
-- Migration 062 - accept_company_invite: an invitation is redeemed, and the
--                 membership granted, in ONE transaction that also proves the
--                 inviter is still an active owner or admin (#49, QA-SAFETY-40 T-1)
-- ----------------------------------------------------------------------------
-- NOT RUN YET. Apply by hand in the Supabase SQL editor: STAGING first (and run
-- the two race proofs in scripts/staging/proofs-062.mjs), then PRODUCTION,
-- BEFORE the application code that calls this function is deployed. Until it
-- exists, every invitation acceptance fails closed (the app gets PGRST202 and
-- shows its generic join failure).
--
-- ── Why ──────────────────────────────────────────────────────
--
-- An invitation used to outlive the admin who sent it: removed or demoted, the
-- admin's pending invitations still redeemed (#40 I3, reproduced on staging).
-- acceptInvite burned the invite and wrote the membership as separate
-- PostgREST statements, each committed on its own, so no application-level
-- check of the inviter could be atomic with the grant: a removal could land
-- between the check and the write.
--
-- Here the whole decision is one transaction:
--
--   1. the invite row is locked FOR UPDATE (pending, unexpired);
--   2. p_email must be the invited address, and p_user_id must be an Auth user
--      with that address (the caller cannot bind the invitation to someone
--      else, even by mistake);
--   3. the inviter's membership row is locked FOR SHARE, and must be active
--      with role owner or admin, in the invite's company;
--   4. the invite is burned and the membership granted (057's rules).
--
-- ── The race, and why it is closed ──────────────────────────
--
-- Removal and demotion are plain UPDATEs of the inviter's company_members row
-- (status or role), which take a FOR NO KEY UPDATE row lock; FOR SHARE
-- conflicts with it. So:
--
--   * removal/demotion commits first: step 3 waits for it, then, under READ
--     COMMITTED, re-evaluates its WHERE clause against the NEW row version,
--     matches nothing and the function returns 'inviter_invalid'. Nothing is
--     burned, nothing is granted.
--   * acceptance locks first: the removal/demotion waits until this
--     transaction commits; the membership was granted while the inviter was
--     still authorised, and the removal/demotion then applies.
--
-- There is no moment at which an unauthorised membership is visible: nothing
-- this function writes is committed before it returns.
--
-- Lock order is invite, then inviter membership, then the joiner's membership.
-- The application's removeMember and updateMemberRole revoke the inviter's
-- pending invitations (company_invites) BEFORE they write company_members, the
-- same order, so the two cannot deadlock. A revoke that waits on this
-- function's invite lock then finds the invite 'accepted' and matches nothing.
--
-- ── Outcomes (returned, never raised, except a genuine error) ──
--
--   joined           a membership was inserted, reactivated or activated
--   already_member   an active membership already existed; the invite is spent
--   invalid          no invite with that token hash
--   not_pending      accepted, revoked or expired by status
--   expired          past expires_at
--   email_mismatch   p_email is not the invited address
--   user_mismatch    p_user_id is not an Auth user with the invited address
--   inviter_invalid  invited_by is NULL, or no longer an active owner/admin
--   stale_removal    the joiner's row is removed and the invite predates its
--                    most recent removal (057); the invite is spent
--   status_changed   a legacy non-active row that does not satisfy 057's
--                    invariant; the invite is spent
--
-- The last two keep today's behaviour: the invite is consumed and a fresh
-- invitation is the way back.
--
-- SECURITY DEFINER with search_path = '' and every reference schema-qualified,
-- so no object on the caller's path can be substituted. EXECUTE for
-- service_role only.
--
-- Rollback: drop function public.accept_company_invite(text, uuid, text, text);
-- (the application code must be reverted first, or every acceptance fails).
-- ============================================================================

begin;

set local lock_timeout = '5s';

create or replace function public.accept_company_invite(
  p_token_hash text,
  p_user_id uuid,
  p_name text,
  p_email text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  inv record;
  member record;
  invited_email text;
begin
  select i.id, i.company_id, i.email, i.role, i.status, i.expires_at, i.created_at, i.invited_by
    into inv
    from public.company_invites i
   where i.token_hash = p_token_hash
   for update;
  if not found then
    return 'invalid';
  end if;
  if inv.status <> 'pending' then
    return 'not_pending';
  end if;
  if inv.expires_at <= pg_catalog.now() then
    return 'expired';
  end if;

  invited_email := pg_catalog.lower(pg_catalog.btrim(inv.email));
  if p_email is null or pg_catalog.lower(pg_catalog.btrim(p_email)) <> invited_email then
    return 'email_mismatch';
  end if;

  perform 1
     from auth.users u
    where u.id = p_user_id
      and pg_catalog.lower(pg_catalog.btrim(u.email)) = invited_email;
  if not found then
    return 'user_mismatch';
  end if;

  if inv.invited_by is null then
    return 'inviter_invalid';
  end if;
  perform 1
     from public.company_members m
    where m.company_id = inv.company_id
      and m.user_id = inv.invited_by
      and m.status = 'active'
      and m.role in ('owner', 'admin')
      for share;
  if not found then
    return 'inviter_invalid';
  end if;

  update public.company_invites
     set status = 'accepted', accepted_at = pg_catalog.now()
   where id = inv.id;

  select m.id, m.status, m.removed_at
    into member
    from public.company_members m
   where m.company_id = inv.company_id
     and m.user_id = p_user_id
     for update;

  if not found then
    insert into public.company_members (company_id, user_id, name, email, role, status)
    values (inv.company_id, p_user_id, p_name, invited_email, inv.role, 'active');
    return 'joined';
  end if;

  if member.status = 'active' then
    return 'already_member';
  end if;

  if member.status = 'removed' then
    -- 057: only an invitation created AFTER the most recent removal brings a
    -- removed member back. A NULL removed_at fails closed; equal is refused.
    if member.removed_at is null or not (member.removed_at < inv.created_at) then
      return 'stale_removal';
    end if;
  elsif member.removed_at is not null then
    -- A legacy non-active row is activated only under 057's invariant.
    return 'status_changed';
  end if;

  update public.company_members
     set status = 'active', role = inv.role, name = p_name, email = invited_email
   where id = member.id;
  return 'joined';
end;
$$;

revoke all on function public.accept_company_invite(text, uuid, text, text) from public;
revoke all on function public.accept_company_invite(text, uuid, text, text) from anon, authenticated;
grant execute on function public.accept_company_invite(text, uuid, text, text) to service_role;

commit;

-- ── Post-check (read-only), run after the commit ────────────────────────────
--
--   select p.proname, p.prosecdef, p.proconfig,
--          pg_catalog.has_function_privilege('anon', p.oid, 'execute') as anon_exec,
--          pg_catalog.has_function_privilege('authenticated', p.oid, 'execute') as auth_exec,
--          pg_catalog.has_function_privilege('service_role', p.oid, 'execute') as service_exec
--     from pg_catalog.pg_proc p
--     join pg_catalog.pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public' and p.proname = 'accept_company_invite';
--
-- Expect one row: prosecdef = true, proconfig = {search_path=""},
-- anon_exec = false, auth_exec = false, service_exec = true.
