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

1. **A, column inventory.** 23 expected (table, column) pairs, each tagged
   `part`: `A` for the guard's columns on `interview_answers`,
   `interview_turns` and `interview_sessions` (054), `B` for the three score
   tables (054b), `E` for `transcript_status` on both transcript tables,
   which the guard never reads and which is Check E's input. LEFT JOINed so
   an absent column prints `MISSING` rather than shortening the count. Expect
   23 rows, all `present`. STOP on a `MISSING` only where `part = 'A'`: that
   column name is wrong and 054's guard would raise RT063 on its first fire.
   A `MISSING` in part `B` blocks 054b, not 054: record it, apply 054, and
   fix the name before 054b. A `MISSING` in part `E` means Check E is wrong
   and must be rewritten; it is not a STOP for the apply. `interview_sessions.id` is
   deliberately not in the list; Check C proves it as the target of the
   foreign keys. The status column is `transcript_status` on both transcript
   tables; its value set in code is `pending`, `done`, `failed`, `skipped`
   (types.ts), enforced by migration 021 on `interview_turns` only. **A2**
   prints the database CHECKs that mention it on both tables. Inspect A2
   before relying on any `interview_answers` constraint: the repo has no
   authority there. If A2 returns no row for `interview_answers`, the
   database enforces NOTHING about that column, and the four values are
   established by application code alone: the confirm route writes
   `pending`, the transcriber writes `done` and `failed`, nothing writes
   `skipped`, and any other string would be accepted. On `interview_turns`
   the database enforces the set and the candidate-only rule itself. No
   STOP on A2; record what it returns.
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
   E is a point-in-time sample. A zero does not prove that no transcription
   is in flight or that none can finish later. `pending` is not the span of
   the provider call; from the code it is set long before any job runs and
   cleared only by a job's final write:
   - answers: set to `pending` by the confirm route when the recording is
     confirmed (`src/app/api/interview/confirm/route.ts:195`), before the
     transcribe job is even enqueued; cleared only by the transcriber's final
     write to `done` or `failed` (`transcribe.ts:361`, `:473`). A job that
     skips (answer gone, re-recorded, past retention) writes nothing, so the
     row stays `pending` for ever; `transcribe-recovery.ts` re-queues
     pending rows older than ten minutes.
   - turns: set to `pending` on every candidate turn at export save
     (`live-ingest.ts:1145`); cleared by the live transcriber's `done` or
     `failed` (`live-transcribe.ts:645`, `:525`); a reviewer's retry puts a
     failed turn back to `pending` (`live-recovery.ts:215`). A past-retention
     skip writes nothing, so the turn stays `pending`.
   - the purge never writes `transcript_status` (its `words` object clears
     text, transcript, segments, error, follow-up reason and stamps
     `content_purged_at`), so a row that was `pending` when its session was
     purged is `pending` afterwards too.
   So E can be non-zero for ever on a purged session, legitimately, and a
   zero at one instant says nothing about the next. Only F, run immediately
   before the apply, speaks to jobs in flight.
6. **F, queued or running jobs aimed at gated sessions.** Derivable from D
   (no gated sessions means no gated jobs), but it MUST BE RUN immediately
   before the production apply (Stage 4, step 22): a job can be in flight at
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

**What passing proves, and what it does not.** P1 to P8 establish the
behaviour of these specific interleavings on staging's trigger and staging's
cascade. They do not prove that every possible interleaving is deadlock-free,
and they do not cover the real purge (`runInterviewPurge`) or the real
`deleteSessions`, both TypeScript issuing PostgREST requests that no SQL
script can invoke. Those need an integration run on staging with the worker
executing the real code while a second connection issues a guarded write.
Read every result below with that limit in view.

**Order of this stage, and why it must not be re-sorted.** P1 to P4 first:
they are cheap, single-connection, and a failure there means the guard is
not firing or blocks legitimate writes. Then P7, P8a and P8b: they carry the
ONLY outcome that could block 054 from production, a `40P01` deadlock
between a guarded write and the cascade delete. Then P5 and P6 last: they
reproduce a residual that has already been examined and accepted, they are
documentation rather than a gate, and they are the most fiddly to restore.
The blocking question comes before the documentation.

