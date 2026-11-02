-- 054 production pre-checks A to G, one file, one result grid. Supabase SQL Editor only:
-- no psql meta-commands. READ-ONLY: no writes, no fixtures, no DDL beyond one temp table.
-- Safe to run whole as many times as needed; run it again immediately before the apply so
-- that F (jobs in flight) is fresh. F has no separate file: this whole file is the re-run.
--
-- Read the finding column alone: PASS, STOP, WARN, record. Any STOP means do not apply 054.
-- The last row is a SUMMARY: STOP if any row is a STOP, else PASS.
--
-- Expected production result (2026-11-02): A every row PASS; B no interview_words_guard and
-- no WARN; C both cascades PASS; D purged 0, due_unpurged 0, never_expire 0, total 28;
-- E 0 and 0; F none; G 0 on all twelve rows.
--
-- G is COPIED from scripts/backfills/054-check-G.sql: its s, a, t and shape CTEs are
-- verbatim; only its final select is wrapped here as CTE g (indented two spaces) so the
-- finding can be mapped onto the count. That file stays the authority for G; change it
-- first and copy the change here. A zero in G is a counted zero in six columns, not
-- proof of absence.
-- Narrative, STOP reasoning and the proofs:
-- scripts/backfills/054-execution-sequence.md.
drop table if exists p_result;
create temp table p_result(id serial, chk text, item text, value text, finding text);

-- -- identity ---------------------------------------------------------------
-- Production has 28 sessions. Staging has 1400 and must never be mistaken for it.
insert into p_result(chk, item, value, finding)
select 'identity', current_database(), count(*)::text || ' sessions',
       case when count(*) = 28 then 'record: production count'
            else 'WARN: not 28 sessions; confirm this is production' end
  from public.interview_sessions;

-- -- A. Column inventory, tagged by part ------------------------------------
-- part A: 054's guard columns. MISSING is a STOP: the guard would raise RT063 on its
-- first fire. part B: 054b's score columns. MISSING blocks 054b only. part E:
-- transcript_status, Check E's input, never read by the guard; MISSING invalidates E,
-- not the apply.
with expected(part, table_name, column_name) as (values
  ('A', 'interview_answers', 'transcript'),
  ('A', 'interview_answers', 'transcript_segments'),
  ('A', 'interview_answers', 'session_id'),
  ('A', 'interview_turns', 'text'),
  ('A', 'interview_turns', 'follow_up_reason'),
  ('A', 'interview_turns', 'transcript'),
  ('A', 'interview_turns', 'transcript_segments'),
  ('A', 'interview_turns', 'session_id'),
  ('A', 'interview_sessions', 'delete_after'),
  ('A', 'interview_sessions', 'purged_at'),
  ('B', 'interview_answer_scores', 'reasoning'),
  ('B', 'interview_answer_scores', 'evidence'),
  ('B', 'interview_answer_scores', 'strengths'),
  ('B', 'interview_answer_scores', 'concerns'),
  ('B', 'interview_answer_scores', 'missing'),
  ('B', 'interview_answer_scores', 'session_id'),
  ('B', 'interview_session_scores', 'summary'),
  ('B', 'interview_session_scores', 'criteria'),
  ('B', 'interview_session_scores', 'session_id'),
  ('B', 'live_interview_scores', 'questions'),
  ('B', 'live_interview_scores', 'session_id'),
  ('E', 'interview_answers', 'transcript_status'),
  ('E', 'interview_turns', 'transcript_status'))
insert into p_result(chk, item, value, finding)
select 'A', e.part || ' ' || e.table_name || '.' || e.column_name,
       coalesce(c.data_type, 'MISSING'),
       case when c.column_name is not null then 'PASS'
            when e.part = 'A' then 'STOP: guard column missing; 054 would raise RT063'
            when e.part = 'B' then 'WARN: blocks 054b only, not 054'
            else 'WARN: Check E invalid; not a 054 STOP' end
  from expected e
  left join information_schema.columns c
    on c.table_schema = 'public' and c.table_name = e.table_name
   and c.column_name = e.column_name
 order by e.part, e.table_name, e.column_name;

