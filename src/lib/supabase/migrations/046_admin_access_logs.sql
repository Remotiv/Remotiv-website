-- ============================================================================
-- Migration 046 - admin_access_logs: every time a Remotiv super admin opens a
--                 company's live interview review, or one of its recordings
-- ----------------------------------------------------------------------------
-- NOT RUN YET. Run by hand in the Supabase SQL editor, after 045. Safe to run
-- twice: the table is created if missing, functions are replaced, triggers
-- are dropped if they exist and created again.
--
-- ── Before running: should return null (the table does not exist yet) ──
-- select to_regclass('public.admin_access_logs') as admin_access_logs;
--
-- ── Why (F4, 22 Oct 2026) ────────────────────────────────────
--
-- A super admin can open any company's AI Video Interview review, read-only,
-- from /admin/interviews. Each view and each recording link is written here
-- FIRST: if the row cannot be written, the page shows no candidate data and
-- no link is signed (fail closed).
--
-- Ids only. No candidate name, transcript, score or anything else from the
-- interview: the row says who looked, at which session, when, and what they
-- opened. application_id is null when the session has no application.
--
-- user_id and session_id are deliberately NOT foreign keys: an audit row must
-- outlive the admin account and the session it is about (a cascade would
-- erase it, a restriction would block deleting either).
--
-- Append-only: never updated, never deleted, never truncated (triggers below).
-- created_at is stamped by the database, so a caller cannot backdate a row.
-- RLS on, no policies: server-only, written and read through the service
-- client, like live_interview_actions (042).

create table if not exists public.admin_access_logs (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null,
  action          text not null,
  session_id      uuid not null,
  company_id      uuid not null,
  application_id  uuid,
  created_at      timestamptz not null default now(),
  constraint admin_access_logs_action
    check (action in ('view_live_review', 'open_turn_audio', 'open_video_piece'))
);

create index if not exists admin_access_logs_session_idx
  on public.admin_access_logs (session_id, created_at desc);
create index if not exists admin_access_logs_user_idx
  on public.admin_access_logs (user_id, created_at desc);

-- The database stamps the time.
create or replace function public.admin_access_logs_stamp()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.created_at := now();
  return new;
end;
$$;

drop trigger if exists admin_access_logs_stamp on public.admin_access_logs;
create trigger admin_access_logs_stamp
  before insert on public.admin_access_logs
  for each row execute function public.admin_access_logs_stamp();

-- Append-only, with no exception: an audit trail is never edited or removed.
create or replace function public.admin_access_logs_append_only()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'admin_access_logs is append-only: rows are never updated, deleted or truncated';
end;
$$;

drop trigger if exists admin_access_logs_no_update on public.admin_access_logs;
create trigger admin_access_logs_no_update
  before update on public.admin_access_logs
  for each row execute function public.admin_access_logs_append_only();

drop trigger if exists admin_access_logs_no_delete on public.admin_access_logs;
create trigger admin_access_logs_no_delete
  before delete on public.admin_access_logs
  for each row execute function public.admin_access_logs_append_only();

drop trigger if exists admin_access_logs_no_truncate on public.admin_access_logs;
create trigger admin_access_logs_no_truncate
  before truncate on public.admin_access_logs
  for each statement execute function public.admin_access_logs_append_only();

alter table public.admin_access_logs enable row level security;

-- ── After running: read-only checks ──────────────────────────
-- 1. The table, RLS on, no policies: one row, rls = true, policies = 0.
-- select c.relname as "table", c.relrowsecurity as rls,
--        (select count(*) from pg_policies p where p.tablename = c.relname) as policies
--   from pg_class c
--  where c.relname = 'admin_access_logs';
--
-- 2. The columns: 7 rows, application_id the only nullable one.
-- select column_name, data_type, is_nullable
--   from information_schema.columns
--  where table_schema = 'public' and table_name = 'admin_access_logs'
--  order by ordinal_position;
--
-- 3. The action check.
-- select conname, pg_get_constraintdef(oid) as definition
--   from pg_constraint
--  where conname = 'admin_access_logs_action';
--   expected: CHECK ((action = ANY (ARRAY['view_live_review'::text, 'open_turn_audio'::text, 'open_video_piece'::text])))
--
-- 4. The four triggers.
-- select tgname from pg_trigger
--  where tgrelid = 'public.admin_access_logs'::regclass and not tgisinternal
--  order by tgname;
--   expected: admin_access_logs_no_delete, admin_access_logs_no_truncate,
--             admin_access_logs_no_update, admin_access_logs_stamp
