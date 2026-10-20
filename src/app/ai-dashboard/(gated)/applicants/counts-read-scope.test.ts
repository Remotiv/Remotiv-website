/**
 * fetchApplicantCounts — the ten new head-counts — run as shipped against a
 * fake database.
 *
 *   node --test "src/app/ai-dashboard/(gated)/applicants/counts-read-scope.test.ts"
 *
 * ── Why a page of numbers needs a tenancy test ───────────────
 *
 * Every figure the Applicants page states used to be `array.length` over rows
 * the list had already fetched, so all twenty inherited the list's single
 * company filter. Counting in the database replaces that with TEN new reads,
 * each of which carries its own boundary — and a count leaks differently from
 * a list. A list that over-selects shows you a stranger's name, which is
 * noticeable. A count that over-selects shows you a slightly larger number,
 * which is not noticeable at all.
 *
 * So the fixture is built so that every filter MATTERS. The responder applies
 * the company and job filters the action actually sends, and the rows are
 * arranged so that dropping any one of them changes a number:
 *
 *   - a8 is another company's application, so a missing `company_id_snapshot`
 *     inflates the stage counts
 *   - a9 is another company's application against a job THIS company owns, so
 *     relying on `jobs.company_id` alone — without the embedded snapshot
 *     filter across the !inner join — makes Open roles read 3 instead of 2
 *   - a4..a6 are on a job the recruiter is not on, so a missing job-scope
 *     filter inflates a scoped member's figures
 *
 * The context and the database are fakes (applicants-test-hook.mjs). job-scope
 * is NOT faked: the hiring-team lookup runs for real against the fake rows, so
 * what is tested is the actual role -> scope -> filter chain.
 */
// @ts-nocheck — same reason as the other node:test files here: Node's `.ts`
// specifier vs this tsconfig, which does not set allowImportingTsExtensions.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../../../test-support/applicants-test-hook.mjs", import.meta.url));

const { call, fakeService } = await import("../../../../test-support/fake-postgrest.mjs");
const { countFlaggedApplicants, fetchApplicantCounts } = await import("./actions.ts");
const { PIPELINE_STAGES } = await import("../../lib/applicant-types.ts");

const CO = "c0000000-0000-0000-0000-000000000001";
const CO2 = "c0000000-0000-0000-0000-000000000002";
const J1 = "a0000000-0000-0000-0000-00000000000a";
const J2 = "b0000000-0000-0000-0000-00000000000b";
const J3 = "c0000000-0000-0000-0000-00000000000c";
const J4 = "d0000000-0000-0000-0000-00000000000d";

const NOW = Date.now();
const RECENT = new Date(NOW - 2 * 24 * 60 * 60 * 1000).toISOString();
const OLD = new Date(NOW - 40 * 24 * 60 * 60 * 1000).toISOString();

/**
 * Jobs, with their own `company_id`. J4 belongs to CO — that is the point of
 * it: its only application belongs to CO2, so the two company columns
 * disagree and the Open roles query has to honour the one on the application.
 */
const JOBS = [
  { id: J1, company_id: CO, deleted_at: null },
  { id: J2, company_id: CO, deleted_at: null },
  { id: J4, company_id: CO, deleted_at: null },
  { id: J3, company_id: CO2, deleted_at: null },
];

const APPS = [
  { id: "a1", company_id_snapshot: CO, job_id: J1, pipeline_stage: "applied", created_at: RECENT },
  { id: "a2", company_id_snapshot: CO, job_id: J1, pipeline_stage: "applied", created_at: OLD },
  {
    id: "a3",
    company_id_snapshot: CO,
    job_id: J1,
    pipeline_stage: "screening",
    created_at: RECENT,
  },
  { id: "a4", company_id_snapshot: CO, job_id: J2, pipeline_stage: "applied", created_at: OLD },
  {
    id: "a5",
    company_id_snapshot: CO,
    job_id: J2,
    pipeline_stage: "shortlisted",
    created_at: RECENT,
  },
  { id: "a6", company_id_snapshot: CO, job_id: J2, pipeline_stage: "hired", created_at: OLD },
  // No job at all — a direct-add candidate. Counts in the population, and
  // cannot count as an open role.
  { id: "a7", company_id_snapshot: CO, job_id: null, pipeline_stage: "applied", created_at: OLD },
  { id: "a8", company_id_snapshot: CO2, job_id: J3, pipeline_stage: "applied", created_at: RECENT },
  // CO2's application against CO's job. The Open roles discriminator.
  { id: "a9", company_id_snapshot: CO2, job_id: J4, pipeline_stage: "applied", created_at: OLD },
];