**Locking, corrected.** The guard's own read (`054:278`) is a plain SELECT:
table-level ACCESS SHARE, no row lock, never waits. That settles the no-cycle
conclusion for a transcript-only UPDATE whose `session_id` is unchanged: the
write holds its child row lock and then waits for nothing. It does NOT settle
INSERTs, nor any UPDATE that changes `session_id`: foreign-key enforcement
makes PostgreSQL take FOR KEY SHARE on the parent `interview_sessions` row for
those, which IS a row lock and DOES conflict with a DELETE of that row. The
cascade delete (`DELETE FROM interview_sessions`, one statement, session row
first, then children through the cascading keys) takes locks in the opposite
order. Whether that is a cycle is settled empirically by P7, P8a and P8b, not
by argument.

Each single-connection proof (P1 to P4) in its own `begin; ... rollback;`.
Candidate turns only (021 refuses a transcript on an interviewer turn). The
expected result is the pass condition; anything else is a STOP.

11. **P1 refused after the stamp.** A stamped session's candidate turn,
    `set transcript = 'probe-054'`: `ERROR` with SQLSTATE `RT063`, message
    naming the session id and "transcript", no words.
12. **P2 status-only passes** on the same row: `set transcript_status =
    'failed'`: `UPDATE 1`.
13. **P3 open session passes.** Months of retention left, pending candidate
    turn, `set transcript = 'probe-054'`: `UPDATE 1`.
14. **P4 the purge's clear passes.** Due unstamped turn, the full `words`
    shape with `content_purged_at = now()`: `UPDATE n`.

**Cascade-delete concurrency proofs P7, P8a, P8b.** Different fixture
discipline from every other proof: these DESTROY their fixture, so each
CREATES its own disposable live session and child turns with explicit,
minimal INSERTs, and borrows nothing seeded. A seeded session may carry
`live_interview_actions` rows (deletable only through the cascade, 042) or a
restart pointing at it, and either would make the DELETE measure something
other than the guard. The expected outcome of each proof is stated BEFORE its
steps so a result confirms or refutes it. The guard must PASS in all three,
so every fixture has `delete_after` 30 days out and `purged_at` null; an
`RT063` anywhere here is a fixture bug, not a finding.

Five signals that all look like "it errored", and must be told apart in the
write-up:

| Signal | SQLSTATE | Meaning here |
|---|---|---|
| ordinary block | none; the prompt does not return until the other connection commits | a row lock wait, expected in all three |
| deadlock | `40P01` `deadlock_detected` | the finding these proofs exist to detect; refutes the no-cycle expectation |
| guard refusal | `RT063` | fixture bug: the session was past retention or stamped |
| foreign-key violation | `23503` `foreign_key_violation` | expected in P8a after the delete commits; anywhere else, read the constraint name in the message |
| cancelled by timeout | `57014` `query_canceled` | the block outlived the safety timeout; record it, do not call it a deadlock |

Conn 2 in every proof runs `set statement_timeout = '60s';` first so an
unresolved block ends as `57014` instead of hanging, and `\timing on` so the
wait is recorded.

**Fixture: one disposable live session plus turns, by explicit INSERT.** The
shape comes from `scripts/backfills/054-fixture-catalog.sql`, run on staging
2026-11-02 (columns, CHECKs, uniques, foreign keys and triggers for both
tables). What the catalog requires of a session row: `company_id` (a real
company; `ON DELETE CASCADE` from companies), `token_hash` (UNIQUE),
`expires_at`, and for a live session `kind = 'live'` with `live_settings` a
non-null JSON object (`interview_sessions_live_settings_kind`); `provider`
and `provider_session_id` both null; `attempt` 1 with `previous_attempt_id`
null (`interview_sessions_attempt_link`). The `interview_sessions_live_ended`
trigger stamps `live_ended_at` for a `submitted` live session itself. Of a
turn row: an interviewer turn needs `kind`, `question_position` and non-empty
`text`; a candidate turn needs `kind` null, `text` null, `responds_to_turn_id`
pointing at a turn of the same session (`interview_turns_responds_to_fk` on
`(responds_to_turn_id, session_id)`), and a non-null `transcript_status`
(`interview_turns_transcript_status`, the candidate-only CHECK); both need
`media_path` matching `{session}/t{sequence}.%`, `media_bytes > 0`, a 64-hex
`media_sha256`, non-empty `media_mime_type`, `offset_ms >= 0`,
`duration_ms > 0`, `ended_at >= started_at`. Nothing is cloned.

