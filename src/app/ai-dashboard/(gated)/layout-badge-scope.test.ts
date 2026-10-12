/**
 * The Messages badge in the gated layout is scoped through the join, not
 * through an application-id allow-list.
 *
 *   node --test "src/app/ai-dashboard/(gated)/layout-badge-scope.test.ts"
 *
 * ── Why this exists ──────────────────────────────────────────
 *
 * The badge used to filter on `.in("application_id", allowedApps)`, where
 * allowedApps was every application id the member could see — unbounded. One
 * uuid costs 39 bytes in a PostgREST query string, so somewhere between 204 and
 * 415 ids the URL crosses a gateway limit and PostgREST answers 414. supabase-js
 * reports that as an `error` beside a null count rather than throwing, and
 * `badgeCount` then renders no badge at all. The failure was silent, and it was
 * on the shared layout, so it would have hit every dashboard route at once.
 *
 * ── What this test can and cannot prove ──────────────────────
 *
 * This reads the layout as SOURCE TEXT. A layout is a server component with a
 * session, a redirect and four concurrent reads; standing a behavioural harness
 * up around it to assert one query shape would cost more than the change. So
 * this pins the STRUCTURE, which is what can silently drift.
 *
 * It does NOT prove the new query returns the same number as the old one. That
 * was established separately, read-only against production: the embed and the
 * `.not("application_id", "is", null)` form both count 146, the 2-job subset
 * counts 40 either way, and widening the join to a LEFT join returns 231 — so
 * the inner join is doing real work. Those numbers are in the Phase 2 report,
 * not reproducible from here, and this file does not claim them.
 *
 * The regexes deliberately scope to the communication_logs block. The Applicants
 * badge right above also filters `.in("job_id", scope.jobIds)`, so a whole-file
 * search for that would pass even with this fix fully reverted.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const layout = readFileSync(new URL("./layout.tsx", import.meta.url), "utf8");

/** Just the Messages badge query — it sits between Applicants and Interviews. */
function logsBlock(): string {
  const start = layout.indexOf('.from("communication_logs")');
  const end = layout.indexOf('.from("interview_sessions")');
  assert.ok(start !== -1, "the Messages badge still reads communication_logs");
  assert.ok(end > start, "the Interviews badge still follows it");
  return layout.slice(start, end);
}

test("SCALE: the Messages badge filters on job id, never on an application-id list", () => {
  const block = logsBlock();

  assert.ok(/job_applications!inner\(/.test(block), "the badge joins job_applications with !inner");
  assert.ok(
    /\.in\(\s*"job_applications\.job_id"/.test(block),
    "a scoped member is narrowed by the jobs they are on, which is bounded",
  );
  assert.ok(
    !/\.in\(\s*"application_id"/.test(block),
    "and NOT by an unbounded application-id list — that is the 414 this fixed",
  );
  assert.ok(
    !/scopedApplicationIds/.test(layout),
    "the layout no longer builds an allow-list at all, so it no longer carries " +
      "the unordered-paging exposure in scopedApplicationIds either",
  );
});

test("CORRECTNESS: the shape that makes the new count equal the old one", () => {
  const block = logsBlock();

  // `!inner` is what replaces the explicit null check: a non-null FK always
  // resolves to a live row, so the inner join keeps exactly the rows the old
  // `.not("application_id", "is", null)` kept. Drop it to a plain embed and
  // PostgREST builds a LEFT join, the embedded filter stops restricting the
  // parent, and the badge counts every log in the company.
  assert.ok(
    /!inner/.test(block),
    "without !inner the embedded job_id filter does not restrict the logs",
  );

  assert.ok(
    /\.eq\(\s*"company_id",\s*ctx\.companyId\s*\)/.test(block),
    "the tenant boundary on the logs themselves is unchanged",
  );
  assert.ok(
    /\.eq\(\s*"job_applications\.company_id_snapshot",\s*ctx\.companyId\s*\)/.test(block),
    "and the join is pinned to the same tenant, as the allow-list query was",
  );
  assert.ok(
    /\.neq\(\s*"status",\s*"cancelled"\s*\)/.test(block),
    "cancelled tombstones stay excluded, or the badge stops matching the page",
  );
  assert.ok(
    /count:\s*"exact"/.test(block) && /head:\s*true/.test(block),
    "still a head count — no rows cross the wire for a badge",
  );
});
