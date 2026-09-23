-- ============================================================================
-- Migration 023 — application_team_comments
-- ----------------------------------------------------------------------------
-- The hiring TEAM's comment thread on an applicant, behind the panel's Comments
-- tab. This is a different audience from public.application_comments, which is
-- Remotiv's own internal notes keyed on admin_id. The two must never be read
-- together, and the distinct name is part of that guarantee: no query reaching
-- for "application comments" can pick this table up by accident.
--
-- ── Authorization is NOT in this file ────────────────────────
-- Company reads go through createServiceClient(), which bypasses RLS. The gate
-- is the server action, and it inherits the panel's chain unchanged — the same
-- one fetchCompanyApplicant uses: getCompanyContext -> company_id_snapshot
-- match -> canAccessJob. That last call is the one that matters. recruiter and
-- hiring_manager are job-scoped via job_hiring_team, so a recruiter cannot read
-- comments on a job they are not on, exactly as they cannot read the applicant.
--
-- RLS is enabled with NO policies, the codebase's default-deny backstop. That
-- line is load-bearing here in a way it is not on most tables: talent users
-- hold real authenticated JWTs and the anon key ships to the browser, so
-- without RLS every candidate could read their own hiring team's private notes
-- straight off PostgREST. Delete that line and the feature leaks.
--
-- ── Retention ────────────────────────────────────────────────
-- ON DELETE CASCADE covers deletion: every application delete is a single
-- DELETE on job_applications and dependents go by cascade, with no hand-kept
-- list of tables in TypeScript to forget to update.
--
-- Cascade alone is NOT enough, because nothing deletes an application on a
-- schedule. cv-purge only nulls cv_path and cv_text; the row survives. Comments
-- would therefore outlive the CV they were written alongside and be kept
-- forever. cv-purge must delete these rows when cv_delete_after passes. That
-- job only touches rows with company_id_snapshot NOT NULL, so it expires
-- comments on client-company applications and leaves Remotiv's own pool alone —
-- which is the same call already made for CVs, for the same reason.
--
-- These are notes about a named person. Opinions recorded about someone are
-- that person's data, so they are disclosable if a candidate asks for their
-- record. The composer says so in as many words; people write differently when
-- they know.
-- ============================================================================

create table if not exists public.application_team_comments (
  id                uuid primary key default gen_random_uuid(),

  application_id    uuid not null references public.job_applications(id) on delete cascade,
  company_id        uuid not null references public.companies(id)        on delete cascade,

  -- ── One level of replies, enforced by the database ──────────────
  -- depth 0 is a root, depth 1 is a reply. parent_depth is generated as the
  -- constant 0 whenever parent_id is set, so the composite FK below can only
  -- resolve against a row whose depth is 0 — a root. A reply to a reply has
  -- nothing it is allowed to point at.
  --
  -- The direction of that CASE is the whole invariant. Written the other way
  -- round it yields NULL for a reply, and a composite FK with a NULL component
  -- is not enforced at all, so the constraint silently does nothing. That is
  -- not hypothetical: it is what the first draft of this migration shipped.
  -- See the test at the bottom of this file.
  parent_id         uuid,
  depth             smallint not null default 0
                      constraint application_team_comments_depth_values
                      check (depth in (0, 1)),
  parent_depth      smallint generated always as (case when parent_id is not null then 0 end) stored,

  -- ON DELETE SET NULL, deliberately unlike interview_notes' CASCADE: removing
  -- a member must not delete their half of a conversation other people replied
  -- to. author_name is snapshotted for the same reason changed_by_name is on
  -- application_stage_history — it records who said this at the time, and
  -- someone who later leaves does not un-say it.
  author_member_id  uuid references public.company_members(id) on delete set null,
  author_name       text not null,

  -- body is NULL only for a tombstone. See the CHECK below.
  body              text check (body is null or char_length(body) between 1 and 5000),
  deleted_at        timestamptz,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint application_team_comments_depth_matches_parent
    check ((parent_id is null) = (depth = 0)),

  -- A deleted comment keeps no text. Deleting a leaf is a hard DELETE; only a
  -- comment that already has replies is tombstoned, and then it holds a place
  -- in the thread and nothing else. This is the shape applicants/actions.ts
  -- argues for where it rejects soft deletes: never a flag on a row that still
  -- carries the person's details. Nulling body is what makes that true, and
  -- this CHECK is what stops a tombstone quietly keeping its words.
  constraint application_team_comments_body_presence
    check ((deleted_at is null) = (body is not null)),

  unique (id, depth),
  constraint application_team_comments_parent_fkey
    foreign key (parent_id, parent_depth)
    references public.application_team_comments(id, depth)
    on delete cascade
);

-- ----------------------------------------------------------------------------
-- Indexes
-- ----------------------------------------------------------------------------
-- The tab renders one whole thread in time order, so (application_id,
-- created_at) covers the read path — and doubles as the lookup a data request
-- goes through, since there is no export flow and someone answers those by
-- hand. The company_id index matches every sibling child table. The parent
-- index serves the cascade and the "does this have replies" test that decides
-- hard-delete versus tombstone.

create index if not exists idx_atc_application
  on public.application_team_comments (application_id, created_at);

create index if not exists idx_atc_company
  on public.application_team_comments (company_id);

create index if not exists idx_atc_parent
  on public.application_team_comments (parent_id);

-- ----------------------------------------------------------------------------
-- Row Level Security — enabled, no policies, default deny
-- ----------------------------------------------------------------------------
alter table public.application_team_comments enable row level security;

-- ============================================================================
-- Test — the one-level invariant, and proof it is actually enforced
-- ----------------------------------------------------------------------------
-- Run against a throwaway database, not this one. Stub the three FK targets,
-- create the table above, then:
--
--   -- 1. a root                                          -> accepted
--   insert into application_team_comments
--     (id, application_id, company_id, author_name, body)
--   values ('…0001', :app, :co, 'Ayesha', 'Strong on the API work.');
--
--   -- 2. a reply to that root                            -> accepted
--   insert into application_team_comments
--     (id, application_id, company_id, parent_id, depth, author_name, body)
--   values ('…0002', :app, :co, '…0001', 1, 'Bilal', 'Agreed, ship the offer.');
--
--   -- 3. a reply to the REPLY                            -> REJECTED
--   insert into application_team_comments
--     (application_id, company_id, parent_id, depth, author_name, body)
--   values (:app, :co, '…0002', 1, 'Cara', 'Third level.');
--
--   ERROR:  insert or update on table "application_team_comments" violates
--           foreign key constraint "application_team_comments_parent_fkey"
--
-- The three ways round it are closed too:
--
--   parent = a reply, depth 0  -> application_team_comments_depth_matches_parent
--   parent = a reply, depth 2  -> application_team_comments_depth_values
--   no parent, depth 1         -> application_team_comments_depth_matches_parent
--
-- And the tombstone rule:
--
--   body set + deleted_at set  -> application_team_comments_body_presence
--   body null + deleted_at set -> accepted
--
-- Cascade, checked rather than assumed — generated columns in a foreign key
-- restrict what ON DELETE can do, so this was worth running:
--
--   delete the root         -> its replies go with it
--   delete the application  -> the whole thread goes
--
-- Why this test exists at all: the first draft had the CASE inverted and every
-- one of these cases still passed EXCEPT case 3, which was silently accepted.
-- The CHECK constraints were doing their job and the foreign key was doing
-- nothing, which is precisely the failure an unexercised invariant hides.
-- ============================================================================
