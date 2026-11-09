/**
 * The applicant drawer's restart status for an AI Video Interview (F10 C6e):
 * one line for a restarted or decision-pending interview, from its latest
 * attempt, in this order: a restart first, then a recorded no-restart decision,
 * then a first attempt that can be decided, otherwise the interview as before.
 * Never the decision's note; never "Sent - not started" or "Cancelled" for a
 * restart; send controls still hidden (C6a); review link per C6b.
 *
 *   node --test "src/app/ai-dashboard/(gated)/applicants/live-restart-status.test.ts"
 *
 * fetchInterviewPanel, restartEligibility (live-restart.ts) and the drawer's
 * liveSectionView, liveRestartText, liveReviewHref and liveSendControls are the
 * shipped code; the company context is interview-invite-test-hook.mjs's fake,
 * the hiring team is stubbed below, the database is fake-live-db.mjs, seeded
 * directly. Set PANEL_TRACE_OUT to write the no-restart cases' payloads, for a
 * diff against HEAD's fetchInterviewPanel. Synthetic data only.
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { register } from "node:module";
import { after, mock, test } from "node:test";

register(new URL("../../../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../../../test-support/tsx-load.mjs", import.meta.url));
register(new URL("../../../../test-support/interview-invite-test-hook.mjs", import.meta.url));
register(
  `data:text/javascript,${encodeURIComponent(`
const STUBS = {
  "@/app/ai-dashboard/lib/job-scope": "export async function canAccessJob(ctx, jobId) { const a = globalThis.__allowedJobs; return a ? a.includes(jobId) : true; }",
  "next/link": "export default function Link() { return null; }",
  "./booking-actions": "export async function fetchBookingPanel() {} export async function sendBookingLink() {} export async function cancelBookingAsRecruiter() {}",
  "./_final-interview-card": "export function FinalInterviewCard() { return null; }",
};
export async function resolve(specifier, context, next) {
  if (specifier in STUBS) return { url: "data:text/javascript," + encodeURIComponent(STUBS[specifier]), shortCircuit: true };
  return next(specifier, context);
}`)}`,
);

const { fetchInterviewPanel } = await import("./interview-actions.ts");
const { liveReviewHref, liveRestartText, liveSectionView, liveSendControls } = await import(
  "./_interview-panel.tsx"
);
const { fakeLiveDb } = await import("../../../../test-support/fake-live-db.mjs");
const { createElement, Fragment } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");

/**
 * A status line as text. Its times are the viewer's, filled in on the client
 * (LocalTime): the server markup carries only the instant, shown here as [iso].
 */
const lineText = (node) =>
  typeof node === "string"
    ? node
    : renderToStaticMarkup(createElement(Fragment, null, node)).replace(
        /<time dateTime="([^"]+)"[^>]*><\/time>/g,
        "[$1]",
      );

const NOW = Date.parse("2026-11-03T12:00:00.000Z");
mock.timers.enable({ apis: ["Date"], now: NOW });
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const at = (ms) => new Date(NOW + ms).toISOString();

const CO = "c0000000-0000-4000-8000-0000000000e6";
const APP = "a0000000-0000-4000-8000-0000000000e6";
const JOB = "b0000000-0000-4000-8000-0000000000e6";
const OTHER_JOB = "b0000000-0000-4000-8000-0000000000e7";
const FIRST = "d0000000-0000-4000-8000-0000000000e1";
const SECOND = "d0000000-0000-4000-8000-0000000000e2";
const NOTE = "SYNTHETIC-DECISION-NOTE-should-never-reach-the-drawer";
const href = (id) => `/ai-dashboard/interviews/${id}`;
const GENERIC = ["Sent - not started", "Cancelled"];

const live = (over = {}) => ({
  id: FIRST,
  company_id: CO,
  application_id: APP,
  job_id: JOB,
  kind: "live",
  attempt: 1,
  previous_attempt_id: null,
  status: "invited",
  token_hash: "1".repeat(64),
  expires_at: at(2 * DAY),
  created_at: at(-3 * DAY),
  submitted_at: null,
  started_at: null,
  provider_session_id: null,
  live_ended_at: null,
  live_outcome: null,
  invited_by_name: null,
  questions_snapshot: [{ position: 1 }],
  ...over,
});
const endedFirst = (over = {}) =>
  live({
    status: "started",
    started_at: at(-3 * HOUR),
    provider_session_id: "provider-1",
    live_ended_at: at(-2 * HOUR),
    live_outcome: { outcome: "technical_failure", final: true },
    ...over,
  });
