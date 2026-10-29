/**
 * Proves every guard in the staging harness fails when the thing it guards is wrong.
 *
 *   node scripts/staging/negative-controls.mjs
 *
 * Same instrument as scripts/revert-probe-commit2.mjs, pointed at the pure
 * modules this task added and at the two staging-probe routes in src. For each
 * reversion: back up, apply ONE textual
 * change, run the named test file, require it to go RED, require the red output
 * to NAME the test that was supposed to catch it, then restore.
 *
 * ── Why this file exists at all ───────────────────────────────
 *
 * The three suites it drives are themselves negative controls — they feed each
 * assertion the input it exists to reject. So this probe is a control on the
 * controls, and it answers a different question: not "does the assertion throw
 * when I hand it bad data" but "is the assertion still WIRED IN to the code path
 * the harness actually uses". Those come apart. Reversion 7 below is the
 * example: delete the required-chip check and the suite still goes red, but for
 * the wrong reason — a downstream `assertCount` throws instead. Only the
 * expect-string check distinguishes those two, and without it the probe would
 * report a healthy guard.
 *
 * ── Three ways this probe can lie, and what stops each ────────
 *
 *   the suite was already red       → a green baseline is required first
 *   the anchor text has moved       → hits !== 1 is a failure, not a skip
 *   red for an unrelated reason     → the output must contain `expect`
 *
 * The middle one is stricter here than in revert-probe-commit2.mjs, which
 * tolerated multiple hits. An anchor that matches twice is reverting something
 * other than what its name claims, so it cannot be read as evidence either way.
 *
 * This file is a tool, not a test. The suite does not run it.
 */

// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the `from`/`to` strings
// below are SOURCE TEXT to be matched and substituted, not templates to evaluate.
// A `${...}` in them is a literal part of the line being reverted, and
// interpolating it here would mean the anchor no longer matches the file.

import { execFile } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = new URL("../../", import.meta.url);
// fileURLToPath, not .pathname: this checkout's path contains spaces, which a
// URL percent-encodes and fs does not decode.
const p = (rel) => fileURLToPath(new URL(rel, ROOT));

const ASSERT = "scripts/staging/assertions.mjs";
const GUARD = "scripts/staging/guard-checks.mjs";
const GUARD_DB = "scripts/staging/guard-db-checks.mjs";
const PLAN = "scripts/staging/seed-plan.mjs";
const DUMP = "scripts/staging/dump-tools.mjs";
const APP_IDENTITY = "scripts/staging/app-identity.mjs";
const APP_ISOLATION = "scripts/staging/app-isolation.mjs";
const ACCOUNTS = "scripts/staging/accounts.mjs";
const CONSTRAINTS = "scripts/staging/constraints.mjs";
const NETWORK_GUARD = "scripts/staging/network-guard.mjs";
const GUARDED_TEST = "scripts/staging/guarded-test.mjs";
const CONNECTIONS = "src/app/api/staging-probe/_lib/connections.ts";
const CSP = "src/lib/security/csp.ts";
const HARNESS = "scripts/staging/harness.spec.mjs";
const GATE = "src/app/api/staging-probe/_lib/gate.ts";
const ISOLATION_ROUTE = "src/app/api/staging-probe/identity/route.ts";
const SCOPED_ROUTE = "src/app/api/staging-probe/scoped-application-ids/route.ts";
const JOB_SCOPE = "src/app/ai-dashboard/lib/job-scope.ts";
const APPLICANTS_ACTIONS = "src/app/ai-dashboard/(gated)/applicants/actions.ts";
const RESCORE_COLLECT = "src/lib/ai/rescore-collect.ts";
const PAGING = "src/lib/supabase/paging.ts";
const MESSAGES_ACTIONS = "src/app/ai-dashboard/(gated)/messages/actions.ts";

const ASSERT_TEST = "scripts/staging/assertions.test.mjs";
const GUARD_TEST = "scripts/staging/guard-checks.test.mjs";
const GUARD_DB_TEST = "scripts/staging/guard-db-checks.test.mjs";
const PLAN_TEST = "scripts/staging/seed-plan.test.mjs";
const DUMP_TEST = "scripts/staging/dump-tools.test.mjs";
const APP_IDENTITY_TEST = "scripts/staging/app-identity.test.mjs";
const APP_ISOLATION_TEST = "scripts/staging/app-isolation.test.mjs";
const ACCOUNTS_TEST = "scripts/staging/accounts.test.mjs";
const CONSTRAINTS_TEST = "scripts/staging/constraints.test.mjs";
const NETWORK_GUARD_TEST = "scripts/staging/network-guard.test.mjs";
const CSP_TEST = "src/lib/security/csp.test.ts";
const WIRING_TEST = "scripts/staging/harness-wiring.test.mjs";
const PROBE_TEST = "src/app/api/staging-probe/probe.test.ts";
const QUERY_ORDER_TEST = "scripts/staging/query-order.test.mjs";
const RESCORE_COLLECT_TEST = "src/lib/ai/rescore-collect.test.ts";
const PAGING_TEST = "src/lib/supabase/paging.test.ts";

const UNIFORM_JOBS = `  ${Array.from({ length: 20 }, () => 500).join(", ")},`;