```sql
-- a real company to own the fixture (read-only pick)
select id as company from public.companies limit 1 \gset
insert into public.interview_sessions
  (company_id, token_hash, status, expires_at, kind, live_settings, attempt, delete_after)
values
  (:'company', encode(sha256(gen_random_uuid()::text::bytea), 'hex'), 'submitted',
   now() + interval '7 days', 'live', '{}'::jsonb, 1, now() + interval '30 days')
returning id \gset fx_
-- :fx_id is S (or S2, S3). Pre-flight, loud: no restart may point at it.
-- (The column is previous_attempt_id, migration 020, not previous_attempt.)
select (count(*) = 0) as ok from public.interview_sessions where previous_attempt_id = :'fx_id' \gset
\if :ok
\else
\echo STOP: a restart points at the fixture; interview_sessions_previous_attempt_fk would fail the DELETE (#69)
\quit
\endif
-- interviewer turn (text is a word column: the guard fires and must pass)
insert into public.interview_turns
  (session_id, session_kind, provider_turn_id, sequence, speaker, kind, question_position, text,
   media_path, media_mime_type, media_bytes, media_sha256, offset_ms, duration_ms, started_at, ended_at)
values
  (:'fx_id', 'live', 'fx-i1', 1, 'interviewer', 'base_question', 1, 'fixture question',
   :'fx_id' || '/t1.wav', 'audio/wav', 1, repeat('0', 64), 0, 1000, now(), now())
returning id \gset fx_q_
```

The candidate turn, inserted where each proof says (P8b inserts it with
`transcript` null and `transcript_status = 'pending'` during fixture setup
and later UPDATEs it; P7 and P8a insert it, with words, inside the proof):

```sql
insert into public.interview_turns
  (session_id, session_kind, provider_turn_id, sequence, speaker, responds_to_turn_id,
   transcript, transcript_status,
   media_path, media_mime_type, media_bytes, media_sha256, offset_ms, duration_ms, started_at, ended_at)
values
  (:'fx_id', 'live', 'fx-c2', 2, 'candidate', :'fx_q_id',
   'probe-054 words', 'done',
   :'fx_id' || '/t2.wav', 'audio/wav', 1, repeat('0', 64), 1000, 1000, now(), now())
returning id \gset fx_c_
```

15. **P7, guarded INSERT first, then the delete.** Fixture S with its
    interviewer turn committed; no candidate turn yet.
    Expected before running: Conn 2's DELETE BLOCKS (ordinary block), because
    Conn 1's uncommitted INSERT holds FOR KEY SHARE on S's session row (and on
    the interviewer turn row, through `interview_turns_responds_to_fk`) and
    the DELETE needs those rows exclusively. No deadlock: Conn 1 waits for
    nothing. On Conn 1's commit, Conn 2's DELETE completes with `DELETE 1`
    and the cascade removes both turns. Final state: no session row, no turn
    rows.
    1. Conn 2: `set statement_timeout = '60s'; \timing on`.
    2. Conn 1: `begin;` then the candidate-turn INSERT above (words present,
       guard must pass). Expect `INSERT 0 1`. Hold open.
    3. Conn 2: `delete from public.interview_sessions where id = :'S';`
       Record: blocks / errors (which SQLSTATE) / completes at once.
    4. Conn 1: `commit;` Record what Conn 2 then prints and how long it waited.
    5. Record final state: `select count(*) from interview_sessions where id
       = :'S'` and `... from interview_turns where session_id = :'S'`.
       Expected 0 and 0.
    Refuted by: `40P01` on either connection; Conn 2 completing in step 3
    while Conn 1 still holds the INSERT (the FK lock did not conflict as
    stated); turn rows surviving step 5.
