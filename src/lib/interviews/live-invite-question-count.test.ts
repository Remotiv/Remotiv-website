/**
 * #19: an AI Video Interview is sent only for a job with 4 to 8 interview
 * questions, checked on the server by gateLiveInterviewInvite
 * (lib/interviews/live-settings.ts) before the send writes, freezes or sends
 * anything. Restart keeps the original snapshot; async invites are untouched.
 *
 *   node --test src/lib/interviews/live-invite-question-count.test.ts
 *
 * The send actions are the shipped code and so is the gate: the hook below
 * puts the real live-settings module back in place of the invite hook's stub.
 * The company context, email, WhatsApp and queue are the fakes of
 * interview-invite-test-hook.mjs; the database is fake-live-db.mjs, which
 * applies filters and limits. Synthetic data.
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

const { sendInterviewInvite, sendLiveInterviewInvite } = await import(
  "../../app/ai-dashboard/(gated)/applicants/interview-actions.ts"
);
const { LIVE_QUESTION_COUNT_ERROR } = await import("./live-settings.ts");
const { fakeLiveDb } = await import("../../test-support/fake-live-db.mjs");

const CO = "c0000000-0000-4000-8000-000000000019";
const APP = "a0000000-0000-4000-8000-000000000019";
const JOB = "b0000000-0000-4000-8000-000000000019";
const TEXT =
  "This job needs 4 to 8 interview questions for an AI Video Interview. Please update the questions and try again.";

function world(questionCount) {
  const w = fakeLiveDb({
    interview_sessions: [],
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
        avatar_interviewer_name: "Sarah",
        live_interview_mode: "structured",
        live_interview_minutes: 30,
      },
    ],
    interview_questions: Array.from({ length: questionCount }, (_, i) => ({
      id: `q${i + 1}`,
      job_id: JOB,
      company_id: CO,
      position: i + 1,
      question: `Synthetic question ${i + 1}?`,
      prep_seconds: 30,
      answer_seconds: 120,
      required: true,
      competency: null,
      rubric: null,
      weight: null,
    })),
    companies: [{ id: CO, name: "Test Co", candidate_reply_email: null }],
  });
  w.rpcs = [];
  w.service.rpc = async (name) => {
    w.rpcs.push(name);
    return name === "consume_allowance"
      ? {
          data: [{ allowed: true, unlimited: true, reason: "unlimited", usage_id: "usage-1" }],
          error: null,
        }
      : { data: true, error: null };
  };
  w.emails = [];
  w.enqueued = [];
  w.whatsapp = [];
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
  globalThis.__inviteWhatsAppForTests = (input) => {
    w.whatsapp.push(input);
    return { kind: "queued" };
  };
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

test("the refusal text is the approved one", () => {
  assert.equal(LIVE_QUESTION_COUNT_ERROR, TEXT);
});

test("3 or 9 questions (and 0): refused with the exact text, and nothing happens at all", async () => {
  for (const n of [0, 3, 9]) {
    const w = world(n);
    const before = structuredClone(w.tables);
    const result = await allowlisted(() => sendLiveInterviewInvite(APP));
    assert.deepEqual(result, { success: false, error: TEXT }, `${n} questions`);
    assert.deepEqual(w.tables, before, `${n}: no session row, nothing cancelled or frozen`);
    assert.deepEqual(w.emails, [], `${n}: no email`);
    assert.deepEqual(w.whatsapp, [], `${n}: no WhatsApp`);
    assert.deepEqual(w.enqueued, [], `${n}: no job enqueued`);
    assert.deepEqual(w.rpcs, [], `${n}: no allowance used`);
  }
});

test("4 and 8 questions: sent, with all of them frozen and the count in the mix", async () => {
  for (const n of [4, 8]) {
    const w = world(n);
    const result = await allowlisted(() => sendLiveInterviewInvite(APP));
    assert.equal(result.success, true, `${n}: ${result.error}`);
    const sessions = w.tables.interview_sessions;
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].kind, "live");
    assert.equal(sessions[0].questions_snapshot.length, n);
    assert.equal(sessions[0].live_settings.v, 4);
    assert.equal(sessions[0].live_settings.question_mix.job_questions, n);
    assert.deepEqual(w.emails, ["interview"]);
  }
});

test("a failed count read still refuses with the existing text, nothing written", async () => {
  const w = world(6);
  w.failNext("interview_questions", "select");
  const before = structuredClone(w.tables);
  const result = await allowlisted(() => sendLiveInterviewInvite(APP));
  assert.deepEqual(result, { success: false, error: "Couldn't send - please try again." });
  assert.deepEqual(w.tables, before);
  assert.deepEqual([w.emails, w.whatsapp, w.enqueued], [[], [], []]);
});

test("a live re-send to a job now outside 4..8 is refused, and the open invite is left alone", async () => {
  const w = world(4);
  assert.equal((await allowlisted(() => sendLiveInterviewInvite(APP))).success, true);
  // The recruiter then adds a fifth to ninth question and presses Send again.
  for (let i = 5; i <= 9; i += 1) {
    w.tables.interview_questions.push({
      ...w.tables.interview_questions[0],
      id: `q${i}`,
      position: i,
    });
  }
  const sent = structuredClone(w.tables.interview_sessions);
  w.emails.length = 0;
  w.enqueued.length = 0;
  const result = await allowlisted(() => sendLiveInterviewInvite(APP));
  assert.deepEqual(result, { success: false, error: TEXT });
  assert.deepEqual(w.tables.interview_sessions, sent, "not cancelled, not changed");
  assert.deepEqual([w.emails, w.enqueued], [[], []]);
});

test("async invites are unaffected: 3 or 9 questions send as before, never through the live gate", async () => {
  for (const n of [3, 9]) {
    const w = world(n);
    const result = await allowlisted(() => sendInterviewInvite(APP));
    assert.equal(result.success, true, `${n}: ${result.error}`);
    assert.equal(w.tables.interview_sessions[0].kind, "async");
    assert.equal(w.tables.interview_sessions[0].live_settings ?? null, null);
  }
});

/* ── every path that creates or re-sends a live invite ─────────── */

