-- ============================================================================
-- Migration 037 — company plans, plan history, pricing settings, allowances
-- ----------------------------------------------------------------------------
-- NOT RUN BY ANY CODE PATH. Applied by hand in the Supabase SQL editor.
--
-- Step 1 of Plans & Usage. It creates the tables and the two allowance
-- functions and NOTHING CALLS THEM YET. No enforcement, no UI, no code change
-- consumes an allowance. Applying this changes no behaviour anywhere: every
-- score, interview and message proceeds exactly as before.
--
-- ── What it adds ────────────────────────────────────────────────────────────
--
-- company_plans          one row per company that has a plan: monthly
--                        allowances and the quoted price. No row = unlimited.
-- company_plan_history   append-only; a database trigger writes one row for
--                        every insert, real update and delete of a plan, with
--                        the full snapshot, who and when. Nothing in the
--                        application has to remember to write it.
-- pricing_settings       the Quote Builder's rates, one row, USD, with the
--                        PKR rate and how many clients share the fixed cost.
-- set_company_plan()     the ONLY insert/update path to company_plans. It
--                        requires the acting user, so the history can say who.
-- remove_company_plan()  the ONLY delete path: returns a company to no plan =
--                        unlimited, with the actor, as a history DELETE row.
-- consume_allowance()    the atomic gate for cv_scored and interview_sent.
-- release_allowance()    hands a slot back when the paid work did not happen.
--
-- ── Decisions this encodes (locked 2026-10-02) ──────────────────────────────
--
-- * Billing month = calendar month in Asia/Karachi.
-- * Re-scores consume a CV-scoring credit: they write the same cv_scored row.
-- * Failed scores do not consume: the caller releases the slot.
-- * No plan = unlimited. companies.is_internal = true = always unlimited. No
--   company UUID appears anywhere in this file.
-- * CV scoring and async interview invitations are hard caps. Live AI minutes
--   get a column now and a metric later. WhatsApp is not capped, so there is
--   deliberately NO whatsapp_limit column: a limit nothing enforces would be a
--   promise the product does not keep.
-- * Plan and price history is kept and never overwritten.
--
-- ── The usage_events CHECK, and why this file asserts it ─────────────────────
--
-- consume_allowance writes usage_events rows of type cv_scored and
-- interview_sent, so both must be allowed by usage_events_type_check. The
-- repository's copy of the schema has been wrong before (migration 035 caught
-- the notifications constraint two values behind the database), and PostgREST
-- on this project exposes only `public`, so the live definition could not be
-- read from the repository on 2026-10-02 (PGRST106 for pg_catalog and
-- information_schema alike).
--
-- What could be observed read-only: rows of cv_scored, whatsapp_sent and
-- interview_scored exist live, and interview_scored was only ever allowed by
-- migration 029. That is consistent with 029's seven-value definition but does
-- not prove interview_sent is in it. So step 1 below reads the live definition
-- and REFUSES unless its set of allowed values is exactly those seven: one
-- missing fails, one extra fails, and the way Postgres prints or casts the
-- CHECK does not matter. Nothing is created if it refuses; the whole file is
-- one transaction.
--
-- To see it yourself first, read-only:
--
--   select conname, pg_get_constraintdef(oid)
--     from pg_constraint
--    where conrelid = 'public.usage_events'::regclass and contype = 'c';
--
-- ── Concurrency ─────────────────────────────────────────────────────────────
--
-- The worker runs several jobs at once, so two requests can arrive with one
-- slot left. consume_allowance takes a transaction-scoped advisory lock keyed
-- on (company, metric) BEFORE it reads the limit or counts usage, and inserts
-- the usage row under that same lock. A second caller waits, then counts the
-- first caller's row. A refusal inserts nothing.
--
-- Safe to re-run: tables and the index are create-if-not-exists, functions are
-- create-or-replace, triggers are dropped and recreated, and the settings row
-- is inserted on conflict do nothing.
-- ============================================================================

begin;

-- ── 1. Preconditions, before anything is created ────────────────────────────

do $$
declare
  v_def      text;
  v_name     text := 'usage_events_type_check';
  v_expected text[] := array[
    'interview_sent',
    'interview_completed',
    'cv_scored',
    'message_sent',
    'live_minutes',
    'whatsapp_sent',
    'interview_scored'
  ];
  v_found      text[];
  v_missing    text[];
  v_unexpected text[];
