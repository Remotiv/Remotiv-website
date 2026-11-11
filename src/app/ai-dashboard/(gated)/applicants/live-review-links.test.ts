/**
 * AI Video Interviews open from the interview list and the applicant drawer
 * (F10 C6b), although they record no interview_answers: the list links every
 * live row to its review page, and the drawer links the latest attempt's,
 * only where the review page's own gate would open it. Async rows and the
 * async drawer are unchanged, and C6a's restart controls stay as they were.
 *
 *   node --test "src/app/ai-dashboard/(gated)/applicants/live-review-links.test.ts"
 *
 * fetchInterviewPanel, the drawer's liveReviewHref and liveSendControls, and
 * the list's rowOpenable are the shipped code; the company context, email and
 * queue are interview-invite-test-hook.mjs's fakes, the hiring team is stubbed
 * below, and the database is fake-live-db.mjs, seeded directly. Synthetic data.
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../../../test-support/tsx-load.mjs", import.meta.url));
register(new URL("../../../../test-support/interview-invite-test-hook.mjs", import.meta.url));
// Registered last, so consulted first: the hiring team as each test sets it.
register(
  `data:text/javascript,${encodeURIComponent(`
const STUBS = {
  "@/app/ai-dashboard/lib/job-scope": "export async function roleAllowsJobAction(ctx, jobId) { const a = globalThis.__allowedJobs; return a ? a.includes(jobId) : true; } export const canAccessJob = roleAllowsJobAction;",
  "next/link": "export default function Link() { return null; }",
  "./booking-actions": "export async function fetchBookingPanel() {} export async function sendBookingLink() {} export async function cancelBookingAsRecruiter() {}",
  "./_final-interview-card": "export function FinalInterviewCard() { return null; }",
  "./actions": "export async function fetchInterviewList() {} export async function setInterviewArchived() {}",
};
export async function resolve(specifier, context, next) {
  if (specifier in STUBS) return { url: "data:text/javascript," + encodeURIComponent(STUBS[specifier]), shortCircuit: true };
  return next(specifier, context);
}`)}`,
);

const { fetchInterviewPanel } = await import("./interview-actions.ts");
const { liveReviewHref, liveSendControls } = await import("./_interview-panel.tsx");
const { rowOpenable } = await import("../interviews/_interviews-client.tsx");
const { fakeLiveDb } = await import("../../../../test-support/fake-live-db.mjs");

const CO = "c0000000-0000-4000-8000-0000000000b6";
const OTHER_CO = "c0000000-0000-4000-8000-0000000000b7";
const APP = "a0000000-0000-4000-8000-0000000000b6";
const JOB = "b0000000-0000-4000-8000-0000000000b6";
const OTHER_JOB = "b0000000-0000-4000-8000-0000000000b7";
const FIRST = "d0000000-0000-4000-8000-0000000000b1";
const SECOND = "d0000000-0000-4000-8000-0000000000b2";
const MIN = 60_000;
const HOUR = 60 * MIN;
const at = (ms) => new Date(Date.now() + ms).toISOString();
const href = (id) => `/ai-dashboard/interviews/${id}`;

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
  expires_at: at(48 * HOUR),
  created_at: at(-3 * 24 * HOUR),
  submitted_at: null,
  started_at: null,
  provider_session_id: null,
  live_ended_at: null,
  live_outcome: null,
  invited_by_name: null,
  questions_snapshot: [{ position: 1 }],
  ...over,
});
const ended = (outcome) =>
  live({
    status: "started",
    started_at: at(-2 * HOUR),
    provider_session_id: "provider-1",
    live_ended_at: at(-HOUR),
    live_outcome: { outcome, final: true },
  });
const decision = (sessionId, d = "restart") => ({
  id: crypto.randomUUID(),
  session_id: sessionId,
  company_id: CO,
  action: "decide_restart",
  decision: d,
  note: "synthetic",
  actor_user_id: "u-1",
  actor_role: "owner",
  created_at: at(-24 * HOUR),
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

// ── the interview list ──────────────────────────────────────

test("list: a live row with zero answers links to its review page", () => {
  for (const progress of [{ answered: 0, purged: false }, null]) {
    assert.equal(rowOpenable({ kind: "live", progress }), true, JSON.stringify(progress));
  }
});

test("list: async rows are linked exactly as before (only with answers, or an unknown count)", () => {
  assert.equal(rowOpenable({ kind: "async", progress: { answered: 0, purged: false } }), false);
  assert.equal(rowOpenable({ kind: "async", progress: { answered: 3, purged: false } }), true);
  assert.equal(rowOpenable({ kind: "async", progress: null }), true, "unknown stays openable");
});

// ── the applicant drawer ────────────────────────────────────

test("drawer: a live interview with zero answers links its review page at every stage", async () => {
  const stages = {
    invited: live(),
    started: live({ status: "started", started_at: at(-5 * MIN), provider_session_id: "p" }),
    submitted: live({ status: "submitted", submitted_at: at(-MIN) }),
    completed: ended("completed"),
    failed: ended("technical_failure"),
    expired: live({ status: "expired", expires_at: at(-HOUR) }),
    "invited, past its deadline": live({ expires_at: at(-HOUR) }),
  };
  for (const [name, session] of Object.entries(stages)) {
    world({ sessions: [session] });
    const state = await panel();
    assert.equal(state.session.answered, 0, `${name}: no interview_answers`);
    assert.equal(liveReviewHref(state.session), href(FIRST), name);
  }
});

test("drawer: a restarted interview opens attempt 2's review page, never attempt 1's", async () => {
  const abandoned = { ...ended("technical_failure"), status: "abandoned" };
  for (const status of ["invited", "started", "expired"]) {
    const restart = live({
      id: SECOND,
      attempt: 2,
      previous_attempt_id: FIRST,
      status,
      created_at: at(-24 * HOUR),
    });
    world({ sessions: [abandoned, restart], actions: [decision(FIRST)] });
    const state = await panel();
    assert.equal(liveReviewHref(state.session), href(SECOND), status);
    // C6a unchanged: no send of its own, and its line points at the same page.
    assert.deepEqual(liveSendControls(state.session, true), {
      allowSend: false,
      restartHref: href(SECOND),
      restarted: true,
    });
  }
  // A "no restart" decision: attempt 1 is still the latest, and it is what opens.
  world({ sessions: [ended("technical_failure")], actions: [decision(FIRST, "no_restart")] });
  const decided = await panel();
  assert.equal(liveReviewHref(decided.session), href(FIRST));
  assert.deepEqual(liveSendControls(decided.session, true), {
    allowSend: false,
    restartHref: href(FIRST),
    restarted: false,
  });
});

test("drawer: no link where the review page's gate would refuse (the session's job outside the hiring team)", async () => {
  // The application is on JOB (the viewer's), the session was sent for OTHER_JOB.
  world({
    sessions: [live({ job_id: OTHER_JOB })],
    allowedJobs: [JOB],
    role: "hiring_manager",
  });
  const state = await panel();
  assert.equal(state.session.reviewable, false);
  assert.equal(liveReviewHref(state.session), null);
  // The same viewer, a session on their own job: linked.
  world({ sessions: [live()], allowedJobs: [JOB], role: "hiring_manager" });
  assert.equal(liveReviewHref((await panel()).session), href(FIRST));
});

test("drawer: another company's application shows nothing and links nothing", async () => {
  world({ sessions: [live()] });
  globalThis.__inviteCtxForTests = {
    companyId: OTHER_CO,
    memberId: "m-2",
    memberName: "X",
    role: "owner",
  };
  const state = await panel();
  assert.equal(state.session, null);
  assert.equal(liveReviewHref(state.session), null);
});

test("drawer: the async panel is unchanged: no live fields, no live link", async () => {
  world({
    sessions: [
      {
        ...live({ kind: "async", id: "d0000000-0000-4000-8000-0000000000b9" }),
        attempt: 1,
      },
    ],
  });
  const state = await panel("async");
  assert.equal(state.session.kind, "async");
  assert.ok(!("reviewable" in state.session), "no reviewable on an async summary");
  assert.ok(!("restart" in state.session), "no restart on an async summary");
  assert.equal(liveReviewHref(state.session), null);
});
