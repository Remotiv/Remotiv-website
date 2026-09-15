-- ============================================================================
-- Migration 019 — interview_sessions.provider, provider_session_id
-- ----------------------------------------------------------------------------
-- Who ran a live interview, and their id for the conversation. Written when the
-- candidate joins and the provider session is created — NOT at invite.
--
-- The precedent is the score tables: interview_answer_scores,
-- interview_session_scores and application_scores each carry ai_model and
-- prompt_version NOT NULL, so every score says which engine produced it. This
-- is the same idea for a conversation instead of a score.
--
-- `text` and not an enum or a value CHECK because the provider is not chosen
-- yet. Worth tightening to a CHECK list once one is: otherwise a typo in a
-- config value silently creates a second provider that no query groups with
-- the first.
--
-- ── Why these CANNOT be NOT NULL for live, when 018's live_settings is ──
--
-- READ THIS BEFORE "FIXING" THE INCONSISTENCY BETWEEN 018 AND 019.
--
-- Both columns answer the same question — null, or absent by constraint? — and
-- get different answers, for one reason: WHEN THE VALUE BECOMES KNOWN.
--
--   live_settings (018) is frozen at INVITE, the moment the row is created, so
--   its constraint demands it on every live row from the start.
--
--   These two are not known until the candidate JOINS. The provider session is
--   created after the consent screen is cleared, which can be days after the
--   invite. A NOT NULL here would make the invite insert impossible.
--
-- So: async => absent by constraint, always. live => nullable until join, then
-- both present. Neither is an oversight.
--
-- ── provider_deleted_at is deliberately ABSENT ───────────────
--
-- The contract has Remotiv record when the provider confirms it deleted the
-- conversation. That belongs with turn ingestion, which is on hold pending the
-- provider's answers. A column added now would be NULL on every row forever
-- and would read as "deletion is tracked" when nothing writes it. Add it with
-- the code that fills it, not before.
-- ============================================================================

alter table public.interview_sessions
  add column if not exists provider            text,
  add column if not exists provider_session_id text;

alter table public.interview_sessions
  drop constraint if exists interview_sessions_provider_live_only;

-- An async session has no provider, ever. A row carrying one is a bug that
-- should fail on write rather than sit there implying a conversation happened.
alter table public.interview_sessions
  add constraint interview_sessions_provider_live_only
  check (kind = 'live' or (provider is null and provider_session_id is null));

alter table public.interview_sessions
  drop constraint if exists interview_sessions_provider_pair;

-- Both or neither. Half a provider link is a link to nothing: an id with no
-- provider cannot be resolved, and a provider with no id names no conversation.
alter table public.interview_sessions
  add constraint interview_sessions_provider_pair
  check ((provider is null) = (provider_session_id is null));

alter table public.interview_sessions
  drop constraint if exists interview_sessions_provider_nonempty;

-- Present means present. '' is the value that looks set and is not — the same
-- class as a weight stored outside its own stops, which cost a day to find.
alter table public.interview_sessions
  add constraint interview_sessions_provider_nonempty
  check (
    (provider is null or length(btrim(provider)) > 0)
    and (provider_session_id is null or length(btrim(provider_session_id)) > 0)
  );

-- One provider session binds to exactly one Remotiv session.
--
-- Turn events arrive keyed by session; two rows claiming the same provider
-- session would cross-talk, and one candidate's answers could land on another's
-- scorecard. Unique on the PAIR, not on provider_session_id alone, because ids
-- are only guaranteed unique within a provider.
--
-- NOTE: this is the first partial unique index in this schema. It is the right
-- tool — the constraint only applies to rows that have joined — but it is a new
-- pattern here, not a local convention.
create unique index if not exists interview_sessions_provider_session_uniq
  on public.interview_sessions (provider, provider_session_id)
  where provider_session_id is not null;
