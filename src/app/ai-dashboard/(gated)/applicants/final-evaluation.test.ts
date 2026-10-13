/**
 * Final interview evaluations and the outcome (completed / no-show), run as
 * shipped against the fake team in final-interview-world.mjs.
 *
 *   node --test "src/app/ai-dashboard/(gated)/applicants/final-evaluation.test.ts"
 *
 * canAccessJob is the real rule (owner and admin pass on role; a recruiter or
 * hiring manager needs a job_hiring_team row), applied to the fake's rows.
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../../../test-support/final-interview-test-hook.mjs", import.meta.url));

const { APP, CO, JOB, finalInterviewWorld, makeDb, writes } = await import(
  "../../../../test-support/final-interview-world.mjs"
);
const { NOT_AN_OUTCOME_ROLE, NOT_STARTED_YET } = await import(
  "../../../../lib/final-interviews/constants.ts"
);
const {
  listFinalEvaluations,
  listFinalInterviews,
  setFinalInterviewOutcome,
  submitFinalEvaluation,
} = await import("./final-interview-actions.ts");

const HOUR = 60 * 60 * 1000;
const PAST = new Date(Date.now() - 2 * HOUR).toISOString();
const FUTURE = new Date(Date.now() + 24 * HOUR).toISOString();
const NOT_FOUND = "Final interview not found in your workspace.";
const CANCELLED_CLOSED = "Evaluations are closed for a cancelled interview.";
const NO_SHOW_NEW_CLOSED =
  "This interview was marked no-show, so new evaluations are closed. Existing ones can still be edited.";

const MEMBERS = {
  "m-owner": "owner",
  "m-admin": "admin",
  "m-host": "recruiter",
  "m-team": "recruiter",
  "m-hm": "hiring_manager",
  "m-off": "recruiter",
};

const ctxAs = (memberId, companyId = CO) => ({
  companyId,
  role: MEMBERS[memberId] ?? "owner",
  memberId,
  memberName: memberId,
  user: { id: `u-${memberId}`, email: `${memberId}@acme.test` },
  company: { name: "Acme", contact_name: "Olive Owner" },
});

/** The real canAccessJob rule, on the fake's job_hiring_team rows. */
const jobAccess = (db) => (ctx, jobId) =>
  !(ctx.role === "recruiter" || ctx.role === "hiring_manager") ||
  db.job_hiring_team.some(
    (t) => t.company_id === ctx.companyId && t.job_id === jobId && t.member_id === ctx.memberId,
  );

const FI = (over = {}) => ({
  id: "fi-1",
  company_id: CO,
  job_id: JOB,
  application_id: APP,
  interview_type: "cto",
  custom_label: null,
  host_member_id: "m-host",
  status: "active",
  created_by: "u-rec",
  created_by_name: "Rae Recruiter",
  created_at: "2026-10-01T00:00:00.000Z",
  cancelled_at: null,
  completed_at: null,
  ...over,
});

const booking = (over = {}) => ({
  id: "b-1",
  company_id: CO,
  application_id: APP,
  job_id: JOB,
  host_member_id: "m-host",
  duration_minutes: 30,
  status: "booked",
  scheduled_start: PAST,
  scheduled_end: PAST,
  purpose: "final",
  final_interview_id: "fi-1",
  expires_at: FUTURE,
  created_at: "2026-10-02T00:00:00.000Z",
  ...over,
});

const evaluation = (memberId, over = {}) => ({
  id: `ev-${memberId}`,
  final_interview_id: "fi-1",
  company_id: CO,
  member_id: memberId,
  rating: 4,
  recommendation: "yes",
  basis: "attended",
  notes: `notes by ${memberId}`,
  submitted_at: "2026-10-03T10:00:00.000Z",
  updated_at: "2026-10-03T10:00:00.000Z",
  ...over,
});

