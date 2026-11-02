/**
 * The drawer's AI Video Interview send never cancels or replaces a restarted
 * interview (F10 C6a). Once an application's live interview has a restart
 * (attempt 2) or a restart decision, sendLiveInterviewInvite refuses with
 * live_restarted before anything is written, and the cancel inside the send
 * carries its own guard (attempt 2 and abandoned attempts never match). A
 * first invite, and the re-send of an invite nobody joined, are unchanged.
 *
 *   node --test "src/app/ai-dashboard/(gated)/applicants/live-restarted-send.test.ts"
 *
 * The send action, fetchInterviewPanel and the drawer's liveSendControls are
 * the shipped code; the company context, email and queue are the fakes of
 * interview-invite-test-hook.mjs; the database is fake-live-db.mjs, seeded
 * directly. Synthetic data only.
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../../../test-support/tsx-load.mjs", import.meta.url));
register(new URL("../../../../test-support/interview-invite-test-hook.mjs", import.meta.url));
register(
  `data:text/javascript,${encodeURIComponent(`
const STUBS = {
  "next/link": "export default function Link() { return null; }",
  "./booking-actions": "export async function fetchBookingPanel() {} export async function sendBookingLink() {} export async function cancelBookingAsRecruiter() {}",
  "./_final-interview-card": "export function FinalInterviewCard() { return null; }",
};
export async function resolve(specifier, context, next) {
  if (specifier in STUBS) return { url: "data:text/javascript," + encodeURIComponent(STUBS[specifier]), shortCircuit: true };
  return next(specifier, context);
}`)}`,
);

const { sendLiveInterviewInvite, fetchInterviewPanel } = await import("./interview-actions.ts");
const { liveSendControls } = await import("./_interview-panel.tsx");
const { fakeLiveDb } = await import("../../../../test-support/fake-live-db.mjs");

const CO = "c0000000-0000-4000-8000-0000000000a6";
const OTHER_CO = "c0000000-0000-4000-8000-0000000000a7";
const APP = "a0000000-0000-4000-8000-0000000000a6";
const OTHER_APP = "a0000000-0000-4000-8000-0000000000a7";
const JOB = "b0000000-0000-4000-8000-0000000000a6";
const FIRST = "d0000000-0000-4000-8000-0000000000a1";
const SECOND = "d0000000-0000-4000-8000-0000000000a2";
const MIN = 60_000;
const HOUR = 60 * MIN;
const at = (ms) => new Date(Date.now() + ms).toISOString();

const RESTARTED = {
  success: false,
  error: "This interview was restarted - manage it from the interview page.",
  code: "live_restarted",
};
const DECIDED = {
  success: false,
  error: "A restart decision was made for this interview - manage it from the interview page.",
  code: "live_restarted",
};

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
  ...over,
});

/** Attempt 1 after a restart: the call began and ended; abandoned once restarted. */
const abandoned = () =>
  live({
    status: "abandoned",
    started_at: at(-2 * 24 * HOUR),
    provider_session_id: "provider-1",
    live_ended_at: at(-2 * 24 * HOUR + 10 * MIN),
    live_outcome: { outcome: "technical_failure", final: true },
  });
const restart = (over = {}) =>
  live({
    id: SECOND,
    attempt: 2,
    previous_attempt_id: FIRST,
    token_hash: "2".repeat(64),
    created_at: at(-24 * HOUR),
    ...over,
  });
const decision = (sessionId, d = "restart", companyId = CO) => ({
  id: crypto.randomUUID(),
  session_id: sessionId,
  company_id: companyId,
  action: "decide_restart",
  decision: d,
  note: "synthetic",
  actor_user_id: "u-1",
  actor_role: "owner",
  created_at: at(-24 * HOUR),
});