const abandoned = () => endedFirst({ status: "abandoned" });
const restart = (over = {}) =>
  live({
    id: SECOND,
    attempt: 2,
    previous_attempt_id: FIRST,
    token_hash: "2".repeat(64),
    created_at: at(-DAY),
    expires_at: at(2 * DAY),
    ...over,
  });
const decision = (sessionId, d) => ({
  id: crypto.randomUUID(),
  session_id: sessionId,
  company_id: CO,
  action: "decide_restart",
  decision: d,
  note: NOTE,
  actor_user_id: "u-1",
  actor_name: "Synthetic Member",
  actor_role: "owner",
  created_at: at(-DAY),
});

function world({ sessions = [], actions = [], allowedJobs = null, role = "owner" } = {}) {
  const w = fakeLiveDb({
    interview_sessions: sessions,
    live_interview_actions: actions,
    job_applications: [{ id: APP, company_id_snapshot: CO, job_id: JOB, email: "c@example.test" }],
    jobs: [
      { id: JOB, company_id: CO, async_interview_enabled: true, avatar_interview_enabled: true },
    ],
  });
  globalThis.__inviteServiceForTests = () => w.service;
  globalThis.__inviteCtxForTests = { companyId: CO, memberId: "m-1", memberName: "M", role };
  globalThis.__allowedJobs = allowedJobs;
  return w;
}
async function quietly(fn) {
  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try {
    return await fn();
  } finally {
    Object.assign(console, saved);
  }
}
const panel = (kind = "live") => quietly(() => fetchInterviewPanel(APP, kind));

const restarted = (second) => ({
  sessions: [abandoned(), second],
  actions: [decision(FIRST, "restart")],
});
const STATES = [
  [
    "1. eligible, undecided",
    { sessions: [endedFirst()] },
    { kind: "decision_needed", availableAt: null },
    FIRST,
    "Needs a restart decision.",
  ],
  [
    "1. too soon (no export yet)",
    { sessions: [endedFirst({ live_ended_at: at(-30 * MIN), live_outcome: null })] },
    { kind: "decision_needed", availableAt: at(30 * MIN) },
    FIRST,
    `Needs a restart decision - available from [${at(30 * MIN)}].`,
  ],
  [
    "2. no restart decided",
    { sessions: [endedFirst()], actions: [decision(FIRST, "no_restart")] },
    { kind: "no_restart" },
    FIRST,
    "No restart - decided.",
  ],
  [
    "3. restart sent",
    restarted(restart()),
    { kind: "restart_sent", deadline: at(2 * DAY) },
    SECOND,
    `Restart created - not started yet, deadline [${at(2 * DAY)}].`,
  ],
  [
    "4. restart past its deadline",
    restarted(restart({ expires_at: at(-HOUR) })),
    { kind: "restart_expired" },
    SECOND,
    "Restart expired.",
  ],
  [
    "4. restart expired",
    restarted(restart({ status: "expired", expires_at: at(-HOUR) })),
    { kind: "restart_expired" },
    SECOND,
    "Restart expired.",
  ],
  [
    "5. restart in progress",
    restarted(restart({ status: "started", started_at: at(-5 * MIN), provider_session_id: "p-2" })),
    { kind: "restart_in_progress" },
    SECOND,
    "Restart in progress.",
  ],
];
const finished = (outcome, final = true) =>
  restarted(
    restart({
      status: "started",
      started_at: at(-HOUR),
      provider_session_id: "p-2",
      live_ended_at: at(-30 * MIN),
      live_outcome: outcome ? { outcome, final } : null,
    }),
  );
const FINISHED = [
  [
    "completed",
    finished("completed"),
    "completed",
    "Restart finished",
    "Restart finished - Completed.",
  ],
  ["partial", finished("partial"), "partial", "Restart finished", "Restart finished - Partial."],
  ["abandoned", finished("abandoned"), "abandoned", "Restart ended", "Restart ended - Abandoned."],
  [
    "technical_failure",
    finished("technical_failure"),
    "technical_failure",
    "Restart ended",
    "Restart ended - Technical failure.",
  ],
  [
    "ending_unconfirmed",
    finished("ending_unconfirmed"),
    "ending_unconfirmed",
    "Restart ended",
    "Restart ended - Ending not confirmed - needs review.",
  ],
  [
    "not final yet",
    finished("technical_failure", false),
    null,
    "Restart ended",
    "Restart ended - no final result yet.",
  ],
  ["no export yet", finished(null), null, "Restart ended", "Restart ended - no final result yet."],
];

// ── a: every state ──────────────────────────────────────────

