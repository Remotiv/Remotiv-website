-- ============================================================================
-- Migration 052 - usage_events outlive the company they were counted for
-- ----------------------------------------------------------------------------
-- NOT RUN YET. For review. Run by hand in the Supabase SQL editor, after 051.
--
-- ── Before running ───────────────────────────────────────────
--
-- The foreign key should exist, with ON DELETE CASCADE (confdeltype 'c'), and
-- be the only foreign key on the table:
--
-- select conname, confdeltype, pg_get_constraintdef(oid)
--   from pg_constraint
--  where conrelid = 'public.usage_events'::regclass and contype = 'f';
--
-- ── Why ──────────────────────────────────────────────────────
--
-- usage_events is the allowance's record of what a company used (invitations
-- sent, interviews completed and scored). Its company_id had a foreign key to
-- companies with ON DELETE CASCADE, so deleting a company erased its usage.
-- Company deletion (lib/company-deletion.ts) now deletes the company's
-- applicants, interviews, files and the company itself, and keeps this
-- record. company_id stays as a plain id, NOT NULL, like
-- company_plan_history: ids and counts only, no candidate data.
--
-- Nothing else changes: the type check, the columns, and every reader
-- (interview-allowance.ts, plans-usage.ts, consume_allowance and
-- release_allowance count rows of a company that exists).
--
-- ── Safe to re-run ───────────────────────────────────────────
--
-- drop constraint if exists. Refuses to start if the table is not there.
-- ============================================================================

begin;

do $$
begin
  if to_regclass('public.usage_events') is null then
    raise exception '052: public.usage_events is missing. Not proceeding.';
  end if;
end;
$$;

alter table public.usage_events drop constraint if exists usage_events_company_id_fkey;

commit;

-- ── After running ────────────────────────────────────────────
--
-- No foreign key left on the table (0 rows), company_id still NOT NULL, and
-- the row count unchanged:
--
-- select count(*) as foreign_keys
--   from pg_constraint
--  where conrelid = 'public.usage_events'::regclass and contype = 'f';
--
-- select attnotnull as company_id_not_null
--   from pg_attribute
--  where attrelid = 'public.usage_events'::regclass and attname = 'company_id';
--
-- select count(*) as usage_rows from public.usage_events;