const ctxFor = (role) => ({
  companyId: CO,
  role,
  memberId: "m-1",
  memberName: "Rae Recruiter",
  user: { id: "u-1", email: "rae@acme.test" },
  company: { name: "Acme" },
});

/** Every `.eq(col, val)` on a query, as a map. Two eqs on one chain is normal. */
const eqMap = (calls) =>
  Object.fromEntries(calls.filter((c) => c[0] === "eq").map((c) => [c[1], c[2]]));

const inList = (calls, col) => calls.find((c) => c[0] === "in" && c[1] === col)?.[2];

/**
 * Answer a head-count the way PostgREST does: no rows, a count, no error.
 * `head: true` means `data` is null even on success, so a test that reads
 * `data` here would be testing the fake rather than the action.
 */
const counted = (n) => ({ data: null, count: n, error: null });

function run(
  role,
  query = {},
  {
    teamJobs = [J1],
    scopeFails = false,
    failTable = null,
    failWhen = null,
    apps = APPS,
    jobs = JOBS,
    // Answers a count directly, bypassing the fixture. Consulted first and only
    // when it returns something, so the response-shape tests below can hand back
    // a shape the fixture cannot produce — `count: null` on a 2xx — or throw, and
    // every other test keeps the fixture it was written against. Receives the eq
    // map so a test can single out ONE of the ten.
    override = null,
  } = {},
) {
  const service = fakeService((table, calls) => {
    if (table !== "job_hiring_team" && override) {
      const answer = override(table, eqMap(calls), calls);
      if (answer !== undefined) return answer;
    }

    if (table === "job_hiring_team") {
      if (scopeFails) return { data: null, error: { message: "boom", code: "57014" } };
      return { data: teamJobs.map((job_id) => ({ job_id })), error: null };
    }

    if (table === "job_applications") {
      const eqs = eqMap(calls);
      if (failTable === "job_applications" && (!failWhen || failWhen(eqs, calls))) {
        return { data: null, count: null, error: { message: "boom", code: "57014" } };
      }
      const jobIds = inList(calls, "job_id");
      const rows = apps
        // The tenant boundary. Absent => every company's rows come back, which
        // is what negative control (b) is meant to expose.
        .filter(
          (r) =>
            !("company_id_snapshot" in eqs) || r.company_id_snapshot === eqs.company_id_snapshot,
        )
        .filter((r) => jobIds === undefined || jobIds.includes(r.job_id))
        .filter((r) => !("job_id" in eqs) || r.job_id === eqs.job_id)
        .filter((r) => !("pipeline_stage" in eqs) || r.pipeline_stage === eqs.pipeline_stage)
        .filter((r) => {
          const gte = calls.find((c) => c[0] === "gte" && c[1] === "created_at")?.[2];
          return gte === undefined || r.created_at >= gte;
        });
      return counted(rows.length);
    }

    if (table === "jobs") {
      const eqs = eqMap(calls);
      if (failTable === "jobs") {
        return { data: null, count: null, error: { message: "boom", code: "57014" } };
      }
      const ids = inList(calls, "id");
      const embedCompany = eqs["job_applications.company_id_snapshot"];
      const rows = jobs
        .filter((j) => !("company_id" in eqs) || j.company_id === eqs.company_id)
        .filter((j) => ids === undefined || ids.includes(j.id))
        .filter((j) => !("id" in eqs) || j.id === eqs.id)
        // !inner — a parent row survives only if it has a matching child.
        .filter((j) =>
          apps.some(
            (a) =>
              a.job_id === j.id &&
              (embedCompany === undefined || a.company_id_snapshot === embedCompany),
          ),
        );
      return counted(rows.length);
    }

    throw new Error(`test: unexpected table ${table}`);
  });

  globalThis.__applicantsServiceForTests = () => service;
  globalThis.__applicantsCtxForTests = ctxFor(role);
  const quiet = console.error;
  console.error = () => {};
  return fetchApplicantCounts(query)
    .then((read) => ({ read, service }))
    .finally(() => {
      console.error = quiet;
    });
}

