/**
 * Analytics, #31: job health reads every job it can show, a failed jobs read is
 * unavailable rather than an empty table, and the score map runs at most six
 * reads at once with the same answer.
 *
 *   node --test "src/app/ai-dashboard/(gated)/analytics/job-health-and-scores.test.ts"
 *
 * Drives the real fetchAnalytics. Only the session (applicants-test-hook) and
 * the database are fakes; the database APPLIES eq, in, is(null), gte, every
 * order term and range, and answers head counts, so a capped or unordered read
 * returns what PostgREST would. Each answer waits one turn of the event loop,
 * so requests issued together overlap and the in-flight count is real.
 */
// @ts-nocheck - same reason as overview-counts.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../../../test-support/applicants-test-hook.mjs", import.meta.url));

const { fakeService } = await import("../../../../test-support/fake-postgrest.mjs");
const { fetchAnalytics } = await import("./actions.ts");

const CO = "c0000000-0000-4000-8000-000000000001";
const pad = (n, w = 3) => String(n).padStart(w, "0");
const jobId = (n) => `j${pad(n, 7)}-0000-4000-8000-000000000000`;
const DAY = 86_400_000;
const recent = (i) => new Date(Date.now() - DAY - i * 1000).toISOString();

/* ── a small PostgREST ────────────────────────────────────────── */

function filterOf([method, col, a]) {
  if (method === "eq") return (r) => r[col] === a;
  if (method === "neq") return (r) => r[col] !== a;
  if (method === "in") {
    const set = new Set(a);
    return (r) => set.has(r[col]);
  }
  if (method === "is" && a === null) return (r) => r[col] === null || r[col] === undefined;
  if (method === "gte") return (r) => r[col] !== null && String(r[col]) >= String(a);
  if (method === "lt") return (r) => r[col] !== null && String(r[col]) < String(a);
  return null;
}

function answer(rows, calls) {
  const filters = calls.map(filterOf).filter(Boolean);
  let out = rows.filter((r) => filters.every((f) => f(r)));
  const select = calls.find((c) => c[0] === "select");
  if (select?.[2]?.count === "exact") return { data: null, count: out.length, error: null };
  const orders = calls.filter((c) => c[0] === "order");
  if (orders.length) {
    out = [...out].sort((x, y) => {
      for (const [, col, opts] of orders) {
        const asc = opts?.ascending !== false;
        const a = String(x[col] ?? "");
        const b = String(y[col] ?? "");
        if (a !== b) return (a < b ? -1 : 1) * (asc ? 1 : -1);
      }
      return 0;
    });
  }
  const range = calls.find((c) => c[0] === "range");
  const limit = calls.find((c) => c[0] === "limit");
  // PostgREST's own cap: no read returns more than 1,000 rows.
  const from = range ? range[1] : 0;
  const to = range ? range[2] : Math.min((limit?.[1] ?? 1000) - 1, 999);
  return { data: out.slice(from, to + 1), count: null, error: null };
}

const flight = { now: 0, max: 0, byTable: {} };

/** `fail(table, calls)` answers that request with an error instead. */
function world(tables, { fail = null } = {}) {
  flight.now = 0;
  flight.max = 0;
  flight.byTable = {};
  return fakeService(async (table, calls) => {
    flight.now += 1;
    flight.byTable[table] = Math.max(flight.byTable[table] ?? 0, flight.now);
    flight.max = Math.max(flight.max, flight.now);
    await new Promise((r) => setImmediate(r));
    try {
      if (fail?.(table, calls)) return { data: null, count: null, error: { code: "57014" } };
      return answer(tables[table] ?? [], calls);
    } finally {
      flight.now -= 1;
    }
  });
}

function install(service) {
  globalThis.__applicantsServiceForTests = () => service;
  globalThis.__applicantsCtxForTests = {
    companyId: CO,
    memberId: "m-1",
    role: "owner",
    memberName: "Owner",
    company: { id: CO, name: "Acme" },
  };
}

const app = (id, job, i) => ({
  id,
  company_id_snapshot: CO,
  job_id: job,
  source_detail: null,
  pipeline_stage: "applied",
  created_at: recent(i),
});

/* ── job health past 50 jobs ──────────────────────────────────── */

/**
 * 60 active jobs plus one archived. Jobs 0-49 have one applicant each, the
 * busiest eight (50-57) have 30 down to 23, 58-59 have two. Read in insertion
 * order, an unordered `.limit(50)` returned jobs 0-49, so the table showed
 * one-applicant roles and none of the busy ones. The archived job is the
 * busiest of all and must stay out, as before.
 */
