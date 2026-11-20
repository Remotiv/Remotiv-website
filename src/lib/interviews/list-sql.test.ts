/**
 * #41 part 2: the Interviews list counts and pages in SQL, so its cost no
 * longer grows with the company's interviews; the review page reads in two
 * parallel waves after the session read.
 *
 *   node --test src/lib/interviews/list-sql.test.ts
 *
 * listInterviewSessions and loadInterviewSession run as shipped against a
 * fake database that applies every filter they send (interview-list-fake.mjs)
 * and records each request, its rows, and how many were in flight at once.
 * Measured on staging (1,400 sessions): the old read moved 639 KB in two
 * sequential 1,000-row pages on every tab click; the new one 11 KB in two
 * waves; the review page went from a median 8.0 s to 2.85 s. Synthetic data.
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { mock, test } from "node:test";

register(new URL("../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../test-support/messages-test-hook.mjs", import.meta.url));

const { call, fakeService } = await import("../../test-support/fake-postgrest.mjs");
const { answerSessions } = await import("../../test-support/interview-list-fake.mjs");
const { listInterviewSessions, loadInterviewSession } = await import("./review.ts");

console.error = () => {};
const NOW = Date.parse("2026-11-03T12:00:00.000Z");
mock.timers.enable({ apis: ["Date"], now: NOW });
const DAY = 86_400_000;
const CO = "c0000000-0000-4000-8000-0000000000e1";
const OTHER = "c0000000-0000-4000-8000-0000000000e2";
const JOB = "b0000000-0000-4000-8000-0000000000e1";
const ctx = { companyId: CO, role: "owner", memberId: "m-1", user: { id: "u-1" } };
const iso = (ms) => new Date(ms).toISOString();
const pad = (i) => String(i).padStart(12, "0");

function sessions(n, company = CO) {
  return Array.from({ length: n }, (_, i) => ({
    id: `5e55${company.slice(-4)}-0000-4000-8000-${pad(i)}`,
    company_id: company,
    application_id: `a0000000-0000-4000-8000-${pad(i)}`,
    job_id: JOB,
    kind: "async",
    status: ["submitted", "started", "invited", "expired", "cancelled"][i % 5],
    started_at: null,
    submitted_at: null,
    expires_at: iso(NOW + (i % 7 === 0 ? -DAY : DAY)),
    delete_after: iso(NOW + 100 * DAY),
    invited_by_name: null,
    questions_snapshot: [{ id: "q0" }, { id: "q1" }],
    archived_at: i % 11 === 0 ? iso(NOW - DAY) : null,
    created_at: iso(NOW - i * 1000),
    previous_attempt_id: null,
  }));
}

/** The database, recording every interview_sessions request and the rows it returned. */
function world(rows) {
  const log = [];
  let inFlight = 0;
  let peak = 0;
  globalThis.__messagesServiceForTests = () =>
    fakeService(async (table, calls) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      if (table === "interview_sessions") {
        const out = answerSessions(rows, calls);
        log.push({ calls, rows: Array.isArray(out.data) ? out.data.length : out.data ? 1 : 0 });
        return out;
      }
      if (table === "interview_answers") return { data: [], count: 0, error: null };
      if (call(calls, "maybeSingle")) return { data: null, error: null };
      return { data: [], error: null };
    });
  return { log, peak: () => peak };
}

const selects = (calls) => String(call(calls, "select")?.[1] ?? "");

test("L1. without a search, no read brings more than one page of sessions, at 100 or 10,000", async () => {
  const shape = [];
  for (const n of [100, 10_000]) {
    const w = world(sessions(n));
    const result = await listInterviewSessions(ctx, { status: "all", page: 3 });
    assert.equal(result.ok, true, `${n}`);
    assert.ok(
      w.log.every((q) => q.rows <= 20),
      `${n}: a read returned ${Math.max(...w.log.map((q) => q.rows))} rows`,
    );
    // Only the visible page's read carries the questions snapshots.
    const withSnapshots = w.log.filter((q) => selects(q.calls).includes("questions_snapshot"));
    assert.equal(withSnapshots.length, 1, `${n}: one read selects questions_snapshot`);
    assert.ok(call(withSnapshots[0].calls, "range"), `${n}: and it is ranged to the page`);
    shape.push(w.log.length);
  }
  assert.equal(shape[0], shape[1], "the same requests whatever the company's size");
});

