# Staging load test: the steps, in order

Nothing in this directory has been run against a database. Every command below
is yours to run. Steps 1-8 are setup, 9 seeds, 10 measures. The order matters:
the sentinel (step 3) is created and verified BEFORE the restore (step 4),
because it is the permission key for everything after it and the restore's
"could not touch the sentinel" check is only meaningful if the sentinel was
already there.

The scripts never print a project ref, a key, a connection string, or any
fragment of one. If you see a value echoed anywhere, that is a bug; report it.

**What a green run proves.** A green run on shared Nano compute is a
CORRECTNESS result and not a performance result. It says which rows arrive. It
says nothing about how fast, and nothing about which index would help.

---

## 1. Take the schema from production (read-only)

Local `pg_dump` is 18.4 and production is Postgres 17.6, which is fine: a
newer `pg_dump` can dump an older server. The reverse would not be.

The connection goes in a libpq service file, never on the command line. Read the
host, port, user and database name out of the Supabase dashboard (Project
Settings, Database, Connection string) and write them into
`~/.pg_service.conf` rather than copying the URI anywhere:

```
# ~/.pg_service.conf
[remotiv-prod]
host=db.THE_PROD_PROJECT_REF.supabase.co
port=5432
user=postgres
dbname=postgres
```

The password goes in `~/.pgpass`, one line, in the order
`host:port:database:user:password`:

```
db.THE_PROD_PROJECT_REF.supabase.co:5432:postgres:postgres:THE_PROD_DB_PASSWORD
```

Both files must be mode 600. libpq silently ignores a `~/.pgpass` that is group
or world readable and falls back to prompting:

```bash
chmod 600 ~/.pg_service.conf ~/.pgpass
```

Then the dump names only the service, and carries no connection parameter at all:

```bash
PGSERVICE=remotiv-prod pg_dump \
  --schema-only \
  --no-owner \
  --no-publications \
  --no-subscriptions \
  --schema=public \
  --file=/tmp/remotiv-prod-schema.sql
```

Why not simply put the URL in a variable and pass that: because it does not
help. The shell expands `"$PROD_DIRECT_URL"` before `exec`, so the expanded
value is what appears in the process list, visible to every user on the machine
for as long as the dump runs, and the command still lands in your shell history.
`execFileSync` and `execSync` embed the whole argv in their error text, so a
dump that fails prints the connection string into whatever is reading that
output. AGENTS.md treats any fragment of a credential as a leak, and a Supabase
URL is covered: the project ref identifies the project.

Note what is deliberately **absent** from the flag list: `--no-privileges`. It
must stay off. That flag suppresses `GRANT` and `REVOKE`, and the grant audit in
step 2 has nothing to read without them. Also absent: `--clean`. See step 4 for
why that is not the safety property anyway.

**This is the only production access this whole exercise needs, and it is
read-only.** `--schema-only` writes no rows and reads no candidate data. The
dump is spent once taken: step 10's parity report is derived from the file, with
no further production connection.

### Why a dump at all, and not the repo

Neither repo artifact can rebuild the database:

- `src/lib/supabase/migrations/` creates 25 tables. The app reads 66.
- `schema.sql` lists 46, and **it is gitignored and untracked** (`.gitignore`),
  so it is one person's local file with no history, not a repo artifact.
- `schema.sql` is also **not current production**: 11 tables created by
  migrations committed before the dump was taken are missing from it
  (`interview_turns` 021, `application_team_comments` 023, `worker_heartbeats`
  035, the three `company_plans` tables 037, the four `final_interview*` tables
  038, `final_interview_bots` 040). So either those migrations were never
  applied to whatever was dumped, or the dump came from a different project.
- Three tables exist in **neither** artifact: `availability_rules`,
  `calendar_connections`, `interview_bookings`, created by hand in the SQL
  editor as migration `013_jobs_positions.sql:2-3` describes. `040` has a
  foreign key to `interview_bookings`.
- There is no applied-migration ledger anywhere in the repo.

## 2. Review the dump BEFORE anything is restored

A Supabase project already has managed roles, extensions and schemas, and a
production dump can carry objects that reach outside the database. Those are
stripped before the restore, never disabled after: a staging database that
restores a webhook and fires it at a real endpoint has already done the damage.

```bash
npm run staging:review-dump -- /tmp/remotiv-prod-schema.sql
```

It prints counts (tables, RLS, policies, indexes, triggers, functions,
sequences, generated columns, grants, grantees), then three sections, then the
restore gate. Every host is masked to `<ref>.supabase.co` and every URL path to
`<path:N>`, so the output can be pasted anywhere.

| Section | What is in it | What you do |
|---|---|---|
| **mechanical** | `CREATE SCHEMA public`, its `COMMENT`, and `ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin` | Nothing. The strip removes these (step 4). |
| **triggers outside public** | A `CREATE TRIGGER` whose function is not `public.*`, which is what a Supabase database webhook looks like (`supabase_functions.http_request`) | Delete the whole statement from the dump by hand. |
| **BLOCKING** | `outbound` (webhooks, pg_net, dblink, NOTIFY), `cron`, `url` (any `https://` or Supabase host, comments included), `owner`, `foreign` (publications, event triggers, foreign servers), `drop` | Decide each one. Delete it from the dump, or write down why it stays. The strip refuses to write anything while this section is non-empty. |

### The restore GATE: effective_score

```bash
grep -c 'GENERATED ALWAYS AS' /tmp/remotiv-prod-schema.sql   # 0 means STOP
grep -n 'effective_score' /tmp/remotiv-prod-schema.sql
```

`application_scores.effective_score` is the GENERATED column Best Match orders
by (`applicants/actions.ts:865`). It appears in no repo artifact; its only
record is a hand-maintained JS copy at
`(gated)/applicants/effective-score-gate.test.ts`. **If the count is 0, stop
and report. Do not restore and investigate afterwards.** A staging database
restored without it is one where Best Match cannot work, and every Best Match
assertion would fail for a reason that has nothing to do with the ordering
under test. The review exits 1 and the strip refuses to write while the column
is absent, so the tooling enforces this; the sentence is here so you know why.
The stale `schema.sql` is exactly such a dump: zero generated columns.

### What the real dump proved about `schema.sql`: worse than stale

The first real dump (2026-10-26) was compared with the untracked `schema.sql`
that earlier work had read as a preview:

| | `schema.sql` said | production has |
|---|---|---|
| tables | 46 | 66 |
| indexes | 104 | 155 |
| triggers | 4 | 34 |
| functions | 5 | 31 |
| generated columns | 0 | 2 |
| policies | 24 | 16 |

