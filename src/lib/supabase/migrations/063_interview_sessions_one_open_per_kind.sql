-- ============================================================================
-- Migration 063 - at most ONE open interview session per applicant and kind
--                 (#52, QA-SAFETY-40 M-1)
-- ----------------------------------------------------------------------------
-- NOT RUN YET. Apply by hand in the Supabase SQL editor: STAGING first, then
-- PRODUCTION. Independent of 064; either order.
--
-- ── Why ──────────────────────────────────────────────────────
--
-- Sending an interview cancels the applicant's open session of that kind and
-- inserts a new one (supersedeOpenSession, interview-actions.ts). Two sends at
-- the same instant (two tabs, two people) both read the same open session and
-- both insert, so the candidate got two live links, two emails and two
-- WhatsApp invitations. The app now refuses a second send inside 60 seconds,
-- but only the database can refuse two at the same instant: with this index
-- the second insert fails with 23505 and the app answers "An invite was just
-- sent to this person. Wait a minute before sending it again."
--
-- ── Safe to add (read 18 Nov 2026) ───────────────────────────
--
-- Production, read-only: 0 sessions in 'invited' or 'started', so 0 applicants
-- with two open sessions of one kind. The live restart function abandons the
-- previous attempt BEFORE inserting the restart (055, live_restart_session,
-- the update at line 502 then the insert), and a unique index is checked per
-- statement, so a restart never holds two open sessions at once.
--
-- Rows with application_id NULL (the applicant was deleted) are not
-- constrained: NULLs are distinct in a unique index, which is what we want.
--
-- Rollback: drop index public.interview_sessions_one_open_per_kind;
-- ============================================================================

begin;

set local lock_timeout = '5s';

-- Refuse loudly rather than fail half-way on a duplicate that appeared since
-- the read above.
do $$
begin
  if exists (
    select 1
      from public.interview_sessions s
     where s.status in ('invited', 'started')
       and s.application_id is not null
     group by s.application_id, s.kind
    having pg_catalog.count(*) > 1
  ) then
    raise exception '063: an applicant already has two open sessions of one kind; resolve them first';
  end if;
end;
$$;

create unique index interview_sessions_one_open_per_kind
  on public.interview_sessions (application_id, kind)
  where status in ('invited', 'started');

commit;

-- ── Post-check (read-only) ──────────────────────────────────────────────────
--
--   select indexdef from pg_catalog.pg_indexes
--    where schemaname = 'public' and indexname = 'interview_sessions_one_open_per_kind';
--
-- Expect: CREATE UNIQUE INDEX interview_sessions_one_open_per_kind ON
-- public.interview_sessions USING btree (application_id, kind) WHERE
-- (status = ANY (ARRAY['invited'::text, 'started'::text]))
