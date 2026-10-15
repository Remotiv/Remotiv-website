/**
 * fetchScreeningAnswers — the new read the export depends on — run as shipped
 * against a fake database.
 *
 *   node --test "src/app/ai-dashboard/(gated)/applicants/screening-read-scope.test.ts"
 *
 * ── What this read is, and why it needs its own scope test ───
 *
 * `screening_answers` left the list projection, so the CSV can no longer format
 * a column it already has: it asks for one page of ids. That makes an export
 * button a NEW path to a jsonb column that was previously only reachable
 * through the list, and a new path needs its own tenancy proof rather than
 * inheriting the list's.
 *
 * Three things are asserted here that nothing else can:
 *
 *   1. the company filter is present on the query, and is `company_id_snapshot`
 *      — not a `jobs.company_id` embed, which is a LEFT join and therefore not
 *      a boundary (see job-scope.ts)
 *   2. a job-scoped member's id list narrows the read, and an UNASSIGNED one
 *      gets an empty answer rather than an unfiltered query
 *   3. the cap refuses before a query is issued, so the jsonb cannot be pulled
 *      for the whole table through this action
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
const { fetchScreeningAnswers } = await import("./actions.ts");
const { CSV_EXPORT_MAX } = await import("./csv-export.ts");

const CO = "c0000000-0000-0000-0000-000000000001";
const JOB_MINE = "a0000000-0000-0000-0000-00000000000a";
const JOB_THEIRS = "b0000000-0000-0000-0000-00000000000b";
const ANN = "11111111-1111-1111-1111-111111111111";
const BOB = "22222222-2222-2222-2222-222222222222";

const ctxFor = (role) => ({
  companyId: CO,
  role,
  memberId: "m-1",
  memberName: "Rae Recruiter",
  user: { id: "u-1", email: "rae@acme.test" },
  company: { name: "Acme" },
});

const answer = (id) => ({
  question_id: id,
  question: `Q${id}`,
  type: "numeric",
  essential: false,
  ideal: 5,
  answer: 7,
  matched: true,
});

/**
 * The applicant rows the fake database holds, and who owns them. The responder
 * APPLIES the company and job filters the action sends, so a missing filter
 * shows up as extra rows rather than as a silently identical result.
 */
const ROWS = [
  { id: ANN, company_id_snapshot: CO, job_id: JOB_MINE, screening_answers: [answer("a1")] },
  { id: BOB, company_id_snapshot: CO, job_id: JOB_THEIRS, screening_answers: [answer("b1")] },
];

function run(role, ids, { teamJobs = [JOB_MINE], fail = false, rows = ROWS } = {}) {
  const service = fakeService((table, calls) => {
    if (table === "job_hiring_team") {
      return { data: teamJobs.map((job_id) => ({ job_id })), error: null };
    }
    if (table === "job_applications") {
      if (fail) return { data: null, error: { message: "boom", code: "57014" } };
      const wantCompany = call(calls, "eq")?.[2];
      const wantIds = calls.find((c) => c[0] === "in" && c[1] === "id")?.[2] ?? [];
      const wantJobs = calls.find((c) => c[0] === "in" && c[1] === "job_id")?.[2] ?? null;
      const data = rows
        .filter((r) => r.company_id_snapshot === wantCompany)
        .filter((r) => wantIds.includes(r.id))
        .filter((r) => wantJobs === null || wantJobs.includes(r.job_id))
        .map((r) => ({ id: r.id, screening_answers: r.screening_answers }));
      return { data, error: null };
    }
    throw new Error(`test: unexpected table ${table}`);
  });

  globalThis.__applicantsServiceForTests = () => service;
  globalThis.__applicantsCtxForTests = ctxFor(role);
  const quiet = console.error;
  console.error = () => {};
  return fetchScreeningAnswers(ids)
    .then((read) => ({ read, service }))
    .finally(() => {
      console.error = quiet;
    });
}