It is missing 20 tables and 30 triggers, AND it claims 8 policies that do not
exist. Wrong in both directions, so it cannot even be read as a lower bound.
**Nothing is ever built from it again**: not a count, not a column list, not an
RLS claim. The only schema authority is a fresh dump taken as step 1 describes,
and this directory's tests pin themselves against that dump, never against
`schema.sql`. (The same note stands in AGENTS.md.)

Decisions already taken, so nobody rediscovers them:

- **pg_cron jobs** are rows in the `cron` schema and cannot appear in a
  `--schema=public` dump. Staging gets no schedule. The functions a job would
  call (`purge_expired_access_logs`) restore inert.
- **The one trigger that enqueues work stays, for parity.**
  `final_interview_bots_orphan_guard` (migration 040) inserts a `background_jobs`
  row after a delete on `final_interview_bots`. It is kept because (1) the seed
  writes no bot rows, (2) nothing deletes one, and (3) the queue has no drain
  without `CRON_SECRET`, which step 7 requires absent. Three reasons are an
  argument; the measurement is `assertQueueEmpty` at the end of the seed, which
  fails the seed if `background_jobs` holds any row.
- **SECURITY DEFINER functions** (`unlock_candidate`, the `company_plans`
  family, `purge_expired_access_logs`) are internal and stay.
- **Roles.** `--no-owner` means no `OWNER TO`. Grantees in the migrations are
  `postgres`, `anon`, `authenticated`, `service_role`, `public`, all present in a
  fresh project. The review lists every grantee it found; any other name must
  exist in staging (`select rolname from pg_roles`) or its line is removed.
- **Publications** are excluded by `--no-publications`, so staging tables are
  not in `supabase_realtime`. No dashboard surface subscribes to realtime
  (grep for `postgres_changes` finds nothing), so this changes no measurement.
  Documented difference.
- **Triggers on `auth.users`** are not dumped (the schema is excluded). The
  functions they call would be. The test accounts are created by hand, so no
  sign-up trigger is needed. Documented difference.

Also confirm `shortlist_flagged_at` and `interview_sessions.archived_at` are in
the dump; shipped code reads both and `schema.sql` lacks the first.

## 3. Pin the identity in git, then create the sentinel in ITS OWN SCHEMA

This comes BEFORE the restore. The sentinel is the human-held key: production
does not have it and cannot acquire it by accident, and every script and both
probe routes refuse without it. Creating it first costs nothing and lets step 4
prove the restore could not touch it.

Get the staging project ref (the subdomain of its Supabase URL), then:

```bash
printf '%s' 'THE_STAGING_PROJECT_REF' | shasum -a 256
```

That prints a hash and nothing else. Put it in
`scripts/staging/approved-identity.json` as `projectRefSha256`. The ref itself
goes nowhere near the repo.

The file ships with a placeholder that is deliberately 64 hex characters
(`deadbeef` x 8), so that the guard's not-placeholder check can be proven to
fire. Until you replace it, `scripts/staging/approved-identity.test.mjs` is red
and its NAME says so: IDENTITY NOT CONFIGURED YET. It goes green after, and
stays green, because it then asserts the shape of the value and not the value.
Do not delete it to make the suite green; do not fill the file with anything but
the output of the command above.

Why git and not `.env.staging`: two values from the same environment file are
one value. Git holds the expectation; the environment supplies the actual; the
sentinel row makes the database assert its own identity. All three must agree,
and no single edit can make them.

Now the sentinel. Run this once, in the **staging** SQL editor. It lives in a
schema of its own, `staging_guard`, NOT in `public`, so the restore in step 4
(which writes only to `public`) cannot drop it and nobody has to remember to
recreate it. Production must never have this schema: its absence is what makes
a production connection fail.

```sql
begin;

create schema if not exists staging_guard;
comment on schema staging_guard is
  'Remotiv staging identity. Not in public, so no restore of public can drop it. Production never has this schema.';
revoke all on schema staging_guard from public;
grant usage on schema staging_guard to service_role;

create table if not exists staging_guard.sentinel (
  id                 integer     primary key default 1,
  project_ref_sha256 text        not null
                                 check (project_ref_sha256 ~ '^[0-9a-f]{64}$'),
  purpose            text        not null,
  created_at         timestamptz not null default now(),
  constraint sentinel_single_row check (id = 1)
);
alter table staging_guard.sentinel enable row level security;
revoke all on staging_guard.sentinel from public, anon, authenticated;
grant select on staging_guard.sentinel to service_role;

insert into staging_guard.sentinel (project_ref_sha256, purpose)
values (
  'PASTE_THE_LOWERCASE_HASH_FROM_approved-identity.json',
  'Remotiv staging load test. Synthetic data only. Not production.'
);

-- Both free-plan limits, readable by the seed between tables. The 500 MB
-- quota and the 2 GB disk are independent: WAL lives on the disk.
-- wal_bytes is NULL when pg_ls_waldir() is not executable by this role;
-- the seed then requires STAGING_WAL_BY_DASHBOARD=yes (step 7).
create or replace function staging_guard.usage()
returns table (db_bytes bigint, wal_bytes bigint, slot_retained_bytes bigint)
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_wal bigint;
begin
  begin
    select sum(size) into v_wal from pg_ls_waldir();
  exception when insufficient_privilege then
    v_wal := null;
  end;
  return query
    select pg_database_size(current_database()),
           v_wal,
           (select max(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn))::bigint
              from pg_replication_slots);
end;
$$;
revoke all on function staging_guard.usage() from public, anon, authenticated;
grant execute on function staging_guard.usage() to service_role;

commit;

-- checks: exactly one row, the hash equals the pin in git, and usage() answers
select count(*) from staging_guard.sentinel;
select project_ref_sha256 = 'PASTE_THE_SAME_HASH' as matches_pin from staging_guard.sentinel;
select * from staging_guard.usage();
```

The `check (id = 1)` is what makes "exactly one row" enforceable rather than
hopeful. The guard refuses to write if it finds any other number.

**Then one HUMAN step in Supabase settings, which nothing can do for you:**
Project Settings, Data API, **Exposed schemas**: add `staging_guard`.
PostgREST only serves schemas on that list, and the guard, the seed, the harness
and the app's identity route all read the sentinel through PostgREST.

Without it, the guard's sentinel read errors and the guard **fails closed**:
nothing runs. Failing closed means nothing runs, rather than something running
unguarded. If `npm run staging:seed` stops at check 6 with "could not read
staging_guard.sentinel", this step is the first thing to look at. The guard is
not broken; it is refusing, correctly, to identify a database it cannot read.