/** A db with one final interview whose booked call started two hours ago. */
function started({ fi = {}, bookings = [booking()], evaluations = [] } = {}) {
  const db = makeDb();
  db.final_interviews.push(FI(fi));
  db.interview_bookings.push(...bookings);
  db.final_interview_evaluations.push(...evaluations);
  return db;
}

async function as(memberId, act, db, { companyId = CO } = {}) {
  const service = finalInterviewWorld(db);
  globalThis.__fiServiceForTests = () => service;
  globalThis.__fiCtxForTests = ctxAs(memberId, companyId);
  globalThis.__fiCanAccessJob = jobAccess(db);
  globalThis.__fiEmails = [];
  globalThis.__fiHostEmails = [];
  globalThis.__fiBell = [];
  const quiet = console.error;
  console.error = () => {};
  try {
    return { result: await act(), service, db };
  } finally {
    console.error = quiet;
  }
}

const VALID = {
  finalInterviewId: "fi-1",
  rating: 4,
  recommendation: "strong_yes",
  basis: "watched_recording",
  notes: "  Clear thinker.  ",
};

const allWrites = (service) =>
  service.queries.flatMap((q) =>
    q.calls
      .filter((c) => ["insert", "update", "upsert", "delete"].includes(c[0]))
      .map((c) => [q.table, ...c]),
  );

/* ── who may evaluate ─────────────────────────────────────────────── */

test("everyone who can access the job may evaluate: host, extra interviewer, hiring manager, owner, admin", async () => {
  for (const member of ["m-host", "m-team", "m-hm", "m-owner", "m-admin"]) {
    const db = started();
    const { result } = await as(member, () => submitFinalEvaluation(VALID), db);
    assert.deepEqual(result, { success: true, data: { created: true } }, member);
    const [row] = db.final_interview_evaluations;
    assert.equal(row.member_id, member, member);
    assert.equal(row.company_id, CO);
  }
});

test("someone who cannot access the job is refused, as not found, with nothing written", async () => {
  const db = started();
  const { result, service } = await as("m-off", () => submitFinalEvaluation(VALID), db);
  assert.deepEqual(result, { success: false, error: NOT_FOUND });
  assert.deepEqual(allWrites(service), []);
  const listed = await as("m-off", () => listFinalEvaluations("fi-1"), db);
  assert.deepEqual(listed.result, { success: false, error: NOT_FOUND });
});

test("another company is refused: its context finds no interview, reads none of these rows", async () => {
  const db = started({ evaluations: [evaluation("m-host")] });
  for (const act of [
    () => submitFinalEvaluation(VALID),
    () => listFinalEvaluations("fi-1"),
    () => setFinalInterviewOutcome({ finalInterviewId: "fi-1", status: "completed" }),
  ]) {
    const { result, service } = await as("o-1", act, db, { companyId: "other" });
    assert.deepEqual(result, { success: false, error: NOT_FOUND });
    assert.deepEqual(allWrites(service), []);
    assert.ok(
      !service.queries.some((q) => q.table === "final_interview_evaluations"),
      "no evaluation read at all",
    );
  }
  assert.equal(db.final_interview_evaluations.length, 1);
  assert.equal(db.final_interviews[0].status, "active");
});

/* ── when ─────────────────────────────────────────────────────────── */

test("before the booked call starts, or with no booked call at all, evaluations are refused", async () => {
  const cases = [
    ["booked, starts tomorrow", [booking({ scheduled_start: FUTURE })]],
    ["no booking", []],
    ["link sent, not booked", [booking({ status: "invited", scheduled_start: null })]],
    ["expired link", [booking({ status: "expired", scheduled_start: null })]],
    ["booking cancelled", [booking({ status: "cancelled", scheduled_start: PAST })]],
  ];
  for (const [name, bookings] of cases) {
    const db = started({ bookings });
    const { result, service } = await as("m-host", () => submitFinalEvaluation(VALID), db);
    assert.deepEqual(result, { success: false, error: NOT_STARTED_YET }, name);
    assert.deepEqual(allWrites(service), [], name);
    const listed = await as("m-host", () => listFinalEvaluations("fi-1"), db);
    assert.equal(listed.result.data.canEvaluate, false, name);
  }
});

