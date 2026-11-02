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
7. **G, words on sessions past retention, per column, transcript tables
   only** (`054-check-G.sql`, twelve fixed rows). The score arms are added
   only after 054b.
   - **purged arm**, `purged_at is not null`. Phase 1 commits every clear as
     its own PostgREST statement and only then issues the `purged_at` stamp,
     excluding any session with something left to retry (purge.ts
     `markable`), so content on a stamped session was written after the
     clear or never cleared. No benign window, no time qualifier. Two
     findings, reported separately:
     - the four candidate-bearing columns (`transcript` and
       `transcript_segments` on both tables): non-zero is THE STOP. A
       possible candidate-data retention violation; run the cleanup and
       identify the writer before installing a guard whose first reading
       would be ambiguous.
     - `interview_turns.text` and `interview_turns.follow_up_reason`:
       non-zero is a purge-completeness WARNING requiring investigation.
       Interviewer-owned by constraint, provider-generated content that may
       quote the candidate; neither proof of a transcript leak nor proof of
       its absence.
   - **backlog arm**, `purged_at is null and delete_after <= now()`: RECORD
     ONLY, no STOP. The daily purge has not reached these.
   Expect production: 0 on all twelve rows.

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

**Guard scope versus Check G scope.** The guard refuses a write that
introduces content into ANY of the four word columns on `interview_turns`
(`text`, `follow_up_reason`, `transcript`, `transcript_segments`) and both on
`interview_answers`, on a gated session, whoever's words they are: refusing
every late write to a session past retention is correct and the guard is not
narrowed. Check G's STOP arm is narrower on purpose. By constraint
(`interview_turns_transcript_candidate_only`, `interview_turns_text_by_speaker`)
`transcript` and `transcript_segments` exist only on candidate turns and are
written only from Whisper over the candidate's audio, and `interview_answers`'
two columns likewise, so content there is candidate speech and is the STOP.
`text` and `follow_up_reason` are interviewer-only by constraint and are
written once, at export save, from the provider's generated interviewer
(`live-ingest.ts` turnRow; `parse-export.ts` keeps `follow_up_reason` as
given). Column ownership is not content provenance: a generated follow-up or
its reason can quote or paraphrase what the candidate just said, and nothing
in the code inspects that. So content left in those two columns after a
purge is a purge-completeness WARNING requiring investigation, neither proof
of a candidate-transcript leak nor proof of its absence.

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
    fails with `23503`. Two keys are violated at that instant,
    `interview_turns_responds_to_fk` (the interviewer turn went with the
    session) and `interview_turns_session_fk` (the session is gone); the
    message names the one PostgreSQL checks first, which the run of
    2026-11-02 showed to be `interview_turns_responds_to_fk`. Record the
    name. Final state: no session row, no turn rows.
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
    production's trigger set and a result here is a staging result. The
    same run showed all 1,400 seeded staging sessions have `delete_after`
    NULL and no turns at all: staging cannot exercise any retention path on
    seeded data, so every proof of a retention behaviour must build its own
    fixture. That requires synthetic fixtures; it does not make retention
    testing impossible, and P1 to P8 are the evidence. And, as the top of
    this stage says: these interleavings only, nothing about the real
    `runInterviewPurge` or `deleteSessions`.

Concurrent proofs P5 and P6 reproduce the accepted residual on the same
DISPOSABLE fixtures as P7 to P8b, destroyed at the end of each: staging holds
no seeded turn and every seeded session has `delete_after` NULL, so there is
nothing to borrow. Every Check G and Check D expectation is a DELTA against a
baseline recorded in the same sitting, and Check G means the CORRECTED,
per-column Check G (`scripts/backfills/054-check-G.sql`). The expectations
below are stated against that corrected check and have NOT been executed in
that form; the executed run of 2026-11-02 used the earlier combined count and
is recorded as it happened under Results. These proofs gate nothing.

