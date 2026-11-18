/**
 * The Jobs page's applicant counts (#82): one company-filtered count read, a
 * job with no applicants listed with 0, and a failed count never shown as 0.
 *
 *   node --test "src/app/ai-dashboard/(gated)/jobs/applicant-counts.test.ts"
 *
 * fetchCompanyJobs and fetchDeletedCompanyJobs run as shipped. The session is
 * applicants-test-hook's; the database is fake-postgrest.mjs, answering the
 * `job_applications!inner(count)` read the way an INNER join does: a job with
 * no matching application is not returned. Its embedded filters apply only if
 * the code sent them, so a missing company filter counts another company's
 * application on our job. Synthetic data only.
 */
// @ts-nocheck - same reason as overview-counts.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../../../test-support/applicants-test-hook.mjs", import.meta.url));

const { call, fakeService } = await import("../../../../test-support/fake-postgrest.mjs");
const { fetchCompanyJobs, fetchDeletedCompanyJobs } = await import("./actions.ts");

const CO = "c0000000-0000-4000-8000-000000000001";
const OTHER_CO = "c0000000-0000-4000-8000-000000000002";
const MEMBER = "m0000000-0000-4000-8000-000000000001";
const job = (id, extra = {}) => ({
  id,
  company_id: CO,
  title: `Role ${id}`,
  status: "open",
  created_at: `2026-11-0${id.length % 9}T00:00:00.000Z`,
  deleted_at: null,
  ...extra,
});
const JOBS = [
  job("job-a"),
  job("job-b"),
  job("job-zero"),
  job("job-del", { deleted_at: "2026-11-10T00:00:00.000Z" }),
  job("job-del-zero", { deleted_at: "2026-11-11T00:00:00.000Z" }),
  job("job-x", { company_id: OTHER_CO }),
];
const app = (id, job_id, company_id_snapshot = CO) => ({ id, job_id, company_id_snapshot });
const APPS = [
  app("a1", "job-a"),
  app("a2", "job-a"),
  app("a3", "job-a"),
  app("b1", "job-b"),
  app("d1", "job-del"),
  app("d2", "job-del"),
  app("x1", "job-x", OTHER_CO),
  // Another company's application pointing at OUR job: never counted.
  app("drift", "job-a", OTHER_CO),
];

const eqOn = (calls, col) => calls.find((c) => c[0] === "eq" && c[1] === col)?.[2];

/** `failCounts`: the inner-count read answers with an error. */
function world({ teamJobs = null, failCounts = false } = {}) {
  return fakeService((table, calls) => {
    if (table === "job_hiring_team") {
      return { data: (teamJobs ?? []).map((job_id) => ({ job_id })), error: null };
    }
    assert.equal(table, "jobs", `unexpected read of ${table}`);
    let rows = JOBS;
    const co = eqOn(calls, "company_id");
    if (co !== undefined) rows = rows.filter((j) => j.company_id === co);
    if (calls.some((c) => c[0] === "is" && c[1] === "deleted_at" && c[2] === null)) {
      rows = rows.filter((j) => j.deleted_at === null);
    }
    if (calls.some((c) => c[0] === "not" && c[1] === "deleted_at")) {
      rows = rows.filter((j) => j.deleted_at !== null);
    }
    const ids = calls.find((c) => c[0] === "in" && c[1] === "id")?.[2];
    if (ids) rows = rows.filter((j) => ids.includes(j.id));

    if (/job_applications!inner\(count\)/.test(call(calls, "select")?.[1] ?? "")) {
      if (failCounts) return { data: null, error: { code: "57014", message: "timeout" } };
      const embedCo = eqOn(calls, "job_applications.company_id_snapshot");
      const counted = rows
        .map((j) => ({
          id: j.id,
          job_applications: [
            {
              count: APPS.filter(
                (a) =>
                  a.job_id === j.id && (embedCo === undefined || a.company_id_snapshot === embedCo),
              ).length,
            },
          ],
        }))
        .filter((r) => r.job_applications[0].count > 0);
      return { data: counted, error: null };
    }
    return { data: rows, error: null };
  });
}

function install(service, role = "owner") {
  globalThis.__applicantsServiceForTests = () => service;
  globalThis.__applicantsCtxForTests = {
    companyId: CO,
    memberId: MEMBER,
    role,
    memberName: "Member",
    company: { id: CO, name: "Acme" },
  };
}
const countsOf = (read) => Object.fromEntries(read.value.map((j) => [j.id, j.applicant_count]));
const countReads = (svc) =>
  svc.queries.filter((q) => /!inner\(count\)/.test(call(q.calls, "select")?.[1] ?? ""));

// Negative control: drop the embedded company filter and job-a counts 4.
test("live jobs: each counted once, a job with no applicants listed with 0, another company's application not counted", async () => {
  const svc = world();
  install(svc);
  const read = await fetchCompanyJobs();
  assert.equal(read.ok, true);
  assert.deepEqual(countsOf(read), { "job-a": 3, "job-b": 1, "job-zero": 0 });
  assert.equal(countReads(svc).length, 1, "one count read, whatever the number of jobs");
  assert.equal(
    svc.queries.filter((q) => q.table === "job_applications").length,
    0,
    "no per-job head count is left",
  );
  const [counted] = countReads(svc);
  assert.equal(eqOn(counted.calls, "job_applications.company_id_snapshot"), CO);
  assert.equal(eqOn(counted.calls, "company_id"), CO);
});

test("deleted view: deleted jobs only, counted, the empty one listed with 0", async () => {
  install(world());
  const read = await fetchDeletedCompanyJobs();
  assert.equal(read.ok, true);
  assert.deepEqual(countsOf(read), { "job-del": 2, "job-del-zero": 0 });
});

// Negative control: drop `if (scope.scoped) q = q.in("id", scope.jobIds)` from the count read.
test("a recruiter's list and its count read are both narrowed to their jobs", async () => {
  const svc = world({ teamJobs: ["job-a"] });
  install(svc, "recruiter");
  const read = await fetchCompanyJobs();
  assert.deepEqual(countsOf(read), { "job-a": 3 });
  const [counted] = countReads(svc);
  assert.deepEqual(counted.calls.find((c) => c[0] === "in" && c[1] === "id")?.[2], ["job-a"]);
});

// Negative control: catch the failure and return an empty Map, and both views answer with zeros.
test("a failed count read makes the whole list unavailable, never a list of zeros", async () => {
  const saved = console.error;
  console.error = () => {};
  try {
    install(world({ failCounts: true }));
    assert.deepEqual(await fetchCompanyJobs(), { ok: false });
    install(world({ failCounts: true }));
    assert.deepEqual(await fetchDeletedCompanyJobs(), { ok: false });
  } finally {
    console.error = saved;
  }
});