function jobsWorld() {
  const jobs = Array.from({ length: 60 }, (_, n) => ({
    id: jobId(n),
    company_id: CO,
    title: `Role ${pad(n, 2)}`,
    archived_at: null,
    deleted_at: null,
  }));
  jobs.push({
    id: jobId(99),
    company_id: CO,
    title: "Archived",
    archived_at: recent(0),
    deleted_at: null,
  });
  const counts = (n) => (n < 50 ? 1 : n < 58 ? 30 - (n - 50) : n < 60 ? 2 : 40);
  const apps = [];
  for (const n of [...Array(60).keys(), 99]) {
    for (let k = 0; k < counts(n); k++)
      apps.push(app(`a${pad(n)}-${pad(k)}`, jobId(n), apps.length));
  }
  return { jobs, job_applications: apps };
}

// Negative control: put back `.limit(50)` and the busy roles drop out.
test("job health ranks every job with applicants, not an arbitrary 50", async () => {
  const service = world(jobsWorld());
  install(service);
  const result = await fetchAnalytics("90d");
  assert.deepEqual(
    result.jobs.map((j) => j.jobId),
    [50, 51, 52, 53, 54, 55, 56, 57].map(jobId),
    "the eight busiest active roles, busiest first",
  );
  assert.deepEqual(
    result.jobs.map((j) => j.applications),
    [30, 29, 28, 27, 26, 25, 24, 23],
  );
  const asked = service.queries
    .filter((q) => q.table === "jobs")
    .flatMap((q) => q.calls.find((c) => c[0] === "in")?.[2] ?? []);
  assert.equal(new Set(asked).size, 61, "every job with applicants was read, archived included");
  assert.ok(!result.jobs.some((j) => j.jobId === jobId(99)), "and the archived one stays out");
  for (const q of service.queries.filter((x) => x.table === "jobs")) {
    assert.ok(!q.calls.some((c) => c[0] === "limit"), "no cap on the jobs read");
  }
});

// Negative control: ignore the jobs read's error and this resolves with jobs: [].
test("a failed jobs read is unavailable, never an empty table", async () => {
  const service = world(jobsWorld(), { fail: (table) => table === "jobs" });
  install(service);
  await assert.rejects(fetchAnalytics("90d"), /job health: jobs read failed/);
});

/* ── the score map at 10,000 applicants ───────────────────────── */

/**
 * 10,000 applicants on 4 jobs, each scored; a human override on every 7th.
 * Average per job computed independently from the seed.
 */
function scoresWorld() {
  const jobs = [0, 1, 2, 3].map((n) => ({
    id: jobId(n),
    company_id: CO,
    title: `Role ${n}`,
    archived_at: null,
    deleted_at: null,
  }));
  const apps = Array.from({ length: 10_000 }, (_, i) =>
    app(`s${pad(i, 6)}-0000-4000-8000-000000000000`, jobId(i % 4), i),
  );
  const scores = apps.map((a, i) => ({
    id: `score-${pad(i, 6)}`,
    company_id: CO,
    application_id: a.id,
    job_id: a.job_id,
    status: "scored",
    overall_score: 40 + (i % 50),
    human_adjusted_score: i % 7 === 0 ? 90 : null,
    adjusted_at: null,
  }));
  return { jobs, job_applications: apps, application_scores: scores };
}

function expectedAverages(tables) {
  const byJob = new Map();
  for (const s of tables.application_scores) {
    const shown = s.human_adjusted_score ?? s.overall_score;
    const list = byJob.get(s.job_id) ?? [];
    list.push(shown);
    byJob.set(s.job_id, list);
  }
  return new Map(
    [...byJob].map(([job, list]) => [
      job,
      Math.round(list.reduce((sum, v) => sum + v, 0) / list.length),
    ]),
  );
}

// The answer the pool must not change, computed independently from the seed.
test("the score map at 10,000 applicants gives the same per-job averages", async () => {
  const tables = scoresWorld();
  const service = world(tables);
  install(service);
  const result = await fetchAnalytics("90d");
  const chunks = service.queries.filter(
    (q) => q.table === "application_scores" && q.calls.some((c) => c[0] === "in"),
  );
  assert.equal(chunks.length, 50, "10,000 ids in chunks of 200");
  const want = expectedAverages(tables);
  assert.equal(result.jobs.length, 4);
  for (const j of result.jobs) assert.equal(j.avgScore, want.get(j.jobId), j.jobId);
});

/*
 * The pool, measured on the score chunks alone. The agreement read runs beside
 * scoreMap, so the page as a whole can hold six score chunks plus one other
 * read; the chunks themselves never exceed six. Negative control: raise
 * SCORE_READS_IN_FLIGHT and this fails; set it to 1 and it fails too.
 */
test("no more than six score chunks are ever in flight together", async () => {
  const tables = scoresWorld();
  let now = 0;
  let max = 0;
  const service = fakeService(async (table, calls) => {
    const isChunk = table === "application_scores" && calls.some((c) => c[0] === "in");
    if (isChunk) max = Math.max(max, ++now);
    await new Promise((r) => setImmediate(r));
    try {
      return answer(tables[table] ?? [], calls);
    } finally {
      if (isChunk) now -= 1;
    }
  });
  install(service);
  await fetchAnalytics("90d");
  assert.equal(max, 6, `${max} score chunks in flight`);
});
