-- ============================================================================
-- Backfill for migration 051: stamp interview_sessions.purged_at on sessions
-- the purge has already finished (#59).
-- ----------------------------------------------------------------------------
-- PRODUCTION'S BACKLOG WAS 0 ON 2026-10-30 (28 sessions in total, none past
-- retention), so this file is currently a no-op there: the dry run reports 0
-- and the batch updates 0 rows. It stays for the day that changes.
--
-- THE STAMP IS `purged_at = delete_after`, NEVER `now()`, and here is the real
-- reason, traced on 2026-10-30. The predicate below proves only that every
-- field the purge clears is empty AT BACKFILL TIME. It proves nothing about
-- writes that arrive afterwards, and the purge's Phase 1b exists precisely for
-- those: it re-checks the score words of sessions stamped inside its window
-- (24 hours, purge.ts LATE_WORDS_WINDOW_MS). A stamp of delete_after is
-- months in the past, so a backfilled session is OUTSIDE that window from the
-- first run and Phase 1b never looks at it again. That is safe only because
-- every writer of these fields refuses a session past retention when its job
-- actually runs: the async scorer checks retentionPassed at job start, before
-- each write and after it; the transcribers and the live ingest check at job
-- start; the live scorer stops on the turns' content_purged_at marker. Each
-- re-reads delete_after on every attempt, so a job queued or re-queued months
-- later is still refused, and delete_after only ever moves earlier. The
-- in-flight race Phase 1b guards (a check that passed seconds before
-- retention, a write landing seconds after) cannot involve a session whose
-- retention passed months ago, which is every session this file can touch.
--
-- Why not now(): it would put the whole backlog inside Phase 1b's window at
-- once, at three round trips per hundred sessions inside a 6-second slice
-- that halts ALL purging when exhausted; staging reproduced that at 809
-- sessions on 2026-10-30. It would also be false: delete_after is when the
-- session stopped being retained.
--
-- What the purge promises after this: in NORMAL OPERATION, one successful run
-- a day, so a session's words go within about a day of its delete_after. It
-- is a daily job that can fail, die on the Phase 1b slice alarm, or wait
-- behind a delayed queue; none of those is a guarantee, and queue-health shows
-- which happened.
--
-- RUN AFTER src/lib/supabase/migrations/051_interview_sessions_purged_at.sql,
-- which adds the column, its index and the orphan sweep's job type. This file
-- is NOT a migration: its second statement is pasted repeatedly until it
-- reports 0 rows updated, which is why it lives here and not there.
--
-- Two statements, each self-contained, no setup and no cleanup, so either can
-- be pasted into a fresh SQL editor session on its own. The predicate is
-- written out twice, identically; if you change one, change both.
--
-- Staging and production alike: paste 1, read the number; paste 2, read the
-- rows-updated count, repeat until 0; paste the check at the end.
-- ============================================================================

-- ── Why this predicate ───────────────────────────────────────
-- Without this, the column only helps sessions purged from now on, and the
-- existing pile keeps burning the budget on every run. The predicate is "the
-- purge would find nothing to do for this session", mirrored sub-purge by
-- sub-purge from purge.ts, live-score-purge.ts and async-score-purge.ts:
--
--   answers      purge.ts reads answers with video_path, transcript or
--                transcript_segments set; a session with none has nothing left
--   turns        purgeDueTurns reads turns with content_purged_at null OR
--                media_path set (NOT "no turns rows": a never-started session
--                has no turns and is just as purged; a turn with a path still
--                waiting on storage is not). The five word columns the purge
--                nulls (text, transcript, transcript_segments,
--                transcript_error, follow_up_reason) are ALSO checked
--                directly, so a turn stamped purged that somehow still holds
--                words keeps its session unstamped rather than trusting the
--                marker alone
--   video pieces purgeDueVideoPieces reads pieces with media_path set
--   live scores  purgeLiveScoreWords clears a question holding a rationale or
--                any quotes
--   async scores purgeAsyncScoreWords clears an answer score holding
--                reasoning/evidence/strengths/concerns/missing, and a session
--                score holding a summary or any criterion quote
--
-- A session that fails any one of these is left NULL and the purge reads it
-- again, which is the safe direction: a false negative costs one visit, a
-- false positive would hide held content forever.
--
-- Two statements, each self-contained, no setup and no cleanup, so either can
-- be pasted into a fresh SQL editor session on its own. The predicate is
-- written out twice, identically, because the editor cannot be relied on to
-- keep a temporary object between pastes. If you change one, change both.
-- ============================================================================

