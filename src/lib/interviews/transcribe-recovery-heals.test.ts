/**
 * The recovery sweep heals: a dead job's answer is marked failed, a succeeded
 * job's still-pending answer gets exactly one more try and then failed, and no
 * stuck row holds a place in the oldest-first scan for ever.
 *
 *   node --test src/lib/interviews/transcribe-recovery-heals.test.ts
 *
 * runTranscribeRecovery, handleTranscribe and requestScorecard are the shipped
 * code. The database is fake-live-db.mjs, whose background_jobs primary key
 * refuses a second row with the same id, as the real one does. The queue's insert
 * is stubbed with the same statement enqueue() runs. Synthetic data only.
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { register } from "node:module";
import { afterEach, beforeEach, test } from "node:test";

register(new URL("../../test-support/node-resolve.mjs", import.meta.url));
register(
  `data:text/javascript,${encodeURIComponent(`
const QUEUE = [
  "export async function enqueue(input) {",
  "  const row = { type: input.type, payload: input.payload ?? {}, company_id: input.companyId ?? null, status: 'queued' };",
  "  if (input.id) row.id = input.id;",
  "  const { data, error } = await globalThis.__service.from('background_jobs').insert(row).select('id').single();",
  "  if (error) return { ok: false, error: error.message, code: error.code };",
  "  return { ok: true, id: data.id };",
  "}",
].join("\\n");
const STUBS = {
  "server-only": "",
  "@/lib/supabase/server": "export const createServiceClient = () => globalThis.__service;",
  "@/lib/jobs-queue": QUEUE,
};
export async function resolve(specifier, context, next) {
  if (specifier in STUBS) return { url: "data:text/javascript," + encodeURIComponent(STUBS[specifier]), shortCircuit: true };
  return next(specifier, context);
}`)}`,
);

const { runTranscribeRecovery, transcribeRequeueJobId, RECOVERY_FAILED_SENTENCE } = await import(
  "./transcribe-recovery.ts"
);
const { handleTranscribe } = await import("./transcribe.ts");
const { readScorecardFacts } = await import("./scorecard.ts");
const { isSafeFailureSentence } = await import("../queue/failure-class.ts");
const { fakeLiveDb } = await import("../../test-support/fake-live-db.mjs");

const SESSION = "d0000000-0000-4000-8000-0000000000d7";
const COMPANY = "c0000000-0000-4000-8000-0000000000d7";
const ANSWER = "e0000000-0000-4000-8000-0000000000d7";
const RECORDED_AT = "2026-11-01T10:00:00.000+00:00";
const NEWER = "2026-11-01T10:05:00.000+00:00";
const VIDEO = `${SESSION}/q1.webm`;
const SAID = "I led the migration and measured the result.";
const RAW = "RAW-PROVIDER-TEXT from the last attempt";
/** Past the recovery threshold: the sweep's clock. */
const NOW = Date.parse("2026-11-02T12:00:00Z");

let lines = [];
let saved = null;
let realFetch = null;
let realKey = null;

const answerRow = (over = {}) => ({
  id: ANSWER,
  session_id: SESSION,
  position: 1,
  video_path: VIDEO,
  transcript: null,
  transcript_segments: null,
  transcript_status: "pending",
  transcript_error: null,
  duration_seconds: 30,
  recorded_at: RECORDED_AT,
  ...over,
});

let jobCount = 0;
const jobRow = (status, over = {}) => ({
  id: `f0000000-0000-4000-8000-${String(++jobCount).padStart(12, "0")}`,
  type: "transcribe",
  status,
  attempts: status === "dead" ? 3 : 0,
  max_attempts: 3,
  last_error: status === "dead" ? RAW : null,
  payload: { answerId: ANSWER, recordedAt: RECORDED_AT },
  created_at: "2026-11-01T10:00:01.000Z",
  ...over,
});

function world({ answers = [answerRow()], jobs = [], status = "submitted", scores = [] } = {}) {
  const db = fakeLiveDb({
    interview_sessions: [
      {
        id: SESSION,
        company_id: COMPANY,
        application_id: null,
        job_id: null,
        kind: "async",
        status,
        delete_after: "2031-01-01T00:00:00.000Z",
        purged_at: null,
      },
    ],
    interview_answers: answers,
    background_jobs: jobs,
    interview_session_scores: scores,
  });
  db.objects.set(VIDEO, { bytes: new Uint8Array([1, 2, 3]), contentType: "video/webm" });
  globalThis.__service = db.service;
  return db;
}

