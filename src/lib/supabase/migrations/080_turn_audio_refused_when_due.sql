-- ============================================================================
-- Migration 080 - server-written live TURN AUDIO is refused once the
--                 session's delete_after is due (#55 part 2, 26 Nov 2026)
-- ----------------------------------------------------------------------------
-- A forward amendment of 066's public.interview_upload_open_session_only().
-- 066 is not edited. NOT APPLIED: Waleed applies it on STAGING, runs
-- scripts/staging/proofs-080.mjs there, then applies it on PRODUCTION, all
-- before the code that ships with it is pushed.
--
-- ── Why ──────────────────────────────────────────────────────
--
-- 066 refuses a live recording piece (v paths) once delete_after is due, but
-- the server's turn audio (t paths) only once the session is deleted or
-- purged. An applicant's delete closes its sessions first (071's Close sets
-- delete_after to now and cancels them), then empties their folders, then
-- deletes the rows (Finish). live-ingest checks retention before it uploads
-- turn audio, but an export that read the row before the Close and uploads
-- after the folder was emptied could write a file Finish then leaves behind
-- (the orphan sweep removed it after 24 hours). With 080 that write is
-- refused at the database, the same rule the v paths already have.
--
-- ── What changes ─────────────────────────────────────────────
--
-- ONE condition, in the t-path branch only:
--     and (ses.delete_after is null or ses.delete_after > pg_catalog.now())
-- Every other line of the function is 066's, byte for byte (pinned by
-- src/lib/supabase/migration-080.test.ts): the q and v branches, the
-- wrong-folder rule, the bucket check, SECURITY DEFINER and search_path ''.
-- The trigger itself (BEFORE INSERT ON storage.objects, FOR EACH ROW) is not
-- recreated: CREATE OR REPLACE keeps it pointing at this function, and keeps
-- the function's owner and the revokes 066 made.
--
-- Rollback: re-run 066's create or replace function (the function only).
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
            and ses.purged_at is null
            and (ses.delete_after is null or ses.delete_after > pg_catalog.now())) then
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

commit;

-- ── CHECK (read-only) ────────────────────────────────────────────────────────
--
--   -- One trigger, unchanged: BEFORE INSERT ... FOR EACH ROW, on this function.
--   select t.tgname, pg_catalog.pg_get_triggerdef(t.oid)
--     from pg_catalog.pg_trigger t
--    where t.tgrelid = 'storage.objects'::regclass
--      and t.tgname = 'interview_upload_open_session_only';
--
--   -- Still SECURITY DEFINER with an empty search_path.
--   select p.prosecdef, p.proconfig
--     from pg_catalog.pg_proc p
--    where p.oid = 'public.interview_upload_open_session_only()'::regprocedure;
--   -- Expect: true, {search_path=""}
--
--   -- 080 is in, and 066's v rules are still there (expect t, t, t).
--   select pg_catalog.strpos(d, 'and (ses.delete_after is null or ses.delete_after > pg_catalog.now())) then') > 0 as t_path_delete_after,
--          pg_catalog.strpos(d, 'pg_catalog.now() > s.live_ended_at + interval') > 0 as v_window_kept,
--          pg_catalog.strpos(d, 's.delete_after is not null and s.delete_after <= pg_catalog.now()') > 0 as v_delete_after_kept
--     from (select pg_catalog.pg_get_functiondef(
--             'public.interview_upload_open_session_only()'::regprocedure) as d) f;