/** The job_applications query the action issued, or undefined. */
const appsQuery = (service) => service.queries.find((q) => q.table === "job_applications");

test("the read is narrowed by company_id_snapshot, not by a jobs embed", async () => {
  const { read, service } = await run("owner", [ANN, BOB]);

  assert.equal(read.ok, true);
  const q = appsQuery(service);
  assert.deepEqual(call(q.calls, "eq"), ["eq", "company_id_snapshot", CO]);

  // The projection asks for the jsonb and nothing else — no jobs() embed that
  // would make the company filter land on a LEFT join.
  assert.deepEqual(call(q.calls, "select"), ["select", "id, screening_answers"]);
});

test("an owner gets every id they asked for, across jobs", async () => {
  const { read } = await run("owner", [ANN, BOB]);
  assert.equal(read.ok, true);
  assert.deepEqual(Object.keys(read.value).sort(), [ANN, BOB].sort());
  assert.deepEqual(read.value[ANN], [answer("a1")]);
});

test("a scoped member's read is narrowed to their jobs, and the other id is simply absent", async () => {
  const { read, service } = await run("recruiter", [ANN, BOB], { teamJobs: [JOB_MINE] });

  assert.equal(read.ok, true);
  const q = appsQuery(service);
  assert.deepEqual(
    q.calls.find((c) => c[0] === "in" && c[1] === "job_id"),
    ["in", "job_id", [JOB_MINE]],
  );

  // Bob is on a job this recruiter is not on. He must not come back — and
  // because he is ABSENT rather than empty, buildApplicantsCsv refuses the
  // file instead of exporting him with a blank Screening cell.
  assert.deepEqual(Object.keys(read.value), [ANN]);
  assert.equal(read.value[BOB], undefined);
});

test("an unassigned member gets an empty answer and NO query", async () => {
  const { read, service } = await run("recruiter", [ANN, BOB], { teamJobs: [] });

  assert.equal(read.ok, true);
  assert.deepEqual(read.value, {});
  // Not `.in("job_id", [])` — an empty IN list is the shape that has fallen
  // open elsewhere. No applicants query is issued at all.
  assert.equal(appsQuery(service), undefined);
});

test("over the cap is a refusal, and issues no query", async () => {
  const ids = Array.from({ length: CSV_EXPORT_MAX + 1 }, (_, i) => `id-${i}`);
  const { read, service } = await run("owner", ids);

  assert.equal(read.ok, false);
  assert.equal(appsQuery(service), undefined);
  // Exactly at the cap still works, so the refusal is a cap and not an off-by-one.
  const at = await run("owner", ids.slice(0, CSV_EXPORT_MAX));
  assert.equal(at.read.ok, true);
});

test("no ids is an answer, not a query", async () => {
  const { read, service } = await run("owner", []);
  assert.equal(read.ok, true);
  assert.deepEqual(read.value, {});
  assert.equal(appsQuery(service), undefined);
});

test("a failed read is unavailable, never a partial map", async () => {
  const { read } = await run("owner", [ANN, BOB], { fail: true });

  // The distinction the export turns on. fetchScoreSummaries degrades to a
  // partial map because a missing score legitimately reads as "pending";
  // a missing screening answer has no such equivalent, so this read must not
  // hand back something buildApplicantsCsv could mistake for completeness.
  assert.equal(read.ok, false);
  assert.equal(read.value, undefined);
});

test("a null jsonb reads as an empty answer set, not a missing one", async () => {
  // '[]' and NULL are both legitimate stored states for a job that asked
  // nothing. Either must produce a PRESENT key, or the export would refuse to
  // write a file for a perfectly ordinary page.
  const rows = [{ id: ANN, company_id_snapshot: CO, job_id: JOB_MINE, screening_answers: null }];
  const { read } = await run("owner", [ANN], { rows });

  assert.equal(read.ok, true);
  assert.deepEqual(read.value, { [ANN]: [] });
  assert.ok(ANN in read.value, "the key is present, so the id is not reported missing");
});
