-- ============================================================================
-- Migration 038 - Final Human Interview: schema only
-- ----------------------------------------------------------------------------
-- Run by hand in Supabase SQL Editor. Not run by Claude Code.
-- Written 2026-10-08 against the live catalog read that day.
--
-- The schema for a human-led final round: who interviews, when (through the
-- existing booking flow), the recording of the call, and each interviewer's
-- evaluation. NOTHING READS OR WRITES THESE TABLES YET. No application code,
-- no UI, no upload path, no playback and no purge ships with this file, so
-- applying it changes no behaviour anywhere. Those come in later steps.
--
-- ── What it adds ────────────────────────────────────────────────────────────
--
-- final_interviews              one row per final round: type, host, status.
-- final_interview_interviewers  the additional interviewers. The host is on
--                               the parent row and is never repeated here.
-- final_interview_recordings    the recording, copied into private storage.
-- final_interview_evaluations   one rating and recommendation per person.
-- interview_bookings            four new columns so a final round is booked
--                               through the same flow as a screening call,
--                               and the two can coexist for one application.
-- three validation triggers     the only tenant guard: every query runs as
--                               the service role, which RLS does not bind.
--
-- ── Decisions this encodes (locked 2026-10-08) ──────────────────────────────
--
-- * Recording is required. A final-round booking cannot reach 'booked'
--   without the candidate's recording-notice acknowledgement and the version
--   of the notice they saw. The CHECK on interview_bookings enforces it.
-- * Recordings are COPIED into Remotiv storage. No Drive link, owner or token
--   is stored; drive_file_id is kept for audit and duplicate warnings only.
-- * Recordings are at most 2 GiB (2147483648 bytes), hence bigint.
-- * One ready recording per final interview; one evaluation per person.
-- * The hiring decision stays the pipeline stage, recorded by
--   application_stage_history. There is deliberately no decided_by or
--   decided_at here: a second copy would drift from the stage history.
-- * The host overlap guard already exists on interview_bookings
--   (interview_bookings_no_host_overlap, for every purpose), so this file
--   adds no overlap constraint and installs no extension.
--
-- ── What is NOT here ────────────────────────────────────────────────────────
--
-- The storage bucket and its policies, the project upload limit, updated_at
-- triggers (the application sets updated_at), role changes, and any change to
-- existing rows or existing constraints. The three live bookings whose
-- application_id is null are not touched: that column is ON DELETE SET NULL,
-- so no CHECK on a final booking may require it, or deleting an applicant
-- would fail.
-- ============================================================================

begin;

-- ── 1. Preconditions, before anything is created ────────────────────────────
--
-- The validation triggers below read these columns by name. The base tables
-- have no migration file in this repository and schema.sql has lagged
-- production before, so the names are checked against the live catalog here
-- and the whole file refuses if any is missing. Nothing is created on refusal.

do $$
declare
  v_missing text[] := array[]::text[];
  v_col     record;
begin
  for v_col in
    select *
      from (values
        ('job_applications', 'company_id_snapshot'),
        ('job_applications', 'job_id'),
        ('company_members',  'company_id'),
        ('interview_bookings', 'host_member_id'),
        ('interview_bookings', 'status')
      ) as want(table_name, column_name)
  loop
    if not exists (
      select 1
        from information_schema.columns c
       where c.table_schema = 'public'
         and c.table_name   = v_col.table_name
         and c.column_name  = v_col.column_name
         and c.data_type in ('uuid', 'text')
    ) then
      v_missing := v_missing || (v_col.table_name || '.' || v_col.column_name);
    end if;
  end loop;

  if array_length(v_missing, 1) > 0 then
    raise exception '038: expected column(s) % not found in public. Not proceeding.',
      array_to_string(v_missing, ', ');
  end if;

  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.interview_bookings'::regclass
       and conname  = 'interview_bookings_no_host_overlap'
  ) then
    raise exception '038: interview_bookings_no_host_overlap is missing; this file relies on it and adds no overlap guard of its own. Not proceeding.';
  end if;
end
$$;


-- ── 2. final_interviews ─────────────────────────────────────────────────────
-- Locked: one row per final round; the hiring decision is NOT stored here.

