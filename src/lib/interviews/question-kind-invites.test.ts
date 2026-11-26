/**
 * #58 commits 3+4: the invite paths read only their own kind of question
 * (interview_questions.interview_kind, migration 082). A job here holds BOTH
 * lists, with different words and weights, so a read that crossed over would
 * show in what was frozen or counted.
 *
 *   - the async invite freezes the async list only, weights as stored;
 *   - the live invite freezes the live list only, every weight 1;
 *   - the live gate counts live questions only: 0 live is refused with the
 *     4-to-8 message whatever the async list holds, and async questions never
 *     lift a live count into or out of range;
 *   - the interview panel's count for a session invited before snapshots
 *     existed counts that session's kind only.
 *
 *   node --test src/lib/interviews/question-kind-invites.test.ts
 *
 * The send actions, the panel and the gate are the shipped code; the company
 * context, email, WhatsApp and queue are interview-invite-test-hook.mjs's
 * fakes; the database is fake-live-db.mjs, which applies filters. Synthetic data.
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../test-support/interview-invite-test-hook.mjs", import.meta.url));
// Registered last, so asked first: the REAL gate, and the live consent text as final.
register(
  `data:text/javascript,${encodeURIComponent(`
const REAL_GATE = ${JSON.stringify(new URL("./live-settings.ts", import.meta.url).href)};
export async function resolve(specifier, context, next) {
  if (specifier === "@/lib/interviews/live-settings") return { url: REAL_GATE, shortCircuit: true };
  if (specifier === "@/lib/interviews/live-consent") {
    return { url: "data:text/javascript," + encodeURIComponent("export function liveConsentReady() { return true; }"), shortCircuit: true };
  }
  return next(specifier, context);
}`)}`,
);

const { sendInterviewInvite, sendLiveInterviewInvite, fetchInterviewPanel } = await import(
  "../../app/ai-dashboard/(gated)/applicants/interview-actions.ts"
);
const { LIVE_QUESTION_COUNT_ERROR } = await import("./live-settings.ts");
const { fakeLiveDb } = await import("../../test-support/fake-live-db.mjs");

const CO = "c0000000-0000-4000-8000-000000000058";
const APP = "a0000000-0000-4000-8000-000000000058";
const JOB = "b0000000-0000-4000-8000-000000000058";

/** n questions of one kind, worded and weighted so a crossed read shows. */
const list = (kind, n, weight) =>
  Array.from({ length: n }, (_, i) => ({
    id: `${kind}-q${i + 1}`,
    job_id: JOB,
    company_id: CO,
    interview_kind: kind,
    position: i + 1,
    question: `${kind === "live" ? "Live" : "Async"} synthetic question ${i + 1}?`,
    prep_seconds: 30,
    answer_seconds: 120,
    required: true,
    competency: "Ownership",
    rubric: `${kind} guide ${i + 1}`,
    weight,
  }));