## 4. Strip the dump, then restore it

Only after step 2 shows no blocking findings and the effective_score gate open,
and step 3's sentinel exists.

```bash
npm run staging:strip-dump -- /tmp/remotiv-prod-schema.sql
```

This writes `/tmp/remotiv-prod-schema.restorable.sql` and prints what it
removed and what it prepended. It refuses, writing nothing, while step 2 still
has a blocking finding, the effective_score column is absent, or an index uses
an access method or operator class from no known extension. The mechanical
edits:

1. The `\restrict <token>` line pg_dump 18 writes at the top is emitted
   **exactly once**, first, and `\unrestrict` exactly once, last. The token is
   random per dump, not an identifier, and psql 18.4 understands it. The first
   build of staging had the line twice (the header re-emitted it and the body
   still carried it) and psql stopped at the second with "backslash commands are
   restricted; only \unrestrict is allowed". The strip now drops the body copies
   and a test counts the lines.
2. `CREATE SCHEMA public;` and `COMMENT ON SCHEMA public` are removed. A fresh
   project already has `public`, so under `ON_ERROR_STOP` the restore would abort
   on line one.
3. `ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin` lines are removed. The
   `postgres` role cannot act for `supabase_admin`, and the fresh project already
   carries identical defaults. `FOR ROLE postgres` lines stay.
4. `CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;` is prepended,
   because ten indexes use `public.gin_trgm_ops` and a `--schema=public` dump
   emits no `CREATE EXTENSION`. It must be `public`, not Supabase's default
   `extensions` schema, or the operator class does not resolve. `uuid-ossp` is
   added the same way only if the dump references `uuid_generate_v*`.
