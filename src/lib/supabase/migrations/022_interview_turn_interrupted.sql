-- ============================================================================
-- Migration 022 — interview_turns.interrupted
-- ----------------------------------------------------------------------------
-- The candidate cut the AI off before it finished speaking.
--
-- Why this needs recording at all: interview_turns.text is the exact text the
-- provider GENERATED, saved before TTS. It is what the interviewer meant to
-- say, not necessarily what the candidate heard. Without this flag, a turn
-- that was talked over reads on the review screen, and to the scorer, as a
-- question asked in full.
--
-- ── boolean NOT NULL DEFAULT false, and no third state ───────
--
-- A turn either was cut off or it was not. An "unknown" would be
-- indistinguishable from "not interrupted" in every query that matters — the
-- review screen's marker, the scorer's input, and the pre-launch check on
-- interruption rates — so it would buy nothing and have to be handled
-- everywhere. The default is false because the provider only sends the flag on
-- the exception, and the table was empty when this ran, so no row is
-- backfilled with a guess.
--
-- ── Only interviewer turns may carry it ──────────────────────
--
-- The flag describes the AI's speech being cut short, which is meaningless on
-- a candidate turn. `speaker` is NOT NULL and constrained to 'interviewer' or
-- 'candidate' (021), so the check below is reliable.
--
-- It does not make ingestion brittle: it fails exactly as the contract already
-- says Remotiv answers a broken rule — 422, naming the rule — rather than
-- storing something nobody defined. And `interrupted: true` on a candidate turn
-- would be one of two things, a provider bug or a DIFFERENT fact (the AI
-- talking over the candidate). That second fact needs its own column and its
-- own decision about what it means for scoring; silently accepting it here
-- would bury both.
--
-- ── WHAT THIS FLAG DOES NOT TELL YOU: where it was cut ───────
--
-- "Tell me about a time you closed a deal, from first contact to—" is a
-- different question from the whole sentence. This column says a turn was cut
-- short; it does not say how much was delivered.
--
-- THE CANDIDATE'S OWN RECORDING CANNOT ESTABLISH IT. Their video captures the
-- microphone, so in principle the AI's voice arrives through the room and stops
-- where they stopped hearing it. It does not hold:
--
--   · The recorder calls getUserMedia with `audio: true`
--     (src/app/interview/[token]/_flow.tsx), which in Chrome means echo
--     cancellation, noise suppression and auto gain are ON. Echo cancellation
--     exists to remove far-end audio playing out of the speakers, which is
--     exactly this audio.
--   · On headphones the AI's voice never reaches the microphone at all.
--   · Where some leaks through, the point playback stopped is indistinguishable
--     from the point cancellation removed it. That is a guess, not a record.
--   · Leakage is its own hazard: the AI's words landing in the candidate's
--     track would put them in the candidate transcript, which is the text the
--     scorer draws evidence quotes from and which must be the candidate's words
--     only (AI-VIDEO-INTERVIEW-PHASE-1.md, A7).
--
-- The provider's turn audio does not answer it either: that file is the full
-- generated audio, so `duration_ms` is the generated length, not what was
-- heard.
--
-- ── delivered_text: ASKED FOR, NOT YET AGREED ────────────────
--
-- The fix is for the provider to send the portion actually spoken —
-- `delivered_text` (the prefix that was heard) alongside the full text, or
-- `delivered_ms` (the playback position at the cut) if their TTS cannot map the
-- cut point back to words. Their in-browser client is what stops playback, so
-- it already knows the position. This has been raised while they are still
-- building and is NOT agreed; no column for it exists here, and none should be
-- added until it is, or it would be null on every row forever and read as
-- "the delivered portion is recorded" when nothing writes it (same reasoning as
-- provider_deleted_at in 019).
--
-- Until that lands, `interrupted` is the flag telling a reader that the
-- question as asked is not known in full. An interrupted question must not be
-- scored as if it was asked completely — nothing may be marked down as an
-- omission — and the turn is worth a person's eye.
-- ============================================================================

alter table public.interview_turns
  add column if not exists interrupted boolean not null default false;

alter table public.interview_turns
  drop constraint if exists interview_turns_interrupted_interviewer_only;

alter table public.interview_turns
  add constraint interview_turns_interrupted_interviewer_only
  check (speaker = 'interviewer' or interrupted = false);