const appQueries = (service) => service.queries.filter((q) => q.table === "job_applications");
const jobsQuery = (service) => service.queries.find((q) => q.table === "jobs");
const teamQueries = (service) => service.queries.filter((q) => q.table === "job_hiring_team");

// ── 1. The numbers themselves ───────────────────────────────

test("an owner's ten figures are counted over the whole company and nothing else", async () => {
  const { read } = await run("owner");

  assert.equal(read.ok, true);
  assert.deepEqual(read.value, {
    stages: {
      applied: 4, // a1 a2 a4 a7
      screening: 1, // a3
      shortlisted: 1, // a5
      interview: 0,
      offer: 0,
      hired: 1, // a6
      rejected: 0,
    },
    // a8 and a9 are CO2's and are absent from every figure above.
    total: 7,
    newThisWeek: 3, // a1 a3 a5
    openRoles: 2, // J1 J2 — not J4, whose only application is CO2's
    /*
     * Equal to `total` HERE and not in general: this read carries no job
     * filter, so the filtered population and the workspace population are the
     * same seven people. They part company in the job-filter tests below, which
     * is the only reason this figure exists — it is what lets an empty Offer tab
     * say "Nothing in this view" instead of telling a company with applicants
     * that it has none.
     *
     * It is its own read rather than a reuse of `total` for the same reason, so
     * it carries its own tenant filter and is asserted by the chain test below.
     */
    grandTotal: 7,
  });
});

test("a recruiter on one job counts that job's population, not the company's", async () => {
  const { read } = await run("recruiter", {}, { teamJobs: [J1] });

  assert.equal(read.ok, true);
  assert.deepEqual(read.value.stages, {
    applied: 2, // a1 a2
    screening: 1, // a3
    shortlisted: 0, // a5 is on J2
    interview: 0,
    offer: 0,
    hired: 0, // a6 is on J2
    rejected: 0,
  });
  assert.equal(read.value.total, 3);
  assert.equal(read.value.newThisWeek, 2); // a1 a3
  assert.equal(read.value.openRoles, 1); // J1
});

test("a hiring manager is scoped by the same chain as a recruiter", async () => {
  // Both are job-scoped roles and nothing branches on which. Asserted rather
  // than assumed, because the figures are the one place a role mix-up would
  // show up as a plausible-looking number instead of an error.
  const mgr = await run("hiring_manager", {}, { teamJobs: [J2] });
  assert.equal(mgr.read.ok, true);
  assert.deepEqual(mgr.read.value.stages, {
    applied: 1, // a4
    screening: 0,
    shortlisted: 1, // a5
    interview: 0,
    offer: 0,
    hired: 1, // a6
    rejected: 0,
  });
  assert.equal(mgr.read.value.total, 3);
  assert.equal(mgr.read.value.openRoles, 1);
});

test("an admin is site-wide, and issues no hiring-team read at all", async () => {
  const { read, service } = await run("admin");
  assert.equal(read.ok, true);
  assert.equal(read.value.total, 7);
  assert.deepEqual(teamQueries(service), []);
  // No job filter on any chain — a site-wide role is not narrowed.
  for (const q of appQueries(service)) {
    assert.equal(inList(q.calls, "job_id"), undefined);
  }
});