test("after a no-show, an existing evaluation can still be edited, and the panel offers it", async () => {
  const mine = evaluation("m-team");
  const db = started({ fi: { status: "no_show" }, evaluations: [{ ...mine }, evaluation("m-hm")] });
  const { result } = await as(
    "m-team",
    () => submitFinalEvaluation({ ...VALID, rating: 2, recommendation: "no" }),
    db,
  );
  assert.deepEqual(result, { success: true, data: { created: false } });
  const row = db.final_interview_evaluations.find((r) => r.member_id === "m-team");
  assert.deepEqual([row.rating, row.recommendation], [2, "no"]);
  assert.equal(row.submitted_at, mine.submitted_at);
  assert.equal(db.final_interview_evaluations.length, 2, "edited in place, nothing added");
  const listed = await as("m-team", () => listFinalEvaluations("fi-1"), db);
  assert.equal(listed.result.data.canEvaluate, true, "Edit is offered");
  assert.equal(listed.result.data.own.edited, true);
});

test("after a no-show, a NEW evaluation is refused, nothing inserted, and the panel offers no Add", async () => {
  const db = started({ fi: { status: "no_show" }, evaluations: [evaluation("m-hm")] });
  const { result, service } = await as("m-team", () => submitFinalEvaluation(VALID), db);
  assert.deepEqual(result, { success: false, error: NO_SHOW_NEW_CLOSED });
  assert.ok(!allWrites(service).some((w) => w[1] === "insert"), "no insert");
  assert.equal(db.final_interview_evaluations.length, 1);
  assert.deepEqual(
    db.final_interview_evaluations[0],
    evaluation("m-hm"),
    "nobody else's row moved",
  );
  const listed = await as("m-team", () => listFinalEvaluations("fi-1"), db);
  assert.deepEqual(listed.result.data, {
    canEvaluate: false,
    submittedCount: 1,
    own: null,
    evaluations: [],
  });
});

test("a cancelled interview refuses both a new evaluation and an edit, with nothing written", async () => {
  const fi = { status: "cancelled", cancelled_at: PAST };
  for (const evaluations of [[], [evaluation("m-team")]]) {
    const db = started({ fi, evaluations: evaluations.map((e) => ({ ...e })) });
    const { result, service } = await as("m-team", () => submitFinalEvaluation(VALID), db);
    const label = evaluations.length ? "edit" : "new";
    assert.deepEqual(result, { success: false, error: CANCELLED_CLOSED }, label);
    assert.deepEqual(allWrites(service), [], label);
    assert.deepEqual(db.final_interview_evaluations, evaluations, label);
    if (evaluations.length) {
      const listed = await as("m-team", () => listFinalEvaluations("fi-1"), db);
      assert.equal(listed.result.data.canEvaluate, false, "no Edit offered");
    }
  }
});

test("a completed interview still takes evaluations", async () => {
  const db = started({ fi: { status: "completed", completed_at: PAST } });
  const { result } = await as("m-team", () => submitFinalEvaluation(VALID), db);
  assert.equal(result.success, true);
});

/* ── the fields ───────────────────────────────────────────────────── */