/** @type {{name: string, file: string, from: string, to: string, test: string, expect: string}[]} */
const REVERSIONS = [
  /* ── the measurement assertions ─────────────────────────────── */
  {
    name: "the census guard stops rejecting an empty collection",
    file: ASSERT,
    from: "  if (count === 0) {",
    to: "  if (false) {",
    test: ASSERT_TEST,
    expect: "requireFound rejects a locator that matched nothing",
  },
  {
    name: "an empty login-banner read is classified instead of refused",
    file: ASSERT,
    from: "  if (t.length === 0) {",
    to: "  if (false) {",
    test: ASSERT_TEST,
    expect: "classifyLoginRefusal refuses an empty or whitespace-only read",
  },
  {
    name: "a fill that did not land is called filled",
    file: ASSERT,
    from: "  if (actual !== expected) {",
    to: "  if (false) {",
    test: ASSERT_TEST,
    expect: "requireFilled REFUSES a fill that did not land",
  },
  {
    name: "the paging loop goes back to networkidle and re-reads the previous page",
    file: HARNESS,
    from: "    await waitForRowsToMove(page, { scope, attr, before: raw, label });",
    to: '    await page.waitForLoadState("networkidle");',
    test: WIRING_TEST,
    expect: "the paging loop waits for the rows to change after Next",
  },
  /* ── #56/#57: rescoreJob pages by key, and the helper really is keyset ── */
  {
    name: "#56: rescoreJob goes back to an inline offset loop for the applications read",
    file: APPLICANTS_ACTIONS,
    from: "    ids = await collectJobApplicationIds(service, jobId, ctx.companyId);",
    to: '    ids = (\n      await pageAll<{ id: string }>(\n        (from, to) =>\n          service\n            .from("job_applications")\n            .select("id")\n            .eq("job_id", jobId)\n            .eq("company_id_snapshot", ctx.companyId)\n            .order("id")\n            .range(from, to),\n        { scope: "rescore", label: "applications" },\n      )\n    ).map((r) => r.id);',
    test: RESCORE_COLLECT_TEST,
    expect: "pin: rescoreJob collects through collectJobApplicationIds",
  },
  {
    name: "#57: the collection module goes back to offset paging, so an insert before the cursor loses an applicant",
    file: RESCORE_COLLECT,
    from: '  const rows = await pageAllByKey<{ id: string }>(\n    () =>\n      service\n        .from("job_applications")\n        .select("id")\n        .eq("job_id", jobId)\n        .eq("company_id_snapshot", companyId),\n    { scope: "rescore", label: "applications on the job" },\n  );',
    to: '  const rows = await pageAll<{ id: string }>(\n    (from, to) =>\n      service\n        .from("job_applications")\n        .select("id")\n        .eq("job_id", jobId)\n        .eq("company_id_snapshot", companyId)\n        .order("id", { ascending: true })\n        .range(from, to),\n    { scope: "rescore", label: "applications on the job" },\n  );',
    test: RESCORE_COLLECT_TEST,
    expect:
      "#56 → #57: collectJobApplicationIds stays complete when a row is inserted before the cursor",
  },
  {
    name: "#57: pageAllByKey pages by position instead of by the last id seen",
    file: PAGING,
    from: '    if (last !== null) q = q.gt("id", last);',
    to: "    if (last !== null) q = q;",
    test: PAGING_TEST,
    expect: "#57: pageAllByKey returns the complete set under the same insert and delete",
  },
  {
    name: "#57: the allowance read goes back to offset paging",
    file: "src/lib/cv-allowance.ts",
    from: "    const rows = await pageAllByKey<{ id: string; quantity: number | null }>(",
    to: "    const rows = await pageAll<{ id: string; quantity: number | null }>(",
    test: RESCORE_COLLECT_TEST,
    expect: "pin: the allowance read pages usage_events by key",
  },
  /* ── the two query fixes: a total order, pinned to the shipped source ── */
  {
    name: "#25: the allow-list read goes back to .range() with no .order(), so pages can skip and repeat rows",
    file: JOB_SCOPE,
    from: '        .order("id", { ascending: true })\n        .range(from, from + PAGE - 1);',
    to: "        .range(from, from + PAGE - 1);",
    test: QUERY_ORDER_TEST,
    expect: "#25: scopedApplicationIds pages under a total order",
  },
  {
    name: "#23: the messages list goes back to created_at alone, so ties have no order between pages",
    file: MESSAGES_ACTIONS,
    from: '      .order("created_at", { ascending: false })\n      // created_at alone is not a total order',
    to: "      // created_at alone is not a total order",
    test: QUERY_ORDER_TEST,
    expect: "#23: the messages list pages under a total order",
  },
  {
    name: "a paged read with no .order() is called a total order",
    file: ASSERT,
    from: "  if (keys.length === 0) {",
    to: "  if (false) {",
    test: ASSERT_TEST,
    expect: "assertTotalOrder refuses a paged read with no .order() at all",
  },
  {
    name: "a non-unique final key is called a total order",
    file: ASSERT,
    from: "  if (last !== uniqueKey) {",
    to: "  if (false) {",
    test: ASSERT_TEST,
    expect: "assertTotalOrder refuses a final key that is not unique",
  },
  {
    name: "#23's established verdict stops reading the query and assumes the order",
    file: HARNESS,
    from: '      order: provenTotalOrder("messages"),',
    to: '      order: { file: "(assumed)", keys: ["created_at", "id"], line: 0 },',
    test: WIRING_TEST,
    expect: "#23 and #25 report ESTABLISHED from the sweep plus a run-time total-order read",
  },
  {
    name: "a stopped sweep stops saying which page it reached",
    file: HARNESS,
    from: "      `${label}: FAILED AT PAGE ${pageNo} with ${seen.length} id(s) collected over ` +",
    to: "      `${label}: failed. ` +",
    test: WIRING_TEST,
    expect: "a stopped sweep reports the page reached",
  },
  {
    name: "a sweep resumes without limit, so a list that never moves is paged by URL to the end",
    file: HARNESS,
    from: "const MAX_RESUMES = 3;",
    to: "const MAX_RESUMES = 1_000_000;",
    test: WIRING_TEST,
    expect: "a stopped sweep reports the page reached",
  },
  {
    name: "the login retries without limit",
    file: HARNESS,
    from: "const MAX_LOGIN_ATTEMPTS = 2;",
    to: "const MAX_LOGIN_ATTEMPTS = 1_000;",
    test: WIRING_TEST,
    expect: "signIn retries a retryable refusal exactly once",
  },
  {
    name: "the 500-page sweeps go back to a 20-minute budget",
    file: HARNESS,
    from: "  // about 50 minutes, and every resume adds a page. Not 20, and not 60.\n  test.setTimeout(120 * 60_000);\n  await signIn(page);\n  await page.goto(`${BASE}/ai-dashboard/applicants?sort=newest`, {",
    to: "  test.setTimeout(20 * 60_000);\n  await signIn(page);\n  await page.goto(`${BASE}/ai-dashboard/applicants?sort=newest`, {",
    test: WIRING_TEST,
    expect: "the 500-page sweeps have a 120-minute budget",
  },
  {
    name: "the paging loop clicks Next before the button is hydrated",
    file: HARNESS,
    from: "      .poll(() => next.evaluate(isHydrated), {",
    to: "      .poll(() => true, {",
    test: WIRING_TEST,
    expect: "the paging loop waits for the rows to change after Next",
  },
  {
    name: "afterAll asserts the network proof in every restarted worker again",
    file: HARNESS,
    from: "  if (probeRanInThisWorker) guard.assertObserved();",
    to: "  if (true) guard.assertObserved();",
    test: WIRING_TEST,
    expect: "afterAll asserts the network proof only in the worker that ran the probe",
  },
  {
    name: "the job test stops reading the select back",
    file: HARNESS,
    from: "    .toBe(bigJobId);",
    to: "    .toBeDefined();",
    test: WIRING_TEST,
    expect: "the job test filters through the URL and reads the select back",
  },
  {
    name: "signIn goes back to a bare [role=alert], which the dev overlay's empty node satisfies",
    file: HARNESS,
    from: 'const LOGIN_BANNER = "main p[role=alert]";',
    to: 'const LOGIN_BANNER = "[role=alert]";',
    test: WIRING_TEST,
    expect: "signIn reads the login form's OWN banner",
  },
  {
    name: "a fallback passes a PARTIAL attribute rollout",
    // The exact forbidden change: fail only when EVERY row lacks the id, so 19
    // of 20 rows carrying one is measured as a page. Clarification 3 names this.
    file: ASSERT,
    from: "  if (missing > 0) {",
    to: "  if (missing > 0 && missing === values.length) {",
    test: ASSERT_TEST,
    expect: "requireAttribute rejects a PARTIAL attribute rollout",
  },
  {
    name: "comparing against an empty expectation is allowed again",
    file: ASSERT,
    from: "  if (expected.length === 0) {",
    to: "  if (false) {",
    test: ASSERT_TEST,
    expect: "assertSameIdSet rejects an empty EXPECTED set",
  },
  {
    name: "duplicate ids in a paged read go unnoticed",
    file: ASSERT,
    from: "  if (repeated.size > 0) {",
    to: "  if (false) {",
    test: ASSERT_TEST,
    expect: "assertSameIdSet catches a duplicate the counts would hide",
  },
  {
    name: "completeness is decided by row COUNT instead of the id set",
    // Clarification 2, as a single edit. The read and the expectation are the
    // same length, 98 ids match and 2 are strays — numerically identical.
    file: ASSERT,
    from: "  if (missing.length > 0 || extra.length > 0) {",
    to: "  if (actual.length !== expected.length) {",
    test: ASSERT_TEST,
    expect: "assertSameIdSet reports missing and extra separately",
  },
  {
    name: "an unread badge is compared numerically",
    file: ASSERT,
    from: '  if (raw === null || raw === undefined || raw === "") {',
    to: "  if (false) {",
    test: ASSERT_TEST,
    expect: "assertCount refuses to compare an unread badge",
  },
  {
    name: "a chip hidden at zero is summed around",
    // Goes red EITHER way: without this check a downstream assertCount throws
    // on the undefined badge. Only `expect` tells the two apart, which is why
    // the probe matches on the message and not just on the exit code.
    file: ASSERT,
    from: "  if (absent.length > 0) {",
    to: "  if (false) {",
    test: ASSERT_TEST,
    expect: "assertPartsSumToWhole rejects a strip missing a hidden-at-zero chip",
  },
  {
    name: "an unresolved finding needs no closing evidence",
    file: ASSERT,
    from: "  if (!finding || !site || !observed || !toClose) {",
    to: "  if (!finding || !site || !observed) {",
    test: ASSERT_TEST,
    expect: "stillAtRisk refuses to exist without the evidence that would close it",
  },
  {
    name: "a report line prints a whole applicant id",
    file: ASSERT,
    from: '  return typeof id === "string" ? id.slice(-6) : String(id);',
    to: "  return String(id);",
    test: ASSERT_TEST,
    expect: "tail exposes six characters and never a whole id",
  },

  /* ── the staging guard ──────────────────────────────────────── */
  {
    name: "the opt-in accepts any truthy value",
    file: GUARD,
    from: "  if (env[OPT_IN_VAR] !== OPT_IN_VALUE) {",
    to: "  if (!env[OPT_IN_VAR]) {",
    test: GUARD_TEST,
    expect: "checkOptIn rejects absence, emptiness and a near-miss",
  },
  {
    name: "two must-be-absent variables drop out of the map",
    // The test loops over MUST_BE_ABSENT itself, so deleting an entry deletes
    // its own test case. The floor assertion is what notices.
    file: GUARD,
    from: '  "paid model calls": ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"],',
    to: '  "paid model calls": [],',
    test: GUARD_TEST,
    expect: "the map has shrunk unnoticed",
  },
  {
    name: "a present key is no longer treated as present",
    file: GUARD,
    from: '      if (env[v] !== undefined && env[v] !== "") found.push(`${v} (re-enables ${consequence})`);',
    to: "      if (false) found.push(`${v} (re-enables ${consequence})`);",
    test: GUARD_TEST,
    expect: "checkKeysAbsent fires for EVERY variable it claims to cover",
  },
  {
    name: "a missing service key makes the leak scan vacuous",
    file: GUARD,
    from: '  if (!service) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");',
    to: "  if (!service) return;",
    test: GUARD_TEST,
    expect: "checkServiceKeyNotPublic refuses to run with no service key rather than passing",
  },
  {
    name: "the leak scan narrows to a whitelist of known public names",
    file: GUARD,
    from: '    .filter((k) => k.startsWith("NEXT_PUBLIC_"))',
    to: '    .filter((k) => k === "NEXT_PUBLIC_SUPABASE_ANON_KEY")',
    test: GUARD_TEST,
    expect: "checkServiceKeyNotPublic catches it under ANY NEXT_PUBLIC_ name",
  },
  {
    name: "the pin check loses its not-placeholder half, so the shipped file is a pin",
    // The placeholder is hex-shaped on purpose: with a non-hex placeholder this
    // reversion stayed green, because the format half refused it first and the
    // not-placeholder half could not be shown to do anything. Now it can.
    file: GUARD,
    from: " ||\n    value.toLowerCase() === PIN_PLACEHOLDER\n",
    to: "\n",
    test: GUARD_TEST,
    expect: "assertPinIsReal rejects the shipped placeholder",
  },
  {
    name: "the pin check loses its format half, so the word todo is a pin",
    file: GUARD,
    from: "    !PIN_HEX.test(value) ||\n",
    to: "",
    test: GUARD_TEST,
    expect: "assertPinIsReal rejects a non-hex value such as todo",
  },
  {
    name: "any host is accepted as a Supabase project",
    file: GUARD,
    from: '  if (!host.endsWith(".supabase.co") && !host.endsWith(".supabase.in")) {',
    to: "  if (false) {",
    test: GUARD_TEST,
    expect: "projectRef refuses anything that is not a Supabase project host",
  },
  {
    name: "the app/seed parity check is not called",
    file: GUARD,
    from: "  checkAppUrlParity(env);",
    to: "  // checkAppUrlParity(env);",
    test: GUARD_TEST,
    expect: "runPureChecks fails if ANY single check fails",
  },
  {
    name: "a seed of zero jobs is certified as having scoring disabled",
    file: GUARD,
    from: "  if (!Array.isArray(jobRows) || jobRows.length === 0) {",
    to: "  if (false) {",
    test: GUARD_TEST,
    expect: "assertScoringDisabled refuses an empty list rather than finding it clean",
  },

  /* ── the database-backed checks ─────────────────────────────── */
  {
    name: "an EMPTY sentinel table counts as agreement",
    // No row in an empty table disagrees with the pin. This is the same shape
    // as the four vacuous test guards.
    file: GUARD_DB,
    from: "  if (data.length !== 1) {",
    to: "  if (data.length > 1) {",
    test: GUARD_DB_TEST,
    expect: "assertSentinel rejects an EMPTY sentinel table",
  },
  {
    name: "the sentinel is compared against an unvalidated pin",
    file: GUARD_DB,
    from: "    expected = assertPinIsReal(pin);",
    to: '    expected = String(pin?.projectRefSha256 ?? "").toLowerCase();',
    test: GUARD_DB_TEST,
    expect: "assertSentinel refuses an unset pin before it reads anything",
  },
  {
    name: "the PostgREST error is quoted into the message, carrying the project URL",
    file: GUARD_DB,
    from: "      `could not read ${SENTINEL_SCHEMA}.${SENTINEL_TABLE}. On a fresh staging project, ` +",
    to: "      `could not read ${SENTINEL_SCHEMA}.${SENTINEL_TABLE}: ${error.message}. On a fresh staging project, ` +",
    test: GUARD_DB_TEST,
    expect: "assertSentinel does not leak the PostgREST error",
  },
  {
    name: "a NULL row count reads as an empty table",
    // `null > 0` is false, so the seed proceeds against a table it cannot count.
    file: GUARD_DB,
    from: '  if (typeof count !== "number") {',
    to: "  if (false) {",
    test: GUARD_DB_TEST,
    expect: "assertTargetEmpty rejects a NULL count instead of reading it as zero",
  },
  {
    name: "the sentinel is read from PUBLIC, where a restore could have replaced it",
    // The 34th control. A guard that reads public passes against whatever
    // public happens to hold, including a sentinel a restore of public wrote.
    file: GUARD_DB,
    from: "  return client.schema(SENTINEL_SCHEMA);",
    to: "  return client;",
    test: GUARD_DB_TEST,
    expect: "assertSentinel reads the sentinel from the staging_guard schema, never public",
  },
  {
    name: "a non-empty queue after the seed is certified empty",
    file: GUARD_DB,
    from: "  if (count > 0) {",
    to: "  if (false) {",
    test: GUARD_DB_TEST,
    expect: "assertQueueEmpty rejects a non-empty queue",
  },
  {
    name: "a null database size compares as under the quota",
    file: GUARD_DB,
    from: '  if (!row || typeof row.db_bytes !== "number") {',
    to: "  if (!row) {",
    test: GUARD_DB_TEST,
    expect: "assertUsageWithinLimits rejects a null db size instead of reading it as small",
  },
  {
    name: "an unreadable WAL figure is assumed small",
    file: GUARD_DB,
    from: "    if (env[WAL_BY_DASHBOARD_VAR] !== WAL_BY_DASHBOARD_VALUE) {",
    to: "    if (false) {",
    test: GUARD_DB_TEST,
    expect:
      "assertUsageWithinLimits rejects an unreadable WAL figure unless the dashboard is being watched",
  },

  /* ── the seed plan ──────────────────────────────────────────── */
  {
    name: "the jobs go back to an even split",
    file: PLAN,
    from: "  2500, 1500, 1200, 1001, 1000, 999, 800, 500, 250, 120, 60, 30, 17, 11, 7, 3, 1, 1,",
    to: UNIFORM_JOBS,
    test: PLAN_TEST,
    expect: "the job tail brackets the internal page boundary and is not uniform",
  },
  {
    name: "the score mix goes scored-heavy, so NULLS LAST is barely touched",
    file: PLAN,
    from: "export const SCORE_MIX = { skipped: 0.6757, scored: 0.2162, pending: 0.0676, failed: 0.0405 };",
    to: "export const SCORE_MIX = { skipped: 0.05, scored: 0.75, pending: 0.1, failed: 0.1 };",
    test: PLAN_TEST,
    expect: "the score mix is skipped-heavy",
  },
  {
    name: "the cancelled interview chip loses its rows",
    file: PLAN,
    from: 'export const CHIP_STATUSES = ["submitted", "started", "invited", "expired", "cancelled"];',
    to: 'export const CHIP_STATUSES = ["submitted", "started", "invited", "expired"];',
    test: PLAN_TEST,
    expect: "interviews cover all five chip statuses",
  },
  {
    name: "the seventh message status is never seeded",
    file: PLAN,
    from: '  "delivered",\n  "read",\n];',
    to: '  "delivered",\n];',
    test: PLAN_TEST,
    expect: "messages cover all seven statuses and both channels",
  },
  {
    name: "every created_at is unique, so no tie needs breaking",
    file: PLAN,
    from: "        created_at: n < scale.applicationTie ? at(0) : at(n),",
    to: "        created_at: at(n),",
    test: PLAN_TEST,
    expect: "created_at collides on purpose, in both tables",
  },
  {
    name: "ai_cv_scoring_enabled is left NULL instead of explicitly false",
    file: PLAN,
    from: "    ai_cv_scoring_enabled: false,",
    to: "    ai_cv_scoring_enabled: null,",
    test: PLAN_TEST,
    expect: "every job sets ai_cv_scoring_enabled explicitly false, never null",
  },
  {
    name: "no skipped row carries a human adjustment",
    file: PLAN,
    from: '    const adjusted = status === "skipped" && i < scale.skippedWithAdjustment ? tied : null;',
    to: "    const adjusted = null;",
    test: PLAN_TEST,
    expect: "some skipped rows carry a human adjustment",
  },
  {
    name: "the #25 expectation shrinks to one single-row job",
    // It stays a real subset and it still has no duplicates, so only the
    // page-boundary assertion notices. 1 row cannot cross 1,000.
    file: PLAN,
    from: "    scopedApplicationIds: scopedJobIndexes.flatMap((j) => applicationIdsByJob[jobs[j].id]),",
    to: "    scopedApplicationIds: applicationIdsByJob[jobs[16].id],",
    test: PLAN_TEST,
    expect: "the scoped expectation crosses the internal page boundary",
  },
  {
    name: "uuidFrom ignores its label, so every id collides",
    file: PLAN,
    from: 'createHash("sha256").update(`remotiv-staging:${label}`)',
    to: 'createHash("sha256").update("remotiv-staging")',
    test: PLAN_TEST,
    expect: "every application id is unique",
  },
  {
    name: "enrich silently overwrites a field the manifest counts",
    file: PLAN,
    from: "    if (key in row) {",
    to: "    if (false) {",
    test: PLAN_TEST,
    expect: "enrich REFUSES to overwrite a field the manifest counts",
  },
  {
    name: "enrich's presence test becomes a truthiness test, so planned NULLs are overwritten",
    // The subtle half. archived_at is null on 1,250 of the 1,400 sessions, so
    // this reversion still refuses every non-null collision and looks healthy
    // against four of the five keys the test loops over.
    file: PLAN,
    from: "    if (key in row) {",
    to: "    if (row[key]) {",
    test: PLAN_TEST,
    expect: "enrich refuses a NULL the plan deliberately set",
  },
  {
    name: "the jobs rows lose the NOT NULL columns the dump requires",
    // The first jobs insert would fail on location, category, experience_level.
    file: PLAN,
    from: "    ...JOB_REQUIRED,\n",
    to: "",
    test: PLAN_TEST,
    expect: "every NOT NULL jobs column without a default is set by the plan or at insert",
  },
  {
    name: "a NULL pipeline_stage comes back, against a NOT NULL column",
    file: PLAN,
    from: "        pipeline_stage: PIPELINE_STAGES[n % PIPELINE_STAGES.length],",
    to: "        pipeline_stage: n % 11 === 0 ? null : PIPELINE_STAGES[n % PIPELINE_STAGES.length],",
    test: PLAN_TEST,
    expect: "pipeline_stage is NOT NULL in the dump, so no planned stage is NULL",
  },

  /* ── the dump review and strip ──────────────────────────────── */
  {
    name: "the strip writes a restorable file despite a blocking finding",
    // The dangerous one: a webhook trigger restored and fired at a real endpoint.
    file: DUMP,
    from: "  if (blockers.length > 0) return { ok: false, review, blockers };",
    to: "  if (blockers.length > 1_000_000) return { ok: false, review, blockers };",
    test: DUMP_TEST,
    expect: "stripDump REFUSES while a webhook trigger is in the dump",
  },
  {
    name: "the effective_score restore gate is removed from the strip",
    file: DUMP,
    from: "  if (review.effectiveScore.length === 0) blockers.push(EFFECTIVE_SCORE_GATE);\n",
    to: "",
    test: DUMP_TEST,
    expect: "stripDump REFUSES a dump with no effective_score generated column: the restore gate",
  },
  {
    name: "the strip stops removing CREATE SCHEMA public",
    file: DUMP,
    from: "    re: /^CREATE SCHEMA (IF NOT EXISTS )?public;/i,",
    to: "    re: /^NEVER MATCHES$/,",
    test: DUMP_TEST,
    expect: "stripDump removes the three mechanical classes and prepends pg_trgm",
  },
  {
    name: "the review stops recognising a database webhook as outbound",
    file: DUMP,
    from: "  outbound: /supabase_functions|http_request|pg_net|net\\.http|dblink|pg_notify|\\bNOTIFY\\b/i,",
    to: "  outbound: /NEVER_MATCHES_ANYTHING/,",
    test: DUMP_TEST,
    expect: "reviewDump flags a database webhook as blocking, and as a trigger outside public",
  },
  {
    name: "a bare project host outside a URL is printed unmasked",
    file: DUMP,
    from: '    .replace(HOST_RE, "<ref>.supabase.$1");',
    to: ";",
    test: DUMP_TEST,
    expect: "mask hides a Supabase project host and every URL path",
  },
  {
    name: "the strip copies the restrict line into the body a second time",
    // The first restore's failure: \restrict at lines 1 and 5, and psql refuses
    // the second. The position test stayed green through it; only a count fails.
    file: DUMP,
    from: '    if (s.text.startsWith("\\\\")) {\n',
    to: "    if (false) {\n",
    test: DUMP_TEST,
    expect: "stripDump emits EXACTLY ONE restrict and EXACTLY ONE unrestrict line",
  },
  {
    name: "a gist element over a btree type stops needing btree_gist",
    // The second restore failure: "data type uuid has no default operator
    // class for access method gist". With the need switched off the strip
    // writes a file that fails exactly there again.
    file: DUMP,
    from: '      btree_gist: gist.some((g) =>\n        g.elements.some((e) => e.source !== "core" && e.source !== "pg_trgm"),\n      ),',
    to: "      btree_gist: false,",
    test: DUMP_TEST,
    expect: "stripDump prepends btree_gist for that constraint, in public, next to pg_trgm",
  },
  {
    name: "a uuid column in gist is classified as core",
    file: DUMP,
    from: '      source: "btree_gist",\n      reason: `${type} has no gist operator class without btree_gist`,',
    to: '      source: "core",\n      reason: type,',
    test: DUMP_TEST,
    expect:
      "reviewDump resolves the real uuid EXCLUDE USING gist to btree_gist, and the range half to core",
  },
  {
    name: "an unknown operator class stops being a blocking finding",
    file: DUMP,
    from: "  blocking.extension = unknownIndexing.map((reason) => ({ line: 0, preview: reason }));",
    to: "  blocking.extension = [];",
    test: DUMP_TEST,
    expect: "an operator class from no known extension is BLOCKING and the strip refuses",
  },
  {
    name: "the strip silently discards every meta-command again",
    // The previous behaviour: any backslash line vanished without a word.
    file: DUMP,
    from: "      if (META_COMMAND_RE.test(s.text)) continue;\n",
    to: "      continue;\n",
    test: DUMP_TEST,
    expect: "stripDump REFUSES an unexpected psql meta-command",
  },

  /* ── the seed scale ─────────────────────────────────────────── */
  {
    name: "the message count stops scaling, so a 50-row run seeds 6,000 messages",
    // One count only: unscaling everything makes buildPlan throw at module
    // load (1,400 sessions over 50 applications), which is red for no named
    // reason and therefore not evidence.
    file: PLAN,
    from: "    messages: r(MESSAGE_TOTAL),",
    to: "    messages: MESSAGE_TOTAL,",
    test: PLAN_TEST,
    expect: "at 50 applicants every count is scaled",
  },
  {
    name: "the internal page boundary is never reported as NOT COVERED",
    file: PLAN,
    from: "  if (largest <= INTERNAL_PAGE) {",
    to: "  if (false) {",
    test: PLAN_TEST,
    expect: "a 50-applicant plan reports the internal page boundary as NOT COVERED",
  },
  {
    name: "buildPlan accepts a missing applicant count and defaults to something",
    file: PLAN,
    from: "  if (!Number.isInteger(applicants) || applicants <= 0) {",
    to: "  if (false) {",
    test: PLAN_TEST,
    expect: "buildPlan refuses a missing, zero, negative or fractional applicant count",
  },

  /* ── the running app's identity and isolation ───────────────── */
  {
    name: "a 404 from the identity route is no longer a stop",
    // Production answers 404. With this reverted the next check still throws,
    // but the message no longer says PRODUCTION or that no browser is opened.
    file: APP_IDENTITY,
    from: "  if (res.status === 404) {",
    to: "  if (false) {",
    test: APP_IDENTITY_TEST,
    expect: "a 404 is refused with a message that says no browser is opened",
  },
  {
    name: "a hash that differs from the pin is accepted",
    // The connection comparison still catches it, under a different message:
    // the test's expected text then no longer appears, which is the point.
    file: APP_IDENTITY,
    from: '  if (body.projectRefSha256 !== expected) {\n    throw new Error(\n      "THE RUNNING APP',
    to: '  if (false) {\n    throw new Error(\n      "THE RUNNING APP',
    test: APP_IDENTITY_TEST,
    expect: "a hash that differs from the pin is refused as the wrong database",
  },
  {
    name: "an app launched outside the launcher is accepted",
    file: APP_IDENTITY,
    from: '    !iso ||\n    typeof iso !== "object" ||\n    !Array.isArray(iso.checked) ||\n    !Array.isArray(iso.present)\n',
    to: "    false\n",
    test: APP_IDENTITY_TEST,
    expect: "an app launched outside the launcher reports no isolation and is refused",
  },
  {
    name: "a present required-absent variable in the app is accepted",
    file: APP_IDENTITY,
    from: "  if (iso.present.length > 0) {",
    to: "  if (iso.present.length > 1_000_000) {",
    test: APP_IDENTITY_TEST,
    expect: "an app with a required-absent variable PRESENT is refused",
  },
  {
    name: "names from the other env files are no longer locked",
    file: APP_ISOLATION,
    from: "  for (const n of otherFileNames) if (!staging.has(n)) blank.add(n);\n",
    to: "",
    test: APP_ISOLATION_TEST,
    expect: "every name another env file could set, and .env.staging does not, is locked",
  },
  {
    name: "the guard's required-absent names are no longer locked",
    file: APP_ISOLATION,
    from: "  for (const n of mustBeAbsent) blank.add(n);\n",
    to: "",
    test: APP_ISOLATION_TEST,
    expect: "a guard-required-absent name is locked even when no file mentions it",
  },
  {
    name: "the child environment stops carrying the locks",
    file: APP_ISOLATION,
    from: '  for (const n of plan.blank) env[n] = "";\n',
    to: "",
    test: APP_ISOLATION_TEST,
    expect: "childEnv locks each name to the empty string",
  },
  {
    name: "the harness no longer proves the app's identity before the browser opens",
    file: HARNESS,
    from: "  await proveAppIdentity({ baseUrl: BASE, cookie, pin: loadPin(), appUrl: APP_URL });\n",
    to: "",
    test: WIRING_TEST,
    expect: "beforeAll runs the guard, then proves the app's identity, before any test",
  },
  {
    name: "the identity route stops reporting isolation",
    file: ISOLATION_ROUTE,
    from: "    isolation: isolationReport(),",
    to: "    isolation: null,",
    test: PROBE_TEST,
    expect: "identity reports which locked variable NAMES are present",
  },

  /* ── the browser's connection, not only the server's ─────────── */
  {
    name: "a browser public URL on another project is accepted when the server agrees",
    file: APP_IDENTITY,
    from: "  if (c.publicRefSha256 !== expected) {",
    to: "  if (false) {",
    test: APP_IDENTITY_TEST,
    expect: "a browser public URL on another project is refused and NAMED",
  },
  {
    name: "an anon key the project rejects is accepted",
    file: APP_IDENTITY,
    from: "  if (c.anonKeyValid !== true) {",
    to: "  if (false) {",
    test: APP_IDENTITY_TEST,
    expect: "an anon key the project rejects, or one that could not be verified, is refused",
  },
  {
    name: "an app reporting no connections falls OPEN instead of closed",
    file: APP_IDENTITY,
    from: '  if (!c || typeof c !== "object") {',
    to: "  if (false) {",
    test: APP_IDENTITY_TEST,
    expect: "an app that reports no connections at all is refused",
  },
  {
    name: "the route reports the anon key as valid without asking the project",
    file: CONNECTIONS,
    from: "      valid = res.status === 200;",
    to: "      valid = true;",
    test: PROBE_TEST,
    expect: "identity reports the browser's URL and anon key as HASHES",
  },

  /* ── the staging accounts ───────────────────────────────────── */
  {
    name: "an account that already belongs to another company is called free",
    file: ACCOUNTS,
    from: "  if (count > 0) {",
    to: "  if (count > 1_000_000) {",
    test: ACCOUNTS_TEST,
    expect: "assertAccountFree REFUSES an account that already belongs somewhere",
  },
  {
    name: "a first membership outside the fixture is called usable",
    file: ACCOUNTS,
    from: "  if (m.company_id !== fixtureCompanyId) {",
    to: "  if (false) {",
    test: ACCOUNTS_TEST,
    expect: "assertAccountUsable REFUSES a first membership outside the fixture",
  },
  {
    name: "the wrong role is called usable, so #25 would measure an unscoped owner",
    file: ACCOUNTS,
    from: "  if (m.role !== role) {",
    to: "  if (false) {",
    test: ACCOUNTS_TEST,
    expect: "assertAccountUsable REFUSES the wrong role",
  },
  {
    name: "a company that forces a password change is called usable, so every browser login diverts",
    file: ACCOUNTS,
    from: "  if (row.must_change_password === true) {",
    to: "  if (false) {",
    test: ACCOUNTS_TEST,
    expect: "assertAccountUsable REFUSES a fixture company that still forces a password change",
  },
  {
    name: "the usability read takes a different first row than the dashboard does",
    file: ACCOUNTS,
    from: '    .order("created_at", { ascending: true })\n    .order("id", { ascending: true })\n    .limit(1);',
    to: '    .order("id", { ascending: true })\n    .limit(1);',
    test: ACCOUNTS_TEST,
    expect: "assertAccountUsable reads EXACTLY what company-access.ts reads",
  },
  {
    name: "the harness stops proving the accounts usable before the browser opens",
    file: HARNESS,
    from: "    await assertAccountUsable(service, {",
    to: "    await (async () => ({}))({",
    test: WIRING_TEST,
    expect: "beforeAll proves both accounts USABLE the dashboard's way",
  },
  /* ── the enum preflight (CHECK-constraint validation) ────────── */
  {
    name: "the seed goes back to an event value the live constraint rejects",
    // The exact first-50-seed bug: interview_invite / rejection are not in
    // communication_logs_event_check. The preflight must catch it offline.
    file: PLAN,
    from: '  "interview",\n  "rejected",\n',
    to: '  "interview_invite",\n  "rejection",\n',
    test: CONSTRAINTS_TEST,
    expect: "every event value the seed writes is permitted",
  },
  {
    name: "the constraint parser stops reading any enumerated values",
    file: CONSTRAINTS,
    from: "  return values.length > 0 ? [m[1], values] : null;",
    to: "  return null;",
    test: CONSTRAINTS_TEST,
    expect: "the dump carries the communication_logs event and status constraints",
  },
  {
    name: "enumViolations stops reporting out-of-constraint values",
    file: CONSTRAINTS,
    from: "    if (bad.length > 0) violations.push({ column: col, bad, allowed });",
    to: "    if (bad.length > 1_000_000) violations.push({ column: col, bad, allowed });",
    test: CONSTRAINTS_TEST,
    expect: "the earlier, wrong event values WOULD be caught as a violation",
  },

  /* ── the production CSP guard ────────────────────────────────── */
  {
    name: "the CSP admits a second Supabase origin alongside the derived host",
    // The production guard: a staging convenience must not widen production's
    // headers. Admitting a second host makes the "and NOTHING else" assertion fail.
    file: CSP,
    from: "    `connect-src 'self' ${https} ${wss} https://calendly.com https://*.calendly.com`,",
    to: "    `connect-src 'self' ${https} ${wss} https://second-project.supabase.co https://calendly.com https://*.calendly.com`,",
    test: CSP_TEST,
    expect: "PRODUCTION CSP names the production Supabase host and NOTHING else",
  },
  {
    name: "a set staging URL falls back to the production host instead of winning",
    file: CSP,
    from: '  return url && url !== "" ? url : PRODUCTION_SUPABASE_URL;',
    to: "  return PRODUCTION_SUPABASE_URL;",
    test: CSP_TEST,
    expect: "a STAGING url yields the staging host in the CSP and the production host nowhere",
  },

  /* ── the browser network guard ──────────────────────────────── */
  {
    name: "any Supabase project host is approved, not only the one whose ref hashes to the pin",
    file: NETWORK_GUARD,
    from: "  if (m && sha256(m[1].toLowerCase()) === policy.approvedRefSha256) {",
    to: "  if (m) {",
    test: NETWORK_GUARD_TEST,
    expect: "a production-looking project, an unknown project, and the pooler are all forbidden",
  },
  {
    name: "an unapproved Supabase destination is classified other, so it continues to the network",
    file: NETWORK_GUARD,
    from: '    return { kind: "forbidden", masked };\n  }\n  return { kind: "other", masked };',
    to: '    return { kind: "other", masked };\n  }\n  return { kind: "other", masked };',
    test: NETWORK_GUARD_TEST,
    expect: "a production-looking project, an unknown project, and the pooler are all forbidden",
  },
  {
    name: "a WebSocket to the wrong project is connected anyway",
    file: NETWORK_GUARD,
    from: '    if (decide(ws.url(), "websocket") === "abort") {',
    to: "    if (false) {",
    test: NETWORK_GUARD_TEST,
    expect: "a WebSocket to the wrong project is CLOSED, never connected",
  },
  {
    name: "a blocked request no longer fails the run",
    // The sentence in the brief: a request that was successfully blocked must still fail.
    file: NETWORK_GUARD,
    from: "    if (violations.length === 0) return;",
    to: "    return;",
    test: NETWORK_GUARD_TEST,
    expect: "a BLOCKED request still FAILS the run",
  },
  {
    name: "zero observed staging requests passes",
    file: NETWORK_GUARD,
    from: "    if (observed.approvedOk > 0) return;",
    to: "    return;",
    test: NETWORK_GUARD_TEST,
    expect: "ZERO observed successful staging requests is a failure, not a pass",
  },
  {
    name: "a wildcard custom domain is accepted into the allowlist",
    file: NETWORK_GUARD,
    from: "    if (!BARE_HOST_RE.test(d) || /[*/:\\s]/.test(d)) {",
    to: "    if (false) {",
    test: NETWORK_GUARD_TEST,
    expect: "custom domains must be exact bare hostnames",
  },
  {
    name: "a masked violation carries the project ref",
    file: NETWORK_GUARD,
    from: "  if (m) return `<ref>.supabase.${m[2]}`;",
    to: "  if (m) return host;",
    test: NETWORK_GUARD_TEST,
    expect: "masking: no ref, no custom domain, no query string, no token ever appears",
  },
  {
    name: "the guarded context no longer intercepts HTTP requests",
    file: GUARDED_TEST,
    from: '      await context.route("**/*", guard.handleRoute);\n',
    to: "",
    test: WIRING_TEST,
    expect: "guarded-test registers interception on the context BEFORE handing it to any page",
  },
  {
    name: "service workers are allowed on the guarded context",
    file: GUARDED_TEST,
    from: '      await use({ ...contextOptions, serviceWorkers: "block" });',
    to: "      await use({ ...contextOptions });",
    test: WIRING_TEST,
    expect: "guarded-test registers interception on the context BEFORE handing it to any page",
  },
  {
    name: "the harness stops failing a test on a forbidden destination",
    file: HARNESS,
    from: "  guard.assertClean(testInfo.title);\n",
    to: "",
    test: WIRING_TEST,
    expect:
      "every test is checked for forbidden destinations, and the run requires observed traffic",
  },
  {
    name: "the launcher stops noticing another dev server in this checkout",
    file: APP_ISOLATION,
    from: "    .filter((l) => l.includes(needle) && /\\bnext\\s+(dev|start)\\b/.test(l))",
    to: "    .filter(() => false)",
    test: APP_ISOLATION_TEST,
    expect: "conflictingDevServers finds a next dev from THIS checkout",
  },
  {
    name: "the harness goes back to driving the admin login form",
    file: HARNESS,
    from: '  await page.locator("#co-email").fill(account.email);',
    to: '  await page.locator("#al-email").fill(account.email);',
    test: WIRING_TEST,
    expect: "pin: signIn drives /ai-dashboard/login and the ids the company form actually renders",
  },

  /* ── the staging-probe routes ───────────────────────────────── */
  {
    name: "the gate reads the session before the sentinel",
    // In production the sentinel read fails; with this order the session was
    // already read, and the 404 no longer means "computed nothing".
    file: GATE,
    from: "  const sentinel = await readSentinel(createServiceClient());\n  if (!sentinel.ok) return sentinel;\n  try {",
    to: "  await getCompanyContext().catch(() => null);\n  const sentinel = await readSentinel(createServiceClient());\n  if (!sentinel.ok) return sentinel;\n  try {",
    test: PROBE_TEST,
    expect: "before the session is read",
  },
  {
    name: "a two-row sentinel passes the gate",
    file: GATE,
    from: 'if (data.length !== 1) return { ok: false, code: "sentinel-count" };',
    to: 'if (data.length < 1) return { ok: false, code: "sentinel-count" };',
    test: PROBE_TEST,
    expect: "a two-row sentinel is refused",
  },
  {
    name: "the gate stops checking the sentinel hash's shape",
    file: GATE,
    from: 'if (typeof row.project_ref_sha256 !== "string" || !HASH.test(row.project_ref_sha256)) {',
    to: 'if (typeof row.project_ref_sha256 !== "string") {',
    test: PROBE_TEST,
    expect: "a sentinel whose hash is not 64 hex characters is refused",
  },
  {
    name: "the gate reports no refusal code, so a 404 is undebuggable again",
    file: GATE,
    from: "  if (code) res.headers.set(REFUSAL_HEADER, code);",
    to: "  if (false) res.headers.set(REFUSAL_HEADER, code);",
    test: PROBE_TEST,
    expect: "a failed sentinel read is a bare 404, code sentinel-unreadable",
  },
  {
    name: "an authenticated-but-no-company refusal is miscoded as unknown",
    // The condition the 50-seed hit. The code is what made it debuggable.
    file: GATE,
    from: '    return e.access.reason === "unauthenticated" ? "unauthenticated" : "no-company";',
    to: '    return "unknown";',
    test: PROBE_TEST,
    expect: "an authenticated user with no company is a 404 with code no-company",
  },
  {
    name: "an unscoped member gets an empty allow-list instead of null",
    // [] and null are different answers: [] filters Messages to nothing.
    file: SCOPED_ROUTE,
    from: "return NextResponse.json({ scoped: false, jobCount: null, ids: null });",
    to: "return NextResponse.json({ scoped: false, jobCount: null, ids: [] });",
    test: PROBE_TEST,
    expect: "an unscoped member gets ids: null, the function's own answer for unrestricted",
  },
];