begin
  select pg_get_constraintdef(oid) into v_def
    from pg_constraint
   where conrelid = 'public.usage_events'::regclass
     and conname = v_name;

  if v_def is null then
    raise exception
      '037: constraint % not found on public.usage_events. Inspect the live constraints before applying; this file will not guess.',
      v_name;
  end if;

  -- Compare the SET of allowed values, not the text Postgres happens to print.
  -- Every single-quoted literal in the definition is taken as a value, with a
  -- doubled quote unescaped, whatever surrounds it: ANY (ARRAY[...]) or IN
  -- (...), ::text or ::character varying or no cast at all, any order, any
  -- spacing. A literal that is not one of the seven therefore fails as
  -- unexpected, which is the safe direction for a CHECK of an unknown shape.
  select array_agg(distinct replace(m[1], '''''', ''''))
    into v_found
    from regexp_matches(v_def, '''((?:[^'']|'''')*)''', 'g') as m;

  select array_agg(e order by e) into v_missing
    from unnest(v_expected) as e
   where e <> all (coalesce(v_found, '{}'::text[]));

  select array_agg(f order by f) into v_unexpected
    from unnest(coalesce(v_found, '{}'::text[])) as f
   where f <> all (v_expected);

  if v_missing is not null then
    raise exception
      '037: the live usage_events constraint is missing %. Not proceeding. Live definition: %',
      v_missing, v_def;
  end if;

  if v_unexpected is not null then
    raise exception
      '037: the live usage_events constraint allows unexpected %. Not proceeding. Live definition: %',
      v_unexpected, v_def;
  end if;

  -- The internal-workspace exemption reads this column.
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'companies'
       and column_name = 'is_internal' and data_type = 'boolean'
  ) then
    raise exception '037: public.companies.is_internal (boolean) not found. Not proceeding.';
  end if;

  -- The columns consume_allowance reads and writes.
  if (
    select count(*) from information_schema.columns
     where table_schema = 'public' and table_name = 'usage_events'
       and column_name in ('id', 'company_id', 'type', 'quantity', 'ref_id', 'created_at')
  ) <> 6 then
    raise exception '037: public.usage_events does not have the expected columns. Not proceeding.';
  end if;
end $$;


-- ── 2. company_plans ─────────────────────────────────────────────────────────

create table if not exists public.company_plans (
  company_id            uuid primary key references public.companies(id) on delete cascade,
  plan_name             text not null default 'Custom'
                          check (length(btrim(plan_name)) between 1 and 80),
  -- Monthly allowances. NULL = unlimited for that metric; 0 = none allowed.
  cv_scoring_limit      integer check (cv_scoring_limit >= 0),
  async_interview_limit integer check (async_interview_limit >= 0),
  -- Reserved for live AI interviews, capped by minutes later. Nothing reads it yet.
  live_minutes_limit    integer check (live_minutes_limit >= 0),
  quoted_price          numeric(12,2) check (quoted_price >= 0),
  currency              text not null default 'USD' check (currency in ('USD', 'PKR')),
  notes                 text check (notes is null or length(notes) <= 2000),
  -- Stamped by the trigger from the acting user set_company_plan supplies.
  -- NULL means the actor is unknown (a direct SQL edit), never a guess.
  updated_by            uuid references auth.users(id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

-- Same posture as background_jobs and worker_heartbeats: RLS on, no policies.
alter table public.company_plans enable row level security;


-- ── 3. company_plan_history, append-only ─────────────────────────────────────

create table if not exists public.company_plan_history (
  id          bigint generated always as identity primary key,
  -- Deliberately no foreign key: the history outlives the plan and the company.
  company_id  uuid not null,
  operation   text not null check (operation in ('INSERT', 'UPDATE', 'DELETE')),
  -- The whole company_plans row as it stood after the change (before it, for
  -- a delete). Every column, so nothing about a past plan has to be inferred.
  snapshot    jsonb not null,
  changed_by  uuid,
  changed_at  timestamptz not null default now()
);

create index if not exists company_plan_history_company_changed_idx
  on public.company_plan_history (company_id, changed_at desc);

alter table public.company_plan_history enable row level security;

-- Refuse every UPDATE, DELETE and TRUNCATE. RLS does not bind the service role,
-- so the guarantee has to be a trigger, which binds everyone short of the
-- table owner deliberately disabling it.
create or replace function public.company_plan_history_append_only()
returns trigger
language plpgsql
as $$
begin
  raise exception 'company_plan_history is append-only: % is not allowed', tg_op
    using errcode = '42501';
end;
$$;

drop trigger if exists company_plan_history_no_update_delete on public.company_plan_history;
create trigger company_plan_history_no_update_delete
  before update or delete on public.company_plan_history
  for each row execute function public.company_plan_history_append_only();

drop trigger if exists company_plan_history_no_truncate on public.company_plan_history;
create trigger company_plan_history_no_truncate
  before truncate on public.company_plan_history
  for each statement execute function public.company_plan_history_append_only();


-- ── 4. Plan triggers: stamp the actor, then record the change ────────────────

-- Who is acting comes from a transaction-local setting that set_company_plan
-- writes, never from a value carried over on the row. A previous editor's id
-- left in updated_by can therefore never be credited with someone else's edit.
create or replace function public.company_plans_stamp()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'UPDATE' and new.company_id is distinct from old.company_id then
    raise exception 'company_plans.company_id cannot change; end the plan and create another'
      using errcode = '42501';
  end if;
  new.updated_by := nullif(current_setting('remotiv.plan_actor', true), '')::uuid;
  new.updated_at := now();
  if tg_op = 'UPDATE' then
    new.created_at := old.created_at;
  end if;
  return new;
end;
$$;

drop trigger if exists company_plans_stamp on public.company_plans;
create trigger company_plans_stamp
  before insert or update on public.company_plans
  for each row execute function public.company_plans_stamp();

-- SECURITY DEFINER is load-bearing. The service role cannot insert into
-- company_plan_history (see the grants at the end), so this function inserts
-- as its owner, the role that ran this migration. That holds on every path
-- that changes a plan: set_company_plan's insert and its update, a
-- remove_company_plan delete, and a delete cascading from public.companies,
-- which runs this trigger for each plan row it removes.
create or replace function public.log_company_plan_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    insert into public.company_plan_history (company_id, operation, snapshot, changed_by)
    values (
      old.company_id, tg_op, to_jsonb(old),
      nullif(current_setting('remotiv.plan_actor', true), '')::uuid
    );
    return old;
  end if;

  -- A save that changed nothing but the stamps is not a change.
  if tg_op = 'UPDATE'
     and (to_jsonb(new) - 'updated_at' - 'updated_by')
         = (to_jsonb(old) - 'updated_at' - 'updated_by') then
    return new;
  end if;

  insert into public.company_plan_history (company_id, operation, snapshot, changed_by)
  values (new.company_id, tg_op, to_jsonb(new), new.updated_by);
  return new;
end;
$$;

drop trigger if exists company_plans_history on public.company_plans;
create trigger company_plans_history
  after insert or update or delete on public.company_plans
  for each row execute function public.log_company_plan_change();


-- ── 5. set_company_plan: the one write path ──────────────────────────────────

create or replace function public.set_company_plan(
  p_company               uuid,
  p_actor                 uuid,
  p_plan_name             text,
  p_cv_scoring_limit      integer,
  p_async_interview_limit integer,
  p_live_minutes_limit    integer,
  p_quoted_price          numeric,
  p_currency              text,
  p_notes                 text
)
returns public.company_plans
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.company_plans;
begin
  if p_actor is null then
    raise exception 'set_company_plan: the acting user is required, so the history can say who'
      using errcode = '22023';
  end if;

  -- Transaction-local: visible to the triggers below, gone at commit.
  perform set_config('remotiv.plan_actor', p_actor::text, true);

  insert into public.company_plans as cp (
    company_id, plan_name, cv_scoring_limit, async_interview_limit,
    live_minutes_limit, quoted_price, currency, notes
  )
  values (
    p_company, coalesce(nullif(btrim(p_plan_name), ''), 'Custom'), p_cv_scoring_limit,
    p_async_interview_limit, p_live_minutes_limit, p_quoted_price,
    coalesce(p_currency, 'USD'), p_notes
  )
  on conflict (company_id) do update set
    plan_name             = excluded.plan_name,
    cv_scoring_limit      = excluded.cv_scoring_limit,
    async_interview_limit = excluded.async_interview_limit,
    live_minutes_limit    = excluded.live_minutes_limit,
    quoted_price          = excluded.quoted_price,
    currency              = excluded.currency,
    notes                 = excluded.notes
  returning cp.* into v_row;

  return v_row;
end;
$$;

-- Returns a company to "no plan = unlimited", on purpose and on the record.
-- The delete fires the history trigger, which appends a DELETE row holding the
-- plan as it stood and the acting user. History itself is never touched: it
-- has no foreign key to company_plans and refuses deletes. Returns whether a
-- plan existed to remove.
create or replace function public.remove_company_plan(p_company uuid, p_actor uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted integer;
begin
  if p_actor is null then
    raise exception 'remove_company_plan: the acting user is required, so the history can say who'
      using errcode = '22023';
  end if;
  -- set_company_plan gets this check from the updated_by foreign key; a delete
  -- writes no such column, so it is made here.
  if not exists (select 1 from auth.users u where u.id = p_actor) then
    raise exception 'remove_company_plan: acting user % not found', p_actor
      using errcode = '23503';
  end if;

  -- Transaction-local: read by the history trigger as changed_by.
  perform set_config('remotiv.plan_actor', p_actor::text, true);

  delete from public.company_plans cp where cp.company_id = p_company;
  get diagnostics v_deleted = row_count;
  return v_deleted > 0;
end;
$$;


-- ── 6. pricing_settings: the Quote Builder's rates ───────────────────────────

create table if not exists public.pricing_settings (
  id                         text primary key default 'default' check (id = 'default'),
  -- The Quote Builder calculates in USD and shows PKR alongside.
  currency                   text not null default 'USD' check (currency = 'USD'),
  -- Per-unit provider cost. NULL = not entered yet, so the builder can say so
  -- rather than quote on a silent zero.
  cv_score_cost              numeric(12,4) check (cv_score_cost >= 0),
  async_interview_cost       numeric(12,4) check (async_interview_cost >= 0),
  live_minute_cost           numeric(12,4) check (live_minute_cost >= 0),
  whatsapp_message_cost      numeric(12,4) check (whatsapp_message_cost >= 0),
  -- Platform cost per month, allocated across this many paying clients.
  fixed_monthly_cost         numeric(12,2) check (fixed_monthly_cost >= 0),
  clients_sharing_fixed_cost integer not null default 1 check (clients_sharing_fixed_cost >= 1),
  minimum_price              numeric(12,2) check (minimum_price >= 0),
  minimum_margin_pct         numeric(5,2) check (minimum_margin_pct between 0 and 100),
  pkr_per_usd                numeric(12,4) check (pkr_per_usd > 0),
  updated_by                 uuid references auth.users(id) on delete set null,
  updated_at                 timestamptz not null default now()
);

alter table public.pricing_settings enable row level security;

create or replace function public.pricing_settings_stamp()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists pricing_settings_stamp on public.pricing_settings;
create trigger pricing_settings_stamp
  before update on public.pricing_settings
  for each row execute function public.pricing_settings_stamp();

insert into public.pricing_settings (id) values ('default') on conflict (id) do nothing;


-- ── 7. Counting index ────────────────────────────────────────────────────────

create index if not exists usage_events_company_type_created_idx
  on public.usage_events (company_id, type, created_at);


-- ── 8. consume_allowance: the atomic gate ────────────────────────────────────

create or replace function public.consume_allowance(
  p_company uuid,
  p_metric  text,
  p_ref     uuid default null
)
returns table (
  allowed      boolean,
  unlimited    boolean,
  reason       text,
  used         integer,
  allowance    integer,
  usage_id     uuid,
  period_start timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  -- Start of the current calendar month in Asia/Karachi, as a timestamptz.
  v_period   timestamptz := date_trunc('month', now() at time zone 'Asia/Karachi')
                              at time zone 'Asia/Karachi';
  v_internal boolean;
  v_has_plan boolean;
  v_limit    integer;
  v_used     integer;
  v_id       uuid;
begin
  if p_metric is null or p_metric not in ('cv_scored', 'interview_sent') then
    raise exception 'consume_allowance: metric % is not capped', p_metric
      using errcode = '22023';
  end if;

  select c.is_internal into v_internal from public.companies c where c.id = p_company;
  if not found then
    raise exception 'consume_allowance: company % not found', p_company
      using errcode = 'P0002';
  end if;

  -- Serialise every request for this company and metric. Taken BEFORE the
  -- limit is read and usage is counted, and held until the transaction ends,
  -- so a concurrent caller counts this caller's row.
  perform pg_advisory_xact_lock(hashtextextended(p_company::text || ':' || p_metric, 0));

  select case p_metric
           when 'cv_scored'      then cp.cv_scoring_limit
           when 'interview_sent' then cp.async_interview_limit
         end
    into v_limit
    from public.company_plans cp
   where cp.company_id = p_company;
  v_has_plan := found;

  select coalesce(sum(ue.quantity), 0)::integer
    into v_used
    from public.usage_events ue
   where ue.company_id = p_company
     and ue.type = p_metric
     and ue.created_at >= v_period;

  -- The only refusal. It returns before the insert, so a refused request
  -- leaves no usage row behind.
  if not coalesce(v_internal, false) and v_has_plan and v_limit is not null and v_used >= v_limit then
    return query select false, false, 'limit_reached'::text, v_used, v_limit, null::uuid, v_period;
    return;
  end if;

  insert into public.usage_events (company_id, type, quantity, ref_id)
  values (p_company, p_metric, 1, p_ref)
  returning id into v_id;

  return query select
    true,
    coalesce(v_internal, false) or not v_has_plan or v_limit is null,
    case
      when coalesce(v_internal, false) then 'unlimited_internal'
      when not v_has_plan               then 'unlimited_no_plan'
      when v_limit is null              then 'unlimited_metric_not_set'
      else 'within_limit'
    end::text,
    v_used + 1,
    case when coalesce(v_internal, false) then null else v_limit end,
    v_id,
    v_period;
end;
$$;


-- ── 9. release_allowance: give the slot back ─────────────────────────────────

-- Deletes the one usage row consume_allowance returned. Restricted to the two
-- capped metrics so it can never remove a whatsapp_sent or interview_scored
-- row. Returns whether a row was removed. No lock is needed: removing a row
-- can only make a concurrent count more conservative, never let it overspend.
create or replace function public.release_allowance(p_usage_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted integer;
begin
  delete from public.usage_events ue
   where ue.id = p_usage_id
     and ue.type in ('cv_scored', 'interview_sent');
  get diagnostics v_deleted = row_count;
  return v_deleted > 0;
end;
$$;


-- ── 10. Grants ───────────────────────────────────────────────────────────────

-- Supabase grants new tables to anon and authenticated by default; RLS with no
-- policies already denies them, and this removes the grant as well.
revoke all on table public.company_plans        from anon, authenticated;
revoke all on table public.company_plan_history from anon, authenticated;
revoke all on table public.pricing_settings     from anon, authenticated;

-- The service role may READ plans and history but not write them directly:
-- set_company_plan and remove_company_plan are the write paths, so every
-- change names its actor.
revoke insert, update, delete, truncate on table public.company_plans        from service_role;
revoke insert, update, delete, truncate on table public.company_plan_history from service_role;

revoke all on function public.set_company_plan(uuid, uuid, text, integer, integer, integer, numeric, text, text)
  from public, anon, authenticated;
revoke all on function public.remove_company_plan(uuid, uuid)     from public, anon, authenticated;
revoke all on function public.consume_allowance(uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.release_allowance(uuid)             from public, anon, authenticated;
revoke all on function public.log_company_plan_change()           from public, anon, authenticated;

grant execute on function public.set_company_plan(uuid, uuid, text, integer, integer, integer, numeric, text, text)
  to service_role;
grant execute on function public.remove_company_plan(uuid, uuid)     to service_role;
grant execute on function public.consume_allowance(uuid, text, uuid) to service_role;
grant execute on function public.release_allowance(uuid)             to service_role;

commit;


-- ── 11. Confirm, read-only ───────────────────────────────────────────────────
--
-- Expect three tables, the settings row, and no plan rows yet:
--   select count(*) from public.company_plans;            -- 0
--   select count(*) from public.company_plan_history;     -- 0
--   select id, currency, clients_sharing_fixed_cost from public.pricing_settings;  -- default, USD, 1
--
-- Expect the three functions, owned by the migration's role:
--   select proname, prosecdef from pg_proc
--    where proname in ('set_company_plan', 'consume_allowance', 'release_allowance');
--
-- Nothing in the application calls any of them yet.