test("every field is checked on the server, with fixed sentences and nothing written", async () => {
  const bad = [
    [{ rating: 0 }, "Choose a rating from 1 to 5."],
    [{ rating: 6 }, "Choose a rating from 1 to 5."],
    [{ rating: 2.5 }, "Choose a rating from 1 to 5."],
    [{ rating: "4" }, "Choose a rating from 1 to 5."],
    [{ recommendation: "definitely" }, "Choose a recommendation."],
    [{ recommendation: undefined }, "Choose a recommendation."],
    [{ basis: undefined }, "Say whether you attended or watched the recording."],
    [{ basis: "auto" }, "Say whether you attended or watched the recording."],
    [{ notes: 42 }, "Notes must be text."],
    [{ notes: "x".repeat(10_001) }, "Notes can be up to 10,000 characters."],
  ];
  for (const [over, error] of bad) {
    const db = started();
    const { result, service } = await as(
      "m-host",
      () => submitFinalEvaluation({ ...VALID, ...over }),
      db,
    );
    assert.deepEqual(result, { success: false, error }, JSON.stringify(over).slice(0, 60));
    assert.deepEqual(allWrites(service), []);
  }
  for (const id of ["", null, "x".repeat(101)]) {
    const db = started();
    const { result } = await as(
      "m-host",
      () => submitFinalEvaluation({ ...VALID, finalInterviewId: id }),
      db,
    );
    assert.deepEqual(result, { success: false, error: NOT_FOUND });
  }
});

test("notes are trimmed, blank notes are stored as none, and 10,000 characters after trimming is allowed", async () => {
  let db = started();
  await as("m-host", () => submitFinalEvaluation(VALID), db);
  assert.equal(db.final_interview_evaluations[0].notes, "Clear thinker.");
  db = started();
  await as("m-host", () => submitFinalEvaluation({ ...VALID, notes: "   " }), db);
  assert.equal(db.final_interview_evaluations[0].notes, null);
  db = started();
  const { result } = await as(
    "m-host",
    () => submitFinalEvaluation({ ...VALID, notes: ` ${"y".repeat(10_000)} ` }),
    db,
  );
  assert.equal(result.success, true);
  assert.equal(db.final_interview_evaluations[0].notes.length, 10_000);
});

test("the basis is the evaluator's choice: both values are stored exactly as chosen", async () => {
  for (const basis of ["attended", "watched_recording"]) {
    const db = started();
    await as("m-host", () => submitFinalEvaluation({ ...VALID, basis }), db);
    assert.equal(db.final_interview_evaluations[0].basis, basis);
  }
});

/* ── one each, own only, blind until submitted ────────────────────── */

test("blind before submitting: a count only, and nobody else's rating, recommendation or notes is read", async () => {
  const db = started({ evaluations: [evaluation("m-host"), evaluation("m-hm")] });
  const { result, service } = await as("m-team", () => listFinalEvaluations("fi-1"), db);
  assert.deepEqual(result, {
    success: true,
    data: { canEvaluate: true, submittedCount: 2, own: null, evaluations: [] },
  });
  for (const q of service.queries.filter((x) => x.table === "final_interview_evaluations")) {
    const select = q.calls.find((c) => c[0] === "select")[1];
    const own = q.calls.some((c) => c[0] === "eq" && c[1] === "member_id" && c[2] === "m-team");
    assert.ok(own || select === "id", `only ids are read across members: ${select}`);
  }
});

test("after submitting: everyone's evaluation, named, the viewer's marked", async () => {
  const db = started({ evaluations: [evaluation("m-host"), evaluation("m-hm")] });
  await as("m-team", () => submitFinalEvaluation(VALID), db);
  const { result } = await as("m-team", () => listFinalEvaluations("fi-1"), db);
  assert.equal(result.success, true);
  const { own, evaluations, submittedCount } = result.data;
  assert.equal(submittedCount, 3);
  assert.equal(own.memberId, "m-team");
  assert.equal(own.isYou, true);
  assert.deepEqual(evaluations.map((e) => [e.memberId, e.name, e.isYou]).sort(), [
    ["m-hm", "Hal Manager", false],
    ["m-host", "Hana Host", false],
    ["m-team", "Tom Team", true],
  ]);
  const host = evaluations.find((e) => e.memberId === "m-host");
  assert.deepEqual(
    [host.rating, host.recommendation, host.basis, host.notes],
    [4, "yes", "attended", "notes by m-host"],
  );
});

