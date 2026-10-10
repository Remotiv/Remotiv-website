/**
 * Who the Messages composer offers as a recipient, per role.
 *
 *   node --test "src/app/ai-dashboard/(gated)/messages/recipients-scope.test.ts"
 *
 * ── The bug this locks down ──────────────────────────────────
 *
 * fetchRecipients used to narrow with
 *
 *   .in("job_id", recipientScope.scoped ? recipientScope.jobIds : [])
 *
 * and `.in(col, [])` matches NO rows — it does not mean "no filter". Owner and
 * admin are the two roles whose scope is `{ scoped: false }`, so the composer
 * offered them nobody at all while the same page listed their messages and the
 * drawer composer beside it worked. Confirmed in production before the fix: the
 * recipient dropdown held only its placeholder for an owner of a company with
 * 140 applicants.
 *
 * So the assertions are not "does a filter get applied". They are: an unscoped
 * role reaches EVERY applicant in its own company and NOBODY outside it, and a
 * scoped role reaches exactly its assignments. The old line fails the first two
 * tests below.
 *
 * ── What is real here ────────────────────────────────────────
 *
 * fetchRecipients, getJobScope, scopeJobIds and isEmptyScope all run as
 * shipped. Only the session and the database are fakes, so the role -> scope ->
 * filter chain under test is the one that ships. The responder HONOURS the
 * recorded filters (fake-postgrest records rather than applies them), which is
 * what makes an unscoped read distinguishable from an empty one.
 */
// @ts-nocheck — same reason as final-interview-actions.test.ts: Node's `.ts`
// specifier vs this repo's tsconfig, which does not set
// allowImportingTsExtensions. Nothing ships from this file.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../../../test-support/messages-test-hook.mjs", import.meta.url));

const { call, fakeService } = await import("../../../../test-support/fake-postgrest.mjs");
const { fetchRecipients } = await import("./actions.ts");

const CO = "c0000000-0000-0000-0000-000000000001";
const OTHER_CO = "c0000000-0000-0000-0000-000000000002";
const JOB_A = "a0000000-0000-0000-0000-00000000000a";
const JOB_B = "b0000000-0000-0000-0000-00000000000b";
const MEMBER = "11111111-1111-1111-1111-111111111111";

/**
 * Three applicants in our company across two jobs, and one in a different
 * company. The foreign row is the isolation probe: it is returned by the fake
 * only if the code forgot company_id_snapshot, so it must never be offered.
 */
const APPLICANTS = [
  {
    id: "app-a1",
    company_id_snapshot: CO,
    job_id: JOB_A,
    first_name: "Ada",
    last_name: "One",
    email: "ada@example.test",
    job_title_snapshot: "Engineer",
    jobs: { title: "Engineer" },
    created_at: "2026-03-03T00:00:00Z",
  },
  {
    id: "app-a2",
    company_id_snapshot: CO,
    job_id: JOB_A,
    first_name: "Bo",
    last_name: "Two",
    email: "bo@example.test",
    job_title_snapshot: "Engineer",
    jobs: { title: "Engineer" },
    created_at: "2026-03-02T00:00:00Z",
  },
  {
    id: "app-b1",
    company_id_snapshot: CO,
    job_id: JOB_B,
    first_name: "Cy",
    last_name: "Three",
    email: "cy@example.test",
    job_title_snapshot: "Designer",
    jobs: { title: "Designer" },
    created_at: "2026-03-01T00:00:00Z",
  },
  {
    id: "foreign",
    company_id_snapshot: OTHER_CO,
    job_id: "f0000000-0000-0000-0000-00000000000f",
    first_name: "Nope",
    last_name: "Nope",
    email: "nope@other.test",
    job_title_snapshot: "Spy",
    jobs: { title: "Spy" },
    created_at: "2026-03-04T00:00:00Z",
  },
];

const ctxFor = (role) => ({
  companyId: CO,
  role,
  memberId: MEMBER,
  memberName: "Test Member",
  user: { id: "u-1", email: "member@example.test" },
  company: { name: "Acme" },
});

/**
 * Run the real action as `role`, with `assignments` as the hiring-team rows.
 *
 * The responder applies company_id_snapshot and job_id the way the database
 * would, so "no .in() recorded" genuinely yields every company row and the old
 * empty-array form genuinely yields none.
 */
