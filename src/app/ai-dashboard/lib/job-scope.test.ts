/**
 * roleAllowsJobAction, called directly (#76): owner and admin pass on role alone
 * and issue no query; a recruiter or hiring manager needs a job_hiring_team row
 * matched on company, job AND member. This file pins that behaviour so the
 * rename (it was canAccessJob) and any later refactor cannot change it silently -
 * every other test that names roleAllowsJobAction only stubs it.
 *
 * The old name survives as a deprecated alias, `export const canAccessJob =
 * roleAllowsJobAction`, because src/lib/interviews/review.ts still imports it and
 * that directory belongs to another session. The last test here pins the alias to
 * the SAME function so it cannot drift into a second implementation.
 *
 *   node --test "src/app/ai-dashboard/lib/job-scope.test.ts"
 *
 * Behaviour only: the real function runs against fake-postgrest.mjs, which
 * records every .from() and every chained filter with its arguments. Filters are
 * recorded, not applied, so the responder below applies the three the function
 * is expected to send; a missing or wrong filter changes the answer.
 */
// @ts-nocheck - same reason as job-scope-cache.test.ts beside this file: Node's
// `.ts` specifier vs this tsconfig, which does not set allowImportingTsExtensions.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../../test-support/applicants-test-hook.mjs", import.meta.url));

const { fakeService } = await import("../../../test-support/fake-postgrest.mjs");
const { roleAllowsJobAction, canAccessJob } = await import("./job-scope.ts");

const CO = "c0000000-0000-0000-0000-000000000001";
const OTHER_CO = "c0000000-0000-0000-0000-000000000002";
const OWN_JOB = "a0000000-0000-0000-0000-00000000000a";
const OTHER_JOB = "a0000000-0000-0000-0000-00000000000b";
const ME = "m-1";
const SOMEONE_ELSE = "m-2";

/** Same shape as job-scope-cache.test.ts. A recruiter unless overridden. */
const ctxFor = (over = {}) => ({
  companyId: CO,
  role: "recruiter",
  memberId: ME,
  memberName: "Rae Recruiter",
  user: { id: "u-1", email: "rae@acme.test" },
  company: { name: "Acme" },
  ...over,
});

/**
 * A fake database holding job_hiring_team rows. The responder honours the
 * company_id, job_id and member_id filters the query carries, and nothing
 * else: a query missing one of them matches more rows than it should, and a
 * query carrying a wrong value matches none.
 */
function install(teamRows) {
  const service = fakeService((table, calls) => {
    if (table !== "job_hiring_team") throw new Error(`test: unexpected table ${table}`);
    const wanted = Object.fromEntries(calls.filter((c) => c[0] === "eq").map((c) => [c[1], c[2]]));
    const matched = teamRows.filter((r) =>
      Object.entries(wanted).every(([column, value]) => r[column] === value),
    );
    // maybeSingle(): one row or null.
    return { data: matched.length === 1 ? { id: matched[0].id } : null, error: null };
  });
  globalThis.__applicantsServiceForTests = () => service;
  return service;
}

/** The eq filters of the one hiring-team query, as { column: value }. */
function filtersOf(service) {
  assert.equal(service.queries.length, 1, "exactly one query was expected");
  const [q] = service.queries;
  assert.equal(q.table, "job_hiring_team");
  return Object.fromEntries(q.calls.filter((c) => c[0] === "eq").map((c) => [c[1], c[2]]));
}

const OWN_TEAM_ROW = { id: "t-1", company_id: CO, job_id: OWN_JOB, member_id: ME };

// ── Site-wide roles: role alone, no query ───────────────────

test("1. an owner passes for a job in ANOTHER company, and .from() is never called", async () => {
  const service = install([]);
  const owner = ctxFor({ role: "owner" });

  assert.equal(await roleAllowsJobAction(owner, OTHER_JOB), true);
  assert.equal(service.queries.length, 0, "an owner's answer must not depend on a read");
});

test("2. an admin passes for a job in ANOTHER company, and .from() is never called", async () => {
  const service = install([]);
  const admin = ctxFor({ role: "admin" });

  assert.equal(await roleAllowsJobAction(admin, OTHER_JOB), true);
  assert.equal(service.queries.length, 0, "an admin's answer must not depend on a read");
});

