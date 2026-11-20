-- ============================================================================
-- Migration 068 - delete the reviewer notes of interviews already purged (#21)
-- ----------------------------------------------------------------------------
-- NOT RUN anywhere. Staging first, then production. Data only: no schema
-- change, no function, no trigger. Safe to re-run (a second run finds nothing).
--
-- ── Why ──────────────────────────────────────────────────────
--
-- From #21 the retention purge (lib/interviews/purge.ts, Phase 1) deletes an
-- interview's interview_notes rows in the same pass that deletes its
-- recordings and transcripts. Phase 1 reads only sessions NOT yet stamped
-- purged_at, so a session purged before #21 is never read again and its notes
-- would stay for ever. This removes exactly those: the notes of every session
-- the purge has already finished.
--
-- Sessions past delete_after but not yet stamped are left to the purge itself,
-- which deletes their notes on its next run.
--
-- Run the count first; expect the second statement to delete that many rows.
-- ============================================================================

-- Read only: how many notes this will delete.
-- select count(*) from public.interview_notes n
--  where exists (select 1 from public.interview_sessions s
--                 where s.id = n.session_id and s.purged_at is not null);

delete from public.interview_notes n
 where exists (
   select 1 from public.interview_sessions s
    where s.id = n.session_id
      and s.purged_at is not null
 );