5. `CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public;` is prepended
   whenever a gist index or EXCLUDE constraint has an element of a btree type.
   Production has one: `interview_bookings_no_host_overlap EXCLUDE USING gist
   (host_member_id WITH =, tstzrange(...) WITH &&)`. The range half is core;
   the uuid half is not, and without btree_gist the restore fails with "data
   type uuid has no default operator class for access method gist". The review
   resolves every gist element to its source (column types are read out of the
   dump's own CREATE TABLE) and prints the result.

The review also prints every access method and operator class the dump uses
with the extension each comes from. For the 2026-10-26 dump: `btree` 144,
`gin` 11 and `gist` 1 are core; `gin_trgm_ops` (10) is pg_trgm; the one gist
element over a uuid is btree_gist. Every function the dump calls outside its
own `public.*` functions is core (`gen_random_uuid`, `to_tsvector`,
`setweight`, `tstzrange`, `hashtextextended`, `pg_advisory_xact_lock`); the
`talent_profiles.search_vector` gin index is a core tsvector index. An access
method or operator class the tooling has never seen is a BLOCKING finding, so
the next extension is a review line and not a restore failure.

Add a second stanza to `~/.pg_service.conf` for the staging project and a
matching `~/.pgpass` line. **The staging stanza is not the same shape as the
production one** when you connect through the Supavisor pooler, which is what
a network without IPv6 needs, since the direct `db.<ref>` host is IPv6-only
without the IPv4 add-on:

```
[remotiv-staging]
host=THE_POOLER_HOST                    # Project Settings, Database, Connection string, "Session pooler"
port=5432                               # session mode; the restore needs a real session
user=postgres.THE_STAGING_PROJECT_REF   # NOT plain "postgres"
dbname=postgres
```

The username on the pooler is `postgres.<project-ref>`. Plain `postgres` fails
with a password error that names `postgres`, which is misleading: the pooler
strips the ref before the backend sees the name, so the backend reports the
user it was handed and the actual mistake, the missing ref, appears nowhere
in the message. The `~/.pgpass` line must use the same `postgres.<ref>` user
and the pooler host, or libpq finds no password and prompts. Then:

```bash
PGSERVICE=remotiv-staging psql --single-transaction --set ON_ERROR_STOP=on \
  -f /tmp/remotiv-prod-schema.restorable.sql
```

**What actually makes this restore safe.** It is not the absence of `--clean`.
Two things together are the safety property:

- With `CREATE SCHEMA public` removed, the file contains no schema statement and
  no `DROP` of any kind (the strip refuses to write a file that has one). The
  restore is structurally unable to remove anything, including the sentinel,
  even if the schema separation in step 3 were somehow bypassed.
- `--single-transaction` with `ON_ERROR_STOP=on` means a failure anywhere rolls
  the whole file back. A half-applied schema is impossible: it all lands or none
  of it does.

A future reader will otherwise assume the flag list is the protection. It is
not; the flag list is what keeps the grants in and the owners out.

After the restore, run these in the staging SQL editor and compare with the
counts the review printed:

```sql
select count(*) from staging_guard.sentinel;   -- still 1: the restore could not reach it

select count(*) as tables, count(*) filter (where relrowsecurity) as rls_on
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r';

select count(*) as policies from pg_policies where schemaname = 'public';

select count(*) as triggers
from pg_trigger t join pg_class c on c.oid = t.tgrelid
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and not t.tgisinternal;

select extname, extnamespace::regnamespace from pg_extension order by 1;

select c.relname, a.attname, pg_get_expr(d.adbin, d.adrelid) as expression
from pg_attribute a
join pg_class c on c.oid = a.attrelid
join pg_namespace n on n.oid = c.relnamespace
join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
where n.nspname = 'public' and a.attgenerated = 's';
```

The first line is the proof the restore could not reach the sentinel, which is
why step 3 ran first. The generated-column query is where `effective_score`'s
expression is compared with the dump's `GENERATED ALWAYS AS (...)` text,
character for character.

Then create the five storage buckets by hand in the staging dashboard: `cvs`,
`company-logos`, `talent_photos`, `interview-videos`,
`final-interview-recordings`. The seed writes no files, so they stay empty.

**RLS: change nothing.** Per the real dump, all 66 tables have RLS enabled with
16 policies across only 9 tables; 57 tables have RLS on and no policy, which
works only because the app uses the service-role key. If staging gets policies
production does not have, staging stops testing the application. (The earlier
figures here, 46 tables and 24 policies, came from `schema.sql` and were wrong
in both directions; see step 2.)

## 5. Which migrations sit outside the baseline

A production dump already contains everything production has, so migrations
are redundant except as a record. Three things to know:

- **024 was skipped.** No file exists, no deletion, no rename, no reference in
  any branch's history. There is no record of intent. Nothing to fix.
- **047 is NOT empty.** It was reserved before 048 and 049 were written, and it
  now holds the 24-month access-log retention migration (commit 54d7e7e, 325
  lines). `migration-048.test.ts:132` and `migration-049.test.ts:155` assert
  exactly that. An earlier version of this file said it was deliberately empty;
  that was true when written and is not now.
- **040 is not re-runnable**: bare `create table`, bare `add column`, bare `drop
  constraint`. `013` is likewise bare. Three files create policies with no
  preceding `drop policy if exists` (`001:42`, `002:42`, `006:72,75`).

Step 10's parity report says which of 001-049 are visible in the dump.

## 6. The staging-probe routes

Two routes exist in the app, under `src/app/api/staging-probe/`:

| Route | Returns | Used by |
|---|---|---|
| `GET /api/staging-probe/identity` | the sentinel's hash and purpose | the harness, to prove the RUNNING app reads the approved project |
| `GET /api/staging-probe/scoped-application-ids` | the signed-in member's own allow-list from the real `scopedApplicationIds` | the seed's visibility self-check and the harness's #25 |

Both pass through one gate (`_lib/gate.ts`), in this order: the sentinel is
read from `staging_guard` through the service client, then the session is
resolved with `getCompanyContext()`, the same resolver every dashboard page
uses. Only then does a route compute anything.

**What happens if one is hit in production.** Production has no
`staging_guard` schema. The sentinel read fails, the route returns a bare 404
with no body, and nothing below it ran: no session was read, no company was
resolved, no applicant id was computed. No environment variable is consulted,
because a variable is a claim the environment makes about itself. The routes
are compiled into every build; the schema is the key, and production cannot
acquire it by accident. `probe.test.ts` asserts the order, not just the status.

Authorization is the dashboard's own. The scoped route returns the ids the
signed-in member can already see in the product. An owner or admin is unscoped
and gets `ids: null`, which is the function's own answer for "unrestricted".

## 7. Write `.env.staging`

Variable names only; fill in the values yourself. **Do not commit this file**;
it is covered by `.gitignore`'s `.env*` pattern.

**Must be present:**

```
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY
STAGING_APP_SUPABASE_URL          # the URL the dashboard itself boots with; must be the same project
REMOTIV_STAGING_WRITES_APPROVED=yes-i-have-read-scripts-staging-README-steps
STAGING_BASE_URL                  # where the app is running, e.g. http://localhost:3000
STAGING_TEST_EMAIL                # an owner account, created by hand in staging auth
STAGING_TEST_PASSWORD
STAGING_SCOPED_EMAIL              # a second account; the seed makes it a job-scoped recruiter
STAGING_SCOPED_PASSWORD
```

### The two test accounts: staging has no users until you create them

The dump was `--schema=public`, so `auth.users` came across empty. Nothing can
sign into the staging dashboard until these exist, and the seed needs them
BEFORE it runs, because it signs them in and writes their membership rows
from the user ids that sign-in returns. Order: **auth users first, then the
seed.** Not the other way round.

1. Staging dashboard, left sidebar: **Authentication**, then **Users**.
2. **Add user**, then **Create new user**.
3. Enter the email you will put in `STAGING_TEST_EMAIL` and a password for
   `STAGING_TEST_PASSWORD`. Tick **Auto Confirm User**, or the account cannot
   sign in until an email that will never arrive is clicked. Create.
4. Repeat for `STAGING_SCOPED_EMAIL` / `STAGING_SCOPED_PASSWORD`. Any two
   addresses you control; they receive nothing (RESEND_API_KEY is absent).
5. Do NOT add either user to a company by hand. That is the seed's job:
   `company-access.ts` resolves a signed-in user to the FIRST active
   `company_members` row (ordered by created_at, then id) and then requires
   that company's status to be `active`. The seed writes the `companies` row
   (status defaults to active) and both `company_members` rows: the first
   account as `owner` (unscoped, sees everything), the second as `recruiter`
   (job-scoped; `job_hiring_team` rows put it on three jobs, which is what #25
   measures). A row you add by hand would be older than the seed's and would be
   the one the dashboard resolves.
6. Nothing to do by hand, but know it: `companies.must_change_password`
   **defaults to true** (no migration defines the column; the first 50-row run
   proved it on the fixture). The gated layout sends every member of such a
   company to `/ai-dashboard/change-password?forced=true` before any
   dashboard page, so a company row written without the flag is one no
   browser login can get past. The seed writes it `false`;
   `assertAccountUsable` refuses it `true` (seed, after its writes, and
   harness `beforeAll`); and the harness's form sign-in names that redirect
   if it ever sees it, instead of waiting 60 s on the dashboard URL.

What each account sees, in order: before the seed, signing in lands on
`/ai-dashboard/login?reason=unauthorized` (valid user, no company). After the
seed, the owner sees the fixture company's dashboard and the recruiter sees
its three jobs. The company login is `/ai-dashboard/login` (inputs
`#co-email` / `#co-password`); `/login` is the admin form and goes to
`/admin`, which is the page the harness used to drive by mistake.

This is asserted, not assumed (`accounts.mjs`, tested offline and reverted
by the controls): the seed refuses before its first write unless both
accounts sign in and are FREE (no active membership anywhere), refuses after
its writes unless both are USABLE (first active membership is the fixture,
planned role, company active), and the harness repeats the USABLE check in
`beforeAll`, before any page exists. `npm run staging:access` reports which
state each account is in. A refusal names the variable; the alternative was a
browser login timing out somewhere deep in the flow.

**Optional:**

```
STAGING_WAL_BY_DASHBOARD=yes      # only if usage() returns NULL wal_bytes and you are watching the disk report
STAGING_RESEED_OVER_EXISTING=yes  # only to re-run the seed over rows from a previous run of this same script
```

### Start the app in isolation: `npm run staging:app`

**Never start the app with plain `next dev` for this work.** `.env.local`
carries production credentials, and `next dev` loads it on every start. The
seed proving ITS process is on staging says nothing about the app's process; a
harness driving a browser around a production app would produce numbers that
are true statements about the wrong database, over real candidate data.

How Next resolves env files, read from the installed `@next/env` 16.2.6
(`node_modules/@next/env/dist/index.js`, `loadEnvConfig` and `processEnv`),
not from documentation, and confirmed by running that function on fabricated
files:

| | result |
|---|---|
| files, in load order, for `next dev` | `.env.development.local`, `.env.local`, `.env.development`, `.env` |
| a key in several files | the first file in that order wins (`.env.local` beat `.env.development` and `.env` in the experiment) |
| a key already in the process environment before any file is read | **wins over every file**: `URL=from_process` stayed `from_process` with `.env.local` saying otherwise |
| a key set to the **empty string** in the process environment | stays empty and is **not reloaded from any file**: `SECRET=` stayed `""` with `.env.local` holding a value |
| `.env.staging` | **never read by Next at all**; it is not in the list |

So `.env.staging` existing proves nothing by itself. `scripts/staging/app.mjs`
uses the two rules: it loads `.env.staging` into its own process (over the
shell, so an exported production variable cannot win; `stagingOverShell`,
tested), refuses to start while another `next dev` or `next start` is running
from this checkout (`conflictingDevServers`, tested: Next 16 writes all
development output to `.next/dev` and takes no lock, so two servers in one
checkout would serve each other's compiled assets, with each other's inlined
`NEXT_PUBLIC_*` values; Commit 10's dev server must be stopped first, or the
staging app run from a separate checkout), runs guard checks 1-5
against that environment and refuses to start on any failure, reads the
variable NAMES out of every other env file that exists, locks each one that
`.env.staging` does not set to the empty string, locks every name the guard
requires absent the same way, sets `SUPABASE_PROJECT_ENV=development` for
`src/lib/supabase/guard.ts`, and spawns `next dev` on the port
`STAGING_BASE_URL` names (local addresses only). `next dev` forks its server
with the same pre-file snapshot (`cli/next-dev.js`, `defaultEnv =
initialEnv`), so the locks reach the process that serves requests. Every call
site in `src` tests these keys for truthiness, so an empty string is absent
to the app exactly as it is to the guard.

The app then proves it from inside: the identity route reports, by NAME, which
locked variables are present in its process (`isolation.present`), and
`proveAppIdentity` (`app-identity.mjs`) refuses the app unless that list is
empty AND the sentinel hash equals the pin AND the app reports isolation at
all.

**The browser's own connection is checked separately.** The sentinel proves
where the SERVER's service-role client talks. The browser never uses that
client: `src/lib/supabase/client.ts` hands it `NEXT_PUBLIC_SUPABASE_URL` and
the anon key, inlined from the app's environment. So the identity route also
reports, as hashes, the project ref in the app's `NEXT_PUBLIC_SUPABASE_URL`,
the `ref` claim inside the anon key when it is a legacy JWT, and whether the
project's `/auth/v1/settings` endpoint accepts that key as its apikey
(`_lib/connections.ts`). `proveAppIdentity` compares all of these and the
scripts' `STAGING_APP_SUPABASE_URL` with the pin, collects every
disagreement, and the error names each party that disagreed: the server-side
connection, the browser's public URL, `STAGING_APP_SUPABASE_URL`, or the anon
key (wrong project, rejected, or unverifiable). Any one of them fails the
run; an app that reports no connection details fails closed. An app started any other way reports nothing and is refused: "I did not
check" is not "absent". The seed calls this before its first write and the
harness calls it in `beforeAll`, where no browser exists, so a 404 (which is
what production answers) stops everything before a page is opened or a
candidate-data request is made. It is a pure function over an injected fetch;
`app-identity.test.mjs` drives every refusal and `negative-controls.mjs`
reverts each one.

### Prove the sentinel's protection holds: `npm run staging:access`

Read-only, against the real staging project, once `.env.staging` and both
test accounts exist:

```bash
npm run staging:access
```

`access.live-test.mjs` (named so the offline `*.test.mjs` glob never runs it)
proves what step 3's grants claim: service_role reads exactly one sentinel
row equal to the pin; anon obtains NO contents; both signed-in accounts
(`authenticated`) obtain NO contents; neither can call `usage()`; the five
buckets exist; both accounts sign in and hold no active membership outside
the fixture company. Each refusal is printed with the mechanism (PostgREST
code 42501 for a missing grant, or 0 rows for RLS), never a message, because
a PostgREST message can carry the request path. A schema on the Data API
whose protection nobody has watched hold is the same class of thing as a guard
nobody has seen fail.

**Must be ABSENT. This is the part that matters.**

The guard refuses to run if any of these is set, because each one re-enables a
path that costs money or sends something to a real person.

| Variable | What it re-enables |
|---|---|
| `ANTHROPIC_API_KEY` | Every Anthropic path. `getAnthropic()` throws without it, and that covers 10 call sites including the job wizard's generators, `ai-matching`, `cv-extract` and `live-question-freeze` |
| `OPENAI_API_KEY` | Scoring, async transcription, live transcription. All three throw without it |
| `CRON_SECRET` | `/api/jobs/worker` is the only drain for the queue and refuses every request without it. Enqueueing still works, so jobs pile up unprocessed, which is what we want, and what `assertQueueEmpty` then proves did not happen |
| `RESEND_API_KEY` | Candidate and internal email. **Read at module scope** (`email/send.ts:3`), so it must be absent before the process starts |
| `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID` | WhatsApp sends via `graph.facebook.com` |
| `RECALL_API_KEY`, `RECALL_RECORDING_ENABLED` | Recall.ai meeting bots |
| `GOOGLE_CALENDAR_CLIENT_ID`, `GOOGLE_CALENDAR_CLIENT_SECRET` | Calendar writes. This one **throws** rather than degrading |

Two behaviours worth knowing before you read the results:

- **Candidate email writes a `communication_logs` row before it fails.**
  `email/candidate/deliver.ts:345` sets `status: "failed"`. A failed send leaves
  a trace; do not mistake those rows for sends.
- **Internal email fails silently.** `email/send.ts:8-11` logs a warning and
  returns null.

There is no `crons` array in `vercel.json`. Cron schedules are configured in the
Vercel dashboard, so a staging deployment will not inherit them. Leave them off.

## 8. Install Playwright

```bash
npm install
npx playwright install chromium
```

The markup attributes the harness reads (`data-applicant-id`,
`data-message-id`, `data-count`, and the three strip attributes) landed in
commit 18c69a6. The harness still **throws** rather than passing if any is
absent on any row: it will not report a result it did not read.

## 9. Seed: 50 first, then 10,000

The applicant count is a **required parameter**, not a mode. There is no
default, so a forgotten flag cannot seed 10,000 rows, and a 50-row run cannot
be mistaken for the full one.

```bash
npm run staging:seed -- --applicants=50       # the smoke run
npm run staging:harness                        # every assertion, against 50
```

The smoke run is the complete pipeline at one two-hundredth of the scale: the
same guard, the same sign-ins, the same identity proof, the same inserts, the
same self-check, and every harness assertion. `seed-plan.mjs` scales every
count proportionally (`scaled()`), and at 10,000 that function returns the
full-scale constants exactly, so the full run is the fixed point of the same
code and not a separate path. A plumbing error surfaces in seconds rather
than after a long run that generates WAL to wait out.

What 50 rows cannot reach is recorded in the manifest as `notCovered`, and
the seed and the harness both print it under **NOT COVERED, never PASS**: the
1,000-row internal page boundary, #25's chunking, a UI page boundary inside a
tie block on either list, Best Match ties spanning a page, the
skipped-with-adjustment branch, the 2,500-applicant job. A green smoke run
closes none of those; it proves the pipeline runs end to end.

### Removing the 50 rows before the 10,000

Do not extend. The ids are deterministic by index, so the 10,000 plan does
contain the 50 run's ids, but their `pipeline_stage` and `created_at` depend on
the global row index and would differ, and the guard refuses to seed on top of
existing rows anyway. Delete and reseed. Every seeded row hangs off ONE
company id, `uuidFrom("company")`, which the seed prints; nothing else in
staging carries it. Two statements, in this order, in the staging SQL editor:

```sql
-- 1. applications first: they carry the company only as a snapshot column and
--    are NOT cascaded by the company delete (job_applications.job_id is
--    ON DELETE SET NULL). This cascades scores, stage history and comments.
delete from public.job_applications where company_id_snapshot = 'THE_FIXTURE_COMPANY_ID';

-- 2. the company: cascades jobs, job_hiring_team, company_members,
--    communication_logs, interview_sessions (and their answers), background_jobs.
delete from public.companies where id = 'THE_FIXTURE_COMPANY_ID';

-- proof: nothing of the fixture remains, and nothing else moved
select (select count(*) from public.job_applications where company_id_snapshot = 'THE_FIXTURE_COMPANY_ID')
     + (select count(*) from public.jobs where company_id = 'THE_FIXTURE_COMPANY_ID')
     + (select count(*) from public.communication_logs where company_id = 'THE_FIXTURE_COMPANY_ID')
     + (select count(*) from public.interview_sessions where company_id = 'THE_FIXTURE_COMPANY_ID') as fixture_rows_left;
select count(*) from staging_guard.sentinel;      -- still 1
select count(*) from auth.users;                  -- unchanged: the two test accounts
```

The foreign keys above are read from the production dump (lines 5155-5763),
not assumed. `staging_guard`, the auth users and the buckets are untouched
because none of them reference the company. Then:

```bash
npm run staging:seed -- --applicants=10000
npm run staging:harness
```

In order, at either scale: the guard (7 checks, the sentinel in `staging_guard`
among them — this is the SERVICE-side proof that gates every write to staging
before the first insert), a sign-in of both test accounts, a check that both
are FREE, a preflight that asks the database whether every column the seed
writes exists (the SHAPE), a second preflight that checks every enumerated
value the seed writes against the schema dump's CHECK constraints (the
CONTENT — `event`, `status`, `channel`, `pipeline_stage`, `role`, `kind` and
the rest: a wrong value is a listed failure here, not a half-written table,
and this reads the dump because PostgREST exposes no `pg_catalog`), a baseline
`usage()` reading, then the writes in 500-row batches through PostgREST. **The running app's identity, isolation and
browser-connection proof runs right after the owner's `company_members` row is
written**, not before the writes: the identity route is gated by
`getCompanyContext()`, which refuses an account with no active membership
(refusal code `no-company`), and the owner is FREE until the seed writes that
row. Proving it earlier 404s for that reason — not the sentinel, not the
cookie. Nothing is at risk from writing first: the service-side sentinel above
already proved this is staging, the seed writes through its own service client,
and the app's browser path is only used later by the harness. In
`--verify-only` there are no writes, and the membership from a prior seed
already exists, so the same proof passes there too. Each batch is its own committed transaction,
so WAL is checkpointed and recycled during the run rather than held. After every
table the seed reads `staging_guard.usage()` and aborts at 400 MB database,
1 GB WAL directory, or 512 MB retained by a replication slot.

