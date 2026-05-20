-- ── Migration 006: hire_requests ──────────────────────────────
-- Captures "Connect with Talent" lead form submissions from /hire-remote.
-- Separate from contact_submissions because schema differs significantly:
-- candidate context, engagement type, budget tier, project description.

create table if not exists hire_requests (
  id                    uuid primary key default gen_random_uuid(),

  -- Contact info (Step 3 of wizard)
  full_name             text not null,
  email                 text not null,
  company               text not null,
  notes                 text,

  -- Engagement (Step 1)
  engagement_type       text not null
                          check (engagement_type in ('per_hour', 'per_month', 'full_time')),

  -- Project details (Step 2)
  budget_range          text not null,
  project_description   text not null,
  timeline              text not null
                          check (timeline in ('asap', 'within_2_weeks', 'within_1_month', 'flexible')),

  -- Candidate context (passed from the profile they were viewing)
  candidate_id          uuid references talent_profiles(id) on delete set null,
  candidate_name        text,
  candidate_rate        text,

  -- Admin workflow
  status                text not null default 'new'
                          check (status in ('new', 'contacted', 'matched', 'placed', 'archived')),

  -- Metadata
  ip_address            text,
  user_agent            text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

-- Indexes for admin filtering / sorting
create index if not exists hire_requests_status_idx
  on hire_requests(status);

create index if not exists hire_requests_created_at_idx
  on hire_requests(created_at desc);

create index if not exists hire_requests_candidate_id_idx
  on hire_requests(candidate_id);

create index if not exists hire_requests_email_idx
  on hire_requests(lower(email));

-- updated_at auto-bump on row update
create or replace function update_hire_requests_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_hire_requests_updated_at on hire_requests;
create trigger trg_hire_requests_updated_at
  before update on hire_requests
  for each row execute function update_hire_requests_updated_at();

-- ── Row Level Security ───────────────────────────────────────
alter table hire_requests enable row level security;

-- Public insert: anyone can submit a hire request (matches contact_submissions pattern)
create policy "public can insert hire_requests"
  on hire_requests for insert to anon with check (true);

create policy "authenticated can insert hire_requests"
  on hire_requests for insert to authenticated with check (true);

-- Read / update / delete: service-role only (admin operations)
-- service_role bypasses RLS automatically — no explicit policy needed.