test("one per person: a second save edits the same row, keeps submitted_at, and shows Edited", async () => {
  const db = started({ evaluations: [evaluation("m-hm")] });
  await as("m-team", () => submitFinalEvaluation(VALID), db);
  const mine = () => db.final_interview_evaluations.find((r) => r.member_id === "m-team");
  const first = { ...mine() };
  assert.equal(first.submitted_at, first.updated_at);
  await new Promise((r) => setTimeout(r, 5));
  const { result } = await as(
    "m-team",
    () => submitFinalEvaluation({ ...VALID, rating: 2, recommendation: "no", notes: "" }),
    db,
  );
  assert.deepEqual(result, { success: true, data: { created: false } });
  assert.equal(db.final_interview_evaluations.filter((r) => r.member_id === "m-team").length, 1);
  assert.equal(mine().submitted_at, first.submitted_at, "first submission time kept");
  assert.ok(mine().updated_at > first.updated_at);
  assert.deepEqual([mine().rating, mine().recommendation, mine().notes], [2, "no", null]);

  const { result: listed } = await as("m-team", () => listFinalEvaluations("fi-1"), db);
  const byMember = Object.fromEntries(listed.data.evaluations.map((e) => [e.memberId, e]));
  assert.equal(byMember["m-team"].edited, true);
  assert.equal(byMember["m-hm"].edited, false);
});

test("only the author's row is ever written: someone else's evaluation is untouched by your save", async () => {
  const theirs = evaluation("m-hm");
  const db = started({ evaluations: [{ ...theirs }] });
  await as("m-team", () => submitFinalEvaluation(VALID), db);
  await as("m-team", () => submitFinalEvaluation({ ...VALID, rating: 1 }), db);
  assert.deepEqual(
    db.final_interview_evaluations.find((r) => r.member_id === "m-hm"),
    theirs,
  );
  const { service } = await as("m-team", () => submitFinalEvaluation(VALID), db);
  for (const [table, op, payload] of allWrites(service)) {
    assert.equal(table, "final_interview_evaluations");
    assert.ok(op === "update" || op === "insert");
    if (op === "insert") assert.equal(payload.member_id, "m-team");
  }
  const update = service.queries.find(
    (q) => q.table === "final_interview_evaluations" && q.calls.some((c) => c[0] === "update"),
  );
  assert.ok(update.calls.some((c) => c[0] === "eq" && c[1] === "member_id" && c[2] === "m-team"));
  assert.ok(update.calls.some((c) => c[0] === "eq" && c[1] === "company_id" && c[2] === CO));
});

test("the evaluation reads are company-filtered: a row filed under another company is never counted or shown", async () => {
  const stray = evaluation("o-1", { id: "ev-stray", company_id: "other" });
  let db = started({ evaluations: [evaluation("m-host"), stray] });
  const before = await as("m-team", () => listFinalEvaluations("fi-1"), db);
  assert.equal(before.result.data.submittedCount, 1);
  db = started({ evaluations: [evaluation("m-host"), stray, evaluation("m-team")] });
  const after = await as("m-team", () => listFinalEvaluations("fi-1"), db);
  assert.deepEqual(after.result.data.evaluations.map((e) => e.memberId).sort(), [
    "m-host",
    "m-team",
  ]);
});

/* ── completed / no-show ──────────────────────────────────────────── */

test("owner, admin, a recruiter on the job, and the host may mark the outcome", async () => {
  for (const member of ["m-owner", "m-admin", "m-team", "m-host"]) {
    const db = started();
    const { result } = await as(
      member,
      () => setFinalInterviewOutcome({ finalInterviewId: "fi-1", status: "completed" }),
      db,
    );
    assert.deepEqual(result, { success: true, data: { status: "completed" } }, member);
  }
});

