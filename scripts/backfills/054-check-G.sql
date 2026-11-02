-- 054 Check G, corrected 2026-11-02: words on sessions past retention, per column.
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