create table if not exists public.final_interviews (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.companies(id)        on delete cascade,
  job_id          uuid not null references public.jobs(id)             on delete cascade,
  application_id  uuid not null references public.job_applications(id) on delete cascade,
  interview_type  text not null
                    check (interview_type in ('final', 'cto', 'ceo', 'hiring_manager', 'technical', 'custom')),
  -- A label exactly when the type is custom, never otherwise.
  custom_label    text
                    check ((interview_type = 'custom') = (custom_label is not null))
                    check (custom_label is null or length(btrim(custom_label)) between 1 and 80),
  -- The organiser: the calendar the booking lands on and the account whose
  -- Drive receives the Meet recording. NO ACTION rather than cascade, so a
  -- member row cannot vanish from under an interview; members are removed by
  -- status in the application, not deleted.
  host_member_id  uuid not null references public.company_members(id),
  -- 'invited' and 'scheduled' are NOT states here: they are read from the
  -- live booking, so the two can never disagree.
  status          text not null default 'active'
                    check (status in ('active', 'completed', 'no_show', 'cancelled'))
                    check (status <> 'completed' or completed_at is not null)
                    check (status <> 'cancelled' or cancelled_at is not null),
  -- auth.users id and display name of the member who set it up, the same
  -- pair interview_bookings.invited_by and application_stage_history.changed_by use.
  created_by      uuid not null,
  created_by_name text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  completed_at    timestamptz,
  cancelled_at    timestamptz,
  -- Targets for the composite foreign keys below, so a child row's company,
  -- job and application can never disagree with its parent's.
  unique (id, company_id),
  unique (id, company_id, job_id, application_id)
);

create index if not exists final_interviews_application_idx
  on public.final_interviews (application_id);
create index if not exists final_interviews_job_idx
  on public.final_interviews (job_id);
create index if not exists final_interviews_company_created_idx
  on public.final_interviews (company_id, created_at desc);
create index if not exists final_interviews_host_idx
  on public.final_interviews (host_member_id);

-- Same posture as every other product table: RLS on, no policies. Only the
-- service role, which RLS does not bind, reaches these rows.
alter table public.final_interviews enable row level security;


-- ── 3. final_interview_interviewers ─────────────────────────────────────────
-- Locked: additional interviewers only; the host lives on final_interviews.

create table if not exists public.final_interview_interviewers (
  final_interview_id uuid not null,
  company_id         uuid not null,
  member_id          uuid not null references public.company_members(id),
  added_by           uuid not null,
  created_at         timestamptz not null default now(),
  primary key (final_interview_id, member_id),
  foreign key (final_interview_id, company_id)
    references public.final_interviews (id, company_id) on delete cascade
);

create index if not exists final_interview_interviewers_member_idx
  on public.final_interview_interviewers (member_id);

alter table public.final_interview_interviewers enable row level security;


-- ── 4. final_interview_recordings ───────────────────────────────────────────
-- Locked: the file is copied into private Remotiv storage; nothing plays from Drive.

create table if not exists public.final_interview_recordings (
  id                 uuid primary key default gen_random_uuid(),
  final_interview_id uuid not null,
  company_id         uuid not null,
  job_id             uuid not null,
  application_id     uuid not null,
  foreign key (final_interview_id, company_id, job_id, application_id)
    references public.final_interviews (id, company_id, job_id, application_id)
    on delete cascade,
  source             text not null check (source in ('google_drive', 'manual_upload')),
  -- The picked file's Drive id, for audit and for warning about a second
  -- import of the same file. Never used for playback.
  drive_file_id      text check ((source = 'google_drive') = (drive_file_id is not null)),
  -- {company_id}/{final_interview_id}/{id}.{ext} in the private bucket.
  -- Nulled by the purge; never returned to a client.
  storage_path       text,
  original_filename  text,
  mime_type          text not null check (mime_type in ('video/mp4', 'video/webm')),
  -- bigint: 2 GiB is 2147483648, one more than integer holds.
  size_bytes         bigint not null check (size_bytes > 0 and size_bytes <= 2147483648),
  duration_seconds   integer check (duration_seconds is null or duration_seconds > 0),
  status             text not null default 'pending'
                       check (status in ('pending', 'ready', 'failed', 'deleted'))
                       check (status <> 'ready' or (delete_after is not null and storage_path is not null))
                       check (status <> 'deleted' or deleted_at is not null),
  -- auth.users id and display name of whoever attached it.
  uploaded_by        uuid not null,
  uploaded_by_name   text,
  uploaded_at        timestamptz,
  -- Set when the recording becomes ready: the interview's scheduled start
  -- plus six months, so a late upload cannot extend retention.
  delete_after       timestamptz,
  deleted_at         timestamptz,
  deleted_by         uuid,
  created_at         timestamptz not null default now()
);

