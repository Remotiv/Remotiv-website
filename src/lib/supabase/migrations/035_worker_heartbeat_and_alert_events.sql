-- ============================================================
-- Remotiv Migration 035: worker heartbeat, and two alert events
-- ============================================================
-- NOT RUN BY ANY CODE PATH. Applied by hand in the Supabase SQL
-- editor, like every other file in this folder.
--
-- ── Read this first: the live constraint could not be read ──
--
-- PostgREST on this project exposes only `public` and
-- `graphql_public` (PGRST106), so neither pg_catalog nor
-- information_schema is reachable from the repository, and the
-- committed schema.sql is known to be stale. This file therefore
-- does NOT trust schema.sql for the current CHECK constraint.
-- Instead it reads the LIVE definition inside a DO block and
-- refuses to proceed unless that definition holds exactly the
-- eight values the code expects. An unexpected constraint fails
-- loudly with its definition in the error, rather than being
-- silently replaced.
--
-- To see the live definition yourself before applying, run:
--
--   select conname, pg_get_constraintdef(oid)
--   from pg_constraint
--   where conrelid = 'public.notifications'::regclass
--     and contype = 'c';
--
-- ── What this adds ──────────────────────────────────────────
--
-- 1. worker_heartbeats: a single-row table the worker upserts at
--    the end of EVERY tick, including ticks with no work. Today an
--    idle worker and a stopped one are indistinguishable, because
--    a tick with nothing to do writes nothing. This row is the
--    liveness signal for the admin queue panel and for
--    GET /api/health/worker, which an external monitor polls.
--
-- 2. Two notification event types, `job_dead` and `worker_stale`,
--    appended to notifications_event_type_check. The worker emits
--    one `job_dead` notification per tick that killed any job, and
--    one `worker_stale` notification when a tick finds the previous
--    heartbeat older than the staleness threshold, i.e. a
--    retrospective record of an outage once the worker returns.
--    Every existing value is preserved; nothing is removed.
--
-- Safe to re-run: the table is create-if-not-exists, and the
-- constraint block detects an already-applied state and skips.
-- ============================================================


-- ── 1. worker_heartbeats ─────────────────────────────────────

create table if not exists public.worker_heartbeats (
  -- One row, ever. The CHECK makes a second row impossible rather than
  -- relying on every writer to remember the id.
  id            text primary key default 'worker' check (id = 'worker'),
  last_tick_at  timestamptz not null,
  claimed       integer not null default 0,
  succeeded     integer not null default 0,
  failed        integer not null default 0,
  dead          integer not null default 0,
  yielded       integer not null default 0,
  duration_ms   integer,
  -- Set by the worker when it notices the previous heartbeat was stale,
  -- so the retrospective `worker_stale` notice is sent once per outage.
  stale_noticed_at timestamptz,
  updated_at    timestamptz not null default now()
);

-- Same posture as background_jobs: RLS on, no policies, so only the
-- service role can read or write it. The health route and the admin
-- panel both go through the service client.
alter table public.worker_heartbeats enable row level security;


-- ── 2. notifications_event_type_check, verified before touched ──

do $$
declare
  v_def   text;
  v_name  text := 'notifications_event_type_check';
  v_expected text[] := array[
    'client_decision',
    'client_note',
    'stage_change',
    'candidate_added',
    'new_inquiry',
    'profile_claimed',
    'profile_approved',
    'profile_rejected'
  ];
  v_added text[] := array['job_dead', 'worker_stale'];
  v_val   text;
  v_count integer;
begin
  select pg_get_constraintdef(oid) into v_def
  from pg_constraint
  where conrelid = 'public.notifications'::regclass
    and conname = v_name;

  if v_def is null then
    raise exception
      '035: constraint % not found on public.notifications. Inspect the live constraints before applying; this file will not guess a name.',
      v_name;
  end if;

  -- Count the literals in the definition. pg_get_constraintdef renders an
  -- IN list as `event_type = ANY (ARRAY['a'::text, 'b'::text, ...])`, so the
  -- number of `::text` casts is the number of allowed values.
  v_count := (length(v_def) - length(replace(v_def, '::text', ''))) / length('::text');

  -- Already applied? Then every expected AND added value is present and the
  -- count is ten. Skip rather than fail, so a re-run is harmless.
  if v_count = array_length(v_expected, 1) + array_length(v_added, 1) then
    foreach v_val in array v_expected || v_added loop
      if position(quote_literal(v_val) || '::text' in v_def) = 0 then
        raise exception '035: constraint has ten values but is missing %; definition: %', v_val, v_def;
      end if;
    end loop;
    raise notice '035: notifications_event_type_check already includes job_dead and worker_stale; skipping.';
    return;
  end if;

  -- Pre-state: exactly the eight expected values, no more, no fewer.
  if v_count <> array_length(v_expected, 1) then
    raise exception
      '035: expected exactly % allowed values but the live constraint has %. Not replacing an unexpected definition. Live definition: %',
      array_length(v_expected, 1), v_count, v_def;
  end if;

  foreach v_val in array v_expected loop
    if position(quote_literal(v_val) || '::text' in v_def) = 0 then
      raise exception
        '035: live constraint does not include expected value %. Not replacing an unexpected definition. Live definition: %',
        v_val, v_def;
    end if;
  end loop;

  -- Verified. Replace with the same eight plus the two new values.
  execute format('alter table public.notifications drop constraint %I', v_name);
  execute format(
    'alter table public.notifications add constraint %I check (event_type in (%s))',
    v_name,
    (select string_agg(quote_literal(x), ', ') from unnest(v_expected || v_added) as x)
  );

  raise notice '035: notifications_event_type_check now allows % values.', v_count + 2;
end $$;