test("a hiring manager who is not the host cannot mark it; one who is the host can", async () => {
  let db = started();
  const refused = await as(
    "m-hm",
    () => setFinalInterviewOutcome({ finalInterviewId: "fi-1", status: "completed" }),
    db,
  );
  assert.deepEqual(refused.result, { success: false, error: NOT_AN_OUTCOME_ROLE });
  assert.deepEqual(allWrites(refused.service), []);
  assert.equal(db.final_interviews[0].status, "active");

  db = started({ fi: { host_member_id: "m-hm" } });
  const allowed = await as(
    "m-hm",
    () => setFinalInterviewOutcome({ finalInterviewId: "fi-1", status: "no_show" }),
    db,
  );
  assert.equal(allowed.result.success, true);
  assert.equal(db.final_interviews[0].status, "no_show");
});

test("a recruiter who cannot access the job cannot mark it", async () => {
  const db = started();
  const { result } = await as(
    "m-off",
    () => setFinalInterviewOutcome({ finalInterviewId: "fi-1", status: "completed" }),
    db,
  );
  assert.deepEqual(result, { success: false, error: NOT_FOUND });
});

test("the moves: completed sets completed_at, undo clears it; no-show and back; nothing else", async () => {
  const db = started();
  const move = (status) =>
    as("m-host", () => setFinalInterviewOutcome({ finalInterviewId: "fi-1", status }), db);
  const fi = () => db.final_interviews[0];

  assert.equal((await move("completed")).result.success, true);
  assert.equal(fi().status, "completed");
  assert.ok(fi().completed_at);
  assert.equal((await move("no_show")).result.success, false, "completed to no-show: undo first");
  assert.equal((await move("completed")).result.success, false, "already completed");
  assert.equal((await move("active")).result.success, true);
  assert.deepEqual([fi().status, fi().completed_at], ["active", null]);
  assert.equal((await move("active")).result.success, false, "already active");
  assert.equal((await move("no_show")).result.success, true);
  assert.deepEqual([fi().status, fi().completed_at], ["no_show", null]);
  assert.equal((await move("completed")).result.success, false, "no-show to completed: undo first");
  assert.equal((await move("active")).result.success, true);
  assert.equal(fi().status, "active");

  for (const status of ["cancelled", "invited", "", undefined]) {
    const { result, service } = await move(status);
    assert.equal(result.success, false, String(status));
    assert.deepEqual(allWrites(service), []);
  }
});

test("never from cancelled, and never before the call starts", async () => {
  for (const status of ["completed", "no_show", "active"]) {
    const db = started({ fi: { status: "cancelled", cancelled_at: PAST } });
    const { result, service } = await as(
      "m-owner",
      () => setFinalInterviewOutcome({ finalInterviewId: "fi-1", status }),
      db,
    );
    assert.equal(result.success, false, status);
    assert.deepEqual(allWrites(service), []);
    assert.equal(db.final_interviews[0].status, "cancelled");
  }
  for (const bookings of [
    [booking({ scheduled_start: FUTURE })],
    [],
    [booking({ status: "invited" })],
  ]) {
    const db = started({ bookings });
    const { result, service } = await as(
      "m-owner",
      () => setFinalInterviewOutcome({ finalInterviewId: "fi-1", status: "completed" }),
      db,
    );
    assert.deepEqual(result, { success: false, error: NOT_STARTED_YET });
    assert.deepEqual(allWrites(service), []);
  }
});

test("the outcome write is conditional on the status it read, and company-filtered", async () => {
  const db = started();
  const { service } = await as(
    "m-host",
    () => setFinalInterviewOutcome({ finalInterviewId: "fi-1", status: "completed" }),
    db,
  );
  const update = service.queries.find(
    (q) => q.table === "final_interviews" && q.calls.some((c) => c[0] === "update"),
  );
  const eqs = update.calls.filter((c) => c[0] === "eq").map((c) => [c[1], c[2]]);
  assert.deepEqual(eqs, [
    ["id", "fi-1"],
    ["company_id", CO],
    ["status", "active"],
  ]);
});

