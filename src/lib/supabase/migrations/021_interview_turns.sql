-- ============================================================================
-- Migration 021 — interview_turns
-- ----------------------------------------------------------------------------
-- One row per turn of a live interview (AI Video Interview): one continuous
-- stretch of speech by one speaker. Run after 020.
--
-- The scored unit does not change. interview_answers stays one row per base
-- question and is what the scorer reads; turns are the conversation beneath
-- it. Scope: AI-VIDEO-INTERVIEW-PHASE-1.md, A4.
--
-- ── What the provider confirmed, and what it changed from A4 ──
--
-- KIND. He tags each interviewer turn base_question, follow_up or
-- clarification. The values are his words, not A4's (original / answer), so
-- ingestion stores what he sends with no translation layer in between.
--   · kind is on INTERVIEWER turns only. A candidate turn's meaning comes from
--     the interviewer turn it responds to.
--   · procedural is NOT one of his three. It is here because a greeting or
--     "can you hear me?" needs a tag; if he will not send it, ingestion refuses
--     those turns. Confirm with him before ingestion is built.
--   · A clarification is an AI turn caused by the candidate asking what a
--     question means, and it does not count toward the two follow-ups. That
--     is structural: only a follow_up may carry follow_up_index, which is 1 or
--     2, and a unique index allows one follow-up per (session, question,
--     index). The database refuses a third follow-up; a clarification cannot
--     occupy a slot.
--   · Clarifications are UNCAPPED. Each is still an extra chance to answer, so
--     the clarification rate is measured across speaking styles alongside the
--     follow-up rate, and shown with each question's conversation.
--
-- TEXT. He saves the exact generated text before TTS, so interviewer text is
-- required. It is what the interviewer MEANT to say: if the candidate talks
-- over it or playback fails, it is not what they heard. Whether he marks a cut
-- turn is an open question — no column until he confirms.
--
-- ── Three changes found checking A4 against the code ─────────
--
-- 1. question_position, not an answer_id foreign key. interview_answers rows
--    are created by /api/interview/confirm when a VIDEO uploads, after the
--    call; turns arrive during it. A foreign key would reject every turn.
--    Turns join to answers on (session_id, position), which is unique.
--
-- 2. A flat media path: {sessionId}/t{sequence}.{ext}, not A5's
--    {sessionId}/live/t{sequence}. The retention purge and deleteInterview
--    both list {sessionId}/ WITHOUT descending into subfolders, so audio in
--    live/ would outlive both. The path check ties each file to its own
--    session and sequence.
--
-- 3. A turn can only belong to a LIVE session: the foreign key is on
--    (session_id, session_kind) against interview_sessions (id, kind), and
--    session_kind can only be 'live'. kind is immutable (017), so this cannot
--    be invalidated later.
--
-- ── Restarts ─────────────────────────────────────────────────
--
-- No attempt column. A restart is a new session (020), so an abandoned
-- attempt's turns are excluded from everything that reads the restart by
-- construction. Late events from a dropped call are stored on the abandoned
-- session, where nothing reads them.
--
-- ── Retention: every column holding the candidate's words ────
--
-- The purge must clear, for every turn whose session passes delete_after:
--   text, transcript, transcript_segments, transcript_error, follow_up_reason
-- and the media object (media_path cleared only once the object is confirmed
-- gone), then set content_purged_at. follow_up_reason is included because it
-- describes the candidate's answer. The constraints below require
-- content_purged_at before any of these may be null where they are otherwise
-- required.
--
-- Kept, as the hiring record: speaker, kind, question position, follow-up
-- index, timings, and the media's type, size and hash.
--
-- The purge does not handle turns yet. Add it in the same change as ingestion:
-- a column of the candidate's words with no purge is the defect fixed in
-- f3419cb for transcript_segments.
-- ============================================================================

-- Lets interview_turns reference (id, kind), so a turn can only exist on a live
-- session. id is already unique, so this cannot fail on existing rows.
alter table public.interview_sessions
  drop constraint if exists interview_sessions_id_kind_key;
alter table public.interview_sessions
  add constraint interview_sessions_id_kind_key unique (id, kind);

