-- ============================================================================
-- Migration 040 - Final Human Interview: Recall.ai recording bots
-- ----------------------------------------------------------------------------
-- Run by hand in Supabase SQL Editor. Not run by Claude Code.
-- Written 2026-10-10 against the live catalog read that day. One transaction:
-- either everything below lands or nothing does.
--
-- An unsigned Recall.ai guest bot joins the Google Meet of a FINAL interview,
-- the host admits it, and the recording is copied into Remotiv's private
-- storage afterwards. This file adds what that needs and nothing that reads
-- or writes it: no application code ships with it, so applying it changes no
-- behaviour anywhere. The handlers, the webhook and the import come in steps
-- 2 to 6.
--
-- ── What it adds ────────────────────────────────────────────────────────────
--
-- final_interview_recordings    'recall_bot' as a source, the vendor's
--                               recording id, and an uploader that may be
--                               absent, because an automatic import has none.
-- final_interview_bots          one row per vendor bot: which booking it
--                               records, where it stands, what was imported,
--                               and which host alerts have gone out.
-- two triggers on the bots      the tenant guard (service role, RLS does not
--                               bind) and the orphan guard (a deleted row
--                               still cleans up its vendor bot).
-- background_jobs               five new job types, three live-job unique
--                               indexes in the 027 pattern.
--
-- ── Decisions this encodes (locked 2026-10-10) ──────────────────────────────
--
-- * Bot created at booking, replaced on reschedule, deleted on cancel. The
--   bot row is written first with status 'pending'; the sync job makes the
--   vendor call and fills provider_bot_id.
-- * One live bot per booking (superseded_at is null). A reschedule marks the
--   old row superseded and writes a new one; nothing is updated in place at
--   the vendor.
-- * One import per vendor recording: vendor_recording_id is unique.
-- * The raw vendor event lands in last_event_code / last_event_sub_code, so a
--   value Recall adds tomorrow never trips a CHECK here.
-- * Deleting a bot row NEVER deletes the vendor bot by itself. The AFTER
--   DELETE trigger enqueues a final_bot_sync delete job that does; the step-2
--   daily reconcile and the unknown-bot webhook rule are the backstops.
--
-- ── What happens on each cascade ────────────────────────────────────────────
--
-- Applicant deleted      job_applications -> final_interviews (038, cascade)
--                        -> final_interview_bots (cascade). The orphan guard
--                        fires per bot row; the vendor bot and its media are
--                        deleted by the queued job.
-- Final interview deleted  final_interviews -> bots (cascade). Same.
-- Booking deleted        interview_bookings -> bots (cascade). Same. Bookings
--                        are cancelled, not deleted, in the application; this
--                        covers a by-hand delete.
-- Company deleted        companies -> final_interviews -> bots. Same, and the
--                        cleanup job carries company_id NULL on purpose so the
--                        company cascade cannot take the job with it.
--
-- ── What is NOT here ────────────────────────────────────────────────────────
--
-- The storage bucket and its policies, communication_logs,
-- notifications_company, message_templates, any interview_bookings change,
-- data backfills, updated_at triggers (the application sets updated_at),
-- and every timeout or retention value (code constants).
-- ============================================================================

begin;

-- ── 1. Preconditions, before anything is created ────────────────────────────
--
-- Refuses, and therefore creates nothing, unless the live database looks
-- exactly like the catalog read of 2026-10-10. A re-run also refuses: the
-- bots table already existing is the signal.

do $$
declare
  v_def      text;
  v_count    integer;
  v_val      text;
  v_types    text[] := array[
    'ai_cv_score',
    'send_message',
    'interview_reminder',
    'interview_expiry',
    'interview_expiry_sweep',
    'cv_score_recompute',
    'transcribe',
    'ai_scorecard',
    'calendar_sync',
    'interview_purge',
    'cv_purge',
    'queue_sweep',
    'talent_retention_warn',
    'talent_retention_purge'
  ];
