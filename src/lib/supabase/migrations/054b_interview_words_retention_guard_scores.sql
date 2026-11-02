-- ============================================================================
-- Migration 054b - the same guard on the three score tables (#63, Part B)
-- ----------------------------------------------------------------------------
-- NOT RUN. HELD. Requires 054 (the function and helpers live there).
--
-- RUN ONLY AFTER scoreLiveSession (lib/interviews/live-scoring.ts) reads
-- delete_after and returns notScored when retention has passed. Today that
-- scorer stops on the turns' content_purged_at marker and has no delete_after
-- check, so on a session B7 is deleting (delete_after = now, rows kept while
-- "files left") it writes rationale and quotes freely and Phase 1 clears them
-- later. With this trigger in place and no pre-check, that write RAISES
-- RT063, LiveScoringError db_error retries it, and after three attempts the
-- job is dead with the model calls paid three times. A surfaced bug, not an
-- outage, but the one-line pre-check turns it into a skip and should land
-- first.
--
-- The async scorer (lib/ai/interview-scoring.ts) already strips words when
-- past retention before each upsert and clears the session again after, so
-- this trigger reaches it only in the race between its check and its upsert;
-- the retry's job-start check then skips.
--
-- Word columns, from async-score-purge.ts and live-score-purge.ts:
--   interview_answer_scores   reasoning, evidence, strengths, concerns, missing
--   interview_session_scores  summary, criteria[*].quote   (projection in 054)
--   live_interview_scores     questions[*].rationale, questions[*].quotes (projection in 054)
-- Human adjustments (human_adjusted_score, human_feedback, adjusted_*) are
-- not word columns and do not fire these triggers.
-- ============================================================================

drop trigger if exists interview_words_guard on public.interview_answer_scores;
create trigger interview_words_guard
  before insert or update of reasoning, evidence, strengths, concerns, missing
  on public.interview_answer_scores
  for each row execute function public.interview_words_guard();

drop trigger if exists interview_words_guard on public.interview_session_scores;
create trigger interview_words_guard
  before insert or update of summary, criteria
  on public.interview_session_scores
  for each row execute function public.interview_words_guard();

drop trigger if exists interview_words_guard on public.live_interview_scores;
create trigger interview_words_guard
  before insert or update of questions
  on public.live_interview_scores
  for each row execute function public.interview_words_guard();