Expected end state: roughly 50,000 rows, 35 MB of data and indexes, a database
well under 100 MB, and WAL steady at whatever `max_wal_size` allows.

It ends with three proofs, in order, and prints `seed complete` only after all
three:

1. a service-role **census**: did the rows land? Labelled as NOT a visibility
   check, because it bypasses RLS and the dashboard's filter chain.
2. **`background_jobs` is empty**: nothing the seed did enqueued work.
3. the **visibility self-check**: signed in as the scoped recruiter, the seed
   calls `/api/staging-probe/scoped-application-ids`, which runs the
   application's real `scopedApplicationIds` in the app's runtime, and compares
   the ids it returns against the manifest the plan generated. A
   reimplementation of the filter can agree with itself while both are wrong,
   which is why the real function is called.

If the third step fails after the writes succeeded, the seed prints `SEED
WRITTEN BUT NOT COMPLETE`, exits 1, and writes no manifest. Fix the cause (the
app not running, not pointed at staging, the route not deployed) and re-run
only that step with `npm run staging:verify`.

If the seed aborts partway through the writes, truncate and start over rather
than re-running; a half-seed makes every figure meaningless, and the guard will
stop you anyway unless you set `STAGING_RESEED_OVER_EXISTING=yes`.

What the seed does NOT do: it does not set `interview_sessions.kind`, so every
session is `async` and the live interview path is never exercised. It does not
go through `/api/apply`, so intake is not exercised. It writes no NULL
`pipeline_stage`, because the column is NOT NULL.