19. **P5 ordering (b), the accepted residual, reproduced.** Fixture S built
    as for P7 (open session 60 days from retention, interviewer turn,
    candidate turn T with `transcript` null and `transcript_status =
    'pending'`), committed.
    Expected (corrected Check G, not yet executed in this form): connection 2
    does NOT block and lands `UPDATE 1`; after the commit, two purged-arm rows
    move by exactly one each: `interview_turns.transcript` (the race write,
    a STOP column) and `interview_turns.text` (the fixture's interviewer text,
    a WARN column: this fixture is stamped by hand without Phase 1's clear,
    so the text the real purge would have removed is still there). Every other
    row unchanged. Cleanup returns all twelve rows to G0. The control write
    after the committed stamp raises `RT063`.
    1. Baseline: Check G, all twelve rows, as G0.
    2. Conn 1: `begin; update interview_sessions set purged_at =
       clock_timestamp() where id = :S;` hold open.
    3. Conn 2, autocommit: `update interview_turns set transcript =
       'probe-054', transcript_status = 'done' where id = :T;` Expect
       `UPDATE 1` at once.
    4. Conn 1: `commit;`
    5. Check G: as expected above.
    6. Cleanup procedure, step 3, scoped to S. Check G: every row back to G0.
    7. Control: the same write as step 3 again: expect `RT063`, the message
       naming the session and "transcript", no words. Check G: still G0.
    8. Destroy: `delete from interview_sessions where id = :S and
       invited_by_name = 'fixture-054'`. Baseline: turns 0, fixtures 0.
20. **P6 ordering (a) closes itself.** Fresh fixture S2 of the same shape,
    candidate turn T2, committed.
    Expected (corrected Check G, not yet executed in this form): connection 2
    does NOT block and lands `UPDATE 1`; after the commit Check D
    `due_unpurged` = D0 + 1, and two backlog-arm rows move by exactly one
    each, `interview_turns.transcript` and `interview_turns.text`, with every
    purged-arm row unchanged: S2 is due and unstamped, which is precisely the
    backlog arm, record only. The purge-shaped clear returns Check G to G0;
    destroying the fixture returns Check D to D0.
    1. Baseline: Check G as G0, Check D as D0.
    2. Conn 1: `begin; update interview_sessions set delete_after =
       clock_timestamp() where id = :S2;` hold open.
    3. Conn 2, autocommit: the transcript write on T2. Expect `UPDATE 1` at
       once.
    4. Conn 1: `commit;`
    5. Check D and Check G: as expected above.
    6. Cleanup step 3 scoped to S2. Check G: back to G0.
    7. Destroy S2 as in P5 step 8. Check D: back to D0. Baseline: turns 0,
       fixtures 0.
21. STOP conditions for this stage: P1 or P5 step 8 does not raise `RT063`
    (the guard is not firing); P2, P3 or P4 raises (the guard blocks a
    legitimate write, the outage shape); any `40P01` in P7, P8a or P8b; any
    `RT063` in P7, P8a or P8b (fixture bug: stop and fix the fixture before
    reading the result); a final state in P7, P8a or P8b with rows left; P5
    step 5 or P6 step 5 moves any Check G row other than the two named ones,
    or moves either by other than exactly one.

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
27. Interpretation, per row of `054-check-G.sql`. Zero on every purged-arm
    row means no retained content was DETECTED in the six monitored columns.
    It is not proof that no late write occurred, and not proof that
    everything else was cleared. Two limits, and only these two. A session
    deleted since the write (B7 or company deletion) takes its rows with it
    through the cascade, so the evidence is gone and G reads zero. And G
    covers six columns on two tables only: not the score tables, not
    `live_outcome`, not `interview_notes`, not `live_session_events`, not
    media objects. Note what is NOT a limit: a later purge run cannot have
    cleared it, because Phase 1 never reads a stamped session again and a
    transcript written after the stamp persists indefinitely. That is the
    premise of #63. A non-zero STOP row (candidate-bearing column, purged arm) after 054 is
    either residual (b) or the trigger off: run the trigger-exists check
    first, then the cleanup procedure, then step 5 of the cleanup to
    identify the writer. A non-zero WARN row (`text` or `follow_up_reason`,
    purged arm) is a purge-completeness problem to investigate: which
    session, why Phase 1 stamped it with content left, and whether the
    content quotes the candidate; it is not by itself a transcript leak.
    A non-zero backlog row is the daily purge not having run yet; record it
    and read it again after the next run. A non-zero score arm before 054b
    may be a privacy issue to clear, but is not a guard failure: no guard is
    installed there yet.

## Results, 2026-11-02

