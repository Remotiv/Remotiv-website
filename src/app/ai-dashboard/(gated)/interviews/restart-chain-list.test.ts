/**
 * The interview list shows each restarted AI Video Interview once (F10 C6d):
 * the restart (attempt 2) stands for it, the first attempt it points back to is
 * dropped from the whole scoped read before any row, count, tab or page is
 * built, "sent this week" counts the chain from its first send, and a live row's
 * Answers column never reads "0/N". Ordinary re-sends and async rows are as
 * before.
 *
 *   node --test "src/app/ai-dashboard/(gated)/interviews/restart-chain-list.test.ts"
 *
 * listInterviewSessions, pageAll and the list's AnswerCount are the shipped
 * code; the hiring-team scope is stubbed below and the database is
 * fake-live-db.mjs (it applies eq/in/order/range). Set LIST_TRACE_OUT to write
 * the no-restart cases' results, for a diff against HEAD's review.ts.
 * Synthetic data only.
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { register } from "node:module";
import { after, mock, test } from "node:test";

register(new URL("../../../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../../../test-support/tsx-load.mjs", import.meta.url));
register(
  `data:text/javascript,${encodeURIComponent(`
const STUBS = {
  "server-only": "",
  "@/lib/supabase/server": "export function createServiceClient() { return globalThis.__listService; }",
  "@/app/ai-dashboard/lib/job-scope": [
    "export async function getJobScope() { return globalThis.__listScope; }",
    "export function isEmptyScope(s) { return s.scoped && s.jobIds.length === 0; }",
    "export function scopeJobIds(s) { return s.scoped ? s.jobIds : null; }",
    "export async function roleAllowsJobAction() { return true; }",
    "export const canAccessJob = roleAllowsJobAction;",
  ].join("\\n"),
  "@/lib/ai/interview-scoring": "export function scoringEnabled() { return false; }",
  "next/link": "export default function Link() { return null; }",
  "./actions": "export async function fetchInterviewList() {} export async function setInterviewArchived() {}",
};
export async function resolve(specifier, context, next) {
  if (specifier in STUBS) return { url: "data:text/javascript," + encodeURIComponent(STUBS[specifier]), shortCircuit: true };
  return next(specifier, context);
}`)}`,
);

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { listInterviewSessions } = await import("../../../../lib/interviews/review.ts");
const { AnswerCount } = await import("./_interviews-client.tsx");
const { fakeLiveDb } = await import("../../../../test-support/fake-live-db.mjs");

const CO = "c0000000-0000-4000-8000-0000000000d6";
const JOB = "b0000000-0000-4000-8000-0000000000d6";
const OTHER_JOB = "b0000000-0000-4000-8000-0000000000d7";
const APP = "a0000000-0000-4000-8000-0000000000d6";
const L1 = "d0000000-0000-4000-8000-0000000000d1";
const L2 = "d0000000-0000-4000-8000-0000000000d2";
const DAY = 24 * 60 * 60 * 1000;
// A fixed clock, so the derived statuses, "sent this week" and the HEAD trace are reproducible.
const NOW = Date.parse("2026-11-03T12:00:00.000Z");
mock.timers.enable({ apis: ["Date"], now: NOW });
const ago = (ms) => new Date(NOW - ms).toISOString();
const ahead = (ms) => new Date(NOW + ms).toISOString();
const ctx = { companyId: CO, role: "owner", memberId: "m-1", user: { id: "u-1" } };
const TABS = ["all", "submitted", "started", "invited", "expired", "cancelled", "archived"];

const session = (id, over = {}) => ({
  id,
  company_id: CO,
  application_id: APP,
  job_id: JOB,
  kind: "live",
  attempt: 1,
  previous_attempt_id: null,
  status: "invited",
  started_at: null,
  submitted_at: null,
  expires_at: ahead(3 * DAY),
  delete_after: null,
  invited_by_name: null,
  questions_snapshot: [{ position: 1 }, { position: 2 }],
  archived_at: null,
  created_at: ago(DAY),
  ...over,
});
const firstAttempt = (over = {}) =>
  session(L1, {
    status: "abandoned",
    started_at: ago(10 * DAY),
    created_at: ago(10 * DAY),
    expires_at: ago(5 * DAY),
    ...over,
  });
const restart = (over = {}) =>
  session(L2, { attempt: 2, previous_attempt_id: L1, created_at: ago(DAY), ...over });
const asyncSession = (i, over = {}) =>
  session(`e0000000-0000-4000-8000-${String(i).padStart(12, "0")}`, {
    kind: "async",
    application_id: null,
    status: i % 3 === 0 ? "submitted" : i % 3 === 1 ? "invited" : "expired",
    submitted_at: i % 3 === 0 ? ago(DAY) : null,
    expires_at: i % 3 === 2 ? ago(DAY) : ahead(DAY),
    created_at: ago(2 * DAY + i * 60_000),
    ...over,
  });

function install(sessions, scope = { scoped: false }) {
  const db = fakeLiveDb({ interview_sessions: sessions, job_applications: [], jobs: [] });
  globalThis.__listService = db.service;
  globalThis.__listScope = scope;
  return db;
}
const list = async (opts = {}, viewer = ctx) => {
  const r = await listInterviewSessions(viewer, opts);
  assert.equal(r.ok, true, "the read worked");
  return r.value;
};
/** Every row of a tab, across every page. */
async function allRows(status, viewer = ctx) {
  const out = [];
  for (let page = 1; ; page++) {
    const v = await list({ status, page }, viewer);
    out.push(...v.rows);
    if (page * v.pageSize >= v.total) return out;
  }
}