## 10. Measure

```bash
npm run staging:harness
```

### The browser's network is guarded, permanently

`NEXT_PUBLIC_*` values are inlined into browser assets when they are
compiled. The sentinel proves the server's service client and the identity
route proves the server's environment; neither proves what the compiled
bundle actually calls. So every harness test runs under `guardedTest`
(`guarded-test.mjs`), which overrides Playwright's `context` fixture: before
any page exists, it blocks service workers, routes every HTTP request and
every WebSocket through `network-guard.mjs`, and counts successful responses.
The guard's verdicts:

| destination | verdict |
|---|---|
| the approved project host (its ref hashes to the pin in git) | continue |
| a hostname listed exactly in `STAGING_SUPABASE_CUSTOM_DOMAINS` (no wildcard, scheme, port or path) | continue |
| any other Supabase-looking host: another project, the pooler, a direct db host | **abort before the network; record masked; the test FAILS** |
| everything else (the app, fonts, calendly) | continue |

A blocked request still fails the test it happened in (`afterEach`), because
it is a request the bundle tried to make. The run also requires at least one
**successful** browser request to the approved project (`afterAll`): zero
observed is not a pass, since a guard that saw no traffic has proven
nothing. The first browser test issues one deliberately, from inside a page
the app served, so it must pass the app's own Content-Security-Policy first.
Recorded destinations are masked (`<ref>.supabase.co/<path:N>`, no query
string), so nothing identifying is written.