-- -- A2. The database's own value set for transcript_status -----------------
-- interview_turns: migration 021's CHECK. interview_answers: no CHECK means the database
-- enforces nothing and the code (pending, done, failed; never skipped) is the only authority.
insert into p_result(chk, item, value, finding)
select 'A2', conrelid::regclass::text || ' ' || conname, pg_get_constraintdef(oid), 'record'
  from pg_constraint
 where contype = 'c'
   and conrelid in ('public.interview_answers'::regclass, 'public.interview_turns'::regclass)
   and pg_get_constraintdef(oid) ilike '%transcript_status%'
 order by 1, 2;
insert into p_result(chk, item, value, finding)
select 'A2', t.rel || ' transcript_status', 'no CHECK',
       'record: database enforces nothing; application code is the only authority'
  from (values ('interview_answers'), ('interview_turns')) as t(rel)
 where not exists (
   select 1 from pg_constraint
    where contype = 'c' and conrelid = ('public.' || t.rel)::regclass
      and pg_get_constraintdef(oid) ilike '%transcript_status%');

-- -- B. Existing triggers on the five word tables ---------------------------
-- Before 054: expect no interview_words_guard. A BEFORE trigger on a transcript table other
-- than the guard is a WARN: confirm by hand that it does not rewrite a word column.
insert into p_result(chk, item, value, finding)
select 'B', c.relname || ' ' || t.tgname, pg_get_triggerdef(t.oid),
       case when t.tgname = 'interview_words_guard'
              then 'record: guard already installed (expected only after 054)'
            when c.relname in ('interview_answers', 'interview_turns')
              then 'WARN: BEFORE trigger on a transcript table; '
                   || 'confirm it rewrites no word column'
            else 'record' end
  from pg_trigger t join pg_class c on c.oid = t.tgrelid
 where not t.tgisinternal
   and c.relname in ('interview_answers', 'interview_turns', 'interview_answer_scores',
                     'interview_session_scores', 'live_interview_scores')
 order by 1, 2;
insert into p_result(chk, item, value, finding)
select 'B', 'interview_answers + interview_turns, triggers other than the guard',
       count(*)::text,
       case when count(*) = 0 then 'PASS' else 'WARN: see rows above' end
  from pg_trigger t join pg_class c on c.oid = t.tgrelid
 where not t.tgisinternal and t.tgname <> 'interview_words_guard'
   and c.relname in ('interview_answers', 'interview_turns');

-- -- C. Foreign keys into interview_sessions --------------------------------
-- Both transcript tables must cascade: B7's ordering (a) closes itself through them.
insert into p_result(chk, item, value, finding)
select 'C', conrelid::regclass::text || ' ' || conname, pg_get_constraintdef(oid), 'record'
  from pg_constraint
 where contype = 'f' and confrelid = 'public.interview_sessions'::regclass
 order by 1, 2;
insert into p_result(chk, item, value, finding)
select 'C', t.rel || ' cascades from interview_sessions',
       case when x.ok then 'ON DELETE CASCADE' else 'absent' end,
       case when x.ok then 'PASS'
            else 'STOP: cascade missing; ordering (a) has no closure' end
  from (values ('interview_answers'), ('interview_turns')) as t(rel)
 cross join lateral (
   select exists (
     select 1 from pg_constraint
      where contype = 'f' and confrelid = 'public.interview_sessions'::regclass
        and conrelid = ('public.' || t.rel)::regclass
        and pg_get_constraintdef(oid) ilike '%ON DELETE CASCADE%') as ok) x;