test("the job filter narrows WITHIN the scope, never past it", async () => {
  // A recruiter on J1 asking for J2. The `.in()` still applies, so the answer
  // is zero rather than J2's rows.
  const { read, service } = await run("recruiter", { jobId: J2 }, { teamJobs: [J1] });

  assert.equal(read.ok, true);
  assert.equal(read.value.total, 0);
  assert.equal(read.value.openRoles, 0);

  const q = appQueries(service)[0];
  assert.deepEqual(inList(q.calls, "job_id"), [J1], "the scope filter was dropped for the request");
  assert.equal(eqMap(q.calls).job_id, J2);
});

test("an owner's job filter counts that job and only that job", async () => {
  const { read } = await run("owner", { jobId: J2 });
  assert.equal(read.ok, true);
  assert.deepEqual(read.value.stages, {
    applied: 1,
    screening: 0,
    shortlisted: 1,
    interview: 0,
    offer: 0,
    hired: 1,
    rejected: 0,
  });
  assert.equal(read.value.total, 3);
  assert.equal(read.value.openRoles, 1);
});

// ── 2. The tenant boundary, per chain ───────────────────────

test("every applications count carries company_id_snapshot on its own chain", async () => {
  const { service } = await run("owner");

  const queries = appQueries(service);
  // Seven stages, newThisWeek, and grandTotal. `total` is the SUM of the stages
  // rather than a read of its own, so it is not among them.
  assert.equal(queries.length, PIPELINE_STAGES.length + 2);
  for (const q of queries) {
    assert.equal(
      eqMap(q.calls).company_id_snapshot,
      CO,
      "a count was issued without the tenant filter",
    );
  }
});

test("Open roles filters BOTH the job's company and the application's snapshot", async () => {
  const { service } = await run("owner");
  const q = jobsQuery(service);
  const eqs = eqMap(q.calls);

  // jobs.company_id is the parent's own filter. It is NOT the boundary: the
  // join is to applications, whose company can differ (a9), so the snapshot
  // filter has to travel across the embed.
  assert.equal(eqs.company_id, CO);
  assert.equal(eqs["job_applications.company_id_snapshot"], CO);

  // And the embed is inner, or the count would include roles nobody applied to.
  assert.deepEqual(call(q.calls, "select"), [
    "select",
    "id, job_applications!inner(id)",
    { count: "exact", head: true },
  ]);
});

test("a scoped role's figures are narrowed by .in(), on every chain", async () => {
  const { service } = await run("recruiter", {}, { teamJobs: [J1, J2] });

  for (const q of appQueries(service)) {
    assert.deepEqual(inList(q.calls, "job_id"), [J1, J2]);
  }
  assert.deepEqual(inList(jobsQuery(service).calls, "id"), [J1, J2]);
});

test("the scope is resolved ONCE per batch, not once per count", async () => {
  const { service } = await run("recruiter", {}, { teamJobs: [J1] });
  // Nine counts behind one permission lookup. More than one would mean the
  // page's permission cost scaled with the number of figures it displays.
  assert.equal(teamQueries(service).length, 1);
});

// ── 3. Empty is not failed ──────────────────────────────────

test("a member genuinely on no jobs gets true zeros and issues NO count", async () => {
  const { read, service } = await run("recruiter", {}, { teamJobs: [] });

  assert.equal(read.ok, true);
  assert.deepEqual(read.value, {
    stages: {
      applied: 0,
      screening: 0,
      shortlisted: 0,
      interview: 0,
      offer: 0,
      hired: 0,
      rejected: 0,
    },
    total: 0,
    newThisWeek: 0,
    openRoles: 0,
    // A TRUE zero, and the one figure here where that is a substantive claim
    // rather than arithmetic: it is what makes the empty table say "No
    // applicants yet". Correct, because a member on no jobs may see nobody —
    // and distinct from the unreadable-scope test below, where every figure is
    // null precisely because the same sentence must not be stated on no
    // evidence.
    grandTotal: 0,
  });
  // Not `.in("job_id", [])` — an empty IN list is the shape that falls open.
  assert.deepEqual(appQueries(service), []);
  assert.equal(jobsQuery(service), undefined);
});