const sweep = (db) => runTranscribeRecovery(db.service, { now: () => NOW });
const row = (db) => db.tables.interview_answers[0];
const jobsOf = (db, type = "transcribe") =>
  db.tables.background_jobs.filter((j) => j.type === type);

beforeEach(() => {
  lines = [];
  saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = (...a) => lines.push(a.join(" "));
  realFetch = globalThis.fetch;
  realKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-key-not-real";
  globalThis.fetch = async (url) =>
    String(url).includes("api.openai.com")
      ? Response.json({ text: SAID, segments: [], duration: 30 })
      : new Response(new Uint8Array([1, 2, 3]));
});

afterEach(() => {
  Object.assign(console, saved);
  globalThis.fetch = realFetch;
  if (realKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = realKey;
});

/* ── a dead job ───────────────────────────────────────────────── */

test("dead job: the row is marked failed, with the safe sentence and none of the job's text", async () => {
  const db = world({ jobs: [jobRow("dead")] });
  const summary = await sweep(db);
  assert.equal(row(db).transcript_status, "failed");
  assert.equal(row(db).transcript_error, RECOVERY_FAILED_SENTENCE);
  assert.ok(isSafeFailureSentence(row(db).transcript_error), "the review page will show it");
  assert.equal(summary.failed, 1);
  assert.equal(jobsOf(db).length, 1, "never re-queued");
  assert.ok(!`${JSON.stringify(row(db))} ${lines.join(" ")}`.includes("RAW-PROVIDER-TEXT"));
  assert.deepEqual(lines, [`[transcribe-recovery] answer ${ANSWER}: marked failed`]);
});

test("replay of the dead job: the transcript lands and a new scorecard is queued over the stored one", async () => {
  const dead = jobRow("dead");
  const db = world({
    jobs: [dead],
    scores: [{ session_id: SESSION, company_id: COMPANY, status: "scored", overall_score: 70 }],
  });
  await sweep(db);
  assert.equal(row(db).transcript_status, "failed");
  assert.equal(jobsOf(db, "ai_scorecard").length, 1, "settling the last answer asks");
  jobsOf(db, "ai_scorecard")[0].status = "succeeded";

  // What the admin retry does to the row, then the worker running it.
  Object.assign(db.tables.background_jobs[0], { status: "queued", attempts: 0, last_error: null });
  await handleTranscribe(db.tables.background_jobs[0]);
  assert.equal(row(db).transcript_status, "done");
  assert.equal(row(db).transcript, SAID);
  assert.equal(row(db).transcript_error, null);
  assert.equal(jobsOf(db, "ai_scorecard").length, 2, "the replay asks for the re-score");
});

test("a settled row unblocks the recruiter's button: nothing is pending any more", async () => {
  const db = world({ jobs: [jobRow("dead")] });
  assert.equal((await readScorecardFacts(db.service, SESSION)).pendingTranscripts, 1);
  await sweep(db);
  assert.equal((await readScorecardFacts(db.service, SESSION)).pendingTranscripts, 0);
});

/* ── a succeeded job, the row still pending ───────────────────── */

test("succeeded but pending: exactly one re-queue, however many sweeps run", async () => {
  const db = world({ jobs: [jobRow("succeeded")] });
  const first = await sweep(db);
  assert.equal(first.requeued, 1);
  assert.equal(row(db).transcript_status, "pending", "not failed yet");
  const added = jobsOf(db).find((j) => j.status === "queued");
  assert.equal(added.id, transcribeRequeueJobId(ANSWER, RECORDED_AT));
  assert.deepEqual(added.payload, { answerId: ANSWER, recordedAt: RECORDED_AT });

  const second = await sweep(db);
  assert.equal(second.requeued, 0, "its job is live: left alone");
  assert.equal(second.live, 1);
  assert.equal(jobsOf(db).length, 2);
});

test("the id is the limit: two sweeps at the same moment queue one job", async () => {
  const db = world({ jobs: [jobRow("succeeded")] });
  const [a, b] = await Promise.all([sweep(db), sweep(db)]);
  assert.equal(a.requeued + b.requeued, 1);
  assert.equal(a.alreadyQueued + b.alreadyQueued, 1);
  assert.equal(a.errors + b.errors, 0);
  assert.equal(jobsOf(db).length, 2);
});

test("the id is stable, per answer and per recording, and a valid uuid", () => {
  const id = transcribeRequeueJobId(ANSWER, RECORDED_AT);
  assert.equal(id, transcribeRequeueJobId(ANSWER, RECORDED_AT));
  assert.notEqual(id, transcribeRequeueJobId(ANSWER, NEWER), "a re-record gets its own try");
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("the re-queued job ends dead: the row is marked failed", async () => {
  const db = world({ jobs: [jobRow("succeeded")] });
  await sweep(db);
  jobsOf(db).find((j) => j.status === "queued").status = "dead";
  const summary = await sweep(db);
  assert.equal(row(db).transcript_status, "failed");
  assert.equal(summary.failed, 1);
  assert.equal(jobsOf(db).length, 2);
});

test("the re-queued job also succeeds with the row pending: marked failed, no third job", async () => {
  const db = world({ jobs: [jobRow("succeeded")] });
  await sweep(db);
  jobsOf(db).find((j) => j.status === "queued").status = "succeeded";
  const summary = await sweep(db);
  assert.equal(row(db).transcript_status, "failed");
  assert.equal(row(db).transcript_error, RECOVERY_FAILED_SENTENCE);
  assert.equal(summary.requeued, 0);
  assert.equal(jobsOf(db).length, 2);
});

test("the re-queued job really runs: the transcript lands and the sweep has nothing left", async () => {
  const db = world({ jobs: [jobRow("succeeded")], status: "started" });
  await sweep(db);
  const added = jobsOf(db).find((j) => j.status === "queued");
  await handleTranscribe(added);
  assert.equal(row(db).transcript_status, "done");
  assert.equal((await sweep(db)).scanned, 0);
});

/* ── the row moved under the sweep ────────────────────────────── */

/** Runs between the sweep's job lookup and its write. */
function underTheSweep(db, change) {
  const from = db.service.from.bind(db.service);
  db.service.from = (table) => {
    if (table === "background_jobs") change();
    return from(table);
  };
}

const SKIP = `[transcribe-recovery] answer ${ANSWER}: nothing changed marking it failed; re-recorded, deleted or already settled`;

for (const [name, change, check] of [
  [
    "re-recorded",
    (db) => {
      row(db).recorded_at = NEWER;
    },
    (db) => assert.equal(row(db).transcript_status, "pending", "the new recording is untouched"),
  ],
  [
    "deleted",
    (db) => {
      db.tables.interview_answers.length = 0;
    },
    () => {},
  ],
  [
    "already finished by a replay",
    (db) => {
      Object.assign(row(db), { transcript_status: "done", transcript: SAID });
    },
    (db) => {
      assert.equal(row(db).transcript_status, "done", "a finished transcript keeps its status");
      assert.equal(row(db).transcript, SAID);
    },
  ],
]) {
  test(`${name} during the sweep: a clean named skip`, async () => {
    const db = world({ jobs: [jobRow("dead")] });
    underTheSweep(db, () => change(db));
    const summary = await sweep(db);
    assert.equal(summary.skipped, 1);
    assert.equal(summary.failed, 0);
    assert.ok(lines.includes(SKIP), lines.join(" | "));
    check(db);
  });
}

/* ── refused writes and raw text ──────────────────────────────── */

test("a refused write throws and nothing is marked; the next sweep lands it", async () => {
  const db = world({ jobs: [jobRow("dead")] });
  db.failNext("interview_answers", "update");
  await assert.rejects(
    () => sweep(db),
    (err) => {
      assert.ok(err.message.includes(ANSWER));
      assert.doesNotMatch(err.message, /fault/, "no raw database text");
      return true;
    },
  );
  assert.equal(row(db).transcript_status, "pending");
  assert.equal(row(db).transcript_error, null);

  await sweep(db);
  assert.equal(row(db).transcript_status, "failed");
});

test("failed reads and failed queue inserts log no raw text", async () => {
  const scan = world();
  scan.failNext("interview_answers", "select");
  assert.equal((await sweep(scan)).errors, 1);

  const lookup = world();
  lookup.failNext("background_jobs", "select");
  assert.equal((await sweep(lookup)).errors, 1);

  const summary = await runTranscribeRecovery(world({ jobs: [jobRow("succeeded")] }).service, {
    now: () => NOW,
    requeue: async () => ({ ok: false, error: "RAW-QUEUE-TEXT", code: "XX000" }),
  });
  assert.equal(summary.errors, 1);

  const lost = await runTranscribeRecovery(world().service, {
    now: () => NOW,
    request: async () => ({ ok: false, error: "RAW-QUEUE-TEXT" }),
  });
  assert.equal(lost.errors, 1);

  assert.doesNotMatch(lines.join(" "), /fault|RAW-QUEUE-TEXT/);
});

/* ── leaving the scan ─────────────────────────────────────────── */

const manyStuck = (n) => {
  const answers = [];
  for (let i = 0; i < n; i++) {
    const id = `a0000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
    answers.push(
      answerRow({
        id,
        position: i + 1,
        recorded_at: `2026-11-01T09:${String(i).padStart(2, "0")}:00.000+00:00`,
      }),
    );
  }
  return answers;
};
const NEWER_ANSWER = "b0000000-0000-4000-8000-000000000001";
const newerLost = () =>
  answerRow({ id: NEWER_ANSWER, position: 99, recorded_at: "2026-11-01T11:00:00.000+00:00" });
const hasJob = (db, id) => jobsOf(db).some((j) => j.payload.answerId === id);

test("25 rows with dead jobs no longer hide a newer lost upload", async () => {
  const stuck = manyStuck(25);
  const db = world({
    answers: [...stuck, newerLost()],
    jobs: stuck.map((a) =>
      jobRow("dead", { payload: { answerId: a.id, recordedAt: a.recorded_at } }),
    ),
  });
  await sweep(db);
  assert.equal(hasJob(db, NEWER_ANSWER), false, "the first batch is all stuck rows");
  const second = await sweep(db);
  assert.equal(hasJob(db, NEWER_ANSWER), true, "the newer one is re-queued");
  assert.equal(second.enqueued, 1);
  const statuses = db.tables.interview_answers.filter((a) => a.id !== NEWER_ANSWER);
  assert.ok(statuses.every((a) => a.transcript_status === "failed"));
});

test("25 rows with succeeded jobs clear too, each with one re-queue, and the newer one is reached", async () => {
  const stuck = manyStuck(25);
  const db = world({
    answers: [...stuck, newerLost()],
    jobs: stuck.map((a) =>
      jobRow("succeeded", { payload: { answerId: a.id, recordedAt: a.recorded_at } }),
    ),
  });
  let sweeps = 0;
  while (!hasJob(db, NEWER_ANSWER) && sweeps < 10) {
    await sweep(db);
    sweeps += 1;
    // The worker runs what was queued, and it changes nothing: the worst case.
    for (const j of db.tables.background_jobs) {
      if (j.status === "queued" && j.payload.answerId !== NEWER_ANSWER) j.status = "succeeded";
    }
  }
  assert.ok(hasJob(db, NEWER_ANSWER), `reached after ${sweeps} sweeps`);
  assert.ok(sweeps <= 4, `took ${sweeps} sweeps`);
  for (const a of stuck) {
    const mine = jobsOf(db).filter((j) => j.payload.answerId === a.id);
    assert.ok(mine.length <= 2, "never more than one re-queue per recording");
  }
});

test("a live job is left alone, and a lost upload is queued normally", async () => {
  const live = world({ jobs: [jobRow("running")] });
  const liveSummary = await sweep(live);
  assert.equal(liveSummary.live, 1);
  assert.equal(row(live).transcript_status, "pending");

  const lost = world();
  const lostSummary = await sweep(lost);
  assert.equal(lostSummary.enqueued, 1);
  assert.equal(jobsOf(lost).length, 1);
});
