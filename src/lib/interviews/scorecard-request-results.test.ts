/**
 * #27a: a scorecard request's result is never dropped, and a recruiter is
 * never told "queued" when nothing was, or queued on facts that were not read.
 *
 *   node --test src/lib/interviews/scorecard-request-results.test.ts
 *
 * requestScorecard, readScorecardFacts, askForScorecard and the recruiter's
 * scoreInterview action run as shipped. The database is fake-postgrest.mjs with
 * failures injected per table; the queue is a stub that records every enqueue.
 * Synthetic data only.
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../test-support/node-resolve.mjs", import.meta.url));
register(
  `data:text/javascript,${encodeURIComponent(`
const STUBS = {
  "server-only": "",
  "next/cache": "export function revalidatePath() {}",
  "@/lib/supabase/server": "export function createServiceClient() { return globalThis.__scService; }",
  "@/app/ai-dashboard/lib/company-guards": "export async function getCompanyContext() { return globalThis.__scCtx; }",
  "@/app/ai-dashboard/lib/job-scope": [
    "export async function getJobScope() { return { scoped: false, jobIds: [] }; }",
    "export function isEmptyScope(s) { return s.scoped && s.jobIds.length === 0; }",
    "export function scopeJobIds(s) { return s.scoped ? s.jobIds : null; }",
    "export async function roleAllowsJobAction() { return true; }",
  ].join("\\n"),
  "@/lib/ai/interview-scoring": "export function scoringEnabled() { return true; }",
  "@/lib/interviews/review": "export async function listInterviewSessions() {} export async function readNotes() {}",
  "@/lib/interviews/live-consent": "export const LIVE_INTERVIEW_CONSENT_VERSION = 'live-v1'; export function liveConsentReady() { return true; } export function liveConsentGiven() { return true; }",
  "@/lib/jobs-queue": "export async function enqueue(job) { globalThis.__scEnqueued.push(job); return globalThis.__scEnqueueResult; }",
};
export async function resolve(specifier, context, next) {
  if (specifier in STUBS) return { url: "data:text/javascript," + encodeURIComponent(STUBS[specifier]), shortCircuit: true };
  return next(specifier, context);
}`)}`,
);

const { fakeService } = await import("../../test-support/fake-postgrest.mjs");
const { askForScorecard, requestScorecard } = await import("./scorecard.ts");
const { scoreInterview } = await import("../../app/ai-dashboard/(gated)/interviews/actions.ts");

const CO = "c0000000-0000-4000-8000-0000000000c7";
const SESSION = "d0000000-0000-4000-8000-0000000000c7";
const FAIL = { data: null, count: null, error: { code: "57014", message: "timeout" } };

/**
 * A submitted async session with every transcript settled, no scorecard and no
 * job: the state where both askers and the button may queue. `fail` names the
 * reads that error.
 */
function world({ fail = [], pending = 0, enqueue = { ok: true, id: "job-1" } } = {}) {
  globalThis.__scEnqueued = [];
  globalThis.__scEnqueueResult = enqueue;
  globalThis.__scCtx = { companyId: CO, role: "owner", memberId: "m-1", user: { id: "u-1" } };
  const service = fakeService((table, calls) => {
    const head = calls.find((c) => c[0] === "select")?.[2]?.head === true;
    const failing =
      (table === "interview_sessions" &&
        fail.includes("session") &&
        calls.some((c) => c[0] === "select" && c[1] === "id, status")) ||
      (table === "interview_session_scores" && fail.includes("scoreRow")) ||
      (table === "interview_answers" && fail.includes("answers")) ||
      (table === "background_jobs" && fail.includes("jobs"));
    if (failing) return FAIL;
    if (table === "interview_sessions") {
      return {
        data: {
          id: SESSION,
          job_id: null,
          application_id: null,
          kind: "async",
          status: "submitted",
          expires_at: null,
        },
        error: null,
      };
    }
    if (table === "interview_session_scores") return { data: null, error: null };
    if (table === "interview_answers" && head) return { data: null, count: pending, error: null };
    return { data: [], error: null };
  });
  globalThis.__scService = service;
  return service;
}