-- One ready recording per interview; a replacement marks the old one deleted first.
create unique index if not exists final_interview_recordings_one_ready_idx
  on public.final_interview_recordings (final_interview_id)
  where status = 'ready';
-- No two rows may claim one object.
create unique index if not exists final_interview_recordings_path_idx
  on public.final_interview_recordings (storage_path)
  where storage_path is not null;

create index if not exists final_interview_recordings_interview_idx
  on public.final_interview_recordings (final_interview_id);
-- The purge's selector: rows whose object still exists.
create index if not exists final_interview_recordings_delete_after_idx
  on public.final_interview_recordings (delete_after)
  where storage_path is not null;
create index if not exists final_interview_recordings_drive_file_idx
  on public.final_interview_recordings (drive_file_id)
  where drive_file_id is not null;

alter table public.final_interview_recordings enable row level security;


-- ── 5. final_interview_evaluations ──────────────────────────────────────────
-- Locked: one evaluation per person per interview, edited in place, never overwritten by another.

create table if not exists public.final_interview_evaluations (
  id                 uuid primary key default gen_random_uuid(),
  final_interview_id uuid not null,
  company_id         uuid not null,
  foreign key (final_interview_id, company_id)
    references public.final_interviews (id, company_id) on delete cascade,
  member_id          uuid not null references public.company_members(id),
  rating             smallint not null check (rating between 1 and 5),
  recommendation     text not null
                       check (recommendation in ('strong_yes', 'yes', 'maybe', 'no', 'strong_no')),
  -- Whether they were in the call or watched the recording afterwards.
  basis              text not null check (basis in ('attended', 'watched_recording')),
  notes              text check (notes is null or length(notes) <= 10000),
  submitted_at       timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (final_interview_id, member_id)
);

create index if not exists final_interview_evaluations_member_idx
  on public.final_interview_evaluations (member_id);

alter table public.final_interview_evaluations enable row level security;


-- ── 6. interview_bookings: new columns only ─────────────────────────────────
-- Locked: purpose = interview | final, so a screening call and a final round
-- can coexist for one application; one live booking per application for
-- screening, one per final interview for a final round. Nothing existing is
-- altered: every current row reads purpose = 'interview' through the default,
-- and the existing constraints, foreign keys and overlap guard stay as they are.

alter table public.interview_bookings
  add column if not exists purpose text not null default 'interview',
  add column if not exists final_interview_id uuid,
  add column if not exists recording_notice_acknowledged_at timestamptz,
  add column if not exists recording_notice_version text;

alter table public.interview_bookings
  drop constraint if exists interview_bookings_purpose_check,
  add constraint interview_bookings_purpose_check
    check (purpose in ('interview', 'final')),
  drop constraint if exists interview_bookings_final_link_check,
  add constraint interview_bookings_final_link_check
    check ((purpose = 'final') = (final_interview_id is not null)),
  -- Recording is required: a final round is booked only once the candidate
  -- has acknowledged the recording notice, and which version of it they saw.
  drop constraint if exists interview_bookings_final_notice_check,
  add constraint interview_bookings_final_notice_check
    check (
      purpose <> 'final'
      or status <> 'booked'
      or (recording_notice_acknowledged_at is not null and recording_notice_version is not null)
    ),
  drop constraint if exists interview_bookings_final_interview_fkey,
  add constraint interview_bookings_final_interview_fkey
    foreign key (final_interview_id, company_id)
    references public.final_interviews (id, company_id) on delete cascade;

-- One live screening booking per application. Null application ids (the
-- three live rows) are distinct to a unique index and are unaffected.
create unique index if not exists interview_bookings_one_live_interview_idx
  on public.interview_bookings (application_id)
  where purpose = 'interview' and status in ('invited', 'booked');
-- One live booking per final interview.
create unique index if not exists interview_bookings_one_live_final_idx
  on public.interview_bookings (final_interview_id)
  where purpose = 'final' and status in ('invited', 'booked');
create index if not exists interview_bookings_final_interview_idx
  on public.interview_bookings (final_interview_id)
  where final_interview_id is not null;


-- ── 7. Validation triggers: the tenant guard ────────────────────────────────
--
-- Every query against these tables runs as the service role, which RLS does
-- not bind, so a foreign key alone cannot stop an interview from naming
-- another company's applicant, job or member. These triggers can. SECURITY
-- INVOKER: they read the same tables the caller may already read, and need
-- no extra rights.

