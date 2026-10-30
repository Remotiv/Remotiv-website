/**
 * "Send it again" never replaces a live interview whose call has begun
 * (F10 C1): finished, running or crashed. A live invite nobody joined, and
 * every async session, are re-sent exactly as before.
 *
 *   node --test "src/app/ai-dashboard/(gated)/applicants/live-resend.test.ts"
 *
 * The send actions, the allowance module and the token minting are the shipped
 * code. The company context, the email path and the queue are the fakes of
 * interview-invite-test-hook.mjs; the database is fake-live-db.mjs, so every
 * filter on the cancelling update is applied, not assumed. Synthetic data.
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../../../test-support/interview-invite-test-hook.mjs", import.meta.url));

const { sendInterviewInvite, sendLiveInterviewInvite } = await import("./interview-actions.ts");
const { liveSummaryCallBegan } = await import("../../../../lib/interviews/live-call.ts");
const { fakeLiveDb } = await import("../../../../test-support/fake-live-db.mjs");

const CO = "c0000000-0000-4000-8000-000000000001";
const APP = "a0000000-0000-4000-8000-000000000001";
const JOB = "b0000000-0000-4000-8000-000000000001";
const OLD = "d0000000-0000-4000-8000-000000000001";
const MIN = 60_000;
const at = (msFromNow) => new Date(Date.now() + msFromNow).toISOString();

const REFUSED = {
  success: false,
  error: "This AI Video Interview has already started, so a new link can't be sent.",
  code: "live_call_started",
};

/** The open session already sent to the candidate, before this re-send. */
const old = (over = {}) => ({
  id: OLD,
  company_id: CO,
  application_id: APP,
  job_id: JOB,
  kind: "live",
  status: "invited",
  expires_at: at(2 * 24 * 60 * MIN),
  created_at: at(-60 * MIN),
  submitted_at: null,
  started_at: null,
  provider_session_id: null,
  live_ended_at: null,
  live_outcome: null,
  ...over,
});

/** A call that began `ago` ms ago, as the start route writes it. */
const began = (ago) => ({
  status: "started",
  started_at: at(-ago),
  provider_session_id: `provider-${ago}`,
});

const LIVE_STATES = {
  completed: old({
    ...began(40 * MIN),
    live_ended_at: at(-5 * MIN),
    live_outcome: { outcome: "completed", final: true },
  }),
  running: old(began(5 * MIN)),
  crashed: old(began(3 * 60 * MIN)),
};