16. **P8a, delete first, then a concurrent INSERT.** Fresh fixture S2 with
    its interviewer turn committed; no candidate turn.
    Expected before running: Conn 2's INSERT BLOCKS on a foreign-key check
    (FOR KEY SHARE waits behind the uncommitted DELETE). The guard's BEFORE
    trigger runs first and passes, because its snapshot still sees S2. No
    deadlock: Conn 1 waits for nothing. On Conn 1's commit, Conn 2's INSERT
    fails with `23503`. Two keys are violated at that moment,
    `interview_turns_session_fk` (the session is gone) and
    `interview_turns_responds_to_fk` (the interviewer turn went with it);
    the message names whichever RI trigger fires first, expected
    `interview_turns_session_fk`. Record the name. Final state: no session
    row, no turn rows.
    1. Conn 2: `set statement_timeout = '60s'; \timing on`.
    2. Conn 1: `begin; delete from public.interview_sessions where id =
       :'S2';` Expect `DELETE 1`. Hold open.
    3. Conn 2: the candidate-turn INSERT for S2. Record: blocks / errors /
       completes.
    4. Conn 1: `commit;` Record what Conn 2 then prints, SQLSTATE and
       constraint name.
    5. Final state as in P7 step 5. Expected 0 and 0.
    Refuted by: `40P01`; `INSERT 0 1` succeeding after the commit (a child
    row with no parent); `RT063` (fixture bug, not a finding).
17. **P8b, delete first, then a concurrent UPDATE.** Its OWN fresh fixture
    S3, with BOTH turns committed beforehand, the candidate turn T3 inserted
    with `transcript` null and `transcript_status = 'pending'`. Separate from
    P8a because a connection blocked on the INSERT cannot issue the UPDATE.
    Expected before running: Conn 1's DELETE has already cascaded and holds
    the turn rows deleted-but-uncommitted, so Conn 2's UPDATE BLOCKS on the
    turn row itself before the guard ever runs. No deadlock. On Conn 1's
    commit the row is gone and Conn 2 reports `UPDATE 0` with no error.
    Final state: no session row, no turn rows.
    1. Conn 2: `set statement_timeout = '60s'; \timing on`.
    2. Conn 1: `begin; delete from public.interview_sessions where id =
       :'S3';` Expect `DELETE 1`. Hold open.
    3. Conn 2: `update public.interview_turns set transcript = 'probe-054
       words', transcript_status = 'done' where id = :'T3';` Record: blocks /
       errors / completes.
    4. Conn 1: `commit;` Record what Conn 2 then prints.
    5. Final state as in P7 step 5. Expected 0 and 0.
    Refuted by: `40P01`; `UPDATE 1` (the write landed on a row the committed
    delete should have removed); any `RT063`.
