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
-- ============================================================================
\set QUIET on
\pset footer off

-- ── A. Column inventory ──────────────────────────────────────
-- Every column the guard names, plus the transcript status column on both
-- transcript tables, as a LEFT JOIN so an absent column prints as MISSING
-- instead of silently shortening the count. Expect 23 rows, every status
-- 'present'. STOP on any MISSING: a guarded column name is wrong and the
-- guard would raise RT063 on its first fire (054 fails loudly on purpose).
-- The transcript status column is `transcript_status` on both tables. Its
-- value set in code (lib/interviews/types.ts TRANSCRIPT_STATUSES) is
-- 'pending', 'done', 'failed', 'skipped'. Migration 021 enforces exactly that
-- set on interview_turns, non-null iff speaker = 'candidate'. No migration in
-- the repo defines interview_answers, so its CHECK, if any, is read below.
with expected(table_name, column_name) as (values
  ('interview_answers','transcript'), ('interview_answers','transcript_segments'),
  ('interview_answers','transcript_status'), ('interview_answers','session_id'),
  ('interview_turns','text'), ('interview_turns','follow_up_reason'), ('interview_turns','transcript'),
  ('interview_turns','transcript_segments'), ('interview_turns','transcript_status'), ('interview_turns','session_id'),
  ('interview_answer_scores','reasoning'), ('interview_answer_scores','evidence'), ('interview_answer_scores','strengths'),
  ('interview_answer_scores','concerns'), ('interview_answer_scores','missing'), ('interview_answer_scores','session_id'),
  ('interview_session_scores','summary'), ('interview_session_scores','criteria'), ('interview_session_scores','session_id'),
  ('live_interview_scores','questions'), ('live_interview_scores','session_id'),
  ('interview_sessions','delete_after'), ('interview_sessions','purged_at'))
select e.table_name, e.column_name,
       coalesce(c.data_type, 'MISSING') as data_type,
       case when c.column_name is null then 'MISSING' else 'present' end as status
from expected e
left join information_schema.columns c
  on c.table_schema = 'public' and c.table_name = e.table_name and c.column_name = e.column_name
order by 1, 2;

-- A2. The real value set of transcript_status in the database, both tables.
-- Expect interview_turns: the 021 constraint quoting the four values. For
-- interview_answers: whatever is there; no rows means no CHECK, and the code
-- is the only authority on its values (it writes pending, done, failed; it
-- never writes skipped). Record, no STOP.
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

-- ── G. Words on sessions past retention, two arms, transcript tables only ──
-- purged arm   purged_at IS NOT NULL and words present. THE STOP. Phase 1
--              commits every transcript clear (separate PostgREST statements)
--              and only then issues the purged_at stamp, excluding any session
--              with something left to retry (purge.ts: `markable`), so words
--              on a stamped session can only have been written AFTER the
--              clear: the race, with no benign window and no time qualifier.
-- backlog arm  purged_at IS NULL and delete_after <= now() and words present.
--              RECORD ONLY, no STOP: the daily purge has not reached these
--              yet. On staging this is the seeded due sessions and is large by
--              construction; folding it into the STOP arm would false-STOP.
-- Expect production: 0 on all four lines.
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