function world(sessions) {
  const w = fakeLiveDb({
    interview_sessions: sessions,
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
  w.service.rpc = async (name) =>
    name === "consume_allowance"
      ? {
          data: [{ allowed: true, unlimited: true, reason: "unlimited", usage_id: "usage-1" }],
          error: null,
        }
      : { data: true, error: null };
  w.emails = [];
  w.enqueued = [];
  globalThis.__inviteServiceForTests = () => w.service;
  globalThis.__inviteCtxForTests = { companyId: CO, memberId: "m-1", memberName: "Test Member" };
  globalThis.__inviteDeliverForTests = (input) => {
    w.emails.push(input.event);
    return { ok: true, logId: "log-1", providerId: "re_1" };
  };
  globalThis.__inviteEnqueueForTests = (job) => {
    w.enqueued.push(job.type);
    return { ok: true };
  };
  globalThis.__inviteLiveGateForTests = { ok: true, settings: { interviewer_name: "Ava" } };
  return w;
}

const sessions = (w) => w.tables.interview_sessions;

async function quietly(fn) {
  const saved = {};
  for (const m of ["error", "warn", "log"]) {
    saved[m] = console[m];
    console[m] = () => {};
  }
  try {
    return await fn();
  } finally {
    Object.assign(console, saved);
  }
}

for (const [state, label] of [
  ["completed", "a"],
  ["running", "b"],
  ["crashed", "c"],
]) {
  test(`${label}: live, ${state} -> re-send refused, the session untouched, nothing sent`, async () => {
    const w = world([LIVE_STATES[state]]);
    const before = structuredClone(sessions(w));
    const result = await quietly(() => sendLiveInterviewInvite(APP));
    assert.deepEqual(result, REFUSED);
    assert.deepEqual(sessions(w), before, "no session changed, none created");
    assert.deepEqual(w.emails, []);
    assert.deepEqual(w.enqueued, []);
  });
}

test("d: live invite never joined -> re-sent as today", async () => {
  const w = world([old()]);
  const result = await quietly(() => sendLiveInterviewInvite(APP));
  assert.equal(result.success, true);
  assert.equal(sessions(w).length, 2);
  assert.equal(sessions(w)[0].status, "cancelled", "the old link stops working");
  assert.equal(sessions(w)[1].status, "invited");
  assert.equal(sessions(w)[1].kind, "live");
  assert.deepEqual(w.emails, ["interview"]);
  assert.deepEqual(w.enqueued, ["interview_expiry"]);
});

test("e: the candidate joins between the read and the write -> refused, nothing cancelled", async () => {
  const w = world([old()]);
  const from = w.service.from.bind(w.service);
  let reads = 0;
  w.service.from = (table) => {
    // The second interview_sessions call is the cancelling update: the candidate joins just before it.
    if (table === "interview_sessions" && ++reads === 2) Object.assign(sessions(w)[0], began(0));
    return from(table);
  };
  const result = await quietly(() => sendLiveInterviewInvite(APP));
  assert.deepEqual(result, REFUSED);
  assert.equal(sessions(w).length, 1, "no new session");
  assert.equal(sessions(w)[0].status, "started", "the joined call is not cancelled");
  assert.deepEqual(w.emails, []);
});

test("f: async, started or invited -> re-sent exactly as today; submitted refused as today", async () => {
  for (const over of [
    { kind: "async", status: "started", started_at: at(-30 * MIN) },
    { kind: "async" },
  ]) {
    const w = world([old(over)]);
    const result = await quietly(() => sendInterviewInvite(APP));
    assert.equal(result.success, true, over.status ?? "invited");
    assert.equal(sessions(w).length, 2);
    assert.equal(sessions(w)[0].status, "cancelled");
    assert.equal(sessions(w)[1].kind, "async");
    assert.equal(sessions(w)[1].status, "invited");
    assert.deepEqual(w.emails, ["interview"]);
  }
  const w = world([old({ kind: "async", status: "submitted", submitted_at: at(-MIN) })]);
  const result = await quietly(() => sendInterviewInvite(APP));
  assert.deepEqual(result, {
    success: false,
    error: "They've already submitted this interview. Answers can't be re-recorded.",
  });
  assert.equal(sessions(w).length, 1);
});

test("g: the drawer hides 'Send it again' once a live call began, and shows it for an unjoined invite", () => {
  const summary = (s) => ({ kind: s.kind, status: s.status, startedAt: s.started_at });
  for (const state of ["completed", "running", "crashed"]) {
    assert.equal(liveSummaryCallBegan(summary(LIVE_STATES[state])), true, state);
  }
  assert.equal(liveSummaryCallBegan(summary(old())), false, "never joined");
  assert.equal(
    liveSummaryCallBegan(summary(old({ kind: "async", status: "started", started_at: at(-MIN) }))),
    false,
    "async is never hidden",
  );

  // Wired: the re-send block renders only when no call began, and the line only when one did.
  const panel = readFileSync(new URL("./_interview-panel.tsx", import.meta.url), "utf8");
  assert.match(panel, /const callBegan = session !== null && liveSummaryCallBegan\(session\);/);
  assert.match(panel, /\{canSend &&\s+waiting &&\s+session &&\s+!callBegan &&\s+\(reissuing \?/);
  assert.match(panel, /\{canSend && waiting && session && callBegan && \(/);
});