create table if not exists public.interview_turns (
  id                  uuid primary key default gen_random_uuid(),
  session_id          uuid not null,
  session_kind        text not null default 'live',
  provider_turn_id    text not null,
  sequence            integer not null,
  speaker             text not null,
  kind                text,
  question_position   integer,
  follow_up_index     smallint,
  follow_up_reason    text,
  responds_to_turn_id uuid,
  text                text,
  transcript          text,
  transcript_segments jsonb,
  transcript_status   text,
  transcript_error    text,
  media_path          text,
  media_mime_type     text not null,
  media_bytes         integer not null,
  media_sha256        text not null,
  offset_ms           integer not null,
  duration_ms         integer not null,
  started_at          timestamptz not null,
  ended_at            timestamptz not null,
  content_purged_at   timestamptz,
  created_at          timestamptz not null default now(),

  -- ── Belongs to one live session ──
  constraint interview_turns_session_fk
    foreign key (session_id, session_kind)
    references public.interview_sessions (id, kind) on delete cascade,
  constraint interview_turns_session_kind_live check (session_kind = 'live'),

  -- ── Responds within its own session ──
  -- MATCH SIMPLE: a null responds_to_turn_id is not checked.
  constraint interview_turns_id_session_key unique (id, session_id),
  constraint interview_turns_responds_to_fk
    foreign key (responds_to_turn_id, session_id)
    references public.interview_turns (id, session_id),
  constraint interview_turns_responds_to_not_self
    check (responds_to_turn_id is distinct from id),

  -- ── Order and idempotency ──
  -- A retried event matches on provider_turn_id; a different turn claiming a
  -- recorded sequence is the contract's 409.
  constraint interview_turns_sequence_key unique (session_id, sequence),
  constraint interview_turns_provider_turn_key unique (session_id, provider_turn_id),
  constraint interview_turns_provider_turn_nonempty check (length(btrim(provider_turn_id)) > 0),
  constraint interview_turns_sequence_positive check (sequence >= 1),

  -- ── Who spoke, and what kind of turn ──
  constraint interview_turns_speaker check (speaker in ('interviewer', 'candidate')),
  constraint interview_turns_kind_values
    check (kind is null or kind in ('base_question', 'follow_up', 'clarification', 'procedural')),
  constraint interview_turns_kind_interviewer_only
    check ((speaker = 'interviewer') = (kind is not null)),

  constraint interview_turns_position_positive
    check (question_position is null or question_position >= 1),
  constraint interview_turns_position_required
    check (kind not in ('base_question', 'follow_up', 'clarification') or question_position is not null),

  -- ── Follow-ups: indexed 1 or 2, with a reason. Nothing else has an index. ──
  -- IS [NOT] DISTINCT FROM, not =: kind is null on candidate turns, and a CHECK
  -- whose expression is null passes.
  constraint interview_turns_follow_up_index check (
    (kind is not distinct from 'follow_up') = (follow_up_index is not null)
    and (follow_up_index is null or follow_up_index in (1, 2))
  ),
  constraint interview_turns_follow_up_reason_required
    check (kind is distinct from 'follow_up' or follow_up_reason is not null or content_purged_at is not null),
  constraint interview_turns_follow_up_reason_only
    check (kind is not distinct from 'follow_up' or follow_up_reason is null),
  constraint interview_turns_follow_up_reason_nonempty
    check (follow_up_reason is null or length(btrim(follow_up_reason)) > 0),

  -- A candidate turn answers something. A follow-up responds to the answer that
  -- prompted it; a clarification to the candidate asking what a question means.
  constraint interview_turns_responds_to_required check (
    not (speaker = 'candidate' or kind in ('follow_up', 'clarification'))
    or responds_to_turn_id is not null
  ),

  -- ── Words ──
  -- Interviewer: the exact generated text, until purged. Candidate: never —
  -- their words come from transcription.
  constraint interview_turns_text_by_speaker check (
    case speaker
      when 'interviewer' then
        (text is not null and length(btrim(text)) > 0)
        or (text is null and content_purged_at is not null)
      else text is null
    end
  ),
  constraint interview_turns_transcript_candidate_only check (
    speaker = 'candidate'
    or (transcript is null and transcript_segments is null
        and transcript_status is null and transcript_error is null)
  ),
  constraint interview_turns_transcript_status check (
    (speaker = 'candidate') = (transcript_status is not null)
    and (transcript_status is null or transcript_status in ('pending', 'done', 'failed', 'skipped'))
  ),

  -- ── Media: one file per turn, recorded only after its size and hash check ──
  -- The accepted types are checked at ingestion: the provider's format is not
  -- confirmed, and a CHECK list would need a migration to add one.
  constraint interview_turns_media_present
    check (media_path is not null or content_purged_at is not null),
  constraint interview_turns_media_path
    check (media_path is null or media_path like session_id::text || '/t' || sequence::text || '.%'),
  constraint interview_turns_media_bytes check (media_bytes > 0),
  constraint interview_turns_media_sha256 check (media_sha256 ~ '^[0-9a-f]{64}$'),
  constraint interview_turns_media_mime_nonempty check (length(btrim(media_mime_type)) > 0),

  constraint interview_turns_timing
    check (offset_ms >= 0 and duration_ms > 0 and ended_at >= started_at)
);

-- At most one follow-up per (question, index): at most two per base question,
-- per attempt. 2 matches MAX_FOLLOW_UPS_PER_BASE_QUESTION in
-- lib/interviews/types.ts; raising that constant needs a migration here too.
create unique index if not exists interview_turns_one_follow_up_per_slot
  on public.interview_turns (session_id, question_position, follow_up_index)
  where kind = 'follow_up';

-- Service role only, like the other interview tables: the anon key reads none
-- of them.
alter table public.interview_turns enable row level security;
