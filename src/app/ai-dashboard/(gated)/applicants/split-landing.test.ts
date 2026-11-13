/**
 * resolveSplitLandingJob (commit 8): which job the Split list lands on when
 * the URL names none. Runs the real server action against a fake database.
 *
 *   node --test "src/app/ai-dashboard/(gated)/applicants/split-landing.test.ts"
 *
 * Order: a deep-linked applicant's own job; else the OPEN job (status open,
 * not archived; on_hold does not count) with the newest application; else the
 * job with the newest application of any status; else the newest open job,
 * else the newest job; null with no jobs. Every read is company-scoped, and a
 * job-scoped role only ever lands on its own jobs. Synthetic data.
 */
// @ts-nocheck - same reason as the other node:test files here: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../../../test-support/applicants-test-hook.mjs", import.meta.url));

const { fakeService } = await import("../../../../test-support/fake-postgrest.mjs");
const { resolveSplitLandingJob } = await import("./actions.ts");

const CO = "c0000000-0000-0000-0000-000000000001";
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const OPEN_OLD = id(1);
const OPEN_NEW = id(2);
const CLOSED = id(3);
const HOLD = id(4);
const ARCHIVED = id(5);
const APP = (n) => id(100 + n);

const owner = {
  companyId: CO,
  role: "owner",
  memberId: "m-1",
  memberName: "Test Owner",
  user: { id: "u-1" },
  company: { name: "Example" },
};
const recruiter = { ...owner, role: "recruiter", memberId: "m-2" };

function world({ jobs, apps, team = [] }) {
  return (table, calls) => {
    const eq = (col) => calls.find((c) => c[0] === "eq" && c[1] === col)?.[2];
    const inn = (col) => calls.find((c) => c[0] === "in" && c[1] === col)?.[2];
    if (table === "job_hiring_team")
      return { data: team.map((job_id) => ({ job_id })), error: null };
    if (table === "jobs") {
      const ids = inn("id");
      const rows = jobs.filter((j) => !ids || ids.includes(j.id));
      return {
        data: rows.slice().sort((a, b) => b.created_at.localeCompare(a.created_at)),
        error: null,
      };
    }
    if (table === "job_applications") {
      const one = eq("id");
      if (one) {
        const a = apps.find((x) => x.id === one);
        return { data: a ? { job_id: a.job_id } : null, error: null };
      }
      const ids = inn("job_id") ?? [];
      const hit = apps
        .filter((a) => ids.includes(a.job_id))
        .sort((x, y) => y.created_at.localeCompare(x.created_at))[0];
      return { data: hit ? { job_id: hit.job_id } : null, error: null };
    }
    return { data: null, error: null };
  };
}

const JOBS = [
  { id: OPEN_OLD, status: "open", archived_at: null, created_at: "2026-01-01" },
  { id: OPEN_NEW, status: "open", archived_at: null, created_at: "2026-03-01" },
  { id: CLOSED, status: "closed", archived_at: null, created_at: "2026-02-01" },
  { id: HOLD, status: "on_hold", archived_at: null, created_at: "2026-04-01" },
  { id: ARCHIVED, status: "open", archived_at: "2026-05-01", created_at: "2026-05-01" },
];

async function run(ctx, w, applicantId = null) {
  const service = fakeService(world(w));
  globalThis.__applicantsServiceForTests = () => service;
  globalThis.__applicantsCtxForTests = ctx;
  const quiet = console.error;
  console.error = () => {};
  try {
    return { job: await resolveSplitLandingJob(applicantId), service };
  } finally {
    console.error = quiet;
  }
}

test("the open job with the newest application wins, even over newer closed, on_hold and archived ones", async () => {
  const apps = [
    { id: APP(1), job_id: OPEN_OLD, created_at: "2026-06-03" },
    { id: APP(2), job_id: OPEN_NEW, created_at: "2026-06-01" },
    { id: APP(3), job_id: CLOSED, created_at: "2026-06-09" },
    { id: APP(4), job_id: HOLD, created_at: "2026-06-09" },
    { id: APP(5), job_id: ARCHIVED, created_at: "2026-06-09" },
  ];
  assert.equal((await run(owner, { jobs: JOBS, apps })).job, OPEN_OLD);
});

test("a deep-linked applicant lands on their own job, open or not", async () => {
  const apps = [
    { id: APP(1), job_id: OPEN_NEW, created_at: "2026-06-09" },
    { id: APP(2), job_id: CLOSED, created_at: "2026-06-01" },
  ];
  assert.equal((await run(owner, { jobs: JOBS, apps }, APP(2))).job, CLOSED);
});

test("an unknown or malformed applicant id falls through to the default", async () => {
  const apps = [{ id: APP(1), job_id: OPEN_NEW, created_at: "2026-06-09" }];
  assert.equal((await run(owner, { jobs: JOBS, apps }, APP(9))).job, OPEN_NEW);
  assert.equal((await run(owner, { jobs: JOBS, apps }, "not-a-uuid")).job, OPEN_NEW);
});

test("no open job with applications: the newest application of any status", async () => {
  const jobs = JOBS.filter((j) => j.id !== OPEN_OLD && j.id !== OPEN_NEW);
  const apps = [
    { id: APP(1), job_id: CLOSED, created_at: "2026-06-01" },
    { id: APP(2), job_id: HOLD, created_at: "2026-06-05" },
  ];
  assert.equal((await run(owner, { jobs, apps })).job, HOLD);
});

test("no applications at all: the newest open job, else the newest job; no jobs: null", async () => {
  assert.equal((await run(owner, { jobs: JOBS, apps: [] })).job, OPEN_NEW);
  const closedOnly = JOBS.filter((j) => j.id === CLOSED || j.id === HOLD);
  assert.equal((await run(owner, { jobs: closedOnly, apps: [] })).job, HOLD);
  assert.equal((await run(owner, { jobs: [], apps: [] })).job, null);
});

test("a job-scoped role lands only on its own jobs, even for a deep link elsewhere", async () => {
  const apps = [
    { id: APP(1), job_id: OPEN_OLD, created_at: "2026-06-09" },
    { id: APP(2), job_id: OPEN_NEW, created_at: "2026-06-01" },
  ];
  const w = { jobs: JOBS, apps, team: [OPEN_NEW] };
  assert.equal((await run(recruiter, w)).job, OPEN_NEW);
  assert.equal(
    (await run(recruiter, w, APP(1))).job,
    OPEN_NEW,
    "not the deep-linked applicant's out-of-scope job",
  );
  assert.equal(
    (await run(recruiter, { jobs: JOBS, apps, team: [] })).job,
    null,
    "on no team: nothing",
  );
});

test("every read is scoped to the company", async () => {
  const apps = [{ id: APP(1), job_id: OPEN_NEW, created_at: "2026-06-09" }];
  const { service } = await run(owner, { jobs: JOBS, apps }, APP(1));
  for (const q of service.queries) {
    const col =
      q.table === "jobs" || q.table === "job_hiring_team" ? "company_id" : "company_id_snapshot";
    assert.ok(
      q.calls.some((c) => c[0] === "eq" && c[1] === col && c[2] === CO),
      `${q.table} read without ${col} = company`,
    );
  }
});