test("a hiring manager genuinely on no jobs gets the same true zeros", async () => {
  const { read, service } = await run("hiring_manager", {}, { teamJobs: [] });
  assert.equal(read.ok, true);
  assert.equal(read.value.total, 0);
  assert.equal(read.value.stages.applied, 0);
  assert.deepEqual(appQueries(service), []);
});

test("an UNREADABLE scope is unavailable, for both scoped roles, with no count issued", async () => {
  // The pair that makes the test above mean something. Same empty list inside
  // job-scope, two different facts — and the whole reason readJobScope exists.
  for (const role of ["recruiter", "hiring_manager"]) {
    const { read, service } = await run(role, {}, { scopeFails: true });
    assert.equal(read.ok, false, `${role}: a failed scope read produced an answer`);
    assert.equal(read.value, undefined);
    assert.deepEqual(appQueries(service), [], `${role}: counted on an unknown scope`);
    assert.equal(jobsQuery(service), undefined);
  }
});

test("an unreadable scope does not affect a site-wide role", async () => {
  // Owner never reads the hiring team, so a broken table cannot blank their page.
  const { read } = await run("owner", {}, { scopeFails: true });
  assert.equal(read.ok, true);
  assert.equal(read.value.total, 7);
});

// ── 4. Failed is not zero ───────────────────────────────────

test("one failed stage count is null, and takes the total with it", async () => {
  const { read } = await run(
    "owner",
    {},
    {
      failTable: "job_applications",
      failWhen: (eqs) => eqs.pipeline_stage === "screening",
    },
  );

  assert.equal(read.ok, true);
  assert.equal(read.value.stages.screening, null, "a failed count was rendered as a number");
  // The others are unaffected: each has its own request, so one timing out
  // must not take the rest of the hero with it.
  assert.equal(read.value.stages.applied, 4);
  assert.equal(read.value.stages.hired, 1);
  assert.equal(read.value.newThisWeek, 3);
  assert.equal(read.value.openRoles, 2);

  // And NOT 6. A partial sum is a number that looks right and is wrong — the
  // page shows six stage cells with figures above a dashed total, which is
  // the intended appearance.
  assert.equal(read.value.total, null);
});

test("a failed week count is null while every other figure stands", async () => {
  const { read } = await run(
    "owner",
    {},
    {
      failTable: "job_applications",
      failWhen: (_eqs, calls) => calls.some((c) => c[0] === "gte"),
    },
  );

  assert.equal(read.ok, true);
  assert.equal(read.value.newThisWeek, null);
  assert.equal(read.value.total, 7, "the week count is not a term in the total");
  assert.equal(read.value.stages.applied, 4);
});

test("a failed Open roles count is null, not 'no open roles'", async () => {
  const { read } = await run("owner", {}, { failTable: "jobs" });
  assert.equal(read.ok, true);
  assert.equal(read.value.openRoles, null);
  assert.equal(read.value.total, 7);
});

test("every stage failing is still nulls, never an answered 0", async () => {
  const { read } = await run("owner", {}, { failTable: "job_applications" });
  assert.equal(read.ok, true);
  for (const stage of PIPELINE_STAGES) {
    assert.equal(read.value.stages[stage], null, `${stage} came back as a number`);
  }
  assert.equal(read.value.total, null);
  assert.equal(read.value.newThisWeek, null);
  // The batch as a whole is still an answer: Open roles read fine and the page
  // can state it. `unavailable()` is reserved for not knowing the scope.
  assert.equal(read.value.openRoles, 2);
});

test("a count of 0 over readable rows is 0, not null", async () => {
  // The discriminating half. Without it, "failures are null" passes trivially
  // by making every count null.
  const { read } = await run("owner");
  assert.equal(read.value.stages.interview, 0);
  assert.equal(read.value.stages.rejected, 0);
});

// ── 4b. The four response shapes, one test each ─────────────
//
// `{ count, error }` has four reachable combinations and the code used to treat
// two of them identically. Separated so a regression names which one came back.
// The stage is `screening` throughout; the other eight stay on the fixture and
// are asserted alongside, so each test also shows the shape is contained.