async function logged(fn) {
  const lines = [];
  const saved = console.error;
  console.error = (...a) => lines.push(a.join(" "));
  try {
    return { result: await fn(), lines };
  } finally {
    console.error = saved;
  }
}

// ── requestScorecard: an unknown state is an error, not "nothing there" ──

// Negative control: drop the error check in readScorecardFacts and these queue.
test("a failed transcript count or job read throws, and nothing is queued", async () => {
  for (const which of ["answers", "jobs"]) {
    const service = world({ fail: [which] });
    await assert.rejects(requestScorecard(service, SESSION), /facts read failed/, which);
    assert.equal(globalThis.__scEnqueued.length, 0, which);
  }
});

test("a failed session read throws; it is not reported as 'no session'", async () => {
  const service = world({ fail: ["session"] });
  await assert.rejects(requestScorecard(service, SESSION), /session read failed/);
  assert.equal(globalThis.__scEnqueued.length, 0);
});

// ── The automatic askers: never throw, never drop a failure ──

// Negative control: return to the bare try/catch around requestScorecard and
// the enqueue failure logs nothing.
test("askForScorecard logs a request that did not queue, and never throws", async () => {
  const failed = world({ enqueue: { ok: false, error: "insert refused", code: "XX000" } });
  const a = await logged(() => askForScorecard(failed, SESSION, "transcribe"));
  assert.deepEqual(a.result, { ok: false, reason: "enqueue_failed", error: "insert refused" });
  assert.deepEqual(a.lines, [
    `[transcribe] session ${SESSION}: scorecard not queued (enqueue_failed)`,
  ]);

  const broken = world({ fail: ["jobs"] });
  const b = await logged(() => askForScorecard(broken, SESSION, "interview"));
  assert.equal(b.result, null);
  assert.deepEqual(b.lines, [
    `[interview] session ${SESSION}: scorecard request failed (read error)`,
  ]);

  const waiting = world({ pending: 2 });
  const c = await logged(() => askForScorecard(waiting, SESSION, "interview"));
  assert.deepEqual(c.result, { ok: false, reason: "transcripts_pending" });
  assert.deepEqual(c.lines, [], "an expected refusal stays quiet");

  const fine = world();
  const d = await logged(() => askForScorecard(fine, SESSION, "interview"));
  assert.deepEqual(d.result, { ok: true, outcome: "queued" });
  assert.deepEqual(d.lines, []);
});

test("the submit route and the transcribe handler ask through askForScorecard only", () => {
  for (const rel of ["../../app/api/interview/submit/route.ts", "./transcribe.ts"]) {
    const src = readFileSync(new URL(rel, import.meta.url), "utf8");
    assert.match(src, /await askForScorecard\(service, /, rel);
    assert.doesNotMatch(src, /requestScorecard\(/, rel);
  }
});

// ── The recruiter's button ──

test("control: an eligible interview queues once and says so", async () => {
  world();
  const r = await scoreInterview(SESSION);
  assert.deepEqual(r, { ok: true, outcome: "queued" });
  assert.equal(globalThis.__scEnqueued.length, 1);
});

// Negative control: read the score row with the old `{ data: scoreRow }` and a
// failed read queues a paid run over a scorecard that may exist.
test("the button: any read it depends on failing is said plainly, and nothing is queued", async () => {
  for (const fail of [["scoreRow"], ["answers"], ["jobs"], ["session"]]) {
    world({ fail });
    const r = await logged(() => scoreInterview(SESSION));
    assert.deepEqual(
      r.result,
      {
        ok: false,
        error: "Couldn't check this interview's scorecard. Nothing was queued. Try again.",
      },
      fail.join(),
    );
    assert.equal(globalThis.__scEnqueued.length, 0, `${fail.join()}: nothing queued`);
  }
});

test("the button: a queue that refuses the insert is never reported as queued", async () => {
  world({ enqueue: { ok: false, error: "insert refused", code: "XX000" } });
  const r = await logged(() => scoreInterview(SESSION));
  assert.deepEqual(r.result, {
    ok: false,
    error: "Couldn't queue the scorecard. Try again in a moment.",
  });
});