/* ── nothing else moves ───────────────────────────────────────────── */

test("no stage write, no email, no bell, from any of it", async () => {
  const db = started({ evaluations: [evaluation("m-hm")] });
  const services = [];
  const runs = [
    () => submitFinalEvaluation(VALID),
    () => submitFinalEvaluation({ ...VALID, rating: 3 }),
    () => listFinalEvaluations("fi-1"),
    () => setFinalInterviewOutcome({ finalInterviewId: "fi-1", status: "completed" }),
    () => setFinalInterviewOutcome({ finalInterviewId: "fi-1", status: "active" }),
    () => setFinalInterviewOutcome({ finalInterviewId: "fi-1", status: "no_show" }),
  ];
  for (const act of runs) {
    const { service } = await as("m-host", act, db);
    services.push(service);
    assert.deepEqual(globalThis.__fiEmails, []);
    assert.deepEqual(globalThis.__fiHostEmails, []);
    assert.deepEqual(globalThis.__fiBell, []);
  }
  const tables = new Set(services.flatMap((s) => allWrites(s).map((w) => w[0])));
  assert.deepEqual([...tables].sort(), ["final_interview_evaluations", "final_interviews"]);
  for (const s of services) {
    assert.deepEqual(writes(s, "job_applications"), []);
    assert.ok(!s.queries.some((q) => q.table === "application_stage_history"));
  }
  const fiUpdates = services.flatMap((s) => writes(s, "final_interviews"));
  for (const [, patch] of fiUpdates) {
    assert.deepEqual(Object.keys(patch).sort(), ["completed_at", "status", "updated_at"]);
  }
});

/* ── what the list tells the card ─────────────────────────────────── */

test("each row says whether its call started and what the viewer may do", async () => {
  const row = async (member, dbOpts) => {
    const db = started(dbOpts);
    const { result } = await as(member, () => listFinalInterviews(APP), db);
    const [r] = result.data;
    return [r.started, r.canEvaluate, r.canSetOutcome];
  };
  assert.deepEqual(await row("m-host"), [true, true, true]);
  assert.deepEqual(await row("m-hm"), [true, true, false], "hiring manager, not the host");
  assert.deepEqual(await row("m-hm", { fi: { host_member_id: "m-hm" } }), [true, true, true]);
  assert.deepEqual(await row("m-owner", { bookings: [booking({ scheduled_start: FUTURE })] }), [
    false,
    false,
    false,
  ]);
  assert.deepEqual(await row("m-owner", { fi: { status: "no_show" } }), [true, false, true]);
  assert.deepEqual(await row("m-owner", { fi: { status: "cancelled", cancelled_at: PAST } }), [
    true,
    false,
    false,
  ]);
  const db = started({ fi: { status: "completed", completed_at: PAST } });
  const { result } = await as("m-owner", () => listFinalInterviews(APP), db);
  assert.equal(result.data[0].completedAt, PAST);
});

/* ── the card, by its source ──────────────────────────────────────── */

const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");
const code = (text) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/^\s*\/\/.*$/gm, "");
const CARD = src("./_final-interview-card.tsx");

