-- ============================================================================
-- Migration 066 - a candidate recording can only be WRITTEN into storage while
--                 its interview may accept it (#50, QA-SAFETY-40 C-1)
-- ----------------------------------------------------------------------------
-- APPLIED TO STAGING 19 Nov 2026 by Waleed, WITHOUT the t-path rule below.
-- AMENDED after that run: scripts/staging/proofs-066.mjs S3 showed the
-- server's turn audio could recreate a file for a session already deleted.
-- The file is re-runnable (create or replace, drop trigger if exists): re-run
-- it on STAGING, re-run the proof, then PRODUCTION. Not on production yet.
--
-- ── Why ──────────────────────────────────────────────────────
--
-- A Supabase signed upload link lives 2 hours and cannot be revoked
-- (scripts/staging/checks-050-uploads.mjs, 19 Nov 2026, on staging):
--   - an upsert:true link can be used again to REPLACE a recording;
--   - after the recording is deleted, an old link (upsert true or false)
--     RECREATES it.
-- Storage writes every upload as INSERT ... ON CONFLICT DO UPDATE, as
-- service_role, whoever holds the link (read from pg_stat_statements). Postgres
-- fires a BEFORE INSERT row trigger for that statement even when the row
-- conflicts (proven on a temporary table in the same script), so one BEFORE
-- INSERT trigger refuses both a replacement and a recreation.
--
-- ── What is refused, by PATH (the role cannot tell a link from the server) ──
--
-- The two paths a candidate is ever given a link for, and the live turn audio
-- the SERVER writes after an interview. Anything else in the bucket is not
-- touched by this trigger.
--
--   {session}/q{position}[-{32 hex}].{webm|mp4}   async answer
--     allowed only while the session is async, invited or started, not
--     expired, not purged and not past delete_after. NO grace window: a saved
--     async link never gets one.
--
--   {session}/v{index}.{webm|mp4}                 live recording piece
--     allowed only for a live session, not purged and not past delete_after,
--     with a PENDING live_video_pieces row for exactly this path, and:
--       not ended: invited or started and not expired;
--       ended:     within 30 minutes of live_ended_at (UPLOAD_WINDOW_MS in
--                  lib/interviews/live-video.ts; a test pins the two).
--     The window is the live recorder finishing its last pieces after the
--     call ends, and applies to these paths only.
--
--   {session}/t{sequence}.{16 hex}.{ext}            live turn audio (server)
--     allowed only while the live session exists and is not purged, with no
--     time limit: the provider's export can arrive long after the call. A
--     session deleted between live-ingest's read and its upload (or a
--     webhook retried after a delete) cannot recreate a file.
--
-- A session that does not exist (deleted applicant) refuses all three. A
-- folder name that is not a uuid, under the candidate patterns, is refused.
--
-- SECURITY DEFINER with search_path = '' and every reference qualified: the
-- trigger reads public tables whichever role inserts.
--
-- Rollback:
--   drop trigger if exists interview_upload_open_session_only on storage.objects;
--   drop function if exists public.interview_upload_open_session_only();
-- ============================================================================

begin;

set local lock_timeout = '5s';

create or replace function public.interview_upload_open_session_only()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  m text[];
  v_session uuid;
  s record;
begin
  if new.bucket_id is distinct from 'interview-videos' then
    return new;
  end if;

  -- async answer: {uuid}/q{n}[-{32 hex}].{webm|mp4}
  m := pg_catalog.regexp_match(
    new.name,
    '^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/q[0-9]+(-[0-9a-f]{32})?\.(webm|mp4)$'
  );
  if m is not null then
    v_session := m[1]::uuid;
    select ses.kind, ses.status, ses.expires_at, ses.purged_at, ses.delete_after
      into s
      from public.interview_sessions ses
     where ses.id = v_session;
    if not found
       or s.kind is distinct from 'async'
       or s.status not in ('invited', 'started')
       or s.expires_at is null or s.expires_at <= pg_catalog.now()
       or s.purged_at is not null
       or (s.delete_after is not null and s.delete_after <= pg_catalog.now()) then
      raise exception using
        errcode = '42501',
        message = '066: this interview is not accepting recordings';
    end if;
    return new;
  end if;

  -- live piece: {uuid}/v{n}.{webm|mp4}
  m := pg_catalog.regexp_match(
    new.name,
    '^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/v[0-9]+\.(webm|mp4)$'
  );
  if m is not null then
    v_session := m[1]::uuid;
    select ses.kind, ses.status, ses.expires_at, ses.purged_at, ses.delete_after, ses.live_ended_at
      into s
      from public.interview_sessions ses
     where ses.id = v_session;
    if not found
       or s.kind is distinct from 'live'
       or s.purged_at is not null
       or (s.delete_after is not null and s.delete_after <= pg_catalog.now())
       or not exists (
            select 1
              from public.live_video_pieces p
             where p.session_id = v_session
               and p.media_path = new.name
               and p.status = 'pending')
       or (s.live_ended_at is not null
           and pg_catalog.now() > s.live_ended_at + interval '30 minutes')
       or (s.live_ended_at is null
           and (s.status not in ('invited', 'started')
                or s.expires_at is null or s.expires_at <= pg_catalog.now())) then
      raise exception using
        errcode = '42501',
        message = '066: this interview is not accepting recordings';
    end if;
    return new;
  end if;

  -- live turn audio (server): {uuid}/t{n}.{16 hex}.{ext}
  m := pg_catalog.regexp_match(
    new.name,
    '^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/t[0-9]+\.[0-9a-f]{16}\.[a-z0-9]{1,5}$'
  );
  if m is not null then
    if not exists (
         select 1
           from public.interview_sessions ses
          where ses.id = m[1]::uuid
            and ses.kind = 'live'
            and ses.purged_at is null) then
      raise exception using
        errcode = '42501',
        message = '066: this interview is not accepting recordings';
    end if;
    return new;
  end if;

  -- Anything else under a candidate-shaped name in the wrong folder shape.
  if new.name ~ '/[qv][0-9]+' and new.name !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/' then
    raise exception using
      errcode = '42501',
      message = '066: this interview is not accepting recordings';
  end if;
  return new;
end;
$$;

-- Postgres checks EXECUTE on a trigger function when the trigger is CREATED,
-- not when it fires, so these revokes stop direct calls and nothing else.
-- service_role is left alone: every Storage insert runs as it.
revoke all on function public.interview_upload_open_session_only() from public;
revoke all on function public.interview_upload_open_session_only() from anon, authenticated;

drop trigger if exists interview_upload_open_session_only on storage.objects;
create trigger interview_upload_open_session_only
  before insert on storage.objects
  for each row
  execute function public.interview_upload_open_session_only();

commit;

-- ── Post-check (read-only) ──────────────────────────────────────────────────
--
--   select t.tgname, pg_catalog.pg_get_triggerdef(t.oid)
--     from pg_catalog.pg_trigger t
--    where t.tgrelid = 'storage.objects'::regclass
--      and t.tgname = 'interview_upload_open_session_only';
--   -- Expect one row: BEFORE INSERT ... FOR EACH ROW
--
--   select p.prosecdef, p.proconfig
--     from pg_catalog.pg_proc p
--    where p.oid = 'public.interview_upload_open_session_only()'::regprocedure;
--   -- Expect: true, {search_path=""}
