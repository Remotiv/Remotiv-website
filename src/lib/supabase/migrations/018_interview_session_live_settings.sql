-- ============================================================================
-- Migration 018 — interview_sessions.live_settings
-- ----------------------------------------------------------------------------
-- The settings that govern ONE live interview (AI Video Interview), frozen on
-- the session at invite: the interviewer's name, the follow-up limit, the
-- follow-up rules text sent to the provider, the language and the session
-- ceiling. A later job edit must not change an interview already in flight —
-- the same reason allow_rerecord and questions_snapshot are frozen here.
--
-- ── One jsonb, not five typed columns ────────────────────────
--
-- What we send the provider is still being decided: the blocking question in
-- AI-VIDEO-INTERVIEW-PHASE-1.md settles whether a criterion or the rubric goes
-- with each question, and several open questions add or remove fields after
-- that. Typed columns would mean a migration per answer.
--
-- More importantly this is ONE artefact — "what governed this interview, and
-- what we told the provider". Split across columns, nothing stops a later
-- reader taking three fields from the snapshot and two from the live job. That
-- partial freeze is the exact failure the snapshot exists to prevent.
--
-- questions_snapshot on this table is already this pattern: the frozen payload
-- as jsonb, its shape documented in TypeScript, with a comment naming what must
-- never be added to it.
--
-- THE COST, STATED: Postgres cannot enforce the shape. The object check below
-- is the first CHECK on a jsonb column in this schema and it only rejects a
-- stored array or scalar. The real guard is readLiveSettings() in
-- src/lib/interviews/types.ts, which narrows every field and logs the session id
-- on a malformed row. questions_snapshot is read with Array.isArray and then
-- cast, which is thin; do not copy that here.
--
-- ── Why this CAN be NOT NULL for live, when the provider ids in 019 cannot ──
--
-- READ THIS BEFORE "FIXING" THE INCONSISTENCY BETWEEN 018 AND 019.
--
-- The two columns answer the same question — null, or absent by constraint? —
-- and get different answers, for one reason: WHEN THE VALUE BECOMES KNOWN.
--
--   live_settings is frozen at INVITE, the moment this row is created, so the
--   constraint can demand it on every live row from the start.
--
--   provider / provider_session_id (019) are not known until the candidate
--   JOINS: the provider session is created after consent, long after the row
--   exists. A NOT NULL there would make the invite insert impossible.
--
-- So: live => live_settings NOT NULL, enforced at insert. live => provider ids
-- nullable until join. Neither is an oversight.
--
-- ── Incomplete settings refuse the send ──────────────────────
--
-- Only one field can actually be missing: the interviewer's name. The limit,
-- the rules and the ceilings are code constants (src/lib/interviews/
-- live-settings.ts). jobs.avatar_interviewer_name is null for a job whose
-- toggle is on but whose name was never typed — reachable today, and the state
-- of every job that has ever enabled the avatar toggle.
--
-- buildLiveSettings() refuses rather than defaulting. A fallback name means the
-- candidate speaks to an interviewer the company never named, and freezing an
-- incomplete snapshot would push the failure to join time, where the CANDIDATE
-- absorbs a configuration mistake the recruiter could have fixed.
-- ============================================================================

alter table public.interview_sessions
  add column if not exists live_settings jsonb;

alter table public.interview_sessions
  drop constraint if exists interview_sessions_live_settings_kind;

-- Equality, not two one-way checks: async must NOT carry settings, and live
-- MUST. Every row that exists today is async with a null here, so this is true
-- on the whole table before anything is written.
alter table public.interview_sessions
  add constraint interview_sessions_live_settings_kind
  check ((kind = 'live') = (live_settings is not null));

alter table public.interview_sessions
  drop constraint if exists interview_sessions_live_settings_object;

-- All this can enforce is "not an array, not a scalar". The shape is the
-- narrowing function's job. It is here because a stored [] or "" would
-- otherwise satisfy the NOT NULL above and read as a present snapshot.
alter table public.interview_sessions
  add constraint interview_sessions_live_settings_object
  check (live_settings is null or jsonb_typeof(live_settings) = 'object');

-- ----------------------------------------------------------------------------
-- STILL PENDING, and deliberately not here.
--
-- `kind` keeps its 'async' default until every writer names a kind explicitly.
-- sendInterviewInvite does; the live invite path does not exist yet, so the
-- drop-default migration is blocked on that path being built. Run it only once
-- both writers name their kind — a writer that forgets must fail NOT NULL
-- rather than silently mint an async session for the wrong option:
--
--   alter table public.interview_sessions alter column kind drop default;
-- ----------------------------------------------------------------------------