test("shape 1 — count: n, error: null — is that number", async () => {
  const { read } = await run(
    "owner",
    {},
    {
      override: (table, eqs) =>
        table === "job_applications" && eqs.pipeline_stage === "screening"
          ? { data: null, count: 41, error: null }
          : undefined,
    },
  );
  assert.equal(read.value.stages.screening, 41);
  assert.equal(read.value.total, 47, "4 + 41 + 1 + 0 + 0 + 1 + 0");
});

test("shape 2 — count: 0, error: null — is 0, and stays 0", async () => {
  // A real zero is a real answer, and this is what stops the fix below from
  // being "make every count unknown".
  const { read } = await run(
    "owner",
    {},
    {
      override: (table, eqs) =>
        table === "job_applications" && eqs.pipeline_stage === "screening"
          ? { data: null, count: 0, error: null }
          : undefined,
    },
  );
  assert.equal(read.value.stages.screening, 0);
  assert.notEqual(read.value.stages.screening, null, "a true zero was folded into unknown");
  assert.equal(read.value.total, 6, "0 is a term in the sum, unlike null");
});

test("shape 3 — count: null, error: null — is UNKNOWN, not 0", async () => {
  /*
   * The case `?? 0` got wrong, and the only one of the four that is silent.
   * postgrest-js derives `count` from the content-range response header and
   * only when the request carried `Prefer: count=`; `error` is set only on a
   * non-2xx. So a 200 whose content-range was stripped or rewritten by a proxy
   * arrives here, and `count ?? 0` published it as a hard zero over a stage
   * that may hold hundreds of people — with nothing on the page looking broken.
   */
  const { read } = await run(
    "owner",
    {},
    {
      override: (table, eqs) =>
        table === "job_applications" && eqs.pipeline_stage === "screening"
          ? { data: null, count: null, error: null }
          : undefined,
    },
  );

  assert.equal(read.ok, true, "a missing count must not fail the whole batch");
  assert.equal(read.value.stages.screening, null, "a missing count was published as a real 0");
  assert.equal(read.value.total, null, "and the total cannot be a sum that is short a stage");
  // Contained: the other eight are unaffected.
  assert.equal(read.value.stages.applied, 4);
  assert.equal(read.value.stages.hired, 1);
  assert.equal(read.value.newThisWeek, 3);
  assert.equal(read.value.openRoles, 2);
});

test("shape 3b — count: NaN — is unknown too, and never the string 'NaN'", async () => {
  // PostgREST answers a content-range of `*` when it cannot supply a total, and
  // parseInt("*") is NaN. countLabel formats with String(), so an unguarded NaN
  // would reach the hero as the literal text "NaN".
  const { read } = await run(
    "owner",
    {},
    {
      override: (table, eqs) =>
        table === "job_applications" && eqs.pipeline_stage === "screening"
          ? { data: null, count: Number.NaN, error: null }
          : undefined,
    },
  );
  assert.equal(read.value.stages.screening, null);
  assert.equal(read.value.total, null);
});

test("shape 4 — count: null, error: set — is unknown, as it always was", async () => {
  const { read } = await run(
    "owner",
    {},
    {
      failTable: "job_applications",
      failWhen: (eqs) => eqs.pipeline_stage === "screening",
    },
  );
  assert.equal(read.value.stages.screening, null);
  assert.equal(read.value.total, null);
  assert.equal(read.value.stages.applied, 4);
});

// ── 4b-ii. The same four shapes on the Flagged badge ────────
//
// countFlaggedApplicants had the identical `count ?? 0` and no test of its own.
// It returns a Read rather than a nullable number, so shape 3 is `unavailable()`
// here where it is `null` above — the same statement in the type that surface
// uses.