-- -- D. Gated sessions, the baseline G is read against ----------------------
insert into p_result(chk, item, value, finding)
select 'D',
       'purged / due_unpurged / never_expire / total',
       count(*) filter (where purged_at is not null) || ' / '
         || count(*) filter (where purged_at is null and delete_after <= now()) || ' / '
         || count(*) filter (where delete_after is null) || ' / ' || count(*),
       case when count(*) filter (where purged_at is not null
                                     or (delete_after is not null and delete_after <= now())) = 0
            then 'PASS: no gated session' else 'record: gated sessions exist; read G closely' end
  from public.interview_sessions;

-- -- E. Transcription still pending under gated sessions --------------------
-- Point-in-time sample; the handlers skip these at job start. Never a STOP.
insert into p_result(chk, item, value, finding)
select 'E', 'answers pending under gated sessions', count(*)::text,
       case when count(*) = 0 then 'PASS' else 'record: handlers skip these; not a STOP' end
  from public.interview_answers a
  join public.interview_sessions s on s.id = a.session_id
 where (s.purged_at is not null or s.delete_after <= now()) and a.transcript_status = 'pending';
insert into p_result(chk, item, value, finding)
select 'E', 'turns pending under gated sessions', count(*)::text,
       case when count(*) = 0 then 'PASS' else 'record: handlers skip these; not a STOP' end
  from public.interview_turns t
  join public.interview_sessions s on s.id = t.session_id
 where (s.purged_at is not null or s.delete_after <= now()) and t.transcript_status = 'pending';

-- -- F. Jobs in flight against gated sessions -------------------------------
-- Derivable from D at rest, but a job can be in flight at the apply: re-run this file then.
with f as (
  select j.type, j.status, count(*) as n
    from public.background_jobs j
    join public.interview_sessions s on s.id::text = j.payload->>'sessionId'
   where j.type in ('transcribe', 'ai_scorecard') and j.status in ('queued', 'running')
     and (s.purged_at is not null or s.delete_after <= now())
   group by 1, 2
  union all
  select j.type, j.status, count(*)
    from public.background_jobs j
    join public.interview_answers a on a.id::text = j.payload->>'answerId'
    join public.interview_sessions s on s.id = a.session_id
   where j.type = 'transcribe' and j.status in ('queued', 'running')
     and (s.purged_at is not null or s.delete_after <= now())
   group by 1, 2)
insert into p_result(chk, item, value, finding)
select 'F', type || ' ' || status, n::text,
       'STOP: job in flight against a gated session; let it drain, re-run F'
  from f;
insert into p_result(chk, item, value, finding)
select 'F', 'jobs in flight against gated sessions', '0', 'PASS'
 where not exists (select 1 from p_result where chk = 'F');

-- -- G. Words on sessions past retention, per column ------------------------
-- COPIED from scripts/backfills/054-check-G.sql; keep in sync, that file is the authority.
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
  ('backlog', 'interview_turns', 'follow_up_reason', 'record: purge not yet run')),
g as (
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
    left join t on t.arm = sh.arm)
insert into p_result(chk, item, value, finding)
select 'G', arm || ' ' || tbl || '.' || col, rows_with_content::text,
       case when rows_with_content = 0 then 'PASS' else finding end
  from g
 order by arm desc, tbl, col;

-- -- SUMMARY ----------------------------------------------------------------
insert into p_result(chk, item, value, finding)
select 'SUMMARY', 'rows: STOP / WARN / record / PASS',
       count(*) filter (where finding like 'STOP%') || ' / '
         || count(*) filter (where finding like 'WARN%') || ' / '
         || count(*) filter (where finding like 'record%') || ' / '
         || count(*) filter (where finding = 'PASS'),
       case when count(*) filter (where finding like 'STOP%') > 0 then 'STOP: do not apply 054'
            when count(*) filter (where finding like 'WARN%') > 0 then 'WARN: read the WARN rows'
            else 'PASS: gate clear' end
  from p_result;
select chk, item, value, finding from p_result order by id;