test("L2. the counts and the page are the company's and agree with deriveStatus", async () => {
  const mine = sessions(300);
  world([...mine, ...sessions(50, OTHER)]);
  const result = await listInterviewSessions(ctx, { status: "all" });
  assert.equal(result.ok, true);
  const v = result.value;
  const live = mine.filter((s) => s.archived_at === null);
  assert.equal(v.counts.all, live.length, "another company's sessions are not counted");
  assert.equal(v.counts.archived, mine.length - live.length);
  const passed = (s) => Date.parse(s.expires_at) < NOW;
  const expect = {
    submitted: live.filter((s) => s.status === "submitted").length,
    cancelled: live.filter((s) => s.status === "cancelled").length,
    expired: live.filter(
      (s) => s.status === "expired" || (["invited", "started"].includes(s.status) && passed(s)),
    ).length,
    started: live.filter((s) => s.status === "started" && !passed(s)).length,
    invited: live.filter((s) => s.status === "invited" && !passed(s)).length,
    unknown: 0,
  };
  for (const [k, n] of Object.entries(expect)) assert.equal(v.counts[k], n, k);
  const sum = Object.values(expect).reduce((a, b) => a + b, 0);
  assert.equal(sum, v.counts.all, "the buckets sum to All");
  assert.equal(v.total, live.length);
  assert.ok(v.rows.every((r) => r.id.startsWith(`5e55${CO.slice(-4)}`)));
  // Paging is in creation order, newest first, 20 at a time.
  const page2 = await listInterviewSessions(ctx, { status: "all", page: 2 });
  assert.deepEqual(
    page2.value.rows.map((r) => r.id),
    live.slice(20, 40).map((s) => s.id),
  );
});

test("L3. a page past the end is an empty page with the true total, not a failure", async () => {
  world(sessions(30));
  const result = await listInterviewSessions(ctx, { status: "all", page: 50 });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.rows, []);
  assert.equal(result.value.total, sessions(30).filter((s) => s.archived_at === null).length);
});

test("L4. the review page: after the session read, its reads run in parallel (two waves)", async () => {
  const one = sessions(1)[0];
  const w = world([{ ...one, status: "submitted" }]);
  const detail = await loadInterviewSession(ctx, one.id);
  assert.ok(detail, "the session loads");
  assert.ok(w.peak() >= 5, `reads in flight at once: ${w.peak()}`);
  const src = readFileSync(new URL("./review.ts", import.meta.url), "utf8");
  const fn = src.slice(
    src.indexOf("export async function loadInterviewSession("),
    src.indexOf("/** A correction, or null."),
  );
  // The session read and the scope check first, then exactly two waits.
  const waits = [...fn.matchAll(/\bawait\b/g)].length;
  assert.equal(waits, 4, "session read, scope, wave 1, wave 2");
  assert.ok(fn.indexOf("getJobScope(ctx)") < fn.indexOf("await Promise.all(["), "scope first");
});

/* ── #41 part 2, review: restarts, and isolation on both paths ── */

const { deriveStatus } = await import("./review.ts");
const J2 = "b0000000-0000-4000-8000-0000000000e2";
const TABS = [
  "all",
  "submitted",
  "started",
  "invited",
  "expired",
  "cancelled",
  "unknown",
  "archived",
];

/** A database with hiring teams and applicant names, so scope and search run for real. */
function richWorld(rows, { team = [] } = {}) {
  globalThis.__messagesServiceForTests = () =>
    fakeService((table, calls) => {
      if (table === "interview_sessions") return answerSessions(rows, calls);
      if (table === "job_hiring_team") {
        return {
          data: team.filter((t) =>
            calls.every((c) => c[0] !== "eq" || t[c[1]] === undefined || t[c[1]] === c[2]),
          ),
          error: null,
        };
      }
      if (table === "job_applications") {
        const ids = call(calls, "in")?.[2] ?? [];
        const company = calls.find((c) => c[0] === "eq" && c[1] === "company_id_snapshot")?.[2];
        const owner = new Map(rows.map((s) => [s.application_id, s.company_id]));
        return {
          data: ids
            .filter((id) => owner.get(id) === company)
            .map((id) => ({
              id,
              first_name: "Cand",
              last_name: id.slice(-4),
              email: `${id.slice(-4)}@x.test`,
            })),
          error: null,
        };
      }
      if (table === "interview_answers") return { data: [], count: 0, error: null };
      if (call(calls, "maybeSingle")) return { data: null, error: null };
      return { data: [], error: null };
    });
}

/** Every row of every tab and page the list serves for these options. */
async function everything(viewer, extra = {}) {
  const out = { rows: [], counts: null };
  for (const status of TABS) {
    for (let page = 1; page < 50; page += 1) {
      const r = await listInterviewSessions(viewer, { status, page, ...extra });
      assert.equal(r.ok, true, `${status} p${page}`);
      if (status === "all" && page === 1) out.counts = r.value.counts;
      out.rows.push(...r.value.rows.map((x) => ({ ...x, tab: status })));
      if (page * 20 >= r.value.total) break;
    }
  }
  return out;
}