/** The Flagged badge's count, with the service answering `answer` for it. */
function runFlagged(answer) {
  const service = fakeService((table) => {
    if (table === "job_hiring_team") return { data: [{ job_id: J1 }], error: null };
    if (table === "job_applications") return answer;
    throw new Error(`test: unexpected table ${table}`);
  });
  globalThis.__applicantsServiceForTests = () => service;
  globalThis.__applicantsCtxForTests = ctxFor("owner");
  const quiet = console.error;
  console.error = () => {};
  return countFlaggedApplicants()
    .then((read) => ({ read, service }))
    .finally(() => {
      console.error = quiet;
    });
}

test("Flagged shape 1 — count: n, error: null — is answered n", async () => {
  const { read } = await runFlagged({ data: null, count: 12, error: null });
  assert.deepEqual(read, { ok: true, value: 12 });
});

test("Flagged shape 2 — count: 0, error: null — is answered 0, not unavailable", async () => {
  // "Nothing is flagged" is an answer the badge is entitled to state.
  const { read } = await runFlagged({ data: null, count: 0, error: null });
  assert.deepEqual(read, { ok: true, value: 0 });
});

test("Flagged shape 3 — count: null, error: null — is UNAVAILABLE, not 0", async () => {
  const { read } = await runFlagged({ data: null, count: null, error: null });
  assert.equal(read.ok, false, "a missing count was answered as 'nothing is flagged'");
});

test("Flagged shape 4 — count: null, error: set — is unavailable, as it always was", async () => {
  const { read } = await runFlagged({ data: null, count: null, error: { message: "boom" } });
  assert.equal(read.ok, false);
});

// ── 4c. A rejection, not an error object ────────────────────

test("one of the ten REJECTS: the other nine stand and nothing throws", async () => {
  /*
   * The ten were a Promise.all holding a Promise.all, so one rejection
   * rejected the inner array, rejected the outer, and threw out of the action —
   * taking nine good figures and the page with it.
   *
   * How reachable is this? Not very: supabase-js answers `{ data, error }`
   * rather than throwing, and postgrest-js converts fetch failure, DNS failure,
   * an AbortError and a malformed JSON body into error RESULTS whenever
   * shouldThrowOnError is false, which is this client's configuration. So the
   * guard is for a future `.throwOnError()`, a client option or a fetch
   * wrapper. Cheap, and the failure it prevents is the whole page.
   */
  let read = null;
  await assert.doesNotReject(async () => {
    ({ read } = await run(
      "owner",
      {},
      {
        override: (table, eqs) => {
          if (table === "job_applications" && eqs.pipeline_stage === "shortlisted") {
            throw new TypeError("fetch failed");
          }
          return undefined;
        },
      },
    ));
  }, "one rejected count threw out of the action");

  assert.equal(read.ok, true);
  assert.equal(read.value.stages.shortlisted, null);
  // The eight that answered, every one of them.
  assert.equal(read.value.stages.applied, 4);
  assert.equal(read.value.stages.screening, 1);
  assert.equal(read.value.stages.interview, 0);
  assert.equal(read.value.stages.offer, 0);
  assert.equal(read.value.stages.hired, 1);
  assert.equal(read.value.stages.rejected, 0);
  assert.equal(read.value.newThisWeek, 3);
  assert.equal(read.value.openRoles, 2);
  assert.equal(read.value.total, null, "a sum missing a stage is not a total");
});

test("the Open roles rejection is contained too, on the outer level", async () => {
  // The inner array is a Promise.all of its own, so the two levels have to be
  // shown separately: this one rejects the OUTER element.
  let read = null;
  await assert.doesNotReject(async () => {
    ({ read } = await run(
      "owner",
      {},
      {
        override: (table) => {
          if (table === "jobs") throw new TypeError("fetch failed");
          return undefined;
        },
      },
    ));
  });

  assert.equal(read.ok, true);
  assert.equal(read.value.openRoles, null);
  assert.equal(read.value.total, 7, "the stage counts are untouched by the outer failure");
  assert.equal(read.value.newThisWeek, 3);
});