function world({ sessions = [], actions = [] } = {}) {
  const w = fakeLiveDb({
    interview_sessions: sessions,
    live_interview_actions: actions,
    job_applications: [
      {
        id: APP,
        company_id_snapshot: CO,
        first_name: "Test",
        last_name: "Candidate",
        email: "candidate@example.test",
        job_id: JOB,
        job_title_snapshot: "Test role",
      },
    ],
    jobs: [
      {
        id: JOB,
        company_id: CO,
        title: "Test role",
        allow_rerecord: true,
        async_interview_enabled: true,
        avatar_interview_enabled: true,
      },
    ],
    interview_questions: [
      {
        id: "q1",
        job_id: JOB,
        company_id: CO,
        position: 1,
        question: "Describe a project you worked on.",
        prep_seconds: 30,
        answer_seconds: 120,
        required: true,
        competency: null,
        rubric: null,
        weight: null,
      },
    ],
    companies: [{ id: CO, name: "Test Co", candidate_reply_email: null }],
  });
  w.emails = [];
  w.jobs = [];
  globalThis.__inviteServiceForTests = () => w.service;
  globalThis.__inviteCtxForTests = { companyId: CO, memberId: "m-1", memberName: "Test Member" };
  globalThis.__inviteDeliverForTests = (input) => {
    w.emails.push(input.event);
    return { ok: true, logId: "log-1", providerId: "re_1" };
  };
  globalThis.__inviteEnqueueForTests = (job) => {
    w.jobs.push(job.type);
    return { ok: true };
  };
  globalThis.__inviteLiveGateForTests = { ok: true, settings: { interviewer_name: "Ava" } };
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

const send = () => quietly(() => sendLiveInterviewInvite(APP));
const sessionWrites = (w) =>
  w.service.queries.filter(
    (q) =>
      q.table === "interview_sessions" && q.calls.some((c) => ["update", "insert"].includes(c[0])),
  );

/** Nothing about the interview changed: no cancel, no new session, no email, no job. */
function assertUntouched(w, before, label) {
  assert.deepEqual(w.tables.interview_sessions, before, `${label}: sessions unchanged`);
  assert.deepEqual(w.emails, [], `${label}: no email`);
  assert.deepEqual(w.jobs, [], `${label}: no job`);
}

const RESTARTED_CHAINS = {
  "attempt 2 invited": [abandoned(), restart()],
  "attempt 2 invited, past its deadline": [abandoned(), restart({ expires_at: at(-HOUR) })],
  "attempt 2 expired": [abandoned(), restart({ status: "expired", expires_at: at(-HOUR) })],
  "attempt 2 started": [
    abandoned(),
    restart({ status: "started", started_at: at(-MIN), provider_session_id: "provider-2" }),
  ],
  "attempt 2 finished": [
    abandoned(),
    restart({
      status: "started",
      started_at: at(-HOUR),
      provider_session_id: "provider-2",
      live_ended_at: at(-30 * MIN),
    }),
  ],
  "attempt 2 submitted": [abandoned(), restart({ status: "submitted", submitted_at: at(-MIN) })],
};

// ── a: attempt 2 invited ────────────────────────────────────

test("a: attempt 2 invited -> refused with live_restarted", async () => {
  const w = world({ sessions: RESTARTED_CHAINS["attempt 2 invited"], actions: [decision(FIRST)] });
  assert.deepEqual(await send(w), RESTARTED);
});

test("a: attempt 2 invited -> never cancelled, no new session, no email, no job", async () => {
  const w = world({ sessions: RESTARTED_CHAINS["attempt 2 invited"], actions: [decision(FIRST)] });
  const before = structuredClone(w.tables.interview_sessions);
  await send(w);
  assertUntouched(w, before, "attempt 2 invited");
});

// ── b: attempt 2 in any other state ─────────────────────────

test("b: attempt 2 past its deadline, expired, started, finished or submitted -> refused with live_restarted", async () => {
  for (const [name, sessions] of Object.entries(RESTARTED_CHAINS)) {
    const w = world({ sessions, actions: [decision(FIRST)] });
    assert.deepEqual(await send(w), RESTARTED, name);
  }
});

test("b: attempt 2 in any state -> untouched, no new session, no email, no job", async () => {
  for (const [name, sessions] of Object.entries(RESTARTED_CHAINS)) {
    const w = world({ sessions, actions: [decision(FIRST)] });
    const before = structuredClone(w.tables.interview_sessions);
    await send(w);
    assertUntouched(w, before, name);
  }
});

// ── c, d: the decision on attempt 1 ─────────────────────────

test("c: attempt 1 abandoned with a restart decision and attempt 2 -> refused before any session write", async () => {
  const w = world({ sessions: [abandoned(), restart()], actions: [decision(FIRST)] });
  const before = structuredClone(w.tables.interview_sessions);
  assert.deepEqual(await send(w), RESTARTED);
  assert.deepEqual(sessionWrites(w), [], "no update and no insert attempted");
  assertUntouched(w, before, "c");
});

test("d: a 'no restart' decision on attempt 1 -> refused with live_restarted (not C1's live_call_started)", async () => {
  const decided = live({
    status: "started",
    started_at: at(-2 * 24 * HOUR),
    provider_session_id: "provider-1",
    live_ended_at: at(-2 * 24 * HOUR + 10 * MIN),
    live_outcome: { outcome: "technical_failure", final: true },
  });
  const w = world({ sessions: [decided], actions: [decision(FIRST, "no_restart")] });
  const before = structuredClone(w.tables.interview_sessions);
  assert.deepEqual(await send(w), DECIDED);
  assert.deepEqual(sessionWrites(w), []);
  assertUntouched(w, before, "d");
});

// ── e: unchanged sends ──────────────────────────────────────

test("e: a first live invite, and the re-send of one nobody joined, work as before", async () => {
  const first = world();
  assert.deepEqual(await send(first), {
    success: true,
    data: { expiresAt: first.tables.interview_sessions[0].expires_at },
  });
  assert.equal(first.tables.interview_sessions.length, 1);
  assert.deepEqual(
    [first.tables.interview_sessions[0].kind, first.tables.interview_sessions[0].attempt],
    ["live", 1],
  );
  assert.deepEqual(first.emails, ["interview"]);
  assert.deepEqual(first.jobs, ["interview_expiry"]);

  const again = world({ sessions: [live()] });
  const r = await send(again);
  assert.equal(r.success, true);
  assert.equal(
    again.tables.interview_sessions[0].status,
    "cancelled",
    "the unjoined invite cancelled",
  );
  assert.equal(again.tables.interview_sessions.length, 2, "a new attempt 1");
  assert.deepEqual(again.emails, ["interview"]);
  // The cancel's own filter: C1's three, and never a restart or an abandoned first attempt.
  const cancel = again.service.queries.find(
    (q) => q.table === "interview_sessions" && q.calls.some((c) => c[0] === "update"),
  );
  assert.deepEqual(
    cancel.calls.filter((c) => ["eq", "is", "neq"].includes(c[0])).map((c) => c.slice(1)),
    [
      ["id", FIRST],
      ["company_id", CO],
      ["kind", "live"],
      ["provider_session_id", null],
      ["started_at", null],
      ["live_ended_at", null],
      ["attempt", 2],
      ["status", "abandoned"],
    ],
  );
  assert.deepEqual(
    cancel.calls.filter((c) => c[0] === "neq").map((c) => c.slice(1)),
    [
      ["attempt", 2],
      ["status", "abandoned"],
    ],
  );
});

test("e: a begun call with no decision is still C1's live_call_started", async () => {
  const begun = live({ status: "started", started_at: at(-5 * MIN), provider_session_id: "p" });
  const w = world({ sessions: [begun] });
  const before = structuredClone(w.tables.interview_sessions);
  assert.deepEqual(await send(w), {
    success: false,
    error: "This AI Video Interview has already started, so a new link can't be sent.",
    code: "live_call_started",
  });
  assertUntouched(w, before, "C1");
});

// ── tenant isolation ────────────────────────────────────────

test("a restart decision on another application's or another company's session never blocks a normal invite", async () => {
  const otherApp = live({ id: "d0000000-0000-4000-8000-0000000000b1", application_id: OTHER_APP });
  const otherCo = live({ id: "d0000000-0000-4000-8000-0000000000b2", company_id: OTHER_CO });
  const otherRestart = restart({
    id: "d0000000-0000-4000-8000-0000000000b3",
    company_id: OTHER_CO,
    previous_attempt_id: otherCo.id,
  });
  const w = world({
    sessions: [otherApp, otherCo, otherRestart],
    actions: [decision(otherApp.id), decision(otherCo.id, "restart", OTHER_CO)],
  });
  const r = await send(w);
  assert.equal(r.success, true, JSON.stringify(r));
  assert.deepEqual(w.emails, ["interview"]);
  const mine = w.tables.interview_sessions.filter(
    (s) => s.application_id === APP && s.company_id === CO,
  );
  assert.deepEqual(
    mine.map((s) => [s.attempt, s.status]),
    [[1, "invited"]],
  );
  // A decision row naming this application's session but another company's never counts either.
  const crossed = world({
    sessions: [live()],
    actions: [decision(FIRST, "restart", OTHER_CO)],
  });
  assert.equal((await send(crossed)).success, true);
});

// ── g: the drawer ───────────────────────────────────────────

const panel = () => quietly(() => fetchInterviewPanel(APP, "live"));

test("g: the drawer hides its own send for a-d and links to the latest attempt; shows it for e", async () => {
  const cases = [
    ["a: attempt 2 invited", [abandoned(), restart()], [decision(FIRST)], SECOND, true],
    [
      "b: attempt 2 expired",
      RESTARTED_CHAINS["attempt 2 expired"],
      [decision(FIRST)],
      SECOND,
      true,
    ],
    [
      "b: attempt 2 started",
      RESTARTED_CHAINS["attempt 2 started"],
      [decision(FIRST)],
      SECOND,
      true,
    ],
    [
      "b: attempt 2 finished",
      RESTARTED_CHAINS["attempt 2 finished"],
      [decision(FIRST)],
      SECOND,
      true,
    ],
    ["c: abandoned with decision", [abandoned(), restart()], [decision(FIRST)], SECOND, true],
    [
      "d: no restart decided",
      [
        live({
          status: "started",
          started_at: at(-HOUR),
          provider_session_id: "p",
          live_ended_at: at(-30 * MIN),
        }),
      ],
      [decision(FIRST, "no_restart")],
      FIRST,
      false,
    ],
  ];
  for (const [name, sessions, actions, latest, restarted] of cases) {
    const w = world({ sessions, actions });
    const state = await panel(w);
    assert.deepEqual(state.session.restart, { latestSessionId: latest, restarted }, name);
    assert.deepEqual(
      liveSendControls(state.session, true),
      { allowSend: false, restartHref: `/ai-dashboard/interviews/${latest}`, restarted },
      name,
    );
  }
  for (const [name, sessions] of [
    ["e: never joined", [live()]],
    ["e: none sent", []],
  ]) {
    const w = world({ sessions });
    const state = await panel(w);
    assert.equal(state.session?.restart ?? null, null, name);
    assert.deepEqual(
      liveSendControls(state.session, true),
      { allowSend: true, restartHref: null, restarted: false },
      name,
    );
  }
  assert.deepEqual(liveSendControls(null, false), {
    allowSend: false,
    restartHref: null,
    restarted: false,
  });
});