function world({ async: asyncCount, live: liveCount, sessions = [] }) {
  const w = fakeLiveDb({
    interview_sessions: sessions,
    interview_answers: [],
    job_applications: [
      {
        id: APP,
        company_id_snapshot: CO,
        first_name: "Test",
        last_name: "Candidate",
        email: "candidate@example.test",
        phone: "+10000000000",
        job_id: JOB,
        job_title_snapshot: "Test role",
        whatsapp_opt_in: false,
        whatsapp_opt_in_at: null,
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
        live_interview_mode: "structured",
        live_interview_minutes: 30,
      },
    ],
    // Async weights 4 (More); live rows hold 6 (Most), which the live freeze must not keep.
    interview_questions: [...list("async", asyncCount, 4), ...list("live", liveCount, 6)],
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
  globalThis.__inviteServiceForTests = () => w.service;
  globalThis.__inviteCtxForTests = { companyId: CO, memberId: "m-1", memberName: "Test Member" };
  globalThis.__inviteDeliverForTests = (input) => {
    w.emails.push(input.event);
    return { ok: true, logId: "log-1", providerId: "re_1" };
  };
  globalThis.__inviteEnqueueForTests = () => ({ ok: true });
  globalThis.__inviteWhatsAppForTests = () => ({ kind: "queued" });
  delete globalThis.__inviteLiveGateForTests;
  return w;
}

async function allowlisted(fn) {
  const before = process.env.AI_VIDEO_INTERVIEW_COMPANY_IDS;
  process.env.AI_VIDEO_INTERVIEW_COMPANY_IDS = CO;
  const saved = {};
  for (const m of ["error", "warn", "log"]) {
    saved[m] = console[m];
    console[m] = () => {};
  }
  try {
    return await fn();
  } finally {
    Object.assign(console, saved);
    if (before === undefined) delete process.env.AI_VIDEO_INTERVIEW_COMPANY_IDS;
    else process.env.AI_VIDEO_INTERVIEW_COMPANY_IDS = before;
  }
}

const sessionOf = (w, kind) => w.tables.interview_sessions.find((s) => s.kind === kind);
const words = (snapshot) => snapshot.map((q) => q.question.split(" ")[0]);

test("the async invite freezes the async list only, with its weights as stored", async () => {
  const w = world({ async: 5, live: 4 });
  const sent = await allowlisted(() => sendInterviewInvite(APP));
  assert.equal(sent.success, true, sent.error);
  const s = sessionOf(w, "async");
  assert.deepEqual(words(s.questions_snapshot), ["Async", "Async", "Async", "Async", "Async"]);
  assert.deepEqual(
    s.questions_snapshot.map((q) => q.id),
    ["async-q1", "async-q2", "async-q3", "async-q4", "async-q5"],
  );
  assert.deepEqual(
    s.scoring_snapshot.map((q) => [q.question_id, q.weight]),
    list("async", 5, 4).map((q) => [q.id, 4]),
  );
});

test("the live invite freezes the live list only, and every live question with weight 1", async () => {
  const w = world({ async: 5, live: 4 });
  const sent = await allowlisted(() => sendLiveInterviewInvite(APP));
  assert.equal(sent.success, true, sent.error);
  const s = sessionOf(w, "live");
  assert.deepEqual(words(s.questions_snapshot), ["Live", "Live", "Live", "Live"]);
  assert.deepEqual(
    s.scoring_snapshot.map((q) => [q.question_id, q.weight, q.rubric]),
    list("live", 4, 6).map((q, i) => [q.id, 1, `live guide ${i + 1}`]),
  );
});

test("a live invite with 0 live questions is refused with the 4-to-8 message, nothing written; the async invite is unchanged", async () => {
  const w = world({ async: 5, live: 0 });
  const live = await allowlisted(() => sendLiveInterviewInvite(APP));
  assert.deepEqual(live, { success: false, error: LIVE_QUESTION_COUNT_ERROR });
  assert.deepEqual(w.tables.interview_sessions, []);
  assert.deepEqual(w.emails, []);
  const sent = await allowlisted(() => sendInterviewInvite(APP));
  assert.equal(sent.success, true, sent.error);
  assert.equal(sessionOf(w, "async").questions_snapshot.length, 5);
});

test("the live gate counts live questions only: async ones never lift a count into or out of range", async () => {
  // 3 live + 5 async would be 8 together: still refused.
  const short = world({ async: 5, live: 3 });
  assert.deepEqual(await allowlisted(() => sendLiveInterviewInvite(APP)), {
    success: false,
    error: LIVE_QUESTION_COUNT_ERROR,
  });
  assert.deepEqual(short.tables.interview_sessions, []);
  // 4 live + 8 async would be 12 together: sent, with the 4.
  const both = world({ async: 8, live: 4 });
  const sent = await allowlisted(() => sendLiveInterviewInvite(APP));
  assert.equal(sent.success, true, sent.error);
  assert.equal(sessionOf(both, "live").questions_snapshot.length, 4);
});

test("the panel's count for a session invited before snapshots existed counts that session's kind only", async () => {
  const old = (kind) => ({
    id: `s-${kind}`,
    company_id: CO,
    application_id: APP,
    job_id: JOB,
    kind,
    status: "invited",
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    submitted_at: null,
    started_at: null,
    invited_by_name: "Test Member",
    created_at: new Date().toISOString(),
    questions_snapshot: null,
  });
  world({ async: 5, live: 7, sessions: [old("async"), old("live")] });
  const asyncPanel = await allowlisted(() => fetchInterviewPanel(APP, "async"));
  const livePanel = await allowlisted(() => fetchInterviewPanel(APP, "live"));
  assert.equal(asyncPanel.session?.total, 5, "async: the 5 async questions");
  assert.equal(livePanel.session?.total, 7, "live: the 7 live questions");
});