// ── a: one row per restart ──────────────────────────────────

test("a: a restarted interview is one row, its restart, with the restart's status", async () => {
  const cases = [
    ["attempt 2 invited", restart(), "invited"],
    ["attempt 2 started", restart({ status: "started", started_at: ago(60_000) }), "started"],
    [
      "attempt 2 finished",
      restart({ status: "started", started_at: ago(DAY), live_ended_at: ago(DAY - 600_000) }),
      "started",
    ],
    ["attempt 2 expired", restart({ status: "expired", expires_at: ago(60_000) }), "expired"],
    ["attempt 2 past its deadline", restart({ expires_at: ago(60_000) }), "expired"],
  ];
  for (const [name, second, status] of cases) {
    install([second, firstAttempt()]);
    const v = await list();
    assert.deepEqual(
      v.rows.map((r) => [r.id, r.status]),
      [[L2, status]],
      name,
    );
  }
});

// ── b: counts, tabs and pages ───────────────────────────────

test("b: counts, every tab and 'sent this week' count the chain once, from its first send", async () => {
  const fresh = session("d0000000-0000-4000-8000-0000000000d9", {
    application_id: null,
    created_at: ago(DAY),
  });
  install([restart(), fresh, firstAttempt()]);
  const v = await list();
  assert.deepEqual(v.counts, {
    all: 2,
    submitted: 0,
    started: 0,
    invited: 2,
    expired: 0,
    cancelled: 0,
    archived: 0,
  });
  assert.equal(v.sentThisWeek, 1, "the restart is not a new send: its chain was sent 10 days ago");
  for (const tab of TABS) {
    assert.ok(!(await allRows(tab)).some((r) => r.id === L1), `${tab}: attempt 1 never shown`);
  }
});

test("b: attempt 1 stays hidden when its restart is in another tab, archived, or on another page", async () => {
  const filler = Array.from({ length: 45 }, (_, i) => asyncSession(i));
  const variants = {
    "restart started (another tab than attempt 1's)": restart({
      status: "started",
      started_at: ago(60_000),
    }),
    "restart archived": restart({ archived_at: ago(60_000) }),
    // Created before every filler row, so it lands on the last page; attempt 1 is older still.
    "restart on the last page": restart({ created_at: ago(9 * DAY) }),
  };
  for (const [name, second] of Object.entries(variants)) {
    install([...filler, second, firstAttempt()]);
    for (const tab of TABS) {
      const rows = await allRows(tab);
      assert.ok(!rows.some((r) => r.id === L1), `${name}, ${tab}: attempt 1 hidden`);
    }
    const counts = (await list()).counts;
    assert.equal(
      counts.all + counts.archived,
      filler.length + 1,
      `${name}: the chain counted once`,
    );
    const restartRows = (await allRows(second.archived_at ? "archived" : "all")).filter(
      (r) => r.id === L2,
    );
    assert.equal(restartRows.length, 1, `${name}: the restart shown once, in its own tab`);
  }
});