`npm run staging:guard-selftest` runs the guard in a real Chromium against
FABRICATED hosts, offline: a production-looking project and an unknown
project are aborted before DNS and recorded masked, a WebSocket to the wrong
project is closed and never connected, the approved host continues and is
counted, a page the test opens itself is already guarded, and a blocked
request fails. Nothing is sent anywhere. `negative-controls.mjs` reverts each
verdict and requires the pure tests to go red.

**FINDING (fixed in the working tree, UNCOMMITTED, Waleed's call to ship):
`next.config.ts` pinned the production project host by name.** Its CSP
`connect-src` (and `img-src`, `media-src`, and `images.remotePatterns`)
named one Supabase host, the production one. A staging-pointed app therefore serves pages whose CSP
forbids the browser from talking to staging and permits it to talk to
production, which is exactly backwards for this test. The dashboard's gated
pages make no browser-side Supabase requests themselves (sign-in is a server
action; the browser client is used only by the password pages and the public
site's navbar and footer), so the harness's own probe request is what hits
this: it would fail with zero attempts observed. The fix now in the tree is
`src/lib/security/csp.ts`: every directive and the image allowlist are pure
functions of ONE host derived from `NEXT_PUBLIC_SUPABASE_URL`, with the
production literal as the unset-only fallback, and `csp.test.ts` asserts
that production's own URL reproduces the exact header string shipped before,
so a staging convenience cannot widen production's headers. It is a change
to production's config file and is not committed: shipping it is Waleed's
decision.

The harness starts by calling the same guard the seed did, with the harness
intent, then, still inside `beforeAll` where no browser exists, signs in
through the SDK and asks the running app for its identity and isolation
through the probe route (`proveAppIdentity`, step 7). A 404 there is
production, and the run stops with no page opened. `harness-wiring.test.mjs`
pins that order in the spec's text, and a negative control deletes the call
and requires that pin to go red. Read the output in four parts:

- **NOT COVERED**: printed first in the summary when the manifest's scale
  leaves anything unreachable (every 50-row run). Nothing in it passed;
  nothing in it failed; it was not measured.

- **CORRECTNESS**: pass/fail, trustworthy. Shared compute makes a query slow; it
  does not make it return a row twice. The three Applicants tests are
  REGRESSION tests for a tiebreaker that was already fixed; their docblock says
  so. #23 on Messages is the live site.
- **LATENCY**: recorded and labelled directional. A latency number from the free
  tier is not evidence for an index.
- **ESTABLISHED, in two halves**: #23 (Messages) and #25 (the scoped
  allow-list) print here, and each verdict names its two halves separately.
  The sweep supplies COMPLETENESS: every expected id once, on one run. The
  query supplies DETERMINISM: the harness reads the shipped source at run
  time (`assertTotalOrder`, assertions.mjs) and refuses unless the paged read
  ends in a unique sort key. A clean sweep cannot show determinism, which is
  why these sat in UNRESOLVED before the fixes; a source pin cannot show
  completeness. Neither half alone closes a pagination finding. The same two
  sites are pinned offline by `query-order.test.mjs`, and
  `negative-controls.mjs` removes each `.order("id")` and requires the pin to
  go red. This is one of the few places a source assertion is the RIGHT
  instrument: the claim is about the query's shape, which no run can prove.
  **Still not established, and the verdict says so:** correctness under
  CONCURRENT inserts and deletes. Both reads page by offset (`.range()`), and
  the #56 reproduction showed offset paging losing a row to an insert before
  the cursor even with a total order. That is a separate, later call-site
  change to `pageAllByKey` (#57), not something a total order gives.
- **UNRESOLVED**: for any surface whose query has no unique final tiebreaker, a
  clean run prints **NOT REPRODUCED, STILL AT RISK**, never PASSED. Ordering
  among tied rows is undefined, not random.

It ends with the NOT COVERED list for the scale that ran, then the STATED
LIMITATIONS: correctness not performance; live interviews not covered; the
stage distribution proves the code handles one, not that it matches production
(which has one distinct `pipeline_stage` across 3,764 rows); the Applied tab's
NULL branch untested.

### What the first 50-row run found (2026-10-27), and where each landed

Every one of these was a harness or seed defect, proven by a probe against
the running staging app before it was changed; none is a finding against the
dashboard's queries. Each fix carries an offline test and a reversion in
`negative-controls.mjs`.

| symptom | cause | fix |
|---|---|---|
| ten browser logins timed out on the dashboard URL | `companies.must_change_password` defaults to true; the seed omitted it | seed writes false; `assertAccountUsable` refuses true; `signIn` names the redirect |
| the form "refused" every login as `unrecognised` | a bare `[role=alert]` matched the Next.js dev overlay's empty node inside its portal (Playwright pierces shadow roots); the classifier accepted an empty read | `LOGIN_BANNER` scopes to the form's own `<p role="alert">`; `classifyLoginRefusal` refuses an empty read; the fill is read back before the click |
| four paged reads reported "20 ids more than once" | the loop read after `networkidle`, which resolves before the next page renders (Messages pages with no request; Applicants commits 1-2 s after its response) | `waitForRowsToMove` polls until the rows differ from the page just read; an unmoved list is named, never reported as #23 |
| Interviews "started" chip read 0 against 2 seeded | the seed's session deadline (`at(i + 100_000)`, 2026-03-15) had passed, and `deriveStatus` expires a live session before it reads the stored status | `SESSION_DEADLINE` is 2099; re-seed required |
| #25: `job-scope.ts` paged the recruiter allow-list with `.range()` and NO `.order()`; #23: `messages/actions.ts` ordered by `created_at` alone | Postgres gives no row order without ORDER BY, so #25's pages could skip and repeat applicants outright (a skipped id is one a recruiter silently cannot see); #23's ties had no order between pages | `.order("id")` on each (2026-10-28); verdicts moved from UNRESOLVED to ESTABLISHED, see above; a run against the 10,000 fixture returned both complete sets again |
| a test that passed its own assertions was reported failed | Playwright restarts the worker after a failure and `afterAll` re-asserted the network proof over the restarted worker's empty count | asserted only in the worker that ran the probe test |

**Noted, probably automation-only:** Playwright's `selectOption` on the
job filter's `<select>` leaves it on "all": a capture-phase listener on
`document` sees the `input` and `change` events arrive with the value
still "all", so the handler writes a `pushState` carrying only `sort`. The
handler itself is sound: a script that sets `select.value` to the job id and
dispatches `change` makes it write `?job=<id>` and the list re-reads, and
opening the page with `?job=<id>` filters to exactly the expected rows. A
real user's change event carries the real value, so this is most likely a
Playwright-and-this-select interaction, not a product defect; it is not
established either way. The harness measures the read path through the URL
and reads the select back.

### What the #57 live run proved (2026-10-28), and why its route is gone

`rescoreJob` collects a job's applicants before it queues them, and #56 showed
that collection paging by offset repeats one applicant and misses another when
a row moves between pages. #57 moved both reads to `pageAllByKey`
(`src/lib/ai/rescore-collect.ts`). The offline proof is by ID SET against a
fake table that mutates between pages (`paging.test.ts`,
`rescore-collect.test.ts`). The live proof ran once, against the 10,000-row
fixture's largest job, and established exactly this:

| What ran | Result |
|---|---|
| the real `collectJobApplicationIds`, through the running app | 2,500 ids, 2,500 distinct, 0 repeated, 0 missing, 0 extra: the set equals `seed-manifest.json` |
| the real `rescoreJob` action, same request | `success`, held 2,500, queued 0, alreadyQueued 0 |
| `background_jobs`, counted before and after | 0 and 0 |

It did NOT prove that every collected applicant is queued and scored. That
would take a run with capacity above zero, comparing the `background_jobs`
rows and then the scorecards against the collected set, which spends scoring
credits and is a separate decision.

**The route that ran it was deleted the same day.** It was
`GET /api/staging-probe/rescore-collect`, and it was the first probe that
could WRITE: `rescoreJob` enqueues. Every route in section 6 is read-only, and
the gate was designed for reads. The only thing that kept that route from
queueing 2,500 real scoring jobs was a `company_plans` row with
`cv_scoring_limit` 0 that the calling script inserted and removed, which is a
safety that lives outside the route. The measurement is done; the route is
not worth the risk of keeping. Section 6's two routes are again the whole list.

**To reproduce it safely, if it is ever needed again.** Two halves, in this
order, and neither needs a route:

1. The SET, with no app and no write. From the repo root, with
   `.env.staging` loaded, run the real collection function directly against
   the fixture and compare it with the manifest:

   ```bash
   node --env-file=.env.staging --input-type=module -e '
   import { register } from "node:module";
   import { readFileSync } from "node:fs";
   import { pathToFileURL } from "node:url";
   const root = pathToFileURL(`${process.cwd()}/`);
   register(new URL("src/test-support/node-resolve.mjs", root));
   register(new URL("src/test-support/server-only-stub.mjs", root));
   const { openStaging } = await import(new URL("scripts/staging/guard.mjs", root).href);
   const { collectJobApplicationIds } = await import(new URL("src/lib/ai/rescore-collect.ts", root).href);
   const m = JSON.parse(readFileSync("scripts/staging/seed-manifest.json", "utf8"));
   const job = m.jobIds[0], expected = new Set(m.applicationIdsByJob[job]);
   const { service } = await openStaging({ intent: "harness" });
   const ids = await collectJobApplicationIds(service, job, m.companyId);
   const seen = new Set(ids);
   console.log({ expected: expected.size, collected: ids.length, distinct: seen.size,
     missing: [...expected].filter((id) => !seen.has(id)).length,
     extra: [...seen].filter((id) => !expected.has(id)).length });'
   ```

   Run on 2026-10-28 against the 10,000-row fixture this printed
   `expected: 2500, collected: 2500, distinct: 2500, missing: 0, extra: 0`.

   Compare the set, never the count: equal counts hid the #56 defect.

2. The ACTION, with capacity forced to zero. Count `background_jobs` and
   record it. Insert a `company_plans` row for the fixture company with
   `cv_scoring_limit` 0 (`scoresToQueue` then returns 0 room and `rescoreJob`
   reports every applicant as `held`). Confirm `readCvCapacity` reports 0 for
   that company BEFORE anything else. Then trigger the re-score the way a
   member does, through the dashboard's confirm dialog in a Playwright session
   signed in as the fixture owner, and read `held`, `queued` and
   `alreadyQueued` from the action's result. Delete the `company_plans` row in
   a `finally`, whatever happened, and count `background_jobs` again: it must
   equal the count before. If it does not, the plan row was not in force, and
   real scoring jobs are queued; stop and clear them before anything else.

   Do not add a route for this. A probe route that calls an action that
   writes is only as safe as the row that happens to be in `company_plans`.

### Parity, from the dump alone

The parity report compares the dump with staging: table count, RLS-enabled
count, policy count, grants, extensions, sequences, generated columns. The
`staging_guard` schema is excluded from it and the report says so. Every other
difference is documented individually. A staging database carrying policies
production lacks has stopped testing the application.

## 11. Prove the guards discriminate

```bash
npm run staging:controls
npm run staging:guard-selftest     # the network guard in a real browser, fabricated hosts, offline
```

Every assertion in this directory, and the gate on both probe routes, is
reverted one at a time and the named test must go RED. A guard nobody has seen
fail is a comment. Run it alone: it rewrites files on disk while it works, so a
build, typecheck or Biome run started alongside it sees reverted files.

## 12. Tear down

### Clear the fixture (between runs)

```bash
npm run staging:teardown
```

Removes the fixture company and its applications and proves nothing of it
remains, so guard check 7 (target table empty) passes on the next seed.
Applications are deleted first by `company_id_snapshot` (not a foreign key, so
the company delete would only `SET NULL` their `job_id`); the company delete
then cascades jobs, members, hiring team, messages, sessions, answers and
background jobs. `staging_guard`, the auth users and the storage buckets
reference no company and are untouched. This is the same company id
(`uuidFrom("company")`) the seed writes, and the removal is the code path
behind README step 9's "Removing the 50 rows". Run it before a clean re-seed
rather than reseeding over a partial fixture.

(Earlier this step only said "delete the project" and had no row-level
teardown; that gap is why the first partial seed had to be cleared by hand.)

### Delete the project (when the measurement is done)

Delete the staging project itself when finished. It holds synthetic data only,
but it also holds a service-role key in someone's `.env.staging`.
