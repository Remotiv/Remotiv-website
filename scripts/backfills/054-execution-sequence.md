# 054 execution sequence

Nothing here is run by the design session. 054b stays on hold until the
live-scoring retention fix (scoreLiveSession returns notScored past
delete_after) is deployed.

**Authority.** `scripts/backfills/054-prechecks-A-G.sql` is the authority for
checks A to G, their expected results and their STOP conditions. This
document narrates that script and must agree with it; where they differ, the
script wins and this document is corrected.

## Stage 1. Production, read-only pre-checks

Run A to G from the script, in the Supabase SQL editor block by block or via
psql with the service file. Record every result in the migration note before
continuing.

1. **A, column inventory.** 23 expected (table, column) pairs, LEFT JOINed so
   an absent column prints `MISSING` rather than shortening the count. Expect
   23 rows, all `present`. STOP on any `MISSING`: a guarded column name is
   wrong and the guard would raise RT063 on its first fire. The status column
   is `transcript_status` on both transcript tables; its value set in code is
   `pending`, `done`, `failed`, `skipped` (types.ts), enforced by migration
   021 on `interview_turns` only. **A2** prints the database CHECKs that
   mention it on both tables; for `interview_answers` the repo has no
   authority, so whatever A2 returns is the record. No STOP on A2.
2. **B, existing triggers** on the five tables. Expect no
   `interview_words_guard`. STOP if any listed BEFORE trigger rewrites a word
   column; none is known.
3. **C, foreign keys to interview_sessions.** Expect `interview_answers` with
   `on delete cascade`. STOP if the cascade is missing: B7's ordering (a) then
   has no self-closure and the design needs revisiting.
4. **D, gated sessions.** Expect `purged = 0`, `due_unpurged = 0`,
   `never_expire` whatever it is. Record it. No STOP condition; this is the
   baseline Check G is read against.
5. **E, transcription still pending under gated sessions.** The predicate is
   `transcript_status = 'pending'`, never `transcript is null`, which also
   matches failed rows and rows that never had media. Expect 0 and 0. No
   STOP: the handlers already skip those at job start; note the count. On
   staging this is how the seeded sessions are read correctly.
6. **F, queued or running jobs aimed at gated sessions.** Derivable from D
   (no gated sessions means no gated jobs), but it MUST BE RUN immediately
   before the production apply (Stage 4, step 18): a job can be in flight at
   that moment. Expect no rows. STOP if any: let it drain or fail it (B7's
   own step 2 does this), then re-run F.
7. **G, words on sessions past retention, two arms, transcript tables only.**
   The score arms are added only after 054b.
   - **purged arm**, `purged_at is not null` and words present: THE STOP.
     Phase 1 commits every transcript clear as its own PostgREST statement
     and only then issues the `purged_at` stamp, excluding any session with
     something left to retry (purge.ts `markable`), so words on a stamped
     session can only have been written after the clear. No benign window,
     no time qualifier. Non-zero: the race has already happened; run the
     cleanup and identify the writer before installing a guard whose first
     reading would be ambiguous.
   - **backlog arm**, `purged_at is null and delete_after <= now()` and words
     present: RECORD ONLY, no STOP. The daily purge has not reached these.
     On staging this is the seeded due sessions and is large by construction.
   Expect production: 0 on all four lines.

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

18. Run F on production immediately before applying, even when D was all
    zeros: F is derivable from D at rest, but a transcribe or ai_scorecard
    job can be in flight at the moment of the apply. Expect no rows. STOP
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
23. Interpretation: 0 on the purged arm means no guarded write got through.
    A non-zero purged arm after 054 is either residual (b) or the trigger
    off: run the trigger-exists check first, then the cleanup procedure,
    then step 5 of the cleanup to identify the writer. A non-zero backlog
    arm is the daily purge not having run yet; record it and read it again
    after the next run. A non-zero score arm before 054b may be a privacy
    issue to clear, but is not a guard failure: no guard is installed there
    yet.

## Check G

The authoritative text is in `054-prechecks-A-G.sql`; this copy is for
reading alongside the interpretation above.

```sql
-- Two arms, transcript tables only, reported separately.
-- purged arm   purged_at IS NOT NULL and words present: THE STOP. Phase 1
--              commits every transcript clear and only then stamps, excluding
--              sessions with anything left to retry, so words here were
--              written AFTER the clear: the race, no benign window.
-- backlog arm  purged_at IS NULL and delete_after <= now() and words present:
--              RECORD ONLY. The daily purge has not reached these yet. Folding
--              it into the STOP arm would false-STOP on staging's seeded due
--              sessions. Do not "fix" the split.
-- Rollout: before 054 and after Part A, these four lines only. After 054b,
-- add the three score arms below (they need 054's helper functions).
select 'purged'  as arm, 'answers' as t, count(*) from public.interview_answers a
  join public.interview_sessions s on s.id = a.session_id
 where s.purged_at is not null
   and (a.transcript is not null or a.transcript_segments is not null)
union all
select 'purged', 'turns', count(*) from public.interview_turns t
  join public.interview_sessions s on s.id = t.session_id
 where s.purged_at is not null
   and (t.transcript is not null or t.transcript_segments is not null
        or t.text is not null or t.follow_up_reason is not null)
union all
select 'backlog', 'answers', count(*) from public.interview_answers a
  join public.interview_sessions s on s.id = a.session_id
 where s.purged_at is null and s.delete_after <= now()
   and (a.transcript is not null or a.transcript_segments is not null)
union all
select 'backlog', 'turns', count(*) from public.interview_turns t
  join public.interview_sessions s on s.id = t.session_id
 where s.purged_at is null and s.delete_after <= now()
   and (t.transcript is not null or t.transcript_segments is not null
        or t.text is not null or t.follow_up_reason is not null)
order by 1 desc, 2;

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
