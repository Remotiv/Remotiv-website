/**
 * markFailed reads its own result. Before this it awaited the write and looked
 * at nothing, so a write the database refused came back as if it had worked: the
 * answer stayed pending, and two of its four callers then ended the job succeeded.
 * Now an error throws, so the queue retries; zero rows means the answer was
 * re-recorded or deleted, which is a clean skip and never buries the job; one row
 * behaves as it always did.
 *
 *   node --test src/lib/interviews/transcribe-mark-failed.test.ts
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
const { TerminalJobError } = await import("../queue/failure-class.ts");
const { fakeLiveDb } = await import("../../test-support/fake-live-db.mjs");

const SESSION = "d0000000-0000-4000-8000-0000000000c1";
const ANSWER = "e0000000-0000-4000-8000-0000000000c1";
const RECORDED_AT = "2026-11-01T10:00:00.000Z";
const NEWER = "2026-11-01T10:05:00.000Z";
const VIDEO = `${SESSION}/q1.webm`;
const PROVIDER_WORDS = "PROVIDER-RAW-TEXT invalid file format";
const SKIP_LINE = `[job-skip] transcribe job-1: answer ${ANSWER}: nothing changed marking it failed; re-recorded or deleted`;

const job = () => ({
  id: "job-1",
  payload: { answerId: ANSWER, recordedAt: RECORDED_AT },
  attempts: 0,
  max_attempts: 3,
});

let realFetch = null;
let realKey = null;
let saved = null;
let lines = [];
let whisperCalls = 0;

/**
 * Each way into markFailed, and a hook at the last moment before its write, so
 * a test can change the row under it there. Two callers return after it, two
 * throw TerminalJobError, which is why all four are walked.
 */
const CALLERS = [
  {
    name: "no video",
    terminal: null,
    row: { video_path: null },
    written: "Answer has no video to transcribe.",
  },
  {
    name: "no API key",
    terminal: "configuration",
    noKey: true,
    written: /configuration|configured|transcri/i,
  },
  {
    name: "over Whisper's size limit",
    terminal: null,
    hugeVideo: true,
    written: /^Recording is 26MB/,
  },
  {
    name: "a provider 400",
    terminal: "deterministic",
    whisperStatus: 400,
    written: /transcri/i,
  },
];

function world(caller, beforeWrite = () => {}) {
  const db = fakeLiveDb({
    interview_sessions: [
      {
        id: SESSION,
        company_id: "c0000000-0000-4000-8000-0000000000c1",
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
        ...caller.row,
      },
    ],
  });
  db.objects.set(VIDEO, { bytes: new Uint8Array([1, 2, 3]), contentType: "video/webm" });
  globalThis.__service = db.service;

  if (caller.noKey) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = "test-key-not-real";

  // The two earliest callers have no await left but this read of the session.
  if (caller.row || caller.noKey) {
    const from = db.service.from.bind(db.service);
    db.service.from = (table) => {
      if (table === "interview_sessions") beforeWrite(db);
      return from(table);
    };
  }
  globalThis.fetch = async (url) => {
    if (String(url).includes("api.openai.com")) {
      whisperCalls += 1;
      beforeWrite(db);
      return new Response(PROVIDER_WORDS, { status: caller.whisperStatus ?? 200 });
    }
    if (caller.hugeVideo) {
      beforeWrite(db);
      return new Response(new Uint8Array(26 * 1024 * 1024));
    }
    return new Response(new Uint8Array([1, 2, 3]));
  };
  return db;
}

const row = (db) => db.tables.interview_answers[0];

beforeEach(() => {
  realFetch = globalThis.fetch;
  realKey = process.env.OPENAI_API_KEY;
  whisperCalls = 0;
  lines = [];
  saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = (...a) => lines.push(a.join(" "));
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (realKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = realKey;
  Object.assign(console, saved);
});

async function outcome() {
  try {
    await handleTranscribe(job());
    return null;
  } catch (err) {
    return err;
  }
}

for (const caller of CALLERS) {
  test(`${caller.name}: a refused write never ends succeeded; the queue retries and the next attempt lands`, async () => {
    const db = world(caller);
    db.failNext("interview_answers", "update");
    const err = await outcome();
    assert.ok(err, "the job must not end succeeded");
    assert.ok(!(err instanceof TerminalJobError), "retried, not buried: nothing was recorded");
    assert.equal(planFailure(job(), err, Date.now()).status, "queued");
    assert.equal(row(db).transcript_status, "pending");
    assert.ok(err.message.includes(ANSWER), "names the answer");
    assert.doesNotMatch(err.message, /fault/, "no raw database text");
    assert.deepEqual(
      lines.filter((l) => l.includes("[job-skip]")),
      [],
      "not logged as a skip",
    );

    await outcome();
    assert.equal(row(db).transcript_status, "failed", "the retry writes it");
  });

  test(`${caller.name}: re-recorded under the write is a clean skip, the job is not dead`, async () => {
    const db = world(caller, (d) => {
      d.tables.interview_answers[0].recorded_at = NEWER;
    });
    assert.equal(await outcome(), null, "no throw, so never dead");
    assert.equal(row(db).transcript_status, "pending", "the new recording is untouched");
    assert.equal(row(db).transcript_error, null);
    assert.ok(lines.includes(SKIP_LINE), lines.join(" | "));
    assert.ok(!lines.some((l) => l.startsWith(`[transcribe] ${ANSWER}:`)), "not logged as failed");
  });

  test(`${caller.name}: the row deleted under the write is a clean skip too`, async () => {
    world(caller, (d) => {
      d.tables.interview_answers.length = 0;
    });
    assert.equal(await outcome(), null);
    assert.ok(lines.includes(SKIP_LINE), lines.join(" | "));
  });

  test(`${caller.name}: one row behaves as it always did`, async () => {
    const db = world(caller);
    const err = await outcome();
    assert.equal(row(db).transcript_status, "failed");
    if (typeof caller.written === "string") assert.equal(row(db).transcript_error, caller.written);
    else assert.match(row(db).transcript_error, caller.written);
    assert.doesNotMatch(
      row(db).transcript_error,
      /PROVIDER-RAW-TEXT/,
      "the provider's words stay out",
    );
    assert.ok(lines.some((l) => l.startsWith(`[transcribe] ${ANSWER}:`)));
    assert.ok(!lines.includes(SKIP_LINE));
    if (caller.terminal) {
      assert.ok(err instanceof TerminalJobError, "still terminal");
      assert.equal(err.failureClass, caller.terminal);
      assert.equal(
        planFailure(job(), err, Date.now()).status,
        "dead",
        "still replayable, as before",
      );
    } else {
      assert.equal(err, null, "returned, as before");
    }
    assert.equal(whisperCalls, caller.whisperStatus ? 1 : 0);
  });
}
