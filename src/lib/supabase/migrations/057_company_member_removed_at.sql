-- ============================================================================
-- Migration 057 - company_members.removed_at: a stale invitation can never
--                 reactivate a removed member (#100)
-- ----------------------------------------------------------------------------
-- NOT RUN YET. Run by hand in the Supabase SQL editor: one paste, one
-- execution, one transaction. Nothing in the repository executes it.
--
-- PRODUCTION SCHEMA, read by Waleed on 10 Nov 2026, which this file rests on:
--
--   company_invites.created_at   timestamptz NOT NULL default now()
--   company_invites.status       CHECK in (pending, accepted, expired, revoked)
--   company_invites              UNIQUE (token_hash)
--   company_members              UNIQUE (company_id, user_id)
--   company_members.status       CHECK in (active, invited, removed), default active
--   company_members.email        text, NULLABLE
--   company_members              has no removed_at; no triggers on either table
--   max(company_invites.created_at) about 1h44m behind now(); 1 pending invite
--
-- So the comparison below rests on a timestamp the DATABASE writes, and the
-- backfill resolves to now() on today's data.
--
-- ── Why ──────────────────────────────────────────────────────
--
-- Since #100 an invitation accepted by a removed member REACTIVATES their
-- surviving company_members row instead of colliding on (company_id,
-- user_id). removeMember revokes that company's pending invitations for the
-- member's address first, but two cases get past it: an invitation already
-- burned when the removal runs (the acceptance then resumes and reactivates),
-- and an invitation sent to a different address than the member row holds
-- (updateOwnAccount changes the auth email and updates only one company's
-- row, settings/actions.ts:271-295). Both are reproduced by the team tests'
-- cases 7c and 7d, which fail until this lands.
--
-- THE RULE: an invitation created before the member's most recent removal
-- must never reactivate them; one created after it may. The membership row
-- gets the time of its most recent removal, written by the database, and the
-- acceptance reactivates with ONE conditional UPDATE whose predicate compares
-- that time with the invitation's server-written created_at.
--
-- ── What the column means ────────────────────────────────────
--
--   status = 'removed'   removed_at IS the time of the most recent removal
--   any other status     removed_at is NULL: no removal is in effect
--
-- Both halves are enforced by the CHECK in step 4, which is what makes a
-- disabled or dropped trigger FAIL LOUDLY at either transition rather than
-- store a wrong or stale value silently:
--
--   - the application never sends removed_at. If it sent a client clock and
--     the trigger were disabled, the CHECK would be satisfied by that clock
--     and a wrong value stored without a sound. With the column written only
--     here, a disabled trigger makes the removal fail against the CHECK.
--     Fail loud beats store wrong. Do not add the field back in the app.
--   - reactivation clears removed_at (step 2, the transition out). Without
--     that, a rejoin followed by a second removal with the trigger disabled
--     would keep the FIRST removal's timestamp, satisfy a one-sided CHECK, and
--     let an invitation issued between the two removals reactivate the member
--     after the second. The two-sided CHECK refuses the reactivation itself
--     when the trigger is not there to clear the column.
--
-- ── Before running: confirm the column is absent ─────────────
--
-- select count(*) as removed_at_columns
--   from information_schema.columns
--  where table_schema = 'public' and table_name = 'company_members'
--    and column_name = 'removed_at';                                        -- 0
-- select max(created_at) as latest_invitation, now() as apply_clock
--   from public.company_invites;                       -- latest < apply_clock
-- ============================================================================

begin;

-- The ALTERs in steps 1 and 4 take ACCESS EXCLUSIVE on company_members and
-- hold it until commit. If a long transaction already holds a lock on the
-- table, the ALTER would wait and every reader and writer would queue behind
-- it. Fail fast instead: the migration rolls back whole, and is run again.
set local lock_timeout = '5s';

-- ── 1. The column ────────────────────────────────────────────
--
-- Nullable, no default: NULL means no removal is in effect. No index: the
-- column is read only in the predicate of a single-row UPDATE by primary key
-- (the acceptance's reactivation), and nothing scans by it.

alter table public.company_members
  add column if not exists removed_at timestamptz;

-- ── 2. The database owns the value ───────────────────────────
--
-- BEFORE UPDATE OF status, both transitions:
--   into 'removed'    removed_at := clock_timestamp()   (the most recent removal)
--   out of 'removed'  removed_at := null                (no removal in effect)
-- An UPDATE that does not touch status never reaches this trigger, and an
-- UPDATE that sets status to its current value changes nothing here.
--
-- clock_timestamp(), NOT now(). now() is the transaction's start time: if the
-- removal's UPDATE waited on a lock, now() would record a moment EARLIER than
-- the removal actually happened, and an invitation created inside that wait
-- would compare as newer and reactivate. clock_timestamp() is the wall clock
-- at the instant the row is written. Milliseconds, not a real-world hole, but
-- free to close and strictly the safer direction.
--
-- What stays on now(): the backfill in step 3 and the invariant block in step
-- 5 are migration-time statements, where transaction time is the right time;
-- and company_invites.created_at keeps its existing default now(), which this
-- migration does not touch. Mixing the two makes a removed_at marginally LATER
-- relative to a created_at written in the same instant, which refuses more
-- invitations rather than fewer: the safe side of the strict less-than.
-- Nothing else in this file should move to clock_timestamp().

create or replace function public.company_members_stamp_removed()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.status = 'removed' and old.status is distinct from 'removed' then
    new.removed_at := clock_timestamp();
  elsif new.status <> 'removed' and old.status = 'removed' then
    new.removed_at := null;
  end if;
  return new;
end;
$$;

drop trigger if exists company_members_stamp_removed on public.company_members;
create trigger company_members_stamp_removed
  before update of status on public.company_members
  for each row execute function public.company_members_stamp_removed();

-- ── 3. The backfill ──────────────────────────────────────────
--
-- Rows already 'removed' have no history, so the only safe statement about
-- them is "removed after every invitation that exists today": then nothing
-- already issued can reactivate anyone, and a fresh invitation (created after
-- this apply) can. greatest() of two arms, although now() wins on today's
-- data (the latest invitation is about 1h44m behind it):
--   - now(): later than every created_at the database wrote, on a correct clock
--   - max(created_at) + 1 second: the guard for a clock that is somehow behind
--     the one that wrote the invitations, so the backfill can never land at or
--     before an existing invitation even then
-- Active and invited rows are not touched: NULL is their correct value.

update public.company_members
   set removed_at = greatest(
         now(),
         (select coalesce(max(created_at), now()) from public.company_invites) + interval '1 second'
       )
 where status = 'removed'
   and removed_at is null;

-- ── 4. The invariant, structural ─────────────────────────────
--
-- Two-sided on purpose (see the header): a removed row always carries its
-- timestamp, and a row that is not removed never does.

alter table public.company_members
  drop constraint if exists company_members_removed_at_matches_status,
  add constraint company_members_removed_at_matches_status
    check ((status = 'removed') = (removed_at is not null));

-- ── 5. THE INVARIANT, asserted before commit ─────────────────
--
-- The CHECK above would already have refused the commit if step 3 had left a
-- removed row unstamped, or if an active row carried a stamp. This block says
-- so in words, with counts, so a failure names what it found rather than a
-- constraint name; and it covers the one shape the CHECK cannot see, a
-- backfilled stamp that is NOT later than the latest invitation.

do $$
declare
  n_unstamped bigint;
  n_stamped_active bigint;
  n_not_after bigint;
begin
  select count(*) into n_unstamped
    from public.company_members where status = 'removed' and removed_at is null;
  select count(*) into n_stamped_active
    from public.company_members where status <> 'removed' and removed_at is not null;
  select count(*) into n_not_after
    from public.company_members m
   where m.status = 'removed'
     and m.removed_at <= (select coalesce(max(created_at), '-infinity') from public.company_invites);
  if n_unstamped > 0 or n_stamped_active > 0 or n_not_after > 0 then
    raise exception 'migration 057: % removed rows unstamped, % non-removed rows stamped, % removed rows not after the latest invitation; rolled back',
      n_unstamped, n_stamped_active, n_not_after;
  end if;
end;
$$;

commit;

-- ── After running: the column, the trigger, the constraint ───
--
-- select data_type, is_nullable, column_default
--   from information_schema.columns
--  where table_schema = 'public' and table_name = 'company_members'
--    and column_name = 'removed_at';           -- timestamp with time zone, YES, NULL
-- select tgname, tgenabled, pg_get_triggerdef(oid)
--   from pg_trigger
--  where tgrelid = 'public.company_members'::regclass and not tgisinternal;
--                                               -- company_members_stamp_removed, O
-- select pg_get_constraintdef(oid)
--   from pg_constraint
--  where conrelid = 'public.company_members'::regclass
--    and conname = 'company_members_removed_at_matches_status';
-- select status, count(*) filter (where removed_at is null) as null_stamp,
--        count(*) filter (where removed_at is not null) as stamped
--   from public.company_members group by status order by status;
--                                   -- removed: null_stamp 0; others: stamped 0
--
-- ── Staging rehearsal, before production ─────────────────────
--
-- The repository's tests run the two actions against fakes. The fakes apply
-- the filters the code sends, but they are not PostgREST, and the one thing
-- they cannot prove is that a timestamptz survives the wire as a .lt() filter
-- value and compares in Postgres the way it does in memory. The rehearsal
-- below proves it on a real database. It is a hand sequence for Waleed; every
-- step says what to see. DUMMY data only: a test company, a throwaway member
-- and throwaway addresses that you control. Never a customer's member.
--
-- 0. SCHEMA COMPARISON FIRST, on BOTH databases, before 057 is applied to
--    either. Staging is not a copy of production (#68) and nothing tracks
--    which migrations ran where. Run this on each and compare the two outputs
--    line by line. They must be identical; if they differ, the rehearsal
--    proves nothing about production, so STOP and reconcile first.
--
--    select 'col' as kind, column_name as name,
--           data_type || ', ' || case is_nullable when 'YES' then 'null' else 'not null' end
--             || ', default ' || coalesce(column_default, 'none') as detail
--      from information_schema.columns
--     where table_schema = 'public' and table_name = 'company_members'
--    union all
--    select 'con', conname, pg_get_constraintdef(oid)
--      from pg_constraint where conrelid = 'public.company_members'::regclass
--    union all
--    select 'trg', tgname, pg_get_triggerdef(oid)
--      from pg_trigger where tgrelid = 'public.company_members'::regclass and not tgisinternal
--    union all
--    select 'col', 'company_invites.' || column_name,
--           data_type || ', ' || case is_nullable when 'YES' then 'null' else 'not null' end
--             || ', default ' || coalesce(column_default, 'none')
--      from information_schema.columns
--     where table_schema = 'public' and table_name = 'company_invites'
--       and column_name in ('created_at', 'status', 'email', 'company_id')
--    order by 1, 2;
--
--    Expect on both: no removed_at column, no trigger, the UNIQUE on
--    (company_id, user_id), the status CHECK in (active, invited, removed),
--    email nullable, and company_invites.created_at timestamptz not null
--    default now().
--
-- 1. APPLY 057 on staging: this file, one paste. Expect "Success. No rows
--    returned". If the step-5 block raises, nothing was applied; read the
--    counts in its message.
--
-- 2. POST-CHECK on staging, the "After running" queries above: the column is
--    timestamp with time zone, nullable, no default; the trigger
--    company_members_stamp_removed is listed with tgenabled O; the constraint
--    company_members_removed_at_matches_status is listed; the by-status counts
--    show removed rows with null_stamp 0 and every other status with stamped 0.
--
-- 3. DEPLOY the code (#100) to staging.
--
-- 4. FIXTURE, in the dummy company, as its owner in the Team page:
--    a dummy member M with address X, active, whose auth account you control.
--    Note M's company_members.id from the row (last six characters suffice
--    for your notes).
--
-- 5. TEST A, invitation revocation: removing a member revokes the pending
--    invitations that match the row's address. The Team page refuses to
--    invite an active member, so a pending invitation to an active member's
--    own address has to be created by SQL for this test. Use a second dummy
--    member N with address Z, active, and an UNUSABLE token (no raw token
--    hashes to this value, so nobody can ever accept it):
--      insert into public.company_invites
--        (company_id, email, name, role, status, expires_at, token_hash)
--      values ('<company id>', lower('<Z>'), 'N', 'recruiter', 'pending',
--              now() + interval '7 days', 'rehearsal-no-token');
--    Remove N from the Team page. Expect: N leaves the members list, and
--      select status, removed_at is not null as stamped
--        from public.company_members where id = '<N id>';      -- removed, true
--      select status from public.company_invites
--       where token_hash = 'rehearsal-no-token';               -- revoked
--    Then remove the rehearsal row:
--      delete from public.company_invites where token_hash = 'rehearsal-no-token';
--    (company_invites has no delete guard; this is the dummy company's row.)
--
-- 6. TEST B, stale-invitation protection, the proven email-mismatch shape
--    (settings/actions.ts:271-295 updates the auth email and only the current
--    company's row). Controlled fixture, no production data:
--      - M is active with row address X and auth address X.
--      - As M, in the DUMMY company's Settings, change the account email to
--        Y. Then, by SQL, put the row back to X to model the other-company
--        case the code produces:
--          update public.company_members set email = '<X>' where id = '<M id>';
--        Now the row holds X and the auth user holds Y: the mismatch.
--      - As the owner, invite Y. The active-member check looks for Y, the row
--        holds X, so the invitation is issued. Do not accept it yet. Note the
--        time:  select created_at from public.company_invites where lower(email) = lower('<Y>') and status = 'pending';
--      - Remove M from the Team page. Expect:
--          select status, removed_at from public.company_members where id = '<M id>';
--                                             -- removed, a timestamp LATER than created_at above
--          select status from public.company_invites where lower(email) = lower('<Y>') order by created_at desc limit 1;
--                                             -- pending: the revoke matched X and missed Y
--      - Open the invitation to Y in a private window and accept it with M's
--        password. Expect the generic page text "Couldn't finish joining the
--        workspace. Please ask for a new invitation." and nothing about why.
--          select status, removed_at from public.company_members where id = '<M id>';
--                                             -- still removed, same stamp
--          select status from public.company_invites where lower(email) = lower('<Y>') order by created_at desc limit 1;
--                                             -- accepted: the stale token was consumed harmlessly
--      If the acceptance SUCCEEDS here, the comparison did not hold on a real
--      database: stop, and report it before anything goes to production.
--
-- 7. TEST C, the fresh re-invitation. THE DECISIVE STEP: if the .lt() filter
--    does not survive the wire, this is where it fails, and finding that out
--    here is the whole reason to rehearse. As the owner, invite Y again (M is
--    removed, so the invitation is issued; it is created now, after the stamp).
--    Accept it as M. Expect: the workspace opens, and
--      select status, removed_at, role from public.company_members where id = '<M id>';
--                                             -- active, NULL, the role you just chose
--    A refusal here, with the generic string, means the filter reached
--    Postgres malformed or the comparison went the wrong way: #100 shipped as
--    its own fix. Stop and report.
--
-- 8. TEST D, the cycle. Remove M (expect removed, stamped), re-invite Y and
--    accept (expect active, NULL), remove M again (expect removed, a stamp
--    LATER than the first). Three reads of the same query, three expected
--    states.
--
-- 9. CLEAN UP the dummy company's members and invitations by the normal
--    screens, or leave them; they are dummies.
--
-- If staging cannot host these conditions safely (no dummy company, or the
-- Settings email change is not available there), report that rather than
-- claiming the stale-invitation test passed.
--
-- ── Production order ─────────────────────────────────────────
--
-- This migration FIRST, then the code (#100), with the rehearsal above green.
-- What runs in the window between the two:
--   - the current production acceptance still INSERTS a membership row, so a
--     removed member accepting a fresh invitation still collides on the
--     unique key: #100 persists, as today, until the deploy. Nothing new
--     breaks.
--   - the current production removeMember sets only status = 'removed', and
--     the trigger stamps removed_at inside that same UPDATE from the database
--     clock, so no removal during the window leaves an unprotected NULL, and
--     the CHECK would refuse one if it tried.
--   - the backfill has already stamped every row removed before the apply.
-- So the window is safe: nothing in it can reactivate anyone, and nothing in
-- it can produce a row the new code would misjudge. The reverse order would
-- make every acceptance's reactivation filter on a column that does not exist
-- and fail closed: loud, and safe, but a reason to keep the order.
--
-- ── The one pending invitation ───────────────────────────────
--
-- It was created today, before this apply. If its target holds a REMOVED
-- membership row in that company, step 3 stamps that row with the apply time,
-- the invitation is then older than the removal, and accepting it is refused
-- (the token is consumed harmlessly). Detectable from data, no personal data
-- returned:
--
-- select exists (
--   select 1 from public.company_invites i
--   join public.company_members m
--     on m.company_id = i.company_id and lower(m.email) = lower(i.email)
--   where i.status = 'pending' and m.status = 'removed') as pending_invite_targets_removed_row;
--
-- If true, the one-line answer is to re-issue it from the Team page after the
-- deploy: the new invitation is created after the stamp and reactivates them.