create or replace function public.final_interviews_validate()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_app_company uuid;
  v_app_job     uuid;
  v_host_company uuid;
begin
  select a.company_id_snapshot, a.job_id
    into v_app_company, v_app_job
    from public.job_applications a
   where a.id = new.application_id;

  if not found then
    raise exception 'final_interviews: application % does not exist', new.application_id
      using errcode = '23503';
  end if;
  if v_app_company is distinct from new.company_id then
    raise exception 'final_interviews: application % does not belong to company %',
      new.application_id, new.company_id
      using errcode = '42501';
  end if;
  if v_app_job is distinct from new.job_id then
    raise exception 'final_interviews: application % is not an application to job %',
      new.application_id, new.job_id
      using errcode = '23514';
  end if;

  select m.company_id into v_host_company
    from public.company_members m
   where m.id = new.host_member_id;

  if not found then
    raise exception 'final_interviews: host member % does not exist', new.host_member_id
      using errcode = '23503';
  end if;
  if v_host_company is distinct from new.company_id then
    raise exception 'final_interviews: host member % does not belong to company %',
      new.host_member_id, new.company_id
      using errcode = '42501';
  end if;

  return new;
end;
$$;

drop trigger if exists final_interviews_validate on public.final_interviews;
create trigger final_interviews_validate
  before insert or update of company_id, job_id, application_id, host_member_id
  on public.final_interviews
  for each row execute function public.final_interviews_validate();

-- Shared by interviewers and evaluations: the named member must belong to the
-- row's company. tg_table_name makes the message say which table refused.
create or replace function public.final_interview_member_validate()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_member_company uuid;
begin
  select m.company_id into v_member_company
    from public.company_members m
   where m.id = new.member_id;

  if not found then
    raise exception '%: member % does not exist', tg_table_name, new.member_id
      using errcode = '23503';
  end if;
  if v_member_company is distinct from new.company_id then
    raise exception '%: member % does not belong to company %',
      tg_table_name, new.member_id, new.company_id
      using errcode = '42501';
  end if;

  return new;
end;
$$;

drop trigger if exists final_interview_interviewers_validate on public.final_interview_interviewers;
create trigger final_interview_interviewers_validate
  before insert or update of member_id, company_id
  on public.final_interview_interviewers
  for each row execute function public.final_interview_member_validate();

drop trigger if exists final_interview_evaluations_validate on public.final_interview_evaluations;
create trigger final_interview_evaluations_validate
  before insert or update of member_id, company_id
  on public.final_interview_evaluations
  for each row execute function public.final_interview_member_validate();


-- ── 8. Grants ───────────────────────────────────────────────────────────────
--
-- Supabase grants new tables to anon and authenticated by default; RLS with
-- no policies already denies them, and this removes the grant as well. The
-- service role keeps its default access: the application is the write path,
-- and the triggers above guard it.

revoke all on table public.final_interviews             from anon, authenticated;
revoke all on table public.final_interview_interviewers from anon, authenticated;
revoke all on table public.final_interview_recordings   from anon, authenticated;
revoke all on table public.final_interview_evaluations  from anon, authenticated;

revoke all on function public.final_interviews_validate()        from public, anon, authenticated;
revoke all on function public.final_interview_member_validate()  from public, anon, authenticated;

commit;


-- ── 9. Confirm, read-only ───────────────────────────────────────────────────
--
-- Expect four empty tables:
--   select count(*) from final_interviews;               -- expect 0
--   select count(*) from final_interview_interviewers;   -- expect 0
--   select count(*) from final_interview_recordings;     -- expect 0
--   select count(*) from final_interview_evaluations;    -- expect 0
--
-- Expect the booking constraints, the existing overlap guard among them, and
-- the three new ones (interview_bookings_final_interview_fkey,
-- interview_bookings_final_link_check, interview_bookings_final_notice_check,
-- interview_bookings_purpose_check):
--   select conname from pg_constraint where conrelid='public.interview_bookings'::regclass order by 1;
--
-- Expect every existing booking to read purpose = 'interview':
--   select purpose, count(*) from interview_bookings group by 1;   -- interview, <row count>
--
-- Expect the two trigger functions, SECURITY INVOKER:
--   select proname, prosecdef from pg_proc
--    where proname in ('final_interviews_validate', 'final_interview_member_validate');  -- both false
--
-- Nothing in the application reads or writes any of this yet.
