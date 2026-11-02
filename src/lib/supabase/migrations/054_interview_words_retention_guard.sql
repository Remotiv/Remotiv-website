-- ============================================================================
-- Migration 054 - no candidate words land on a session past retention (#63)
-- ----------------------------------------------------------------------------
-- NOT RUN. FOR REVIEW. Applied by hand, staging first, after 053.
-- Re-runnable: every statement is CREATE OR REPLACE or DROP IF EXISTS + CREATE.
-- Part A only: the two transcript tables. The three score tables are 054b,
-- held until scoreLiveSession checks delete_after itself (see 054b's header).
--
-- ── The hole ─────────────────────────────────────────────────
--
-- transcribe.ts, live-transcribe.ts and live-ingest.ts check delete_after ONCE
-- at job start, then download, call the provider (~55 s) and write with no
-- re-check. The purge's Phase 1b re-checks score words for 24 h after a
-- session is stamped purged_at; it never re-checks transcripts, and Phase 1
-- never reads a stamped session again. So a transcript written after the
-- stamp is kept for ever, and one written after delete_after (B7 sets it to
-- now()) is kept until the next daily run. Three writers, three disciplines;
-- this is one rule for all of them, and for writers nobody has audited.
--
-- ── The rule ─────────────────────────────────────────────────
--
-- A write that INTRODUCES words (non-empty in NEW and, on UPDATE, different
-- from OLD) into a word column below is refused when the owning
-- interview_sessions row is purged (purged_at not null) or past retention
-- (delete_after <= the clock). Everything else passes untouched: the purge's
-- own clearing (NEW holds no words), status-only writes (no word column
-- changes), the same words sent again, and every write to a session whose
-- retention has not run. No application code changes.
--
-- Word columns, from what purge.ts clears (its `words` object at
-- purgeDueTurns and the two answer updates in Phase 1):
--   interview_answers  transcript, transcript_segments
--   interview_turns    text, follow_up_reason, transcript, transcript_segments
-- Not words, not guarded: video_path, media_path, content_purged_at (paths
-- and markers), transcript_error (Remotiv's fixed sentences, which is what
-- keeps markFailed legal on a dying session), live_outcome (facts, counts and
-- sequences only; checked field by field 2026-11-02).
--
-- On refusal the statement RAISES with SQLSTATE 'RT063'. The message carries
-- the session id, the dates and the column names: never the words. The
-- writers' own error path then retries once with backoff, and the retry's
-- pre-check skips: one failed attempt in last_error, no dead letter.
--
-- ── The clock: clock_timestamp(), not now() ──────────────────
--
-- now() is the transaction's start time; clock_timestamp() is the wall clock
-- at the moment the comparison runs. A PostgREST write is one statement in
-- one transaction, so in practice they agree to within the statement's own
-- run time. clock_timestamp() is the stricter of the two in the only
-- direction that matters: a write whose transaction began a moment before
-- delete_after and reaches the trigger a moment after it is refused. The
-- purge's own selector compares delete_after with the app's clock at the
-- start of its run, so the trigger is never looser than the purge.
--
-- ── The residual, stated: NO ROW LOCK (decision 2026-11-02) ──
--
-- The trigger's SELECT reads interview_sessions under READ COMMITTED with the
-- write statement's snapshot. It takes no lock. Two orderings can therefore
-- land words after the gate:
--
--   (a) B7, applicant deletion. The write's snapshot predates B7's
--       `delete_after = now()` commit, so the trigger sees the old date and
--       passes. Words land on a session B7 is deleting. Closed seconds later
--       by B7's cascade delete of the session row (step 5), or, when B7 stops
--       at "files left" and keeps the rows, by the next purge run: purged_at
--       is still null there, so Phase 1 reads the session and clears it.
--       This ordering never persists.
--
--   (b) Retention. The purge cleared the session's words (one statement,
--       committed) and has not yet stamped purged_at (a later statement). A
--       write's snapshot falls between the two, so purged_at reads null. The
--       deadline check still refuses UNLESS the database clock has not yet
--       reached delete_after while the purge's app clock had: the purge
--       selects by the app's clock. So (b) needs BOTH the snapshot ordering
--       AND app-ahead-of-database clock skew, and the write must fall inside
--       that skew window at the session's exact delete_after. Then the words
--       land, the stamp lands after them, and Phase 1 never reads the session
--       again. THIS IS THE ONE THAT PERSISTS. The next purge run does NOT
--       clear it: the purge excludes stamped sessions by design (051).
--       Bound: one statement's duration, inside a window the width of the
--       clock skew, coinciding with the daily purge run. Without skew the
--       window is zero.
--
-- Why not SELECT ... FOR SHARE on the session: it would close the snapshot
-- half of (b) (a locking read sees the latest committed row), but not the
-- skew half, and it introduces a deadlock class with the purge, which writes
-- answer and turn rows and then the session row. Today each purge write is
-- its own PostgREST statement and commits before the next, so no lock is
-- held across them; the day the purge moves into one transaction (an RPC,
-- which the #59 notes contemplate) a shared lock here would deadlock it. A
-- new failure mode in the retention path is a worse trade than a residual
-- this size, and the lock does not even close all of it.
--
-- What closes (b) instead: Check G (read-only, in the execution notes) finds
-- any words on a stamped session, and the cleanup procedure clears them.
-- Phase 1b re-checking transcripts for stamped sessions, as it already does
-- score words, is the permanent closure (a code change on the Phase 1b
-- pattern; recorded, not built).
--
-- When Check G runs (decision 2026-11-02; production has 28 sessions, none
-- past retention, normal retention is six months and the product has not
-- launched, so no standing weekly check): the day after 054 is applied; at
-- the customer-1 rehearsal; after an actual applicant or company deletion or
-- a purge run that touched sessions; and when the first six-month expiries
-- begin. Not on a calendar.
--
-- What would change the decision: Check G non-zero in production even once;
-- measured app-to-database clock skew above one second; or the purge becoming
-- a single transaction, in which case the closure must be the Phase 1b
-- extension, never a lock here.
--
-- ── Clock skew, observed (not a guaranteed future maximum) ────
--
-- The residual (b) is as wide as the application clock runs AHEAD of the
-- database clock. Measured 2026-11-02 (method in 054-measurement.md):
--
--   staging database vs NTP   about -1 ms, uncertainty about +/-0.3 s
--     via a laptop proxy: 12 samples over one open connection, best
--     round trip 167 ms, database minus laptop +2710 ms +/-84 ms; the
--     laptop itself measured 2711 ms +/-218 ms behind NTP (sntp), so the
--     database agrees with NTP within the uncertainty.
--   production database       NOT measured by the designer (production
--     reads are not permitted to the design session). Same method, M2,
--     for the operator to run; expected result: within the same bound.
--   application runtime (Vercel functions, where B7 and the purge run)
--     NOT measured directly: no read-only path exists without a code
--     change (M3, later). M1 gives a historical estimate from rows the
--     runtime wrote; see the measurement notes.
--
-- Read this as: on 2026-11-02 the staging database clock was NTP-true to
-- well under a second. A cloud runtime that is also NTP-true leaves a
-- residual window of milliseconds. Nothing here guarantees either clock
-- tomorrow; that is why Check G exists.
--
-- ── Check G scope by rollout stage ───────────────────────────
--
--   before 054        run the two transcript arms (answers, turns) only.
--                     They need no function from this file.
--   after 054 Part A  the same two arms are the #63 monitor. A non-zero
--                     there is a guarded write that got through: the race,
--                     or the trigger off.
--   after 054b        enable the three score arms (answer_scores,
--                     session_scores, live_scores). Before 054b a non-zero
--                     score arm may still be a privacy issue worth clearing,
--                     but it is NOT a guard failure: no guard is installed
--                     on those tables yet.
--
-- ── Coordination with F10 (the other session's work) ─────────
--
-- Part A guards interview_turns, which saveLiveExport inserts and
-- handleLiveTurnTranscribe updates. Both pre-check delete_after
-- (live-ingest.ts past_retention; live-transcribe.ts "not transcribed"), the
-- restart RPC (053) copies attempt 1's delete_after to attempt 2 and refuses
-- a deadline at or past it, and live-restart.ts writes only
-- live_interview_actions and token_hash. No F10 flow writes turn text to a
-- session past delete_after on purpose. The webhook that will call
-- saveLiveExport does not exist in src/ yet: when it does, a turn insert that
-- fails with SQLSTATE RT063 is ordering (a), the applicant being deleted
-- under a late export. It must be treated as "ask again", not alerted; the
-- re-ask is refused by past_retention, and the audio uploaded at step 3
-- before the refused insert sits in a folder no row references until the
-- orphan sweep removes it after its 24-hour grace (application-deletion.ts
-- already documents this folder).
-- ============================================================================

-- ── 1. Does a JSON value hold anything? ──────────────────────
-- SQL NULL, JSON null, '' and whitespace, [] and {} are empty. Anything else
-- is content.
create or replace function public.interview_words_present(v jsonb)
returns boolean
language sql
immutable
as $$
  select case
    when v is null then false
    when jsonb_typeof(v) = 'null' then false
    when jsonb_typeof(v) = 'string' then btrim(v #>> '{}') <> ''
    when jsonb_typeof(v) = 'array' then jsonb_array_length(v) > 0
    when jsonb_typeof(v) = 'object' then v <> '{}'::jsonb
    else true
  end
$$;

-- ── 2. The words inside a score's JSON, and nothing else ─────
-- Used by 054b. interview_session_scores.criteria keeps every criterion and
-- whether it was shown; only each quote is the candidate's.
-- live_interview_scores.questions keeps scores, statuses, weights and counts;
-- only rationale and quotes are words. Any other (table, column) is returned
-- as is. Defined here so 054b is three triggers and nothing else.
create or replace function public.interview_words_projection(tbl text, col text, v jsonb)
returns jsonb
language sql
immutable
as $$
  select case
    when tbl = 'interview_session_scores' and col = 'criteria' and jsonb_typeof(v) = 'array' then
      coalesce((
        select jsonb_agg(c -> 'quote')
        from jsonb_array_elements(v) as c
        where nullif(btrim(c ->> 'quote'), '') is not null
      ), '[]'::jsonb)
    when tbl = 'live_interview_scores' and col = 'questions' and jsonb_typeof(v) = 'array' then
      coalesce((
        select jsonb_agg(jsonb_build_object('rationale', q -> 'rationale', 'quotes', q -> 'quotes'))
        from jsonb_array_elements(v) as q
        where nullif(btrim(q ->> 'rationale'), '') is not null
           or (jsonb_typeof(q -> 'quotes') = 'array' and jsonb_array_length(q -> 'quotes') > 0)
      ), '[]'::jsonb)
    else v
  end
$$;

-- ── 3. The guard ─────────────────────────────────────────────
-- BEFORE INSERT OR UPDATE OF <word columns>, one function for every guarded
-- table. Costs nothing unless words arrive: the session row is read only
-- then, by primary key, with no lock (see the residual above). SECURITY
-- DEFINER so the decision never depends on what the writing role may see of
-- interview_sessions.
create or replace function public.interview_words_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  cols     text[];
  n        jsonb := to_jsonb(new);
  o        jsonb := case when tg_op = 'UPDATE' then to_jsonb(old) else null end;
  col      text;
  nv       jsonb;
  ov       jsonb;
  arriving text[] := '{}';
  sess     uuid;
  s_delete_after timestamptz;
  s_purged_at    timestamptz;
  at_write       timestamptz;
begin
  cols := case tg_table_name
    when 'interview_answers'        then array['transcript', 'transcript_segments']
    when 'interview_turns'          then array['text', 'follow_up_reason', 'transcript', 'transcript_segments']
    when 'interview_answer_scores'  then array['reasoning', 'evidence', 'strengths', 'concerns', 'missing']
    when 'interview_session_scores' then array['summary', 'criteria']
    when 'live_interview_scores'    then array['questions']
    else null
  end;
  if cols is null then
    raise exception 'interview_words_guard: not configured for %.%', tg_table_schema, tg_table_name
      using errcode = 'RT063';
  end if;

  -- Which word columns does this write INTRODUCE? A column name that is not
  -- on the row is a misconfiguration and fails loudly rather than guarding
  -- nothing in silence.
  foreach col in array cols loop
    if not (n ? col) then
      raise exception 'interview_words_guard: %.% has no column %', tg_table_schema, tg_table_name, col
        using errcode = 'RT063';
    end if;
    nv := public.interview_words_projection(tg_table_name, col, n -> col);
    if not public.interview_words_present(nv) then
      continue;                                    -- clearing, or nothing there
    end if;
    if o is not null then
      ov := public.interview_words_projection(tg_table_name, col, o -> col);
      if nv = ov then
        continue;                                  -- the same words again: not new
      end if;
    end if;
    arriving := arriving || col;
  end loop;
  if cardinality(arriving) = 0 then
    return new;
  end if;

  -- Words are arriving. Is the owning session still open to them? A plain
  -- read, no lock: the residual this leaves is stated in the header.
  sess := (n ->> 'session_id')::uuid;
  select delete_after, purged_at
    into s_delete_after, s_purged_at
    from public.interview_sessions
   where id = sess;
  if not found then
    raise exception 'interview_words_guard: %.% write names session % which has no row; words refused',
      tg_table_schema, tg_table_name, sess
      using errcode = 'RT063';
  end if;
  -- The wall clock at this comparison, not the transaction's start: stricter
  -- than now() by the statement's own run time, in the safe direction.
  at_write := clock_timestamp();
  if s_purged_at is not null
     or (s_delete_after is not null and s_delete_after <= at_write) then
    raise exception 'interview_words_guard: session % is past retention (delete_after %, purged_at %, at %); % refused on %.%',
      sess, s_delete_after, s_purged_at, at_write, array_to_string(arriving, ', '), tg_table_schema, tg_table_name
      using errcode = 'RT063',
            hint = 'The session is purged or being deleted. There is nothing to retry.';
  end if;
  return new;
end;
$$;

-- ── 4. Part A: the transcript tables ─────────────────────────
drop trigger if exists interview_words_guard on public.interview_answers;
create trigger interview_words_guard
  before insert or update of transcript, transcript_segments
  on public.interview_answers
  for each row execute function public.interview_words_guard();

drop trigger if exists interview_words_guard on public.interview_turns;
create trigger interview_words_guard
  before insert or update of text, follow_up_reason, transcript, transcript_segments
  on public.interview_turns
  for each row execute function public.interview_words_guard();

-- ── 5. Not an API ────────────────────────────────────────────
-- The helpers are harmless but have no business on PostgREST. The trigger
-- body runs as its owner, so firing is unaffected.
revoke all on function public.interview_words_present(jsonb) from public, anon, authenticated;
revoke all on function public.interview_words_projection(text, text, jsonb) from public, anon, authenticated;

comment on function public.interview_words_guard() is
  'Refuses a write that introduces candidate words (transcripts, interviewer text, score quotes and reasoning) into a row whose interview_sessions row is purged (purged_at) or past retention (delete_after <= clock_timestamp()). SQLSTATE RT063. Clearing, status-only writes and unchanged words always pass. No row lock: see migration 054 for the stated residual and Check G. Migration 054 (#63).';