Staging only, 054 Part A applied, both guard triggers enabled (verified at
the start of every block). Proven against staging's cascade (nine foreign
keys into `interview_sessions`, no `live_session_events`) and staging's
trigger set. Nothing here is a production result, and nothing here exercised
the real `runInterviewPurge` or `deleteSessions`. Baseline after every
concurrent proof: turns 0, sessions 1400, fixtures 0.

| Proof | Run by | Predicted | Actual |
|---|---|---|---|
| P1 | Waleed, Supabase editor, `054-proof-P1.sql` | `RT063` | PASS, `RT063`; triggers 2 enabled |
| P2 | same, `054-proof-P2.sql` | `UPDATE 1` | PASS |
| P3 | same, `054-proof-P3.sql` | `UPDATE 1` | PASS |
| P4 | same, `054-proof-P4.sql` | 2 rows, no `23514` | PASS |
| P7 | design session, psql, two connections | block, then `DELETE 1`, final 0/0 | blocked (still running at 4 s); `DELETE 1` in 2617 ms; final 0/0 |
| P8a | same | block, then `23503`, `session_fk` expected first, `responds_to_fk` possible | blocked; `23503` naming `interview_turns_responds_to_fk`; final 0/0. Prediction detail refuted: `responds_to_fk` is the key PostgreSQL names first |
| P8b | same | block, then `UPDATE 0`, no error | blocked; `UPDATE 0` in 3028 ms; final 0/0 |
| P5 | same | `UPDATE 1` not blocked; OLD combined G `purged/turns` +1; cleanup to G0; control `RT063` | `UPDATE 1` in 169 ms, not blocked; OLD combined G `purged/turns` +2, prediction refuted; cleanup cleared 2 rows, G0; control `RT063` with the guard's message; destroyed |
| P6 | same | `UPDATE 1`; D `due_unpurged` +1; OLD combined G `backlog/turns` +1 | `UPDATE 1` in 173 ms; D 0 to 1 and back to 0 after destroy; OLD combined G `backlog/turns` +2, same refutation; clear to G0; destroyed |

No `40P01` on any connection in any proof. The only errors were the predicted
`23503` in P8a and the predicted `RT063` in P5's control. The cascade
concurrency question is closed for these interleavings.

The +2 in P5 and P6 is fully explained and is what led to the per-column
Check G: the old combined count read the fixture's interviewer `text` (never
cleared, because the hand stamp skipped Phase 1's clear) identically to the
candidate transcript written in the race. Under the corrected Check G the
same run is EXPECTED to read +1 on `interview_turns.transcript` (STOP column)
and +1 on `interview_turns.text` (WARN column). That is an expectation
derived from the explanation, not an executed result.

## Check G

The authoritative, runnable text is `scripts/backfills/054-check-G.sql`
(corrected 2026-11-02, per column; also mirrored in the G section of
`054-prechecks-A-G.sql`). It returns twelve fixed rows: two arms, six
columns, a count of rows with content, and a finding. Rows exist even when
an arm has no sessions, so a 0 is a counted zero, never a missing row. A
counted zero is non-detection in these six columns, not proof of absence:
step 27 states the two limits.

- **purged arm**, `purged_at is not null`. Phase 1 commits every clear as its
  own statement and stamps only afterwards, excluding sessions with anything
  left to retry, so content here was written after the clear or was never
  cleared.
  - `interview_answers.transcript`, `interview_answers.transcript_segments`,
    `interview_turns.transcript`, `interview_turns.transcript_segments`:
    candidate-bearing by constraint and by writer. Non-zero is **STOP:
    investigate a possible candidate-data retention violation** before
    anything else.
  - `interview_turns.text`, `interview_turns.follow_up_reason`:
    interviewer-owned by constraint, provider-generated content that may
    quote candidate speech. Non-zero is a **purge-completeness warning
    requiring investigation**, not automatically evidence of a transcript
    leak and not evidence of its absence.
- **backlog arm**, `purged_at is null and delete_after <= now()`: the daily
  purge has not reached these. Every row is **record only**; on staging it
  is whatever fixtures exist, on production it is pending cleanup.

Rollout: before 054 and after Part A, run it as is. After 054b, the three
score tables get their own arms (they need 054's helper functions).

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
