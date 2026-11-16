# Production's hand-run revoke on six tables (#68)

A record, **not a migration yet**. Production holds a privilege change that no file in this repository makes. This note sets down what is known, so it can become a numbered migration later. Nothing here has been run, and this note changes nothing.

## What production holds

The production schema dump (14 Nov 2026, `scripts/staging/.schema/prod-schema.sql`, git-ignored) gives each of these six tables exactly one grant, `GRANT ALL ... TO service_role`, and no other grantee:

| Table | ACL entry in the production dump | Staging dump |
|---|---|---|
| `bookings` | line 7916 | line 7657: ALL to anon, authenticated, service_role |
| `contact_submissions` | line 8054 | line 7792: the same |
| `hire_requests` | line 8105 | line 7855: the same |
| `job_applications` | line 8184 | line 7936: the same |
| `jobs` | line 8209 | line 7963: the same |
| `profiles` | line 8291 | line 8049: the same |

RLS is enabled on all six in both dumps, and neither dump has a policy on any of them. So on production, anon and authenticated have no privilege on these tables at all, and on staging they have every privilege. RLS denies them rows, but not the table-level privileges RLS does not govern: `TRUNCATE`, `REFERENCES` and `TRIGGER`.

## Why this must have been a revoke run by hand

- **No file writes it.** PROVEN: no `revoke` naming any of these six tables exists in `src/lib/supabase/migrations/`, `scripts/backfills/` or `scripts/staging/` (searched 14 Nov 2026). The revokes that do exist (037, 038, 040, 047, 050, 055, 056) name other tables.
- **Production's defaults would have granted it.** PROVEN: production's default privileges grant ALL on new tables in `public` to anon and authenticated, both for tables created by `postgres` (production dump line 8450) and by `supabase_admin` (line 8460). The default-privilege lines are identical in both dumps. A table created under these defaults gets the anon and authenticated grants, so their absence on production means someone removed them.
- **When, and by whom: UNPROVEN.** No file records it. It is also UNPROVEN that the defaults were the same when these tables were created. If they were different then, the tables could have been born without the grants, and nothing was ever revoked. The end state is proven; how it got there is not.

## The statement that reproduces the end state

The same lines as `04-staging-grants.sql` section 2. They are idempotent, and on production they would change nothing:

```sql
revoke all on table public.bookings            from anon, authenticated;
revoke all on table public.contact_submissions from anon, authenticated;
revoke all on table public.hire_requests       from anon, authenticated;
revoke all on table public.job_applications    from anon, authenticated;
revoke all on table public.jobs                from anon, authenticated;
revoke all on table public.profiles            from anon, authenticated;
```

## To make it a numbered migration later (Waleed's decision)

1. Take the next free number after 059. 059 is written but not applied anywhere, so the number depends on the order Waleed chooses.
2. Use the standard shape: begin, `set local lock_timeout = '5s'`, the six revokes, then an invariant block that raises unless `has_table_privilege` is false for anon and authenticated on all six (the check in `04-staging-grants.sql` section 3), then commit.
3. Its header records that production already holds this state, so applying it there is a no-op that only writes the fact down. It does nothing on staging after step 04 either.

## A related question, outside #68

Production still grants anon and authenticated ALL on **52 of its 69 tables** (counted from the production dump's ACL entries, 14 Nov 2026). They are protected by RLS, and these six plus 11 others are the exceptions. Whether the 52 should follow the same rule is a separate decision. This plan does not change it, on either database.
