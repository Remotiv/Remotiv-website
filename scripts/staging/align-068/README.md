# #68 staging alignment

This plan brings the staging schema up to production's, as the #68 audit (14 Nov 2026) measured it. **Nothing in this folder has been run.** Waleed runs every file by hand in the Supabase SQL editor of the database it names. Nothing in the repository executes them.

## What the audit found, and what closes it

Staging is behind production, not ahead. It has no object production lacks.

| Audit finding (staging vs production) | Closed by |
|---|---|
| 056 not applied: `candidate_erasures`, 2 `orphaned_at` columns, 2 triggers, 6 functions, their grants | `01-staging-056-without-step6.sql` |
| 057 not applied: `company_members.removed_at`, its CHECK, function and trigger | `02-staging-057.sql` (runs 057 as written) |
| 058 not applied: `communication_logs.attempt_started_at` and its comment | `03-staging-058.sql` (runs 058 as written) |
| 25 grants looser on staging: the revoke sections of 037, 038, 040 and 047, plus production's hand revoke on 6 tables | `04-staging-grants.sql` |
| Production's hand revoke is in no file | `05-production-record-hand-revoke.md` (a note, not a migration) |

## Order

Every SQL file that writes refuses to run on a database without `staging_guard.sentinel` (README-steps.md step 3), which production never has. Each one is a single transaction, with an invariant that raises before commit.

| Step | Run on | File | What it proves | Check after |
|---|---|---|---|---|
| 0 | **production**, then **staging** | `00-effective-access-READONLY.sql` | The effective privileges of public, anon, authenticated and service_role on all 33 objects in the audit's grants list, ending in one fingerprint row | Keep both outputs. Staging should differ from production only on the 25 objects the audit listed as looser and on the 8 objects that read ABSENT. |
| 0b | staging | `00b-staging-erase-orphans.sql`: section A (read-only), then B, then C (read-only) | Clears 056's six fields on the seed's 400 orphan messages, which are born with no application. Without this, 01's step 0 refuses, because step 7 would leave them unreachable for good. It is an update only, and refuses unless all 400 rows are the seed's ids with the seed's own address and subject | Section C: 0 orphans with an address, 400 erased, 400 kept. Then re-run `01` section A: `orphan_messages_with_address` 0, `orphan_sweepable_bells` 0 |
| 1a | staging | `01`, section A (read-only) | Staging has no orphaned rows that step 7 would refuse, no triggers on the two tables, no 056 leftovers, and that this is staging | Every expected value in the row. Any orphan count above 0 is a **STOP**: see "Needs a decision". |
| 1b | staging | `01`, section B | 056's schema is on staging, without the production sweep | The after-checks at the end of `01`; then `00`, where 056's 7 objects now read the same as production |
| 2 | staging | `02`: BEFORE, then 057 as written, then AFTER | 057 is on staging, with every existing removed row stamped | AFTER: column, trigger `O`, CHECK, `removed_unstamped` 0, `others_stamped` 0 |
| 3 | staging | `03`: BEFORE, then 058 as written, then AFTER | 058 is on staging | AFTER: column `timestamp with time zone, YES, NULL`, `has_comment` true |
| 4 | staging | `04-staging-grants.sql` | The 25 grant rows equal production's, asserted inside the transaction | `00` on staging: the **fingerprint equals production's** |
| 5 | staging | a fresh staging dump, then the #68 comparison again | Staging's schema equals production's | **0 differences**, except `live_interview_scores_skipped`, whose CHECK differs only in brackets (043:58) and has the same logic |

Steps 1 to 4 touch different objects and could run in any order. They are numbered in migration order so that the record of each one reads the same way production's did. Step 4 can run first if the open grants are the bigger worry.

For step 5, take the staging dump the same way as production's (README-steps.md step 1, with the staging service), into `scripts/staging/.schema/staging-schema.sql`. `scripts/staging/schema-dump.mjs` no longer refuses it as OUTDATED once step 3 has run.

## Not part of this plan

- **017's trigger `interview_sessions_kind_immutable` is NOT included.** It is missing on production too (#103), along with its function (017:44-63). 017's index is not missing: it exists on both databases as `interview_sessions_application_kind_idx`, with the same definition. Migration 060 restores the trigger and function on both databases, staging first.
- **059 goes to staging only after this plan**, following its own staging order (059:448-504), and only with a staging dump that shows 0 differences. 059's own header says applying it opens a new, recorded staging-versus-production difference (059:11-16).
- **Staging's 1,400 interview sessions, all with `delete_after` NULL** (staging data check, 14 Nov 2026), are a separate seed decision. No file here reads or writes session rows.
- The other early gaps that are **identical on both** databases are not differences, so they are left alone: `saved_profiles_candidate_id_idx` (003:25), two `hire_requests` insert policies (006:72, :75) and `idx_talent_profiles_public_visible` (014:46).
- Production's 52 tables that still grant anon and authenticated ALL behind RLS. See the end of `05`.

## Needs a decision (Waleed)

1. **Orphans on staging.** If section A of `01` shows orphaned messages with an address, or orphaned sweepable bells, `01` refuses, by design. Step 7 must not be removed. The choice is either to clear those seeded rows the way production's step 6 did (staging's own counts and a staging user id), or to delete them as seed data. That is a staging data change, and it belongs in a separate file.
2. **Code already ahead of staging's schema.** The code on main already uses 057's column (`src/app/ai-dashboard/accept/actions.ts:221`, `:244`) and 056's functions (`src/lib/erasure/orphan-sweep.ts:16-17`). If staging runs that code today, those paths fail until steps 1 and 2. No code uses 058's column yet (searched `src/`, 14 Nov 2026). Which commit staging is running is UNPROVEN.
3. **Step 4 may break a staging path that relied on the anon grant.** Production already works without these grants, so this is unlikely, but only exercising the staging app after step 4 proves it.
4. **`05`'s revoke as a numbered migration:** whether, and which number.