test("R1. only first attempts a restart points to are hidden; an abandoned session nothing restarted is listed as cancelled; a candidate who stopped early is listed by status", async () => {
  const base = sessions(6);
  const superseded = { ...base[0], kind: "live", status: "abandoned", archived_at: null };
  const restart = {
    ...base[1],
    id: "5e55e1e1-0000-4000-8000-0000000000aa",
    kind: "live",
    status: "invited",
    previous_attempt_id: superseded.id,
    archived_at: null,
  };
  // 053 needs a recorded decision for `abandoned`, not that attempt 2 exists.
  const lonely = { ...base[2], kind: "live", status: "abandoned", archived_at: null };
  // live_outcome 'abandoned' is an OUTCOME (the candidate left), not the status.
  const stoppedEarly = {
    ...base[3],
    kind: "live",
    status: "started",
    live_outcome: { outcome: "abandoned" },
    archived_at: null,
  };
  const plain = { ...base[4], archived_at: null };
  const rows = [superseded, restart, lonely, stoppedEarly, plain];
  richWorld(rows);
  const all = await everything(ctx);
  const shown = new Set(all.rows.map((r) => r.id));
  assert.ok(!shown.has(superseded.id), "the superseded first attempt is hidden everywhere");
  for (const s of [restart, lonely, stoppedEarly, plain]) assert.ok(shown.has(s.id), s.id);
  // Every visible row is in the tab deriveStatus puts it in, and counted there.
  const visible = rows.filter((s) => s !== superseded);
  for (const s of visible) {
    const tabs = all.rows.filter((r) => r.id === s.id).map((r) => r.tab);
    assert.deepEqual(tabs.sort(), ["all", deriveStatus(s.status, s.expires_at)].sort(), s.id);
  }
  assert.equal(all.rows.find((r) => r.id === lonely.id && r.tab === "all").status, "cancelled");
  for (const st of ["submitted", "started", "invited", "expired", "cancelled", "unknown"]) {
    assert.equal(
      all.counts[st],
      visible.filter((s) => deriveStatus(s.status, s.expires_at) === st).length,
      st,
    );
  }
  assert.equal(all.counts.all, visible.length);
});

test("R2. isolation, SQL path: another company's sessions never appear in any tab, page or count", async () => {
  const mine = sessions(130);
  const theirs = sessions(90, OTHER);
  richWorld([...mine, ...theirs]);
  const all = await everything(ctx);
  assert.ok(all.rows.length > 0);
  assert.ok(
    all.rows.every((r) => !r.id.startsWith(`5e55${OTHER.slice(-4)}`)),
    "no other-company row",
  );
  assert.equal(all.counts.all + all.counts.archived, mine.length, "the counts are mine alone");
  assert.equal(
    new Set(all.rows.filter((r) => r.tab === "all").map((r) => r.id)).size,
    all.counts.all,
  );
});

test("R3. isolation, SQL path: a job-scoped recruiter sees only their jobs' sessions and counts, on every page", async () => {
  const mine = sessions(150).map((s, i) => ({ ...s, job_id: i % 3 === 0 ? J2 : JOB }));
  richWorld([...mine, ...sessions(40, OTHER)], {
    team: [{ company_id: CO, member_id: "m-1", job_id: JOB }],
  });
  const recruiter = { ...ctx, role: "recruiter" };
  const all = await everything(recruiter);
  assert.ok(all.rows.length > 0);
  assert.ok(
    all.rows.every((r) => r.jobId === JOB),
    "only the recruiter's job",
  );
  const onJob = mine.filter((s) => s.job_id === JOB);
  assert.equal(
    all.counts.all + all.counts.archived,
    onJob.length,
    "the counts are the job's alone",
  );
  const r = await listInterviewSessions(recruiter, { status: "all" });
  assert.equal(r.value.openRoles <= 1, true);
});

test("R4. isolation, search path: the same for another company and for a job-scoped recruiter", async () => {
  const mine = sessions(60).map((s, i) => ({ ...s, job_id: i % 2 ? J2 : JOB }));
  richWorld([...mine, ...sessions(40, OTHER)], {
    team: [{ company_id: CO, member_id: "m-1", job_id: JOB }],
  });
  // "cand" matches every candidate's name, so the search keeps every row it may.
  const owner = await everything(ctx, { query: "cand" });
  assert.ok(owner.rows.length > 0);
  assert.ok(owner.rows.every((r) => !r.id.startsWith(`5e55${OTHER.slice(-4)}`)));
  assert.equal(owner.counts.all + owner.counts.archived, mine.length);
  const scoped = await everything({ ...ctx, role: "recruiter" }, { query: "cand" });
  assert.ok(scoped.rows.length > 0);
  assert.ok(scoped.rows.every((r) => r.jobId === JOB));
  assert.equal(
    scoped.counts.all + scoped.counts.archived,
    mine.filter((s) => s.job_id === JOB).length,
  );
});