begin
  if to_regclass('public.final_interviews') is null then
    raise exception '040: public.final_interviews is missing. Apply 038 first. Not proceeding.';
  end if;
  if to_regclass('public.final_interview_recordings') is null then
    raise exception '040: public.final_interview_recordings is missing. Apply 038 first. Not proceeding.';
  end if;
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'interview_bookings' and column_name = 'purpose'
  ) then
    raise exception '040: interview_bookings.purpose is missing. Apply 038 first. Not proceeding.';
  end if;
  if to_regclass('public.final_interview_bots') is not null then
    raise exception '040: public.final_interview_bots already exists. This file has been applied. Not proceeding.';
  end if;

  -- The recordings source CHECK must still be the two-value 038 version.
  select pg_get_constraintdef(oid) into v_def
    from pg_constraint
   where conrelid = 'public.final_interview_recordings'::regclass
     and conname  = 'final_interview_recordings_source_check';
  if v_def is null then
    raise exception '040: final_interview_recordings_source_check not found. Not proceeding.';
  end if;
  if position('''recall_bot''' in v_def) > 0 then
    raise exception '040: final_interview_recordings_source_check already allows recall_bot. Not proceeding.';
  end if;

  -- background_jobs_type_check: exactly the fourteen values the live
  -- database allowed on 2026-10-10, which is also JOB_TYPES in
  -- src/lib/jobs-queue.ts. pg_get_constraintdef renders an IN list as
  -- `type = ANY (ARRAY['a'::text, ...])`, so the `::text` casts count values.
  select pg_get_constraintdef(oid) into v_def
    from pg_constraint
   where conrelid = 'public.background_jobs'::regclass
     and conname  = 'background_jobs_type_check';
  if v_def is null then
    raise exception '040: background_jobs_type_check not found. Inspect the live constraints; this file will not guess a name.';
  end if;
  v_count := (length(v_def) - length(replace(v_def, '::text', ''))) / length('::text');
  if v_count <> array_length(v_types, 1) then
    raise exception
      '040: expected exactly % job types in background_jobs_type_check but the live constraint has %. Not replacing an unexpected definition. Live definition: %',
      array_length(v_types, 1), v_count, v_def;
  end if;
  foreach v_val in array v_types loop
    if position(quote_literal(v_val) || '::text' in v_def) = 0 then
      raise exception
        '040: background_jobs_type_check does not include expected value %. Not replacing an unexpected definition. Live definition: %',
        v_val, v_def;
    end if;
  end loop;
end
$$;


-- ── 2. final_interview_recordings: a third source, and no uploader for it ───
--
-- 'recall_bot' rows are written by the import job, which has no user behind
-- it. uploaded_by was NOT NULL in 038 because every source then was a person
-- attaching a file; it stays required for those two sources. The application
-- writes uploaded_by_name = 'Remotiv automatic import' on bot rows.

alter table public.final_interview_recordings
  add column vendor_recording_id text;

alter table public.final_interview_recordings
  drop constraint final_interview_recordings_source_check,
  add constraint final_interview_recordings_source_check
    check (source in ('google_drive', 'manual_upload', 'recall_bot')),
  -- The vendor id exactly when the source is the vendor, never otherwise.
  add constraint final_interview_recordings_vendor_recording_check
    check ((source = 'recall_bot') = (vendor_recording_id is not null)),
  alter column uploaded_by drop not null,
  add constraint final_interview_recordings_uploader_check
    check (source = 'recall_bot' or uploaded_by is not null);

-- One import per vendor recording.
create unique index if not exists final_interview_recordings_vendor_recording_idx
  on public.final_interview_recordings (vendor_recording_id)
  where vendor_recording_id is not null;


-- ── 3. final_interview_bots ─────────────────────────────────────────────────