18. **Scope of P7 to P8b.** Staging's cascade runs through NINE foreign keys
    into `interview_sessions`; production's runs through TEN, because
    `live_session_events` does not exist on staging (#68). That table has no
    word columns and no trigger, so it does not change the lock ordering, but
    the honest record of a pass is "proven against staging's cascade", never
    "the production cascade". The catalog run of 2026-11-02 also shows
    staging's `interview_sessions` triggers are not production's:
    `interview_sessions_attempt_rules` is migration 020's body, not 053's,
    and 017's `interview_sessions_kind_immutable` is absent. Neither touches
    an INSERT with `previous_attempt_id` null or a DELETE, so the fixtures and
    the proofs are unaffected, but staging is not a faithful copy of
    production's trigger set and a result here is a staging result. And, as
    the top of this stage says: these interleavings only, nothing about the
    real `runInterviewPurge` or `deleteSessions`.

Concurrent proofs P5 and P6 borrow seeded sessions and RESTORE them. Staging
already holds seeded due and stamped sessions, so every Check G and Check D
expectation below is a DELTA against a baseline recorded in the same sitting,
never an absolute. They reproduce the accepted residual; they gate nothing.

19. **P5 ordering (b), the accepted residual, reproduced.** Two psql
    connections to staging; seed session S with `delete_after` a day or more
    out, `purged_at` null, candidate turn T with transcript null; record S, T
    and their original values.
    1. Baseline: run Check G, record all four lines as G0.
    2. Conn 1: `begin; update interview_sessions set purged_at =
       clock_timestamp() where id = :S;` hold open.
    3. Conn 2, autocommit: `update interview_turns set transcript =
       'probe-054', transcript_status = 'done' where id = :T;` Expect
       `UPDATE 1`. This is the residual: snapshot before the stamp, deadline
       still ahead on the database clock.
    4. Conn 1: `commit;`
    5. Check G: expect the `purged / turns` line to be G0 + 1 exactly; the
       other three lines unchanged.
    6. Cleanup procedure, step 3, for S. Check G: expect every line back to
       G0.
    7. Restore: `purged_at = null` on S; `transcript_status = 'pending',
       content_purged_at = null` on T. Check G: still G0.
    8. Control: Conn 1 `begin; update interview_sessions set purged_at =
       clock_timestamp() where id = :S; commit;` then Conn 2 the same write
       as step 3: expect `RT063`. Check G: still G0 (nothing landed).
       Restore `purged_at = null`.
20. **P6 ordering (a) closes itself.** Same shape on a second seed session S2
    (`delete_after` in the future, `purged_at` null, candidate turn T2 with
    transcript null); record originals.
    1. Baseline: Check G as G0, Check D as D0.
    2. Conn 1: `begin; update interview_sessions set delete_after =
       clock_timestamp() where id = :S2;` hold open.
    3. Conn 2, autocommit: the transcript write on T2. Expect `UPDATE 1`.
    4. Conn 1: `commit;`
    5. Check D: expect `due_unpurged` = D0 + 1. Check G: expect the
       `purged / turns` line unchanged and the `backlog / turns` line = G0 + 1
       exactly: S2 is due and unstamped, which is precisely the backlog arm.
    6. Clear with the cleanup's purge-shaped SQL for S2 (step 3 of the
       cleanup, with `s.purged_at is not null` replaced by `s.id = :S2`).
       Check G: back to G0.
    7. Restore S2's original `delete_after`; restore T2 (`transcript_status
       = 'pending'`, `content_purged_at = null`). Check D: back to D0.
21. STOP conditions for this stage: P1 or P5 step 8 does not raise `RT063`
    (the guard is not firing); P2, P3 or P4 raises (the guard blocks a
    legitimate write, the outage shape); any `40P01` in P7, P8a or P8b; any
    `RT063` in P7, P8a or P8b (fixture bug: stop and fix the fixture before
    reading the result); a final state in P7, P8a or P8b with rows left; P5
    step 5 or P6 step 5 moves any line other than the named one, or moves it
    by other than exactly one.

## Stage 4. Production, apply 054

22. Run F on production immediately before applying, even when D was all
    zeros: F is derivable from D at rest, but a transcribe or ai_scorecard
    job can be in flight at the moment of the apply. Expect no rows. STOP
    otherwise.
23. Run `054_interview_words_retention_guard.sql` top to bottom. Expect no
    errors. It is re-runnable; a partial failure is fixed by correcting and
    running the whole file again.
24. Trigger-exists check: expect 2 rows, both `tgenabled = 'O'`. STOP if not.
25. Do NOT run any P-proof on production.

## Stage 5. Production, one-time Check G and interpretation

26. The day after 054 is applied, run Check G with the two transcript arms.
    Then only at: the customer-1 rehearsal; after an actual applicant or
    company deletion, or a purge run that touched sessions; and when the
    first six-month expiries begin. Not on a calendar. Phase 1b transcript
    re-checking is the permanent closure.
27. Interpretation: 0 on the purged arm means no guarded write got through.
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
