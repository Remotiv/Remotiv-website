-- ============================================================================
-- Migration 041 — interview_sessions.live_outcome, interview_turns.audio_stopped_ms
-- ----------------------------------------------------------------------------
-- Run by hand in the Supabase SQL editor on 19 Oct 2026, together with the
-- interview-videos bucket update at the end of this file. Both succeeded.
--
-- live_outcome: what an AI Video Interview's saved export showed, written once
-- when the provider's export is saved (lib/interviews/live-ingest.ts): each
-- question's status (answered / skipped / not_reached), follow-up counts,
-- timing_suspect and the turns it affects, wording flags, the export's hash,
-- when it was saved, and the outcome (completed / partial / abandoned /
-- technical_failure) with answered_count, total and completion_percent. Facts
-- only: nothing here is a score.
--
-- Its own column, not a key in live_settings: live_settings is frozen at
-- invite, and migration 020's restart trigger requires a restart to copy it
-- unchanged, which would stamp the first attempt's outcome onto the second.
-- The trigger does not look at this column, so a restart starts empty.
--
-- audio_stopped_ms: for an interviewer turn the candidate cut off
-- (interrupted, migration 022), the point on the session clock where the
-- interviewer's audio stopped. Only an interrupted turn may carry it.
-- ============================================================================

alter table public.interview_sessions add column if not exists live_outcome jsonb;
alter table public.interview_sessions add constraint interview_sessions_live_outcome_object
  check (live_outcome is null or jsonb_typeof(live_outcome) = 'object');
alter table public.interview_sessions add constraint interview_sessions_live_outcome_live_only
  check (live_outcome is null or kind = 'live');
alter table public.interview_turns add column if not exists audio_stopped_ms integer;
alter table public.interview_turns add constraint interview_turns_audio_stopped_interrupted_only
  check (audio_stopped_ms is null or (interrupted and audio_stopped_ms >= 0));

-- ── Storage: the interview bucket accepts turn audio as well as video ──
-- Not a schema change; recorded here because it was run with this migration
-- and the turn audio upload (live-ingest.ts) depends on it.
update storage.buckets
   set allowed_mime_types = array['video/webm','video/mp4','audio/wav','audio/x-wav','audio/webm','audio/mpeg']
 where id = 'interview-videos';