test("the card: outcome buttons from canSetOutcome, evaluations loaded only for the open row", () => {
  const c = code(CARD);
  assert.match(c, /\{row\.canSetOutcome && row\.status === "active" && !confirming && \(/);
  assert.match(c, /\{row\.canSetOutcome && marked && \(/);
  assert.match(c, /onClick=\{\(\) => void setOutcome\(row\.id, "completed"\)\}/);
  assert.match(c, /onClick=\{\(\) => void setOutcome\(row\.id, "no_show"\)\}/);
  assert.match(c, /onClick=\{\(\) => void setOutcome\(row\.id, "active"\)\}/);
  const setOutcome = c.slice(
    c.indexOf("async function setOutcome("),
    c.indexOf("const scheduleButton"),
  );
  assert.match(setOutcome, /if \(busyId !== null\) return;/);
  assert.match(setOutcome, /await load\(\);/);
  // One call site for the evaluations read, reached from the toggle and after a save.
  assert.equal((c.match(/listFinalEvaluations\(/g) ?? []).length, 1);
  assert.equal((c.match(/loadEvaluations\(/g) ?? []).length, 2, "the toggle and after a save");
  const toggle = c.slice(
    c.indexOf("function toggleEvaluations("),
    c.indexOf("async function fetchPlayback("),
  );
  assert.match(toggle, /void loadEvaluations\(rowId\);/);
  assert.match(
    c,
    /onToast\(created \? "Evaluation submitted\." : "Evaluation updated\."\);\s*void loadEvaluations\(rowId\);/,
  );
  assert.doesNotMatch(
    c.slice(
      c.indexOf("const load = useCallback("),
      c.indexOf("useEffect(() => {\n    setRows(null);"),
    ),
    /Evaluations/,
  );
  assert.match(c, /aria-expanded=\{evalOpen\}/);
  assert.match(c, /\{row\.started && \(/);
});

test("the card: blind wording, the Edited line, and an accessible form with no double submit", () => {
  const c = code(CARD);
  assert.match(c, /\. Submit yours to see the others\./);
  assert.match(c, /\{view\.own \? "Edit your evaluation" : "Add your evaluation"\}/);
  assert.match(c, /\{view\.own && view\.evaluations\.length > 0 && \(/);
  assert.match(c, /\{e\.edited && \(/);
  assert.match(c, /Edited \{formatInZone\(Date\.parse\(e\.updatedAt\), zone\)\}/);
  const dialog = c.slice(c.indexOf("function EvaluationDialog("));
  assert.match(
    dialog,
    /useModalFocus\(dialogRef, true, \{ onClose, overlayRef, initialFocus: "first" \}\)/,
  );
  assert.match(dialog, /role="dialog"\s+aria-modal="true"\s+aria-labelledby=\{`\$\{id\}-title`\}/);
  assert.equal(
    (dialog.match(/<legend className=\{LABEL\}>/g) ?? []).length,
    3,
    "rating, recommendation, basis",
  );
  assert.match(dialog, /htmlFor=\{`\$\{id\}-notes`\}/);
  assert.match(dialog, /aria-describedby=\{`\$\{id\}-notes-count`\}/);
  assert.match(dialog, /maxLength=\{FINAL_EVALUATION_NOTES_MAX\}/);
  assert.match(dialog, /if \(!canSubmit \|\| submitting/);
  assert.match(dialog, /disabled=\{!canSubmit\}/);
  // Nothing is preselected for a new evaluation: the basis included.
  assert.match(dialog, /useState<FinalEvaluationBasis \| null>\(own\?\.basis \?\? null\)/);
  assert.match(dialog, /useState<number \| null>\(own\?\.rating \?\? null\)/);
});

test("hyphens, never em dashes, in what this change added", () => {
  const EM = String.fromCharCode(0x2014);
  const actions = src("./final-interview-actions.ts");
  const constants = src("../../../../lib/final-interviews/constants.ts");
  const added = [
    actions.slice(actions.indexOf("/* ── evaluations ──")),
    constants.slice(
      constants.indexOf("/* ── evaluations and the outcome"),
      constants.indexOf("/* ── fixed copy"),
    ),
    constants.slice(constants.indexOf("export const NOT_AN_OUTCOME_ROLE")),
    CARD.slice(CARD.indexOf("/* ───────────────────── one row's evaluations")),
    CARD.slice(CARD.indexOf("const BASIS_SEEN"), CARD.indexOf("type Player = {")),
    CARD.slice(CARD.indexOf("async function setOutcome("), CARD.indexOf("const scheduleButton")),
  ];
  for (const text of added) {
    assert.ok(text.length > 100, "the slice was found");
    assert.ok(!text.includes(EM), "no em dash");
  }
});