test("all ten rejecting is ten nulls, not a thrown page", async () => {
  let read = null;
  await assert.doesNotReject(async () => {
    ({ read } = await run(
      "owner",
      {},
      {
        override: () => {
          throw new TypeError("fetch failed");
        },
      },
    ));
  });

  assert.equal(read.ok, true, "the action still answers — with nothing known");
  for (const stage of PIPELINE_STAGES) {
    assert.equal(read.value.stages[stage], null);
  }
  assert.equal(read.value.total, null);
  assert.equal(read.value.newThisWeek, null);
  assert.equal(read.value.openRoles, null);
  // The one figure here that is not rendered as an em dash. It decides a
  // SENTENCE — "No applicants yet" against "Nothing in this view" — and there
  // is no dash to put in prose, so a 0 would be read as a fact about their
  // pipeline with nothing on screen to qualify it.
  assert.equal(read.value.grandTotal, null);
});

// ── 5. The shape of the reads ───────────────────────────────

test("all ten reads are head-counts: no row is transferred", async () => {
  const { service } = await run("owner");

  const all = [...appQueries(service), jobsQuery(service)];
  assert.equal(all.length, 10);
  for (const q of all) {
    const select = call(q.calls, "select");
    assert.deepEqual(
      select[2],
      { count: "exact", head: true },
      `${q.table}: a count fetched rows instead of counting them`,
    );
  }
});

test("the request count is fixed, and does not grow with the population", async () => {
  // The claim that makes ten queries acceptable: it is ten for an empty
  // company and ten for a large one. A per-applicant or per-job read here
  // would be the thing that turned a count into a latency problem.
  const big = Array.from({ length: 500 }, (_, i) => ({
    id: `big-${i}`,
    company_id_snapshot: CO,
    job_id: i % 2 ? J1 : J2,
    pipeline_stage: PIPELINE_STAGES[i % PIPELINE_STAGES.length],
    created_at: RECENT,
  }));

  const small = await run("owner");
  const large = await run("owner", {}, { apps: [...APPS, ...big] });

  assert.equal(small.service.queries.length, 10);
  assert.equal(large.service.queries.length, 10);
  assert.equal(large.read.value.total, 507);
});

test("no count groups, distinguishes or orders — the figures are plain counts", async () => {
  const { service } = await run("owner");
  for (const q of [...appQueries(service), jobsQuery(service)]) {
    for (const method of ["order", "limit", "range", "group"]) {
      assert.equal(call(q.calls, method), undefined, `${q.table}: unexpected .${method}()`);
    }
  }
});

// ── 6. Open roles keeps today's definition ──────────────────

test("Open roles ignores deleted_at, status and archived_at — today's definition exactly", async () => {
  // Today's figure is the distinct job_ids on the loaded applications, which
  // includes a job since deleted as long as an application still points at it.
  // Preserving that is a decision, not an oversight, so it is pinned: the
  // query must send no such filter.
  const { service } = await run("owner");
  const eqs = eqMap(jobsQuery(service).calls);

  assert.ok(!("deleted_at" in eqs), "a deleted_at filter would change today's number");
  assert.ok(!("status" in eqs));
  assert.ok(!("archived_at" in eqs));
  assert.equal(call(jobsQuery(service).calls, "is"), undefined);
  assert.equal(call(jobsQuery(service).calls, "not"), undefined);
});

test("a soft-deleted job with applications still counts as an open role", async () => {
  // The behavioural half of the pin above. J2 is gone; its applications are
  // not, and they are still in the stage counts, so the role they belong to
  // has to stay in the denominator or the page would describe 7 applicants
  // across 1 role.
  const jobs = JOBS.map((j) => (j.id === J2 ? { ...j, deleted_at: OLD } : j));
  const { read } = await run("owner", {}, { jobs });

  assert.equal(read.value.openRoles, 2);
  assert.equal(read.value.total, 7);
});

test("an applicant with no job counts in the population but not as an open role", async () => {
  // a7 was added by hand and filed under nothing. 7 applicants across 2 roles
  // is correct; 3 roles would be counting a null.
  const { read } = await run("owner");
  assert.equal(read.value.stages.applied, 4, "a7 is in the population");
  assert.equal(read.value.openRoles, 2, "a null job_id was counted as a role");
});