const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");
const ACTIONS = read("../../app/ai-dashboard/(gated)/applicants/interview-actions.ts");
const PANEL = read("../../app/ai-dashboard/(gated)/applicants/_interview-panel.tsx");
const RESTART = read("./live-restart.ts");

function body(text, signature) {
  const start = text.indexOf(signature);
  assert.ok(start > 0, signature);
  return text.slice(start, text.indexOf("\n}\n", start));
}

test("source: the live send calls the gate before anything is cancelled, created or sent", () => {
  const send = body(ACTIONS, "export async function sendLiveInterviewInvite(");
  const gate = send.indexOf("await gateLiveInterviewInvite(");
  assert.ok(gate > 0);
  assert.match(
    send.slice(gate),
    /^await gateLiveInterviewInvite\([^)]*\);\n\s+if \(!gate\.ok\) return \{ success: false, error: gate\.error \};/,
  );
  for (const effect of [
    "supersedeOpenSession(",
    ".insert(",
    "deliverInvite",
    "enqueue(",
    "queueManualWhatsApp(",
    "consume",
  ]) {
    const at = send.indexOf(effect);
    assert.ok(at === -1 || at > gate, `${effect} comes after the gate`);
  }
});

test("source: the only TypeScript writer of a live session row is that send", () => {
  // Every interview_sessions insert in the app is in interview-actions.ts: the
  // async send and the live send. A live row is otherwise only created by the
  // restart RPC, which copies the original (next test).
  const inserts = [...ACTIONS.matchAll(/\.insert\(\{\n(?:[^\n]*\n){0,12}?\s+kind: "(\w+)"/g)].map(
    (m) => m[1],
  );
  assert.deepEqual(inserts.sort(), ["async", "live"]);
  assert.equal((ACTIONS.match(/gateLiveInterviewInvite\(/g) ?? []).length, 1);
  // Send, Send again and a retry after an error are one handler calling that action.
  assert.equal((PANEL.match(/await sendLiveInterviewInvite\(/g) ?? []).length, 1);
});

test("source: restart keeps the original snapshot: no gate, no count, the SQL copies it", () => {
  assert.doesNotMatch(RESTART, /gateLiveInterviewInvite|interview_questions|live-settings/);
  assert.match(RESTART, /service\.rpc\("live_restart_session"/);
  const sql = read("../supabase/migrations/055_live_restart_link_events.sql");
  const last = sql.lastIndexOf("insert into public.interview_sessions");
  assert.match(
    sql.slice(last, last + 700),
    /'invited', 'live', prev\.live_settings, 2, prev\.id, false,\s+prev\.questions_snapshot, prev\.scoring_snapshot,/,
  );
});

/* ── 24 Nov: mode and length frozen at invite; edits reach only a new invite ── */

test("editing the job's mode and length after an invite leaves that invite byte-equal; a new invite gets the new values", async () => {
  const w = world(6);
  Object.assign(w.tables.jobs[0], { live_interview_mode: "ai_guided", live_interview_minutes: 60 });
  assert.equal((await allowlisted(() => sendLiveInterviewInvite(APP))).success, true);
  const first = w.tables.interview_sessions[0];
  assert.deepEqual(
    [
      first.live_settings.interview_mode,
      first.live_settings.max_follow_ups_per_base_question,
      first.live_settings.max_session_seconds,
    ],
    ["ai_guided", 2, 3600],
  );
  // What Postgres fills in on insert and the fake does not: nobody has joined yet.
  Object.assign(first, {
    id: first.id ?? "d0000000-0000-4000-8000-000000000019",
    // Sent an hour ago, outside the double-send guard.
    created_at: new Date(Date.now() - 60 * 60_000).toISOString(),
    started_at: null,
    submitted_at: null,
    provider_session_id: null,
    live_ended_at: null,
    live_outcome: null,
  });
  const frozen = JSON.stringify(first.live_settings);
  const snapshot = JSON.stringify(first.questions_snapshot);

  // The recruiter switches to Recruiter-Defined, 30 minutes, then sends again.
  Object.assign(w.tables.jobs[0], {
    live_interview_mode: "structured",
    live_interview_minutes: 30,
  });
  assert.equal((await allowlisted(() => sendLiveInterviewInvite(APP))).success, true);
  assert.equal(
    JSON.stringify(first.live_settings),
    frozen,
    "the first invite's settings, byte-equal",
  );
  assert.equal(JSON.stringify(first.questions_snapshot), snapshot);
  const second = w.tables.interview_sessions.find((s) => s.id !== first.id);
  assert.deepEqual(
    [
      second.live_settings.interview_mode,
      second.live_settings.max_follow_ups_per_base_question,
      second.live_settings.max_session_seconds,
    ],
    ["structured", 0, 1800],
  );
});

test("restart copies attempt 1's live_settings whole (mode, limit, length) and never reads the job", () => {
  assert.doesNotMatch(RESTART, /from\("jobs"\)|live_interview_mode|live_interview_minutes/);
  const sql = read("../supabase/migrations/055_live_restart_link_events.sql");
  const start = sql.lastIndexOf("create or replace function public.live_restart_session(");
  const body = sql.slice(start, sql.indexOf("\n$$;", start));
  assert.doesNotMatch(body, /public\.jobs\b|\bjobs\./, "the restart never reads the job");
  // The new attempt's settings ARE the old attempt's: mode, follow-up limit and length with them.
  assert.match(body, /'invited', 'live', prev\.live_settings, 2, prev\.id, false,/);
  assert.match(body, /select \* into prev\s+from public\.interview_sessions/);
});