// ── c, d: unchanged ─────────────────────────────────────────

const traces = {};
after(() => {
  if (process.env.LIST_TRACE_OUT) {
    writeFileSync(process.env.LIST_TRACE_OUT, `${JSON.stringify(traces, null, 2)}\n`);
  }
});

/** Every tab and page of the list, for a byte-for-byte comparison with HEAD. */
async function snapshot() {
  const out = {};
  for (const tab of TABS) {
    for (let page = 1; page <= 3; page++) out[`${tab}:${page}`] = await list({ status: tab, page });
  }
  return out;
}

test("c: two unlinked first attempts from an ordinary re-send are both rows, as before", async () => {
  const sessions = [
    session("d0000000-0000-4000-8000-0000000000e2", { created_at: ago(DAY) }),
    session("d0000000-0000-4000-8000-0000000000e1", {
      status: "cancelled",
      created_at: ago(9 * DAY),
    }),
  ];
  install(sessions);
  const v = await list();
  assert.deepEqual(
    v.rows.map((r) => [r.id, r.status]),
    [
      ["d0000000-0000-4000-8000-0000000000e2", "invited"],
      ["d0000000-0000-4000-8000-0000000000e1", "cancelled"],
    ],
  );
  assert.equal(v.counts.all, 2);
  assert.equal(v.sentThisWeek, 1);
  traces["ordinary live re-send"] = await snapshot();
});

test("d: async rows and counts, across every tab and page, as before", async () => {
  install(
    Array.from({ length: 45 }, (_, i) =>
      asyncSession(i, i % 7 === 0 ? { archived_at: ago(DAY) } : {}),
    ),
  );
  const v = await list();
  assert.equal(v.counts.all + v.counts.archived, 45);
  traces.async = await snapshot();
});

// ── e: the live Answers column ──────────────────────────────

test("e: a live row's Answers column never reads 0/N; an async row's still does", () => {
  const row = (kind, answered) => ({
    kind,
    status: "invited",
    totalQuestions: 8,
    progress: { answered, purged: false },
  });
  const live = renderToStaticMarkup(createElement(AnswerCount, { row: row("live", 0) }));
  assert.doesNotMatch(live, /0\/8/);
  assert.match(live, /data-live-answers/);
  assert.match(live, />-</);
  const asyncZero = renderToStaticMarkup(createElement(AnswerCount, { row: row("async", 0) }));
  assert.match(asyncZero, />0\/8</, "async unchanged");
  const asyncSome = renderToStaticMarkup(createElement(AnswerCount, { row: row("async", 3) }));
  assert.match(asyncSome, />3\/8</);
});

// ── g: hiring-team scope ────────────────────────────────────

test("g: a scoped viewer sees only their jobs' rows; the chain filter reveals nothing else", async () => {
  const otherFirst = session("d0000000-0000-4000-8000-0000000000f1", {
    job_id: OTHER_JOB,
    status: "abandoned",
    created_at: ago(10 * DAY),
  });
  const otherRestart = session("d0000000-0000-4000-8000-0000000000f2", {
    job_id: OTHER_JOB,
    attempt: 2,
    previous_attempt_id: otherFirst.id,
  });
  install([restart(), firstAttempt(), otherRestart, otherFirst], { scoped: true, jobIds: [JOB] });
  const viewer = { ...ctx, role: "hiring_manager" };
  for (const tab of TABS) {
    const rows = await allRows(tab, viewer);
    assert.ok(
      rows.every((r) => r.jobId === JOB),
      `${tab}: only the viewer's job`,
    );
  }
  const v = await list({}, viewer);
  assert.deepEqual(
    v.rows.map((r) => r.id),
    [L2],
  );
  assert.equal(v.counts.all, 1);
  assert.deepEqual(
    v.jobs.map((j) => j.id),
    [],
    "no job names leak (no jobs table rows here)",
  );
});
