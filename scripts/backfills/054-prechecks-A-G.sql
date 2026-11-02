-- ============================================================================
-- 054 production read-only pre-checks A to G (#63)
-- ----------------------------------------------------------------------------
-- THIS FILE IS THE AUTHORITY for the checks and their STOP conditions;
-- scripts/backfills/054-execution-sequence.md narrates it and must agree.
-- Read-only: counts, names and definitions. No row content, no candidate words.
-- Run in the Supabase SQL editor block by block, or:
--   psql "service=remotiv-prod" -X -v ON_ERROR_STOP=1 -f scripts/backfills/054-prechecks-A-G.sql
-- Pre-054b form: G has the two transcript tables only. The score arms are
-- added to G only after 054b is applied (they need 054's helper functions).
-- Check A tags every column with its part: 'A' (054: interview_answers,
-- interview_turns, interview_sessions), 'B' (054b: the three score tables)
-- or 'E' (transcript_status, Check E's input, never read by the guard).
-- A MISSING in part A is a STOP for 054. A MISSING in part B blocks 054b
-- only: record it, apply 054, fix the name before 054b. A MISSING in part E
-- invalidates Check E and is not a STOP for the apply.
-- ============================================================================
\set QUIET on
\pset footer off

-- ── A. Column inventory ──────────────────────────────────────
-- Every column the guard names, plus the transcript status column on both
-- transcript tables, as a LEFT JOIN so an absent column prints as MISSING
-- instead of silently shortening the count. Expect 23 rows, every status
-- 'present'. Each row carries its part:
--   part A  054:  interview_answers, interview_turns, interview_sessions.
--           STOP on any MISSING here: a guarded column name is wrong and
--           054's guard would raise RT063 on its first fire (it fails loudly
--           on purpose).
--   part B  054b: interview_answer_scores, interview_session_scores,
--           live_interview_scores. A MISSING here blocks 054b, not 054:
--           record it, apply 054, fix the name before 054b.
--   part E  transcript_status on both transcript tables. The guard never
--           reads it; it is Check E's input. A MISSING here means Check E is
--           wrong and must be rewritten; it is NOT a STOP for the 054 apply.
-- interview_sessions.id is deliberately absent: Check C proves it as the
-- target of the foreign keys.
-- The transcript status column is `transcript_status` on both tables. Its
-- value set in code (lib/interviews/types.ts TRANSCRIPT_STATUSES) is
-- 'pending', 'done', 'failed', 'skipped'. Migration 021 enforces exactly that
-- set on interview_turns, non-null iff speaker = 'candidate'. No migration in
-- the repo defines interview_answers, so its CHECK, if any, is read in A2.
with expected(part, table_name, column_name) as (values
  ('A', 'interview_answers','transcript'), ('A', 'interview_answers','transcript_segments'),
  ('A', 'interview_answers','session_id'),
  ('A', 'interview_turns','text'), ('A', 'interview_turns','follow_up_reason'), ('A', 'interview_turns','transcript'),
  ('A', 'interview_turns','transcript_segments'), ('A', 'interview_turns','session_id'),
  ('E', 'interview_answers','transcript_status'), ('E', 'interview_turns','transcript_status'),
  ('A', 'interview_sessions','delete_after'), ('A', 'interview_sessions','purged_at'),
  ('B', 'interview_answer_scores','reasoning'), ('B', 'interview_answer_scores','evidence'), ('B', 'interview_answer_scores','strengths'),
  ('B', 'interview_answer_scores','concerns'), ('B', 'interview_answer_scores','missing'), ('B', 'interview_answer_scores','session_id'),
  ('B', 'interview_session_scores','summary'), ('B', 'interview_session_scores','criteria'), ('B', 'interview_session_scores','session_id'),
  ('B', 'live_interview_scores','questions'), ('B', 'live_interview_scores','session_id'))
select e.part, e.table_name, e.column_name,
       coalesce(c.data_type, 'MISSING') as data_type,
       case when c.column_name is null then 'MISSING' else 'present' end as status,
       case when c.column_name is null and e.part = 'A' then 'STOP (054)'
            when c.column_name is null and e.part = 'B' then 'blocks 054b only'
            when c.column_name is null and e.part = 'E' then 'Check E invalid; not a 054 STOP'
            else '' end as consequence
from expected e
left join information_schema.columns c
  on c.table_schema = 'public' and c.table_name = e.table_name and c.column_name = e.column_name
order by 1, 2, 3;

-- A2. The real value set of transcript_status in the database, both tables.
-- Inspect this before relying on any interview_answers constraint. Expect
-- interview_turns: the 021 constraint quoting the four values and the
-- candidate-only rule, enforced by the database. For interview_answers: no
-- row means the database enforces NOTHING about the column; its values are
-- then established by application code alone (the confirm route writes
-- 'pending', the transcriber 'done' and 'failed', nothing writes 'skipped',
-- and any other string would be accepted). Record, no STOP.
select conrelid::regclass as table_name, conname, pg_get_constraintdef(oid)
from pg_constraint
where contype = 'c'
  and conrelid in ('public.interview_answers'::regclass, 'public.interview_turns'::regclass)
  and pg_get_constraintdef(oid) ilike '%transcript_status%'
order by 1, 2;

-- ── B. Existing triggers on the five tables ──────────────────
-- Expect no interview_words_guard before 054. STOP if any listed BEFORE
-- trigger rewrites a word column (none is known).
select c.relname, t.tgname, pg_get_triggerdef(t.oid)
from pg_trigger t join pg_class c on c.oid = t.tgrelid
where not t.tgisinternal
  and c.relname in ('interview_answers','interview_turns','interview_answer_scores','interview_session_scores','live_interview_scores')
order by 1, 2;

-- ── C. Foreign keys to interview_sessions ────────────────────
-- Expect interview_answers and interview_turns with ON DELETE CASCADE. STOP
-- if either cascade is missing: B7's ordering (a) then has no self-closure.
select conrelid::regclass, pg_get_constraintdef(oid)
from pg_constraint
where contype = 'f' and confrelid = 'public.interview_sessions'::regclass
order by 1;

-- ── D. Gated sessions ────────────────────────────────────────
-- Baseline for G. Record; no STOP.
select count(*) filter (where purged_at is not null) as purged,
       count(*) filter (where purged_at is null and delete_after <= now()) as due_unpurged,
       count(*) filter (where delete_after is null) as never_expire,
       count(*) as total
from public.interview_sessions;

-- ── E. Transcription still pending under gated sessions ──────
-- The real pending predicate is transcript_status = 'pending'. NOT
-- "transcript is null": that also matches failed rows and rows that never
-- had media. Rows here are jobs the handlers already skip at job start; the
-- guard changes nothing for them. Record; no STOP.
select 'answers' as t, count(*) from public.interview_answers a
  join public.interview_sessions s on s.id = a.session_id
 where (s.purged_at is not null or s.delete_after <= now()) and a.transcript_status = 'pending'
union all
select 'turns', count(*) from public.interview_turns t
  join public.interview_sessions s on s.id = t.session_id
 where (s.purged_at is not null or s.delete_after <= now()) and t.transcript_status = 'pending';

-- ── F. Live jobs aimed at gated sessions ─────────────────────
-- Derivable from D (no gated sessions, no gated jobs) but MUST BE RUN
-- immediately before the production apply: a job can be in flight at that
-- moment. Expect no rows. STOP if any: let it drain, re-run F.
select j.type, j.status, count(*)
from public.background_jobs j
join public.interview_sessions s on s.id::text = j.payload->>'sessionId'
where j.type in ('transcribe','ai_scorecard') and j.status in ('queued','running')
  and (s.purged_at is not null or s.delete_after <= now())
group by 1, 2
union all
select j.type, j.status, count(*)
from public.background_jobs j
join public.interview_answers a on a.id::text = j.payload->>'answerId'
join public.interview_sessions s on s.id = a.session_id
where j.type = 'transcribe' and j.status in ('queued','running')
  and (s.purged_at is not null or s.delete_after <= now())
group by 1, 2;

-- ── G. Words on sessions past retention, per column (corrected 2026-11-02) ──
-- Mirrors scripts/backfills/054-check-G.sql; that file is the runnable copy.
-- Two arms, twelve fixed rows, transcript tables only (the score arms come with 054b).
--   purged arm   purged_at IS NOT NULL. Phase 1 commits every clear before it stamps, so
--                content here was written AFTER the clear, or was never cleared.
--   backlog arm  purged_at IS NULL and delete_after <= now(): the purge has not run yet.
-- The finding column says what a non-zero count means:
--   STOP  candidate-bearing columns after purge (answers.transcript, answers.transcript_segments,
--         turns.transcript, turns.transcript_segments): a possible candidate-data retention
--         violation. Investigate before anything else.
--   WARN  other word columns after purge (turns.text, turns.follow_up_reason): the purge did
--         not finish its clear. Interviewer-owned by constraint, but their content comes from
--         the provider's generated interviewer and MAY quote candidate speech, so this is a
--         purge-completeness warning requiring investigation, not proof of a transcript leak
--         and not proof of its absence.
--   record  any backlog-arm count: pending cleanup on the next purge run. Not a STOP.
-- Rows exist for every column even when the arm has no sessions, so a 0 is a counted zero,
-- never a missing row. A counted zero is non-detection in these six columns, not proof that
-- no late write occurred: a session deleted since the write took its rows with it.
with s as (
  select id,
         case when purged_at is not null then 'purged' else 'backlog' end as arm
    from public.interview_sessions
   where purged_at is not null or delete_after <= now()
),
a as (
  select s.arm,
         count(*) filter (where x.transcript is not null) as transcript,
         count(*) filter (where x.transcript_segments is not null) as transcript_segments
    from s join public.interview_answers x on x.session_id = s.id
   group by s.arm
),
t as (
  select s.arm,
         count(*) filter (where x.transcript is not null) as transcript,
         count(*) filter (where x.transcript_segments is not null) as transcript_segments,
         count(*) filter (where x.text is not null) as text,
         count(*) filter (where x.follow_up_reason is not null) as follow_up_reason
    from s join public.interview_turns x on x.session_id = s.id
   group by s.arm
),
shape(arm, tbl, col, finding) as (values
  ('purged', 'interview_answers', 'transcript', 'STOP: candidate words after purge'),
  ('purged', 'interview_answers', 'transcript_segments', 'STOP: candidate words after purge'),
  ('purged', 'interview_turns', 'transcript', 'STOP: candidate words after purge'),
  ('purged', 'interview_turns', 'transcript_segments', 'STOP: candidate words after purge'),
  ('purged', 'interview_turns', 'text', 'WARN: purge incomplete; may quote candidate'),
  ('purged', 'interview_turns', 'follow_up_reason', 'WARN: purge incomplete; may quote candidate'),
  ('backlog', 'interview_answers', 'transcript', 'record: purge not yet run'),
  ('backlog', 'interview_answers', 'transcript_segments', 'record: purge not yet run'),
  ('backlog', 'interview_turns', 'transcript', 'record: purge not yet run'),
  ('backlog', 'interview_turns', 'transcript_segments', 'record: purge not yet run'),
  ('backlog', 'interview_turns', 'text', 'record: purge not yet run'),
  ('backlog', 'interview_turns', 'follow_up_reason', 'record: purge not yet run'))
select sh.arm, sh.tbl, sh.col,
       coalesce(case sh.tbl || '.' || sh.col
                  when 'interview_answers.transcript' then a.transcript
                  when 'interview_answers.transcript_segments' then a.transcript_segments
                  when 'interview_turns.transcript' then t.transcript
                  when 'interview_turns.transcript_segments' then t.transcript_segments
                  when 'interview_turns.text' then t.text
                  when 'interview_turns.follow_up_reason' then t.follow_up_reason
                end, 0) as rows_with_content,
       sh.finding
  from shape sh
  left join a on a.arm = sh.arm
  left join t on t.arm = sh.arm
 order by sh.arm desc, sh.tbl, sh.col;