const FILES = [...new Set(REVERSIONS.map((r) => r.file))];
const TESTS = [...new Set(REVERSIONS.map((r) => r.test))];

/*
 * Asynchronous on purpose (#58). With the synchronous child call the whole
 * control loop was one synchronous block: a SIGINT queued behind it could not
 * run until the loop had finished and process.exit had already won, so Ctrl-C
 * either killed the process mid-control with no handler (the leak) or was
 * ignored for the whole run with one. Awaiting each test run turns the event
 * loop between a control's write and its restore, which is exactly where the
 * handler below must be able to run.
 */
function run(file) {
  return new Promise((resolve) => {
    execFile("node", ["--test", file], { cwd: p("."), encoding: "utf8" }, (err, stdout, stderr) => {
      if (err) resolve({ red: true, out: `${stdout ?? ""}${stderr ?? ""}` });
      else resolve({ red: false, out: stdout });
    });
  });
}

/** A suite that executed nothing exits 0. AGENTS.md: the test count is the evidence. */
function ranSomething(out) {
  const m = out.match(/^# tests (\d+)$/m) ?? out.match(/tests (\d+)/);
  return m ? Number(m[1]) : 0;
}

/*
 * #58: the window between a control's write and its restore. Without this, a
 * Ctrl-C or a crash in that window left a DISABLED guard in the working tree
 * with a .probe-bak beside it, and the next build, test or commit ran against
 * the reverted file. Every exit path now restores and removes the backups:
 * the signals, an uncaught throw, and the normal end. `existsSync` because the
 * normal path removes the backups itself before `exit` fires. Installed BEFORE
 * the backups are taken: a handler only ever runs between synchronous phases,
 * so it can never see a half-written backup, and a signal during the copies
 * finds every backup complete.
 */
const restoreAndClean = () => {
  for (const f of FILES) {
    const bak = `${p(f)}.probe-bak`;
    if (!existsSync(bak)) continue;
    copyFileSync(bak, p(f));
    rmSync(bak);
  }
};
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    restoreAndClean();
    console.log(`\n${signal}: every file restored, backups removed`);
    process.exit(130);
  });
}
process.on("uncaughtException", (err) => {
  restoreAndClean();
  console.error("\nuncaught exception: every file restored, backups removed\n", err);
  process.exit(1);
});
process.on("exit", restoreAndClean);

