/**
 * #44: each invite freezes ONE consistent question set.
 *
 * A job save (replace_interview_questions, 082) deletes and re-inserts the
 * list with new ids in one transaction. The send used to read the table two
 * (async) or three (live: the gate's count, the question snapshot, the marking
 * scheme) times, each its own statement, so a save between two reads gave a
 * count that disagreed with the snapshot, or a question snapshot paired with
 * another version's rubrics. Now: one select per send, and the count, the
 * question snapshot and the marking scheme all built from that one array.
 *
 *   node --test src/lib/interviews/invite-race.test.ts
 *
 * The send actions, the gate, the mappers and the restart decision are the
 * shipped code; the company context, email, WhatsApp and queue are
 * interview-invite-test-hook.mjs's fakes; the database is fake-live-db.mjs,
 * whose `afterSelect` commits a save between two of a caller's reads, as
 * Postgres would show it. Synthetic data.
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
const { decideLiveRestart } = await import("./live-restart.ts");
const { fakeLiveDb } = await import("../../test-support/fake-live-db.mjs");

const CO = "c0000000-0000-4000-8000-000000000044";
const APP = "a0000000-0000-4000-8000-000000000044";
const JOB = "b0000000-0000-4000-8000-000000000044";
const FIRST = "d0000000-0000-4000-8000-000000000044";
const NOW = Date.parse("2026-11-27T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();
const SEND_FAILED = "Couldn't send - please try again.";
const NO_QUESTIONS = "Add interview questions to this job first - there's nothing to ask yet.";

/** Question p of a kind: its text and its rubric name the same p, so a wrong pairing shows. */
const q = (kind, p, over = {}) => ({
  id: `${kind}-v1-q${p}`,
  job_id: JOB,
  company_id: CO,
  interview_kind: kind,
  position: p,
  question: `${kind} question ${p}?`,
  prep_seconds: 30,
  answer_seconds: 120,
  required: true,
  competency: `Skill ${p}`,
  rubric: `${kind} guide ${p}`,
  weight: kind === "async" ? 2 : 1,
  ...over,
});
const list = (kind, n) => Array.from({ length: n }, (_, i) => q(kind, i + 1));

/** The list a save sends: version `v` of n questions, in the given order of positions. */
const saveList = (kind, positions, v = 2) =>
  positions.map((p) => ({
    question: `${kind} question ${p}?`,
    competency: `Skill ${p}`,
    rubric: `${kind} guide ${p} (v${v})`,
    prep_seconds: 30,
    answer_seconds: 120,
    weight: kind === "async" ? 2 : 1,
    required: true,
  }));

