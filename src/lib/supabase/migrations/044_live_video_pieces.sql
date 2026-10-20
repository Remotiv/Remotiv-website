-- ============================================================================
-- Migration 044 - live_video_pieces, interview_sessions.live_ended_at
-- ----------------------------------------------------------------------------
-- NOT RUN YET. Run by hand in the Supabase SQL editor, after 042 (it reuses
-- 042's live_scoring_session_company() trigger function).
--
-- ── Before running ───────────────────────────────────────────
-- The table should not exist yet (NULL), and no live session has ended yet
-- (live links are locked):
--
-- select to_regclass('public.live_video_pieces') as table_exists,
--        (select count(*) from public.interview_sessions where kind = 'live') as live_sessions;
--
-- ── What it stores ───────────────────────────────────────────
--
-- The candidate's CAMERA VIDEO of an AI Video Interview, recorded by
-- Remotiv's own candidate screen and stored by Remotiv in the
-- interview-videos bucket (never on the interview server). The video carries
-- the camera and the candidate's own microphone only: Sarah's voice is NOT in
-- it. The review page plays her turn audio (interview_turns) separately.
--
-- A 30-minute interview is recorded as pieces of about two minutes (three at
-- most), each a complete, standalone file: the screen stops and restarts the
-- recorder for every piece, because a recorder's timeslice chunk is not
-- playable on its own. Pieces upload while the next one records, so a dropped
-- call loses at most the piece in progress.
--
-- ── Reserved at the start, confirmed after the upload ────────
--
-- A piece is RESERVED (status 'pending') when it starts recording, which is
-- when the screen asks for its upload URL; it is CONFIRMED once the file is
-- checked in storage. Reserving at the start is what lets the end of the
-- interview be a hard line:
--
--   while the interview is open    pieces are reserved and confirmed
--   once it has ended              no new piece can be reserved; pieces
--   (live_ended_at set)            already reserved can still be confirmed
--                                  for 30 minutes, then nothing
--
-- A reserved piece never confirmed is a gap the review page shows.
--
-- ── Fixed once reserved, never replaced once confirmed ───────
--
-- A reservation's identity never changes: session_id, company_id,
-- piece_index, media_path, mime_type and reserved_at stay as reserved, before
-- and after the interview ends. A pending piece changes in exactly two ways:
-- it is CONFIRMED (status, confirmed_at and the verified recording metadata:
-- bytes, started_ms, duration_ms, is_last), or retention clears its
-- media_path and stamps content_purged_at. A purged piece is never confirmed,
-- and a purge is never undone. A confirmed piece is immutable: only retention
-- may still clear its path. Writing a confirmed piece's own values again is a
-- no-op, so a repeated confirmation is harmless. The upload itself is
-- create-only (the backend signs with upsert false), so an old signed URL
-- cannot overwrite a stored file either.
--
-- ── Kept with the session, ended once ────────────────────────
--
-- A piece row is never deleted while its session exists: it goes only with
-- the session (ON DELETE CASCADE), when the trigger finds the session gone.
--
-- live_ended_at is the DATABASE's time, set once:
--   - a live session moving to a terminal status (submitted, expired,
--     cancelled, abandoned: migration 020's values) with no live_ended_at
--     gets live_ended_at = now(), whoever made the change;
--   - whoever sets it first, with whatever value, gets now(): no client,
--     past or future value is ever stored;
--   - once set, it is never changed or cleared,
-- so the 30-minute window is always measured from the real end and cannot
-- be reopened or moved. As a fallback, a piece is never confirmed on a
-- terminal session that somehow has no live_ended_at.
--
-- The backend stamps it the moment the interview server reports that the
-- conversation has ended (writing any value, which becomes now()), not only
-- at a later status change; the terminal-status rule is the backstop.
--
-- ── Clock ────────────────────────────────────────────────────
--
-- started_ms is milliseconds since the interview server's "conversation
-- started" message, measured by the candidate screen: the same clock as the
-- turns' offset_ms, so a quote's moment maps to a piece and an offset in it.
--
-- ── Retention and access ─────────────────────────────────────
--
-- Rows cascade with the session. The 6-month purge removes the session's
-- whole folder and clears media_path on each row; the orphan sweep counts a
-- confirmed piece's path as referenced (backend change, not here). RLS on, no
-- policies: server-only, like the other live tables. Company and live-only
-- are checked by 042's trigger function.
-- ============================================================================

-- ── interview_sessions.live_ended_at ─────────────────────────

alter table public.interview_sessions
  add column if not exists live_ended_at timestamptz;

alter table public.interview_sessions
  drop constraint if exists interview_sessions_live_ended_live_only,
  add constraint interview_sessions_live_ended_live_only
    check (live_ended_at is null or kind = 'live');

-- The end of a live interview: stamped by the database at the first terminal
-- status or first write, with its own time, and never moved after.
create or replace function public.interview_sessions_live_ended()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' and old.live_ended_at is not null then
    if new.live_ended_at is distinct from old.live_ended_at then
      raise exception 'interview_sessions: live_ended_at is set once and never changed or cleared';
    end if;
    return new;
  end if;
  -- Not ended yet: a terminal status, or anyone setting it, stamps the database's time.
  if new.live_ended_at is not null
     or new.status in ('submitted', 'expired', 'cancelled', 'abandoned') then
    new.live_ended_at := now();
  end if;
  return new;
end;
$$;

-- Replaces the set-once-only trigger of an earlier draft of this file, if present.
drop trigger if exists interview_sessions_live_ended_once on public.interview_sessions;
drop function if exists public.interview_sessions_live_ended_once();

drop trigger if exists interview_sessions_live_ended on public.interview_sessions;
create trigger interview_sessions_live_ended
  before insert or update on public.interview_sessions
  for each row
  when (new.kind = 'live')
  execute function public.interview_sessions_live_ended();

-- ── live_video_pieces ────────────────────────────────────────

create table if not exists public.live_video_pieces (
  id                 uuid primary key default gen_random_uuid(),
  session_id         uuid not null references public.interview_sessions (id) on delete cascade,
  company_id         uuid not null,
  piece_index        integer not null,
  status             text not null default 'pending',
  media_path         text,
  mime_type          text not null,
  bytes              bigint,
  started_ms         integer,
  duration_ms        integer,
  is_last            boolean not null default false,
  reserved_at        timestamptz not null default now(),
  confirmed_at       timestamptz,
  content_purged_at  timestamptz
);

alter table public.live_video_pieces
  drop constraint if exists live_video_pieces_one_per_index,
  add constraint live_video_pieces_one_per_index unique (session_id, piece_index);

alter table public.live_video_pieces
  drop constraint if exists live_video_pieces_index_range,
  add constraint live_video_pieces_index_range check (piece_index between 0 and 199);

alter table public.live_video_pieces
  drop constraint if exists live_video_pieces_status,
  add constraint live_video_pieces_status check (status in ('pending', 'confirmed'));

alter table public.live_video_pieces
  drop constraint if exists live_video_pieces_mime,
  add constraint live_video_pieces_mime check (mime_type in ('video/webm', 'video/mp4'));

-- Exactly the piece's own object: {session}/v{index}.webm or .mp4, matching its type.
-- Every reservation is created with this path; only retention clears it.
alter table public.live_video_pieces
  drop constraint if exists live_video_pieces_media_path,
  add constraint live_video_pieces_media_path
    check (
      media_path is null
      or media_path = session_id::text || '/v' || piece_index::text || '.'
           || case mime_type when 'video/mp4' then 'mp4' else 'webm' end
    );

alter table public.live_video_pieces
  drop constraint if exists live_video_pieces_media_present,
  add constraint live_video_pieces_media_present
    check (media_path is not null or content_purged_at is not null);

-- 50 MB, three minutes.
alter table public.live_video_pieces
  drop constraint if exists live_video_pieces_limits,
  add constraint live_video_pieces_limits
    check (
      (bytes is null or bytes between 1 and 52428800)
      and (duration_ms is null or duration_ms between 1 and 180000)
      and (started_ms is null or started_ms >= 0)
    );

-- Confirmed means checked: size, timing and time all present. Pending means none of that yet.
alter table public.live_video_pieces
  drop constraint if exists live_video_pieces_confirmed_fields,
  add constraint live_video_pieces_confirmed_fields
    check (
      case status
        when 'confirmed' then
          confirmed_at is not null and bytes is not null and started_ms is not null and duration_ms is not null
        else confirmed_at is null and not is_last
      end
    );

create index if not exists live_video_pieces_company on public.live_video_pieces (company_id);

drop trigger if exists live_video_pieces_company on public.live_video_pieces;
create trigger live_video_pieces_company
  before insert or update of session_id, company_id on public.live_video_pieces
  for each row execute function public.live_scoring_session_company();

-- The end of the interview is a hard line, and a confirmed piece is never replaced.
create or replace function public.live_video_pieces_guard()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  s_status text;
  s_ended timestamptz;
begin
  select status, live_ended_at into s_status, s_ended
    from public.interview_sessions where id = new.session_id;

  if tg_op = 'INSERT' then
    if new.status <> 'pending' then
      raise exception 'live_video_pieces: a piece is reserved before it is confirmed';
    end if;
    if s_ended is not null or s_status is distinct from 'invited' and s_status is distinct from 'started' then
      raise exception 'live_video_pieces: the interview has ended, no new piece can be reserved';
    end if;
    return new;
  end if;

  -- UPDATE. The reservation's identity never changes, in any state. The path
  -- may only be cleared (retention), and a purge is never undone.
  if new.session_id is distinct from old.session_id
     or new.company_id is distinct from old.company_id
     or new.piece_index is distinct from old.piece_index
     or new.mime_type is distinct from old.mime_type
     or new.reserved_at is distinct from old.reserved_at
     or (new.media_path is not null and new.media_path is distinct from old.media_path)
     or (old.content_purged_at is not null and new.content_purged_at is distinct from old.content_purged_at) then
    raise exception 'live_video_pieces: a piece keeps its reservation (session, company, number, path, type, time)';
  end if;

  if old.status = 'confirmed' then
    -- Immutable. Retention may only clear the path and stamp the purge;
    -- the same values written again are a no-op.
    if (to_jsonb(new) - 'media_path' - 'content_purged_at')
         is distinct from (to_jsonb(old) - 'media_path' - 'content_purged_at') then
      raise exception 'live_video_pieces: a confirmed piece is never replaced';
    end if;
    return new;
  end if;

  -- Pending, staying pending: only retention, or nothing at all.
  if new.status = 'pending' then
    if (to_jsonb(new) - 'media_path' - 'content_purged_at')
         is distinct from (to_jsonb(old) - 'media_path' - 'content_purged_at') then
      raise exception 'live_video_pieces: a reserved piece changes only by being confirmed, or by retention';
    end if;
    return new;
  end if;

  -- Pending to confirmed: the verified metadata arrives; the file must still be there.
  if old.media_path is null or old.content_purged_at is not null
     or new.media_path is null or new.content_purged_at is not null then
    raise exception 'live_video_pieces: a purged piece is never confirmed';
  end if;
  -- Fallback: a terminal session with no recorded end gets no window at all.
  if s_ended is null and s_status in ('submitted', 'expired', 'cancelled', 'abandoned') then
    raise exception 'live_video_pieces: the interview has ended without a recorded end, no piece can be confirmed';
  end if;
  if s_ended is not null and now() > s_ended + interval '30 minutes' then
    raise exception 'live_video_pieces: the upload window closed 30 minutes after the interview ended';
  end if;
  return new;
end;
$$;

drop trigger if exists live_video_pieces_guard on public.live_video_pieces;
create trigger live_video_pieces_guard
  before insert or update on public.live_video_pieces
  for each row execute function public.live_video_pieces_guard();

-- Never deleted while the session exists: a row goes only with its session.
-- The cascade deletes the session first, so the trigger finds it gone.
create or replace function public.live_video_pieces_no_delete()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if exists (select 1 from public.interview_sessions where id = old.session_id) then
    raise exception 'live_video_pieces: a piece goes only with its session';
  end if;
  return old;
end;
$$;

drop trigger if exists live_video_pieces_no_delete on public.live_video_pieces;
create trigger live_video_pieces_no_delete
  before delete on public.live_video_pieces
  for each row execute function public.live_video_pieces_no_delete();

alter table public.live_video_pieces enable row level security;

-- ── After running: constraints, RLS on, 0 policies ───────────
-- select conname, pg_get_constraintdef(oid) as definition
--   from pg_constraint
--  where conrelid = 'public.live_video_pieces'::regclass
--     or conname = 'interview_sessions_live_ended_live_only'
--  order by conname;
--
-- select c.relname, c.relrowsecurity as rls,
--        (select count(*) from pg_policies p where p.tablename = c.relname) as policies
--   from pg_class c
--  where c.relnamespace = 'public'::regnamespace and c.relname = 'live_video_pieces';
--
-- The four triggers this adds (should list 4 rows):
-- select tgrelid::regclass as "table", tgname
--   from pg_trigger
--  where tgname in ('interview_sessions_live_ended', 'live_video_pieces_company',
--                   'live_video_pieces_guard', 'live_video_pieces_no_delete')
--  order by 1, 2;