-- ── 1. The dry run. Paste, run, read the number. ───────────
-- `would_stamp` is how many rows the batched statement below will stamp in
-- total; `due_now` is the backlog before it; `due_now - would_stamp` is what
-- the purge will still have to process afterwards.
select
  (select count(*)
     from public.interview_sessions s
    where s.delete_after is not null
      and s.delete_after <= now()
      and s.purged_at is null
      and not exists (select 1 from public.interview_answers a
                       where a.session_id = s.id
                         and (a.video_path is not null or a.transcript is not null
                              or a.transcript_segments is not null))
      and not exists (select 1 from public.interview_turns t
                       where t.session_id = s.id
                         and (t.content_purged_at is null or t.media_path is not null
                              or t.text is not null or t.transcript is not null
                              or t.transcript_segments is not null
                              or t.transcript_error is not null
                              or t.follow_up_reason is not null))
      and not exists (select 1 from public.live_video_pieces p
                       where p.session_id = s.id and p.media_path is not null)
      and not exists (select 1 from public.live_interview_scores l
                       where l.session_id = s.id and jsonb_typeof(l.questions) = 'array'
                         and exists (select 1 from jsonb_array_elements(l.questions) q
                                      where jsonb_typeof(q->'rationale') not in ('null')
                                         or (jsonb_typeof(q->'quotes') = 'array'
                                             and jsonb_array_length(q->'quotes') > 0)))
      and not exists (select 1 from public.interview_answer_scores x
                       where x.session_id = s.id
                         and ((x.reasoning is not null and x.reasoning <> '')
                           or (x.evidence  is not null and x.evidence  not in ('[]'::jsonb, 'null'::jsonb, '""'::jsonb))
                           or (x.strengths is not null and x.strengths not in ('[]'::jsonb, 'null'::jsonb, '""'::jsonb))
                           or (x.concerns  is not null and x.concerns  not in ('[]'::jsonb, 'null'::jsonb, '""'::jsonb))
                           or (x.missing   is not null and x.missing   not in ('[]'::jsonb, 'null'::jsonb, '""'::jsonb))))
      and not exists (select 1 from public.interview_session_scores y
                       where y.session_id = s.id
                         and ((y.summary is not null and y.summary <> '')
                           or (jsonb_typeof(y.criteria) = 'array'
                               and exists (select 1 from jsonb_array_elements(y.criteria) c
                                            where c->'quote' is not null
                                              and c->'quote' not in ('null'::jsonb, '""'::jsonb)))))
  ) as would_stamp,
  (select count(*)
     from public.interview_sessions
    where delete_after is not null and delete_after <= now() and purged_at is null
  ) as due_now;

-- ── 2. The backfill. Paste, run, read the rows-updated count, repeat ──────
-- ── until it reports 0. The ONLY way to do it, on staging and production. ──
-- At most 500 rows per statement, idempotent: a stamped row no longer matches,
-- so running it again continues where the last one stopped, and nothing is
-- lost if one run is interrupted. Six correlated NOT EXISTS per candidate row
-- are cheap individually; 500 per statement keeps each run well inside the SQL
-- editor's statement timeout whatever the backlog turns out to be.
update public.interview_sessions s
   set purged_at = s.delete_after
 where s.id in (
   select s2.id
     from public.interview_sessions s2
    where s2.delete_after is not null
      and s2.delete_after <= now()
      and s2.purged_at is null
      and not exists (select 1 from public.interview_answers a
                       where a.session_id = s2.id
                         and (a.video_path is not null or a.transcript is not null
                              or a.transcript_segments is not null))
      and not exists (select 1 from public.interview_turns t
                       where t.session_id = s2.id
                         and (t.content_purged_at is null or t.media_path is not null
                              or t.text is not null or t.transcript is not null
                              or t.transcript_segments is not null
                              or t.transcript_error is not null
                              or t.follow_up_reason is not null))
      and not exists (select 1 from public.live_video_pieces p
                       where p.session_id = s2.id and p.media_path is not null)
      and not exists (select 1 from public.live_interview_scores l
                       where l.session_id = s2.id and jsonb_typeof(l.questions) = 'array'
                         and exists (select 1 from jsonb_array_elements(l.questions) q
                                      where jsonb_typeof(q->'rationale') not in ('null')
                                         or (jsonb_typeof(q->'quotes') = 'array'
                                             and jsonb_array_length(q->'quotes') > 0)))
      and not exists (select 1 from public.interview_answer_scores x
                       where x.session_id = s2.id
                         and ((x.reasoning is not null and x.reasoning <> '')
                           or (x.evidence  is not null and x.evidence  not in ('[]'::jsonb, 'null'::jsonb, '""'::jsonb))
                           or (x.strengths is not null and x.strengths not in ('[]'::jsonb, 'null'::jsonb, '""'::jsonb))
                           or (x.concerns  is not null and x.concerns  not in ('[]'::jsonb, 'null'::jsonb, '""'::jsonb))
                           or (x.missing   is not null and x.missing   not in ('[]'::jsonb, 'null'::jsonb, '""'::jsonb))))
      and not exists (select 1 from public.interview_session_scores y
                       where y.session_id = s2.id
                         and ((y.summary is not null and y.summary <> '')
                           or (jsonb_typeof(y.criteria) = 'array'
                               and exists (select 1 from jsonb_array_elements(y.criteria) c
                                            where c->'quote' is not null
                                              and c->'quote' not in ('null'::jsonb, '""'::jsonb)))))
    limit 500
 );

-- ── 3. After the batches report 0 ────────────────────────────
select count(*) filter (where purged_at is not null) as marked,
       count(*) filter (where purged_at is null and delete_after <= now()) as still_due
  from public.interview_sessions where delete_after is not null;
-- `still_due` is the real backlog. The purge resumes from there at its
-- measured ~40 sessions per run, and the marker keeps it from re-reading what
-- it has finished.