test("a: each state shows its status and links the latest attempt", async () => {
  for (const [name, seed, status, latest, line] of STATES) {
    world(seed);
    const { session } = await panel();
    assert.deepEqual(session.restartStatus, status, name);
    const shown = lineText(liveSectionView(session).restartLine);
    assert.equal(shown, line, name);
    assert.doesNotMatch(shown, /UTC/, `${name}: no UTC on the dashboard`);
    assert.equal(liveReviewHref(session), href(latest), name);
  }
});

test("a: every terminal restart outcome; a technical failure never reads as finished", async () => {
  for (const [name, seed, outcome, badge, line] of FINISHED) {
    world(seed);
    const { session } = await panel();
    assert.deepEqual(session.restartStatus, { kind: "restart_finished", outcome }, name);
    const view = liveSectionView(session);
    assert.equal(view.badge.label, badge, name);
    assert.equal(lineText(view.restartLine), line, name);
    assert.equal(liveReviewHref(session), href(SECOND), name);
  }
  assert.equal(
    liveRestartText({ kind: "restart_finished", outcome: "technical_failure" }).badge,
    "Restart ended",
  );
});

// ── b: never the generic invite states ──────────────────────

test("b: a restarted chain never shows 'Sent - not started' or 'Cancelled'", async () => {
  for (const [name, seed] of [...STATES.slice(3), ...FINISHED.map(([n, s]) => [n, s])]) {
    world(seed);
    const view = liveSectionView((await panel()).session);
    assert.equal(view.card, "restart", name);
    assert.ok(!GENERIC.includes(view.badge.label), `${name}: ${view.badge.label}`);
  }
});

// ── c: never the note ───────────────────────────────────────

test("c: no decision note in the drawer payload, for any role", async () => {
  for (const role of ["owner", "admin", "recruiter", "hiring_manager"]) {
    for (const seed of [
      { sessions: [endedFirst()], actions: [decision(FIRST, "no_restart")] },
      restarted(restart()),
    ]) {
      world({ ...seed, role, allowedJobs: [JOB] });
      const state = await panel();
      assert.ok(state.session, role);
      const payload = JSON.stringify(state);
      assert.ok(!payload.includes(NOTE), `${role}: no note`);
      assert.ok(!payload.includes("Synthetic Member"), `${role}: no decider's name`);
    }
  }
});

// ── d: who sees what ────────────────────────────────────────

test("d: a hiring manager off the session's job sees the status (the drawer is theirs) but no link", async () => {
  world({
    ...restarted(restart({ job_id: OTHER_JOB })),
    allowedJobs: [JOB],
    role: "hiring_manager",
  });
  const { session } = await panel();
  assert.deepEqual(session.restartStatus, { kind: "restart_sent", deadline: at(2 * DAY) });
  assert.equal(liveReviewHref(session), null);
  // Off the application's own job: no drawer at all, so no status either.
  world({ ...restarted(restart()), allowedJobs: [OTHER_JOB], role: "hiring_manager" });
  assert.equal((await panel()).session, null);
});

// ── e: everything else, as before ───────────────────────────

const traces = {};
after(() => {
  if (process.env.PANEL_TRACE_OUT) {
    writeFileSync(process.env.PANEL_TRACE_OUT, `${JSON.stringify(traces, null, 2)}\n`);
  }
});

test("e: a live interview a restart has nothing to do with, and the async drawer, read as before", async () => {
  const normal = {
    "live invited": { sessions: [live()] },
    "live started": {
      sessions: [live({ status: "started", started_at: at(-5 * MIN), provider_session_id: "p" })],
    },
    "live completed": {
      sessions: [endedFirst({ live_outcome: { outcome: "completed", final: true } })],
    },
    "live not final yet": {
      sessions: [endedFirst({ live_outcome: { outcome: "technical_failure", final: false } })],
    },
    "live expired": { sessions: [live({ status: "expired", expires_at: at(-HOUR) })] },
  };
  for (const [name, seed] of Object.entries(normal)) {
    world(seed);
    const state = await panel();
    assert.ok(!("restartStatus" in state.session), `${name}: no restart status`);
    traces[name] = state;
  }
  world({ sessions: [live({ kind: "async", id: "d0000000-0000-4000-8000-0000000000e9" })] });
  const asyncState = await panel("async");
  assert.ok(!("restartStatus" in asyncState.session));
  traces.async = asyncState;
});

// ── f: C6a ──────────────────────────────────────────────────

test("f: send controls stay hidden for every restarted or decided state (C6a)", async () => {
  for (const [name, seed] of [...STATES.slice(2), ...FINISHED.map(([n, s]) => [n, s])]) {
    world(seed);
    const { session } = await panel();
    assert.equal(liveSendControls(session, true).allowSend, false, name);
  }
});
