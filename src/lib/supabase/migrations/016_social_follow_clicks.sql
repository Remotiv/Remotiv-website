-- ============================================================================
-- Migration 016 — social_follow_clicks
-- ----------------------------------------------------------------------------
-- Persistent counter for the "Follow Remotiv on LinkedIn" CTA on the
-- apply-success modal (and future social-follow CTAs elsewhere). Append-only,
-- no PII: only source + platform + timestamp are stored. The service-role
-- insert path lives in src/app/api/track/follow-click/route.ts.
--
-- RLS is enabled with NO policies — service role bypasses RLS, which is the
-- only writer. Anon/authenticated clients cannot read or write directly. If
-- an admin dashboard tile ever needs to display counts, it goes through the
-- service client the same way signed_url_logs analytics do.
-- ============================================================================

create table if not exists public.social_follow_clicks (
  id         uuid primary key default gen_random_uuid(),
  source     text not null default 'apply_success_modal',
  platform   text not null default 'linkedin',
  created_at timestamptz not null default now()
);

create index if not exists idx_social_follow_clicks_created_at
  on public.social_follow_clicks (created_at desc);

create index if not exists idx_social_follow_clicks_platform
  on public.social_follow_clicks (platform);

alter table public.social_follow_clicks enable row level security;

-- No policies == no anon/auth access; service role bypasses RLS, which is
-- what the /api/track/follow-click route uses.

comment on table public.social_follow_clicks is
  'Counter for social-follow CTA clicks (e.g. LinkedIn follow on apply-success modal). Append-only; service-role writes; no PII.';

-- End of migration 016.