for (const f of FILES) copyFileSync(p(f), `${p(f)}.probe-bak`);
const restore = () => {
  for (const f of FILES) copyFileSync(`${p(f)}.probe-bak`, p(f));
};

let failures = 0;
for (const t of TESTS) {
  const { red, out } = await run(t);
  const n = ranSomething(out);
  console.log(`${red ? "BASELINE RED " : "baseline green"}  ${t}  [${n} tests]`);
  if (red || n === 0) failures += 1;
}
if (failures > 0) {
  restore();
  for (const f of FILES) rmSync(`${p(f)}.probe-bak`);
  console.log(
    "\nthe suites are not green, or one ran nothing — no reversion below would mean anything",
  );
  process.exit(1);
}

for (const r of REVERSIONS) {
  const src = readFileSync(p(r.file), "utf8");
  const hits = src.split(r.from).length - 1;
  if (hits !== 1) {
    // Zero means the anchor has moved. More than one means the reversion is
    // changing something besides what its name claims. Neither is evidence.
    console.log(`NOT APPLIED     ${r.name}  (${hits} matches in ${r.file}, need exactly 1)`);
    failures += 1;
    continue;
  }

  writeFileSync(p(r.file), src.split(r.from).join(r.to));
  const { red, out } = await run(r.test);
  restore();

  const named = out.includes(r.expect);
  const ok = red && named;
  if (!ok) failures += 1;
  const why = red && !named ? "  (red, but not the expected test)" : "";
  console.log(`${ok ? "RED as required" : "STILL GREEN    "}  ${r.name}${why}`);
}

restore();
for (const f of FILES) rmSync(`${p(f)}.probe-bak`);
console.log(
  failures === 0
    ? `\nall ${REVERSIONS.length} guards discriminate`
    : `\n${failures} of ${REVERSIONS.length} guard(s) did not discriminate`,
);
process.exit(failures === 0 ? 0 : 1);