create table public.final_interview_bots (
  id                   uuid primary key default gen_random_uuid(),
  final_interview_id   uuid not null,
  company_id           uuid not null,
  job_id               uuid not null,
  application_id       uuid not null,
  -- Same composite target 038 gave the recordings table, so a bot row's
  -- company, job and application can never disagree with its interview's.
  foreign key (final_interview_id, company_id, job_id, application_id)
    references public.final_interviews (id, company_id, job_id, application_id)
    on delete cascade,
  -- The booking this bot records. A reschedule makes a new booking time on
  -- the same row, and a new bot row pointing at it; the old one is superseded.
  booking_id           uuid not null references public.interview_bookings(id) on delete cascade,
  provider             text not null check (provider = 'recall'),
  -- Filled by the sync job once the vendor has accepted the bot.
  provider_bot_id      text,
  provider_recording_id text,
  -- When the bot is told to join. The application sets it a little before
  -- scheduled_start; the lead time is a code constant.
  join_at              timestamptz not null,
  -- Remotiv's own view of where the bot stands. The vendor's raw words are in
  -- last_event_code / last_event_sub_code and are never constrained here.
  status               text not null default 'pending'
                         check (status in (
                           'pending', 'scheduled', 'waiting_room', 'in_call', 'recording',
                           'call_ended', 'done', 'fatal', 'superseded', 'deleted'
                         ))
                         check (status <> 'superseded' or superseded_at is not null),
  last_event_code      text,
  last_event_sub_code  text,
  last_event_at        timestamptz,
  -- Host alerts, stamped so each is sent once.
  lobby_alert_sent_at  timestamptz,
  failure_alert_sent_at timestamptz,
  -- The copy into Remotiv storage.
  import_status        text not null default 'none'
                         check (import_status in ('none', 'queued', 'importing', 'ready', 'failed')),
  import_started_at    timestamptz,
  import_error         text,
  -- Set when a reschedule or cancel replaces this bot. Null means live.
  superseded_at        timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

-- The vendor never hands out one bot id twice; neither may we hold it twice.
create unique index final_interview_bots_provider_bot_idx
  on public.final_interview_bots (provider_bot_id)
  where provider_bot_id is not null;
-- One live bot per booking.
create unique index final_interview_bots_one_live_idx
  on public.final_interview_bots (booking_id)
  where superseded_at is null;

create index final_interview_bots_interview_idx
  on public.final_interview_bots (final_interview_id);
-- The lobby check's selector: bots in a given state around their join time.
create index final_interview_bots_status_join_idx
  on public.final_interview_bots (status, join_at);
create index final_interview_bots_company_idx
  on public.final_interview_bots (company_id);

-- Same posture as every other product table: RLS on, no policies. Only the
-- service role, which RLS does not bind, reaches these rows.
alter table public.final_interview_bots enable row level security;


-- ── 4. Tenant guard ─────────────────────────────────────────────────────────
--
-- Every query against this table runs as the service role, so a foreign key
-- alone cannot stop a bot row from naming another company's booking. The
-- booking must belong to the row's company and to the row's final interview.
-- SECURITY INVOKER: it reads the same table the caller may already read.

create or replace function public.final_interview_bots_validate()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_booking_company   uuid;
  v_booking_interview uuid;
begin
  select b.company_id, b.final_interview_id
    into v_booking_company, v_booking_interview
    from public.interview_bookings b
   where b.id = new.booking_id;

  if not found then
    raise exception 'final_interview_bots: booking % does not exist', new.booking_id
      using errcode = '23503';
  end if;
  if v_booking_company is distinct from new.company_id then
    raise exception 'final_interview_bots: booking % does not belong to company %',
      new.booking_id, new.company_id
      using errcode = '42501';
  end if;
  if v_booking_interview is distinct from new.final_interview_id then
    raise exception 'final_interview_bots: booking % is not a booking of final interview %',
      new.booking_id, new.final_interview_id
      using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists final_interview_bots_validate on public.final_interview_bots;
create trigger final_interview_bots_validate
  before insert or update of booking_id, final_interview_id, company_id
  on public.final_interview_bots
  for each row execute function public.final_interview_bots_validate();


-- ── 5. Orphan guard ─────────────────────────────────────────────────────────
--
-- Deleting a bot row never deletes the vendor bot by itself. When a row that
-- still names a vendor bot disappears, whatever the reason (a cascade from
-- the applicant, the interview, the booking or the company, or a delete by
-- hand), this queues the job that deletes it at the vendor. company_id is
-- NULL on purpose: background_jobs.company_id is nullable, and a job scoped
-- to a company that is being deleted would cascade away with it.
--
-- It must never block the delete. The insert is wrapped so any failure,
-- including a 23505 from the cleanup unique index when the same bot is
-- already queued for deletion, becomes a WARNING. A missed job is caught by
-- the step-2 daily reconcile.

create or replace function public.final_interview_bots_orphan_guard()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  -- Nothing to clean up when the vendor bot was never created, was already
  -- deleted at the vendor, or its recording is safely in Remotiv storage (the
  -- import deletes the vendor copy before marking itself ready). A 'done' bot
  -- may still hold its recording at the vendor, so 'done' is NOT skipped.
  if old.provider_bot_id is null
     or old.status = 'deleted'
     or old.import_status = 'ready' then
    return old;
  end if;

  begin
    insert into public.background_jobs (type, payload, company_id, status)
    values (
      'final_bot_sync',
      jsonb_build_object(
        'action', 'delete',
        'providerBotId', old.provider_bot_id,
        'providerRecordingId', old.provider_recording_id
      ),
      null,
      'queued'
    );
  exception when others then
    raise warning 'final_interview_bots: could not queue vendor cleanup for bot % (%): %',
      old.provider_bot_id, sqlstate, sqlerrm;
  end;

  return old;
end;
$$;

drop trigger if exists final_interview_bots_orphan_guard on public.final_interview_bots;
create trigger final_interview_bots_orphan_guard
  after delete
  on public.final_interview_bots
  for each row execute function public.final_interview_bots_orphan_guard();


-- ── 6. background_jobs: five new job types, three live-job indexes ──────────
--
-- The CHECK is replaced only after section 1 verified it holds exactly the
-- fourteen known values. The nineteen below must match JOB_TYPES in
-- src/lib/jobs-queue.ts once step 2 adds the five new constants there.

do $$
declare
  v_types text[] := array[
    'ai_cv_score',
    'send_message',
    'interview_reminder',
    'interview_expiry',
    'interview_expiry_sweep',
    'cv_score_recompute',
    'transcribe',
    'ai_scorecard',
    'calendar_sync',
    'interview_purge',
    'cv_purge',
    'queue_sweep',
    'talent_retention_warn',
    'talent_retention_purge',
    -- New in 040.
    'final_bot_sync',
    'final_bot_lobby_check',
    'final_recording_import',
    'final_recording_import_watchdog',
    'final_recording_purge'
  ];
begin
  alter table public.background_jobs drop constraint background_jobs_type_check;
  execute format(
    'alter table public.background_jobs add constraint background_jobs_type_check check (type in (%s))',
    (select string_agg(quote_literal(x), ', ') from unnest(v_types) as x)
  );
  raise notice '040: background_jobs_type_check now allows % values.', array_length(v_types, 1);
end
$$;

-- One live import per bot.
create unique index if not exists background_jobs_final_recording_import_live_uniq
  on public.background_jobs ((payload->>'botId'))
  where type = 'final_recording_import' and status in ('queued', 'running');

-- One live sync per booking (create, replace), excluding vendor cleanup.
create unique index if not exists background_jobs_final_bot_sync_live_uniq
  on public.background_jobs ((payload->>'bookingId'))
  where type = 'final_bot_sync'
    and status in ('queued', 'running')
    and (payload->>'action') is distinct from 'delete';

-- One live vendor cleanup per vendor bot. The orphan guard above relies on
-- this to collapse duplicate cascades into one job.
create unique index if not exists background_jobs_final_bot_cleanup_live_uniq
  on public.background_jobs ((payload->>'providerBotId'))
  where type = 'final_bot_sync'
    and status in ('queued', 'running')
    and (payload->>'action') = 'delete';


-- ── 7. Grants ───────────────────────────────────────────────────────────────
--
-- Supabase grants new tables to anon and authenticated by default; RLS with
-- no policies already denies them, and this removes the grant as well. The
-- service role keeps its default access.

revoke all on table public.final_interview_bots from anon, authenticated;

revoke all on function public.final_interview_bots_validate()     from public, anon, authenticated;
revoke all on function public.final_interview_bots_orphan_guard() from public, anon, authenticated;

commit;


-- ── 8. Confirm, read-only ───────────────────────────────────────────────────
--
-- Expect an empty bots table:
--   select count(*) from final_interview_bots;                       -- expect 0
--
-- Expect the three-value source CHECK, the two new CHECKs, and a nullable
-- uploaded_by on the recordings table:
--   select conname, pg_get_constraintdef(oid) from pg_constraint
--    where conrelid = 'public.final_interview_recordings'::regclass order by 1;
--   select column_name, is_nullable from information_schema.columns
--    where table_name = 'final_interview_recordings'
--      and column_name in ('uploaded_by', 'vendor_recording_id');       -- YES, YES
--
-- Expect nineteen job types:
--   select pg_get_constraintdef(oid) from pg_constraint
--    where conrelid = 'public.background_jobs'::regclass
--      and conname = 'background_jobs_type_check';
--
-- Expect the three new partial unique indexes on background_jobs and the five
-- on final_interview_bots:
--   select indexname from pg_indexes where tablename = 'background_jobs'
--      and indexname like 'background_jobs_final_%' order by 1;         -- 3 rows
--   select indexname from pg_indexes where tablename = 'final_interview_bots' order by 1;
--
-- Expect both trigger functions, SECURITY INVOKER (prosecdef false):
--   select proname, prosecdef from pg_proc
--    where proname in ('final_interview_bots_validate', 'final_interview_bots_orphan_guard');
--
-- Nothing in the application reads or writes any of this yet.
