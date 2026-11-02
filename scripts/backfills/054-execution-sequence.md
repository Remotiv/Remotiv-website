# 054 execution sequence

Nothing here is run by the design session. 054b stays on hold until the
live-scoring retention fix (scoreLiveSession returns notScored past
delete_after) is deployed.

## Stage 1. Production, read-only pre-checks

Run A to G in the Supabase SQL editor. Record every result in the migration
note before continuing.

1. **A, column inventory.** Expect exactly 21 rows. STOP if fewer: a column
   name in the guard is wrong, and the guard would raise on its first fire.
2. **B, existing triggers** on the five tables. Expect no
   `interview_words_guard`. STOP if any listed BEFORE trigger rewrites a word
   column; none is known.
3. **C, foreign keys to interview_sessions.** Expect `interview_answers` with
   `on delete cascade`. STOP if the cascade is missing: B7's ordering (a) then
   has no self-closure and the design needs revisiting.
4. **D, gated sessions.** Expect `purged = 0`, `due_unpurged = 0`,
   `never_expire` whatever it is. Record it. No STOP condition; this is the
   baseline Check G is read against.
5. **E, pending transcripts under gated sessions.** Expect 0 and 0. Non-zero
   is not a STOP: the handlers already skip those; note the count.
6. **F, queued or running jobs aimed at gated sessions.** Expect no rows.
   STOP if any: a job is live against a session being deleted or purged; let
   it drain or fail it (B7's own step 2 does this), then re-run F.
7. **G, the two transcript arms only** (the score arms need 054's functions).
   Expect 0 and 0. STOP if non-zero: the race has already happened on
   production; run the cleanup procedure first and understand the writer
   before adding a guard whose first reading would be ambiguous.

## Stage 2. Staging, apply Part A

8. Run checks A to G on staging the same way (G's two arms). Staging's D will
   be non-zero from the seeded sessions; that is expected.
9. Run `054_interview_words_retention_guard.sql` top to bottom in the staging
   SQL editor. Expect no errors.
10. Trigger-exists check: expect 2 rows (`interview_answers`,
    `interview_turns`), both `tgenabled = 'O'`. STOP if not.

## Stage 3. Staging, functional and concurrent proofs

Each single-connection proof in its own `begin; ... rollback;`. Candidate
turns only (021 refuses a transcript on an interviewer turn). The expected
result is the pass condition; anything else is a STOP.

11. **P1 refused after the stamp.** A stamped session's candidate turn,
    `set transcript = 'probe-054'`: `ERROR` with SQLSTATE `RT063`, message
    naming the session id and "transcript", no words.
12. **P2 status-only passes** on the same row: `set transcript_status =
    'failed'`: `UPDATE 1`.
13. **P3 open session passes.** Months of retention left, pending candidate
    turn, `set transcript = 'probe-054'`: `UPDATE 1`.
14. **P4 the purge's clear passes.** Due unstamped turn, the full `words`
    shape with `content_purged_at = now()`: `UPDATE n`.
15. **P5 ordering (b), the accepted residual, reproduced.** Two psql
    connections to staging; seed session S with `delete_after` a day or more
    out, candidate turn T with transcript null; record originals.
    1. Conn 1: `begin; update interview_sessions set purged_at =
       clock_timestamp() where id = :S;` hold open.
    2. Conn 2, autocommit: `update interview_turns set transcript =
       'probe-054', transcript_status = 'done' where id = :T;` Expect
       `UPDATE 1`. This is the residual: snapshot before the stamp, deadline
       still ahead on the database clock.
    3. Conn 1: `commit;`
    4. Check G: expect `turns 1`.
    5. Cleanup procedure, step 3, for S. Check G: expect 0.
    6. Restore: `purged_at = null` on S; `transcript_status = 'pending',
       content_purged_at = null` on T.
    7. Control: commit the stamp first, then the same write: expect `RT063`.
       Restore `purged_at`.
16. **P6 ordering (a) closes itself.** Same shape on S2 with Conn 1 holding
    `delete_after = clock_timestamp()`; Conn 2's transcript write passes;
    commit. Check D: `due_unpurged` rises by one. Check G: unchanged, by
    design. Clear with the cleanup's purge-shaped SQL; restore S2.
17. STOP conditions for this stage: P1 or P5 step 7 does not raise `RT063`
    (the guard is not firing); P2, P3 or P4 raises (the guard blocks a
    legitimate write, the outage shape); P5 step 4 shows anything other than
    `turns 1`.

## Stage 4. Production, apply 054

18. Re-run F on production immediately before applying. Expect no rows. STOP
    otherwise.
19. Run `054_interview_words_retention_guard.sql` top to bottom. Expect no
    errors. It is re-runnable; a partial failure is fixed by correcting and
    running the whole file again.
20. Trigger-exists check: expect 2 rows, both `tgenabled = 'O'`. STOP if not.
21. Do NOT run any P-proof on production.

## Stage 5. Production, one-time Check G and interpretation

22. The day after 054 is applied, run Check G with the two transcript arms.
    Then only at: the customer-1 rehearsal; after an actual applicant or
    company deletion, or a purge run that touched sessions; and when the
    first six-month expiries begin. Not on a calendar. Phase 1b transcript
    re-checking is the permanent closure.
23. Interpretation: 0 on both arms means no guarded write got through. A
    non-zero transcript arm after 054 is either residual (b) or the trigger
    off: run the trigger-exists check first, then the cleanup procedure,
    then step 5 of the cleanup to identify the writer. A non-zero score arm
    before 054b may be a privacy issue to clear, but is not a guard failure:
    no guard is installed there yet.

## Check G

```sql
-- Scoped to purged_at IS NOT NULL on purpose. A stamped session is one the
-- purge FINISHED and will never read again, so words there are the race,
-- proven, and persist until cleared by hand. A due-but-unpurged session
-- holding words is pending cleanup on the next run, not evidence; Check D
-- counts those. Widening this to delete_after <= now() manufactures false
-- positives. Do not "fix" the scope.
--
-- Rollout: before 054 and after Part A, run the first two arms only. After
-- 054b, add the three score arms (they need 054's helper functions).
select 'answers' as t, count(*) from public.interview_answers a
  join public.interview_sessions s on s.id = a.session_id
 where s.purged_at is not null and (a.transcript is not null or a.transcript_segments is not null)
union all
select 'turns', count(*) from public.interview_turns t
  join public.interview_sessions s on s.id = t.session_id
 where s.purged_at is not null
   and (t.transcript is not null or t.transcript_segments is not null
        or t.text is not null or t.follow_up_reason is not null);

-- After 054b only:
select 'answer_scores' as t, count(*) from public.interview_answer_scores x
  join public.interview_sessions s on s.id = x.session_id
 where s.purged_at is not null and (nullif(btrim(x.reasoning), '') is not null
    or public.interview_words_present(to_jsonb(x.evidence)) or public.interview_words_present(to_jsonb(x.strengths))
    or public.interview_words_present(to_jsonb(x.concerns)) or public.interview_words_present(to_jsonb(x.missing)))
union all
select 'session_scores', count(*) from public.interview_session_scores x
  join public.interview_sessions s on s.id = x.session_id
 where s.purged_at is not null and (nullif(btrim(x.summary), '') is not null
    or public.interview_words_present(public.interview_words_projection('interview_session_scores', 'criteria', to_jsonb(x.criteria))))
union all
select 'live_scores', count(*) from public.live_interview_scores l
  join public.interview_sessions s on s.id = l.session_id
 where s.purged_at is not null
   and public.interview_words_present(public.interview_words_projection('live_interview_scores', 'questions', l.questions));
```

Ids variant for the cleanup (ids only, never words):

```sql
select 'turns' as t, t.session_id, t.id from public.interview_turns t
  join public.interview_sessions s on s.id = t.session_id
 where s.purged_at is not null
   and (t.transcript is not null or t.transcript_segments is not null or t.text is not null or t.follow_up_reason is not null)
union all
select 'answers', a.session_id, a.id from public.interview_answers a
  join public.interview_sessions s on s.id = a.session_id
 where s.purged_at is not null and (a.transcript is not null or a.transcript_segments is not null);
```

## Cleanup procedure (by hand, only when G is non-zero)

1. Record the ids variant and `select id, delete_after, purged_at from
   public.interview_sessions where id in (...)` in the incident note.
2. Trigger-exists check. If the trigger is off, that is the cause; re-run 054.
3. Words out, purge-shaped, idempotent (the trigger passes these; Phase 1
   would not reach a turn already stamped content_purged_at with media_path
   null):

   ```sql
   update public.interview_turns t
      set text = null, follow_up_reason = null, transcript = null,
          transcript_segments = null, transcript_error = null,
          content_purged_at = coalesce(t.content_purged_at, now())
     from public.interview_sessions s
    where s.id = t.session_id and s.purged_at is not null
      and (t.text is not null or t.follow_up_reason is not null
           or t.transcript is not null or t.transcript_segments is not null);

   update public.interview_answers a
      set transcript = null, transcript_segments = null
     from public.interview_sessions s
    where s.id = a.session_id and s.purged_at is not null
      and (a.transcript is not null or a.transcript_segments is not null);
   ```
4. If any affected turn has `media_path` set, any answer has `video_path`
   set, or a score arm was non-zero: un-stamp those sessions only
   (`set purged_at = null where id in (...) and delete_after <= now()`) and
   let the next purge run do objects, score words and the re-stamp. Under
   about 100 a day, for the Phase 1b alarm. Confirm the re-stamp next day.
5. Find the writer in `background_jobs` by session and answer ids around the
   words' arrival. Ordering (b) shows one succeeded attempt inside the purge
   run's minute at the session's `delete_after`. Anything else is a bypass:
   escalate before clearing more.
6. Check G again: 0. Close the note.
