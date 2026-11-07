/**
 * A failed read in the transcribe handler is a failure, not an answer. Before
 * this, a read error at either of the handler's two generation reads came back
 * as "no row", so the job logged "no longer exists" or "re-recorded" and was
 * marked succeeded: never retried, and the answer stayed pending for good. A row
 * that really is gone, or really was re-recorded, is still a clean skip.
 *
 *   node --test src/lib/interviews/transcribe-read-errors.test.ts
 *
 * handleTranscribe and the queue's planFailure are the shipped code. The database
 * is fake-live-db.mjs; storage and Whisper are a stubbed fetch. Synthetic data only.
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { register } from "node:module";
import { afterEach, beforeEach, test } from "node:test";

register(new URL("../../test-support/node-resolve.mjs", import.meta.url));
register(
  `data:text/javascript,${encodeURIComponent(`
const STUBS = {
  "server-only": "",
  "@/lib/supabase/server": "export const createServiceClient = () => globalThis.__service;",
};
export async function resolve(specifier, context, next) {
  if (specifier in STUBS) return { url: "data:text/javascript," + encodeURIComponent(STUBS[specifier]), shortCircuit: true };
  return next(specifier, context);
}`)}`,
);

const { handleTranscribe } = await import("./transcribe.ts");
const { planFailure } = await import("../queue/transitions.ts");
const { fakeLiveDb } = await import("../../test-support/fake-live-db.mjs");

const SESSION = "d0000000-0000-4000-8000-0000000000b1";
const ANSWER = "e0000000-0000-4000-8000-0000000000b1";
const RECORDED_AT = "2026-11-01T10:00:00.000Z";
const NEWER = "2026-11-01T10:05:00.000Z";
const VIDEO = `${SESSION}/q1.webm`;
const SAID = "I led the migration and measured the result.";

const job = (recordedAt = RECORDED_AT) => ({
  id: "job-1",
  payload: { answerId: ANSWER, recordedAt },
  attempts: 0,
  max_attempts: 3,
});

let realFetch = null;
let realKey = null;
let realLog = null;
let realWarn = null;
let realError = null;
let lines = null;
let whisperCalls = null;
/** Runs while the video downloads: between the first read and the second. */
let duringDownload = null;

function world(over = {}) {
  const db = fakeLiveDb({
    interview_sessions: [
      {
        id: SESSION,
        company_id: "c0000000-0000-4000-8000-0000000000b1",
        application_id: null,
        job_id: null,
        kind: "async",
        status: "started",
        delete_after: "2031-01-01T00:00:00.000Z",
        purged_at: null,
      },
    ],
    interview_answers: [
      {
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
      },
    ],
  });
  db.objects.set(VIDEO, { bytes: new Uint8Array([1, 2, 3]), contentType: "video/webm" });
  globalThis.__service = db.service;
  return db;
}

const row = (db) => db.tables.interview_answers[0];

beforeEach(() => {
  realFetch = globalThis.fetch;
  realKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-key-not-real";
  whisperCalls = 0;
  duringDownload = () => {};
  globalThis.fetch = async (url) => {
    if (String(url).includes("api.openai.com")) {
      whisperCalls += 1;
      return Response.json({ text: SAID, segments: [], duration: 30 });
    }
    duringDownload();
    return new Response(new Uint8Array([1, 2, 3]));
  };
  lines = [];
  realLog = console.log;
  realWarn = console.warn;
  realError = console.error;
  console.log = console.warn = console.error = (...a) => lines.push(a.join(" "));
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (realKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = realKey;
  console.log = realLog;
  console.warn = realWarn;
  console.error = realError;
});

/** The job throws, the queue would retry it, and the row is untouched. */
async function assertRetries(db, name) {
  let thrown = null;
  await assert.rejects(
    () => handleTranscribe(job()),
    (err) => {
      thrown = err;
      return true;
    },
    `${name}: the job must not be marked succeeded`,
  );
  assert.equal(row(db).transcript_status, "pending", name);
  assert.equal(row(db).transcript, null, name);
  assert.equal(planFailure(job(), thrown, Date.now()).status, "queued", `${name}: queued to retry`);
  assert.ok(thrown.message.includes(ANSWER), `${name}: names the answer`);
  assert.doesNotMatch(thrown.message, /fault/, `${name}: no raw database text`);
  assert.deepEqual(
    lines.filter((l) => l.includes("[job-skip]")),
    [],
    `${name}: not logged as a skip`,
  );
}

test("first read fails: the job throws, the row stays pending, the next attempt writes done", async () => {
  const db = world();
  db.failNext("interview_answers", "select");
  await assertRetries(db, "first read");
  assert.equal(whisperCalls, 0, "nothing was paid for");

  await handleTranscribe(job());
  assert.equal(row(db).transcript_status, "done");
  assert.equal(row(db).transcript, SAID);
  assert.equal(whisperCalls, 1);
});

test("re-read after the download fails: the job throws, before Whisper; the next attempt writes done", async () => {
  const db = world();
  duringDownload = () => {
    db.failNext("interview_answers", "select");
    duringDownload = () => {};
  };
  await assertRetries(db, "second read");
  assert.equal(whisperCalls, 0, "no Whisper call on a recording it could not check");

  await handleTranscribe(job());
  assert.equal(row(db).transcript_status, "done");
  assert.equal(row(db).transcript, SAID);
  assert.equal(whisperCalls, 1);
});

test("no read error, no row: still today's clean skip", async () => {
  const db = world();
  db.tables.interview_answers.length = 0;
  await handleTranscribe(job());
  assert.equal(whisperCalls, 0);
  assert.deepEqual(lines, [`[job-skip] transcribe job-1: answer ${ANSWER} no longer exists`]);
});

test("the row vanishes during the download: still a clean skip, no Whisper call", async () => {
  const db = world();
  duringDownload = () => {
    db.tables.interview_answers.length = 0;
  };
  await handleTranscribe(job());
  assert.equal(whisperCalls, 0);
  assert.ok(lines.some((l) => l.includes("re-recorded during download")));
});

test("re-recorded before the first read: still a clean skip, the row untouched", async () => {
  const db = world({ recorded_at: NEWER });
  await handleTranscribe(job());
  assert.equal(whisperCalls, 0);
  assert.equal(row(db).transcript_status, "pending");
  assert.ok(lines.some((l) => l.includes("was re-recorded (job for")));
});

test("re-recorded during the download: still a clean skip, the row untouched", async () => {
  const db = world();
  duringDownload = () => {
    row(db).recorded_at = NEWER;
  };
  await handleTranscribe(job());
  assert.equal(whisperCalls, 0);
  assert.equal(row(db).transcript_status, "pending");
  assert.equal(row(db).transcript, null);
  assert.ok(lines.some((l) => l.includes("re-recorded during download")));
});

test("no read error at all: transcribed as before", async () => {
  const db = world();
  await handleTranscribe(job());
  assert.equal(row(db).transcript_status, "done");
  assert.equal(row(db).transcript, SAID);
  assert.deepEqual(
    lines.filter((l) => l.includes("[job-skip]")),
    [],
  );
});