async function recipientsFor(role, assignments = []) {
  const service = fakeService((table, calls) => {
    if (table === "job_hiring_team") {
      return { data: assignments.map((job_id) => ({ job_id })), error: null };
    }
    if (table === "job_applications") {
      const company = call(calls, "eq")?.[2];
      const jobFilter = call(calls, "in");
      let rows = APPLICANTS.filter((r) => r.company_id_snapshot === company);
      if (jobFilter) {
        const allowed = new Set(jobFilter[2]);
        rows = rows.filter((r) => allowed.has(r.job_id));
      }
      return { data: rows, error: null };
    }
    throw new Error(`test: unexpected table ${table}`);
  });

  globalThis.__messagesServiceForTests = () => service;
  globalThis.__messagesCtxForTests = ctxFor(role);
  try {
    return { rows: await fetchRecipients(), service };
  } finally {
    globalThis.__messagesServiceForTests = undefined;
    globalThis.__messagesCtxForTests = undefined;
  }
}

const idsOf = (rows) => rows.map((r) => r.applicationId).sort();

/** The applicants read, or undefined when the code never issued one. */
const applicantQuery = (service) => service.queries.find((q) => q.table === "job_applications");

test("owner sees every applicant in the company", async () => {
  const { rows } = await recipientsFor("owner");
  assert.deepEqual(idsOf(rows), ["app-a1", "app-a2", "app-b1"]);
});

test("admin sees every applicant in the company", async () => {
  const { rows } = await recipientsFor("admin");
  assert.deepEqual(idsOf(rows), ["app-a1", "app-a2", "app-b1"]);
});

test("an unscoped role carries no job filter at all, not an empty one", async () => {
  const { service } = await recipientsFor("owner");
  const q = applicantQuery(service);
  assert.ok(q, "the applicants read must happen for an owner");
  // The regression in one assertion: an `.in()` recorded here with [] is the
  // bug, and `.in()` recorded at all for an unscoped role is wrong.
  assert.equal(call(q.calls, "in"), undefined);
});

test("recruiter sees only applicants on assigned jobs", async () => {
  const { rows } = await recipientsFor("recruiter", [JOB_A]);
  assert.deepEqual(idsOf(rows), ["app-a1", "app-a2"]);
});

test("hiring manager sees only applicants on assigned jobs", async () => {
  const { rows } = await recipientsFor("hiring_manager", [JOB_B]);
  assert.deepEqual(idsOf(rows), ["app-b1"]);
});

test("a scoped role on several jobs sees all of them", async () => {
  const { rows } = await recipientsFor("recruiter", [JOB_A, JOB_B]);
  assert.deepEqual(idsOf(rows), ["app-a1", "app-a2", "app-b1"]);
});

test("a scoped role with no assignments sees nobody, and never queries", async () => {
  const { rows, service } = await recipientsFor("hiring_manager", []);
  assert.deepEqual(rows, []);
  // Fails closed BEFORE the database: the empty scope must not become an
  // unfiltered read, which is the failure mode in the opposite direction.
  assert.equal(applicantQuery(service), undefined);
});

test("no role is offered another company's applicant", async () => {
  for (const role of ["owner", "admin", "recruiter", "hiring_manager"]) {
    const { rows } = await recipientsFor(role, [JOB_A, JOB_B]);
    assert.ok(
      rows.every((r) => r.applicationId !== "foreign"),
      `${role} was offered a foreign-company applicant`,
    );
  }
});

test("every role filters on company_id_snapshot", async () => {
  for (const role of ["owner", "admin", "recruiter", "hiring_manager"]) {
    const { service } = await recipientsFor(role, [JOB_A]);
    const q = applicantQuery(service);
    assert.ok(q, `${role} must issue an applicants read`);
    assert.deepEqual(call(q.calls, "eq"), ["eq", "company_id_snapshot", CO]);
  }
});

test("the recipient picker is still capped at 500", async () => {
  const { service } = await recipientsFor("owner");
  const limit = call(applicantQuery(service).calls, "limit");
  assert.deepEqual(limit, ["limit", 500]);
});