function world({ live = 4, async = 3, sessions = [], job = {}, allowance = "allowed" } = {}) {
  const w = fakeLiveDb({
    interview_sessions: sessions,
    interview_answers: [],
    live_interview_actions: [],
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
        description: "A synthetic role.",
        allow_rerecord: true,
        async_interview_enabled: true,
        avatar_interview_enabled: true,
        live_interview_mode: "ai_guided",
        live_interview_minutes: 30,
        ...job,
      },
    ],
    interview_questions: [...list("live", live), ...list("async", async)],
    companies: [{ id: CO, name: "Test Co", candidate_reply_email: null }],
  });
  w.rpcs = [];
  const fakeRpc = w.service.rpc;
  w.service.rpc = async (name, args) => {
    w.rpcs.push(name);
    if (name === "replace_interview_questions") return fakeRpc(name, args);
    if (name === "consume_allowance") {
      return allowance === "allowed"
        ? {
            data: [{ allowed: true, unlimited: false, reason: "", usage_id: "usage-1" }],
            error: null,
          }
        : { data: [{ allowed: false, used: 10, allowance: 10 }], error: null };
    }
    return { data: true, error: null };
  };
  w.emails = [];
  w.enqueued = [];
  w.whatsapp = [];
  w.emailOk = true;
  globalThis.__inviteServiceForTests = () => w.service;
  globalThis.__inviteCtxForTests = { companyId: CO, memberId: "m-1", memberName: "Test Member" };
  globalThis.__inviteDeliverForTests = (input) => {
    w.emails.push(input.event);
    return w.emailOk
      ? { ok: true, logId: "log-1", providerId: "re_1" }
      : { ok: false, kind: "provider", message: "provider said no", logId: "log-1" };
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

/** A job save, through the fake's replace_interview_questions: delete + insert, new ids. */
function save(w, kind, positions, v = 2) {
  const r = w.service.rpc("replace_interview_questions", {
    p_job_id: JOB,
    p_company_id: CO,
    p_async: kind === "async" ? saveList("async", positions, v) : null,
    p_live: kind === "live" ? saveList("live", positions, v) : null,
  });
  // The fake answers synchronously under the hood; a rejected promise would surface in the test.
  return r;
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

const selectsOf = (w, table) => w.counts.selects[table] ?? 0;
const liveRows = (w) => w.tables.interview_questions.filter((r) => r.interview_kind === "live");

/** The one property #44 asks for: a session whose frozen set is one version, whole. */
function assertWhole(s, kind, label) {
  const qs = s.questions_snapshot;
  const ss = s.scoring_snapshot;
  assert.equal(qs.length, ss.length, `${label}: both snapshots the same length`);
  if (kind === "live") {
    assert.equal(
      s.live_settings.question_mix.job_questions,
      qs.length,
      `${label}: the mix counts the frozen questions`,
    );
  }
  const ids = new Set(qs.map((x) => x.id));
  for (const [i, m] of ss.entries()) {
    assert.ok(ids.has(m.question_id), `${label}: scoring entry ${i + 1} names a frozen question`);
    const asked = qs.find((x) => x.id === m.question_id);
    assert.equal(asked.position, m.position, `${label}: entry ${i + 1} at the same position`);
    // "live question 3?" is marked by "live guide 3 ..." and never by another number's guide.
    const p = asked.question.match(/question (\d+)\?/)[1];
    assert.match(m.rubric, new RegExp(`^${kind} guide ${p}\\b`), `${label}: rubric ${i + 1}`);
    assert.equal(m.competency, `Skill ${p}`, `${label}: competency ${i + 1}`);
  }
}

/* ── the race itself ─────────────────────────────────────────── */

test("live: a save from 4 to 5 questions between the send's reads: one read, and the frozen set is one whole version", async () => {
  const w = world({ live: 4 });
  // Commits right after the FIRST read of the questions. On the shipped code
  // that was the gate's count (4); the two snapshot reads then saw 5.
  w.afterSelect("interview_questions", 1, () => save(w, "live", [1, 2, 3, 4, 5]));
  const result = await allowlisted(() => sendLiveInterviewInvite(APP));
  assert.equal(result.success, true, result.error);
  const [s] = w.tables.interview_sessions;
  assertWhole(s, "live", "4 to 5");
  assert.equal(selectsOf(w, "interview_questions"), 1, "exactly one read of the questions");
  // Whichever version it froze, it froze all of it: 4 of v1 here, since the
  // save landed after the one read.
  assert.equal(s.questions_snapshot.length, 4);
  assert.equal(s.live_settings.question_mix.job_questions, 4);
});

test("live: a reorder with new rubrics between the question read and the scoring read cannot split the snapshots", async () => {
  const w = world({ live: 4 });
  // On the shipped code the second read was the question snapshot; this save
  // landed before the third, the marking scheme, which then came back reversed.
  w.afterSelect("interview_questions", 2, () => save(w, "live", [4, 3, 2, 1]));
  const result = await allowlisted(() => sendLiveInterviewInvite(APP));
  assert.equal(result.success, true, result.error);
  const [s] = w.tables.interview_sessions;
  assertWhole(s, "live", "reorder");
  assert.equal(selectsOf(w, "interview_questions"), 1);
  assert.deepEqual(
    s.scoring_snapshot.map((m) => m.question_id),
    s.questions_snapshot.map((x) => x.id),
    "the same ids in the same order",
  );
});

test("async: a save between the reads cannot split the snapshots; weights as stored", async () => {
  const w = world({ async: 3 });
  w.afterSelect("interview_questions", 1, () => save(w, "async", [3, 1, 2]));
  const result = await allowlisted(() => sendInterviewInvite(APP));
  assert.equal(result.success, true, result.error);
  const [s] = w.tables.interview_sessions;
  assertWhole(s, "async", "async");
  assert.equal(selectsOf(w, "interview_questions"), 1);
  assert.deepEqual(
    s.scoring_snapshot.map((m) => m.weight),
    [2, 2, 2],
    "async weights are frozen as stored",
  );
  assert.deepEqual(
    w.rpcs.filter((n) => n !== "replace_interview_questions"),
    ["consume_allowance"],
  );
});

test("live: every live weight is frozen as 1, and the candidate payload carries no marking fields", async () => {
  const w = world({ live: 4 });
  // The stored live weights are irrelevant: 6 here, 1 frozen.
  for (const r of liveRows(w)) r.weight = 6;
  assert.equal((await allowlisted(() => sendLiveInterviewInvite(APP))).success, true);
  const [s] = w.tables.interview_sessions;
  assert.deepEqual(
    s.scoring_snapshot.map((m) => m.weight),
    [1, 1, 1, 1],
  );
  for (const x of s.questions_snapshot) {
    assert.deepEqual(Object.keys(x).sort(), [
      "answer_seconds",
      "id",
      "position",
      "prep_seconds",
      "question",
      "required",
    ]);
  }
});

/* ── the count, from the one array, before any side effect ───── */

test("live: a save to 3 or 0 just before the read is refused with the 4-to-8 text; nothing cancelled, inserted, sent or consumed", async () => {
  for (const n of [3, 0]) {
    const open = {
      id: `e0000000-0000-4000-8000-00000000000${n}`,
      company_id: CO,
      application_id: APP,
      job_id: JOB,
      kind: "live",
      status: "invited",
      attempt: 1,
      previous_attempt_id: null,
      token_hash: "a".repeat(64),
      questions_snapshot: [{ id: "old", position: 1, question: "old?" }],
      scoring_snapshot: [{ position: 1, question_id: "old" }],
      live_settings: { v: 4 },
      expires_at: iso(NOW + 24 * HOUR),
      delete_after: iso(NOW + 180 * 24 * HOUR),
      created_at: iso(NOW - 2 * HOUR),
    };
    const w = world({ live: 4, sessions: [open] });
    // The application read comes first on both paths; the save lands right after it.
    w.afterSelect("job_applications", 1, () =>
      save(
        w,
        "live",
        Array.from({ length: n }, (_, i) => i + 1),
      ),
    );
    const before = structuredClone(w.tables);
    const result = await allowlisted(() => sendLiveInterviewInvite(APP));
    assert.deepEqual(result, { success: false, error: LIVE_QUESTION_COUNT_ERROR }, `${n}`);
    assert.deepEqual(w.tables.interview_sessions, before.interview_sessions, `${n}: untouched`);
    assert.equal(w.tables.interview_sessions[0].status, "invited", `${n}: nothing cancelled`);
    assert.deepEqual([w.emails, w.whatsapp, w.enqueued], [[], [], []], `${n}: nothing sent`);
    assert.deepEqual(
      w.rpcs.filter((r) => r !== "replace_interview_questions"),
      [],
      `${n}: no allowance`,
    );
  }
});

test("async: a save to 0 just before the read is refused; the credit is never consumed, nothing cancelled or sent", async () => {
  const open = {
    id: "e0000000-0000-4000-8000-000000000a00",
    company_id: CO,
    application_id: APP,
    job_id: JOB,
    kind: "async",
    status: "invited",
    token_hash: "b".repeat(64),
    questions_snapshot: [],
    scoring_snapshot: [],
    expires_at: iso(NOW + 24 * HOUR),
    created_at: iso(NOW - 2 * HOUR),
  };
  const w = world({ async: 3, sessions: [open] });
  w.afterSelect("job_applications", 1, () => save(w, "async", []));
  const result = await allowlisted(() => sendInterviewInvite(APP));
  assert.deepEqual(result, { success: false, error: NO_QUESTIONS });
  assert.equal(w.tables.interview_sessions.length, 1);
  assert.equal(w.tables.interview_sessions[0].status, "invited");
  assert.deepEqual(
    w.rpcs.filter((r) => r !== "replace_interview_questions"),
    [],
  );
  assert.deepEqual([w.emails, w.whatsapp, w.enqueued], [[], [], []]);
});

test("a failed question read refuses both sends with 'Couldn't send'; nothing written or consumed", async () => {
  for (const [send, label] of [
    [sendLiveInterviewInvite, "live"],
    [sendInterviewInvite, "async"],
  ]) {
    const w = world();
    w.failNext("interview_questions", "select");
    const before = structuredClone(w.tables);
    const result = await allowlisted(() => send(APP));
    assert.deepEqual(result, { success: false, error: SEND_FAILED }, label);
    assert.deepEqual(w.tables, before, label);
    assert.deepEqual(w.rpcs, [], `${label}: no allowance`);
    assert.deepEqual([w.emails, w.whatsapp, w.enqueued], [[], [], []], label);
  }
});

/* ── the gate ────────────────────────────────────────────────── */

test("the gate reads the job row only: no interview_questions select in live-settings.ts, and one in the whole live send", async () => {
  const src = readFileSync(new URL("./live-settings.ts", import.meta.url), "utf8");
  assert.ok(!src.includes('"interview_questions"'), "the gate no longer counts the table itself");
  assert.match(src, /jobQuestionCount: number/, "the count is an input to the gate");
  const w = world({ live: 5 });
  assert.equal((await allowlisted(() => sendLiveInterviewInvite(APP))).success, true);
  assert.equal(selectsOf(w, "interview_questions"), 1);
  assert.equal(selectsOf(w, "jobs"), 1, "the gate's one job-row read");
  // The one read selects exactly an InviteQuestionRow's columns: both mappers' needs, nothing else.
  const actions = readFileSync(
    new URL("../../app/ai-dashboard/(gated)/applicants/interview-actions.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    actions,
    /const INVITE_QUESTION_COLUMNS =\s*"id, position, question, prep_seconds, answer_seconds, required, competency, rubric, weight";/,
  );
  assert.match(actions, /\.from\("interview_questions"\)\s*\.select\(INVITE_QUESTION_COLUMNS\)/);
  const snapshots = readFileSync(new URL("./invite-snapshots.ts", import.meta.url), "utf8");
  const rowType = snapshots.slice(snapshots.indexOf("export type InviteQuestionRow = {"));
  const fields = [...rowType.slice(0, rowType.indexOf("};")).matchAll(/^\s+(\w+):/gm)].map(
    (m) => m[1],
  );
  assert.deepEqual(fields, [
    "id",
    "position",
    "question",
    "prep_seconds",
    "answer_seconds",
    "required",
    "competency",
    "rubric",
    "weight",
  ]);
});

test("a job settings save between the gate's job-row read and the insert: the frozen settings are the one read's, and the snapshot is whole", async () => {
  for (const change of [
    { live_interview_mode: "structured" },
    { live_interview_minutes: 60 },
    { avatar_interview_enabled: false },
  ]) {
    const w = world({
      live: 4,
      job: { live_interview_mode: "ai_guided", live_interview_minutes: 30 },
    });
    w.afterSelect("jobs", 1, (tables) => Object.assign(tables.jobs[0], change));
    const result = await allowlisted(() => sendLiveInterviewInvite(APP));
    assert.equal(result.success, true, `${JSON.stringify(change)}: ${result.error}`);
    const [s] = w.tables.interview_sessions;
    assert.equal(s.live_settings.interview_mode, "ai_guided", JSON.stringify(change));
    assert.equal(s.live_settings.max_follow_ups_per_base_question, 2, JSON.stringify(change));
    assert.equal(s.live_settings.max_session_seconds, 1800, JSON.stringify(change));
    assert.equal(s.live_settings.question_mix.job_questions, 4);
    assertWhole(s, "live", JSON.stringify(change));
    assert.equal(selectsOf(w, "jobs"), 1, "the job row was read once");
  }
});

/* ── immutability ────────────────────────────────────────────── */

test("restart after a job save: attempt 2 copies attempt 1's frozen set; the restart reads no questions and sends none", async () => {
  const first = {
    id: FIRST,
    company_id: CO,
    application_id: APP,
    job_id: JOB,
    kind: "live",
    attempt: 1,
    previous_attempt_id: null,
    status: "started",
    token_hash: "1".repeat(64),
    live_ended_at: iso(NOW - 2 * HOUR),
    live_outcome: { v: 6, outcome: "technical_failure", final: true },
    live_settings: { v: 4, question_mix: { job_questions: 4 } },
    questions_snapshot: list("live", 4).map(({ id, position, question }) => ({
      id,
      position,
      question,
      prep_seconds: 30,
      answer_seconds: 120,
      required: true,
    })),
    scoring_snapshot: list("live", 4).map((r) => ({
      position: r.position,
      question_id: r.id,
      competency: r.competency,
      rubric: r.rubric,
      weight: 1,
    })),
    expires_at: iso(NOW + 24 * HOUR),
    delete_after: iso(NOW + 180 * 24 * HOUR),
    created_at: iso(NOW - 48 * HOUR),
  };
  const w = world({ live: 4, sessions: [first] });
  const frozen = structuredClone({ q: first.questions_snapshot, s: first.scoring_snapshot });
  // The recruiter rewrites the job's list after the first attempt.
  await save(w, "live", [5, 6, 7, 8, 1]);
  assert.equal(liveRows(w).length, 5);
  // live_restart_session as 053 writes it: a copy of attempt 1, enforced by its trigger.
  const rpcArgs = [];
  const baseRpc = w.service.rpc;
  w.service.rpc = async (name, args) => {
    if (name !== "live_restart_session") return baseRpc(name, args);
    rpcArgs.push(args);
    const prev = w.tables.interview_sessions.find((s) => s.id === args.p_session_id);
    prev.status = "abandoned";
    w.tables.live_interview_actions.push({ session_id: prev.id, action: "decide_restart" });
    w.tables.interview_sessions.push({
      ...structuredClone(prev),
      id: args.p_new_session_id,
      token_hash: args.p_token_hash,
      status: "invited",
      attempt: 2,
      previous_attempt_id: prev.id,
      live_ended_at: null,
      live_outcome: null,
      expires_at: iso(NOW + 72 * HOUR),
    });
    return { data: iso(NOW + 72 * HOUR), error: null };
  };
  const readsBefore = selectsOf(w, "interview_questions");
  const result = await allowlisted(() =>
    decideLiveRestart({
      service: w.service,
      sessionId: FIRST,
      actor: { userId: "u-1", memberId: "m-1", name: "Owner", role: "owner", companyId: CO },
      decision: "restart",
      note: "Call dropped.",
      now: () => NOW,
    }),
  );
  assert.equal(result.ok, true, result.code);
  assert.equal(selectsOf(w, "interview_questions"), readsBefore, "no questions read");
  assert.equal(rpcArgs.length, 1);
  for (const k of Object.keys(rpcArgs[0])) {
    assert.ok(!/question|snapshot|settings/.test(k), `the restart sends no ${k}`);
  }
  const second = w.tables.interview_sessions.find((s) => s.attempt === 2);
  assert.deepEqual(second.questions_snapshot, frozen.q, "attempt 2 asks attempt 1's questions");
  assert.deepEqual(second.scoring_snapshot, frozen.s, "and is marked by attempt 1's scheme");
  assert.notDeepEqual(
    second.questions_snapshot.map((x) => x.question),
    liveRows(w)
      .sort((a, b) => a.position - b.position)
      .map((r) => r.question),
    "the job's current list is not what attempt 2 asks",
  );
  // The database enforces the copy: 053's insert copies attempt 1's columns and its trigger refuses a difference.
  const sql = readFileSync(
    new URL("../supabase/migrations/053_live_restart_decision.sql", import.meta.url),
    "utf8",
  );
  assert.match(sql, /prev\.questions_snapshot, prev\.scoring_snapshot/);
  assert.match(sql, /new\.questions_snapshot is distinct from prev\.questions_snapshot/);
  assert.match(sql, /new\.scoring_snapshot is distinct from prev\.scoring_snapshot/);
});

test("re-send after a job save: a NEW session with the new set; the old one is cancelled with its own snapshot untouched", async () => {
  const w = world({ live: 4 });
  assert.equal((await allowlisted(() => sendLiveInterviewInvite(APP))).success, true);
  const [old] = w.tables.interview_sessions;
  const oldFrozen = structuredClone({ q: old.questions_snapshot, s: old.scoring_snapshot });
  // Not a double click: the first link went out two minutes ago.
  old.created_at = iso(Date.now() - 2 * 60 * 1000);
  await save(w, "live", [1, 2, 3, 4, 5, 6]);
  w.emails.length = 0;
  const again = await allowlisted(() => sendLiveInterviewInvite(APP));
  assert.equal(again.success, true, again.error);
  assert.equal(w.tables.interview_sessions.length, 2);
  const [first, second] = w.tables.interview_sessions;
  assert.equal(first.status, "cancelled");
  assert.deepEqual(first.questions_snapshot, oldFrozen.q, "the old row's snapshot is as it was");
  assert.deepEqual(first.scoring_snapshot, oldFrozen.s);
  assert.equal(second.status, "invited");
  assert.equal(second.questions_snapshot.length, 6, "the re-send asks the current questions");
  assert.match(second.scoring_snapshot[0].rubric, /\(v2\)$/, "with the current rubrics");
  assertWhole(second, "live", "re-send");
  assert.deepEqual(w.emails, ["interview"], "one new email");
});

/* ── order of writes ─────────────────────────────────────────── */

test("the insert fails: no email, no WhatsApp, no job; the async credit goes back", async () => {
  const live = world({ live: 4 });
  live.failNext("interview_sessions", "insert");
  assert.deepEqual(await allowlisted(() => sendLiveInterviewInvite(APP)), {
    success: false,
    error: SEND_FAILED,
  });
  assert.deepEqual([live.emails, live.whatsapp, live.enqueued], [[], [], []]);
  assert.deepEqual(live.tables.interview_sessions, []);

  const w = world({ async: 3 });
  w.failNext("interview_sessions", "insert");
  assert.deepEqual(await allowlisted(() => sendInterviewInvite(APP)), {
    success: false,
    error: SEND_FAILED,
  });
  assert.deepEqual(w.rpcs, ["consume_allowance", "release_allowance"], "reserved, then released");
  assert.deepEqual([w.emails, w.whatsapp, w.enqueued], [[], [], []]);
  assert.deepEqual(w.tables.interview_sessions, []);
});

test("the email fails: the complete row was saved first, then cancelled; no WhatsApp, no job; the async credit goes back", async () => {
  for (const [send, kind] of [
    [sendLiveInterviewInvite, "live"],
    [sendInterviewInvite, "async"],
  ]) {
    const w = world();
    w.emailOk = false;
    const result = await allowlisted(() => send(APP));
    assert.equal(result.success, false, kind);
    assert.equal(result.error, "The email couldn't be sent - please try again.", kind);
    const [s] = w.tables.interview_sessions;
    assert.equal(s.status, "cancelled", `${kind}: nobody can reach it`);
    assertWhole(s, kind, `${kind}: the row that was saved before the email was whole`);
    assert.deepEqual(w.emails, ["interview"], `${kind}: the one attempt`);
    assert.deepEqual([w.whatsapp, w.enqueued], [[], []], kind);
    if (kind === "async") {
      assert.deepEqual(w.rpcs, ["consume_allowance", "release_allowance"]);
    }
  }
});

test("the allowance is refused: nothing inserted, cancelled or sent", async () => {
  const open = {
    id: "e0000000-0000-4000-8000-000000000a01",
    company_id: CO,
    application_id: APP,
    job_id: JOB,
    kind: "async",
    status: "invited",
    token_hash: "c".repeat(64),
    expires_at: iso(NOW + 24 * HOUR),
    created_at: iso(NOW - 2 * HOUR),
  };
  const w = world({ async: 3, sessions: [open], allowance: "refused" });
  const result = await allowlisted(() => sendInterviewInvite(APP));
  assert.equal(result.success, false);
  assert.match(result.error, /limit/i);
  assert.deepEqual(w.rpcs, ["consume_allowance"]);
  assert.equal(w.tables.interview_sessions.length, 1);
  assert.equal(w.tables.interview_sessions[0].status, "invited", "the open link stays");
  assert.deepEqual([w.emails, w.whatsapp, w.enqueued], [[], [], []]);
});