// ── Scoped roles: one query, three filters, the caller's own values ──

test("3. a recruiter on the team of a job in their OWN company passes, through one query filtered on company, job and member", async () => {
  const service = install([OWN_TEAM_ROW]);

  assert.equal(await roleAllowsJobAction(ctxFor(), OWN_JOB), true);
  assert.deepEqual(filtersOf(service), {
    company_id: CO,
    job_id: OWN_JOB,
    member_id: ME,
  });
});

test("4. a recruiter against a job in ANOTHER company is refused, by the same three filters carrying the caller's own company id", async () => {
  // The other company's team row exists and names this member id. Only the
  // company_id filter stands between the recruiter and a pass, so its VALUE is
  // what is asserted: the refusal must come from the filter, not from an empty table.
  const service = install([{ id: "t-9", company_id: OTHER_CO, job_id: OTHER_JOB, member_id: ME }]);

  assert.equal(await roleAllowsJobAction(ctxFor(), OTHER_JOB), false);
  assert.deepEqual(filtersOf(service), {
    company_id: CO,
    job_id: OTHER_JOB,
    member_id: ME,
  });
});

// ── Negative controls ───────────────────────────────────────

test("5. control for case 1: the same input with the role flipped to recruiter and no team row is FALSE", async () => {
  // If this did not flip, case 1 would not be testing the role branch.
  const service = install([]);

  assert.equal(await roleAllowsJobAction(ctxFor({ role: "recruiter" }), OTHER_JOB), false);
  assert.equal(service.queries.length, 1, "a recruiter's answer comes from a read");
});

test("6. control for case 3: a team row for a DIFFERENT member on the same company and job is not accepted", async () => {
  // If the member_id filter were missing or ignored, this row would match and
  // the result would be true.
  const service = install([
    { id: "t-2", company_id: CO, job_id: OWN_JOB, member_id: SOMEONE_ELSE },
  ]);

  assert.equal(await roleAllowsJobAction(ctxFor(), OWN_JOB), false);
  assert.equal(
    filtersOf(service).member_id,
    ME,
    "the query asked for the caller, not the row's member",
  );
});

test("6b. the same control for the job column: a row for the caller on a DIFFERENT job in the same company is not accepted", async () => {
  const service = install([{ id: "t-3", company_id: CO, job_id: OTHER_JOB, member_id: ME }]);

  assert.equal(await roleAllowsJobAction(ctxFor(), OWN_JOB), false);
  assert.equal(filtersOf(service).job_id, OWN_JOB);
});

test("a hiring manager is scoped exactly like a recruiter: on the team passes, off it is refused, never on role", async () => {
  const onTeam = install([{ ...OWN_TEAM_ROW, member_id: "m-hm" }]);
  assert.equal(
    await roleAllowsJobAction(ctxFor({ role: "hiring_manager", memberId: "m-hm" }), OWN_JOB),
    true,
  );
  assert.equal(onTeam.queries.length, 1);

  const offTeam = install([]);
  assert.equal(
    await roleAllowsJobAction(ctxFor({ role: "hiring_manager", memberId: "m-hm" }), OWN_JOB),
    false,
  );
  assert.equal(offTeam.queries.length, 1);
});

test("an empty job id and a missing member id are refused for a scoped role without a query", async () => {
  // The function's own short-circuit: nothing to look up, so nothing is read,
  // and the answer is the closed one.
  const service = install([OWN_TEAM_ROW]);
  assert.equal(await roleAllowsJobAction(ctxFor(), ""), false);
  assert.equal(await roleAllowsJobAction(ctxFor({ memberId: null }), OWN_JOB), false);
  assert.equal(service.queries.length, 0);
});

// ── The deprecated alias ────────────────────────────────────

test("the deprecated alias canAccessJob IS roleAllowsJobAction (same function object, not a second implementation)", () => {
  assert.equal(typeof roleAllowsJobAction, "function");
  assert.strictEqual(canAccessJob, roleAllowsJobAction);
});
