/**
 * #15: a live interview turn never stays `pending` for good. The recovery
 * sweep (live-turn-recovery.ts) queues a turn that never had a job, marks
 * failed a turn whose job finished without settling it (dead, failed, or a
 * write that never landed, including the job's own refused failure write),
 * leaves live jobs alone, and tries again next tick when its own write fails.
 *
 *   node --test src/lib/interviews/live-turn-recovery.test.ts
 *
 * runLiveTurnRecovery and handleLiveTurnTranscribe run as shipped over
 * fake-postgrest.mjs answering their reads; every turn write, enqueue and
 * settle is recorded. Synthetic data only.
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
  "@/lib/supabase/server": "export function createServiceClient() { return globalThis.__ltrService; }",
};
export async function resolve(specifier, context, next) {
  if (specifier in STUBS) return { url: "data:text/javascript," + encodeURIComponent(STUBS[specifier]), shortCircuit: true };
  return next(specifier, context);
}`)}`,
);

const { runLiveTurnRecovery, LIVE_RECOVERY_FAILED_SENTENCE } = await import(
  "./live-turn-recovery.ts"
);
const { handleLiveTurnTranscribe } = await import("./live-transcribe.ts");
const { call, fakeService } = await import("../../test-support/fake-postgrest.mjs");

const S1 = "5b0f2c1e-0000-4000-8000-0000000000f1";
const CO = "7aad434d-0000-4000-8000-0000000000f1";
const turnId = (n) => `7c0f2c1e-0000-4000-8000-00000000000${n}`;

/**
 * `turns`: pending candidate turns of S1. `jobs`: transcribe jobs as
 * { turnId, status }. `session`: S1's row. `refuseFailureWrite`: the next
 * failure write errors. `doneElsewhere`: turn ids whose status already moved on.
 */
function world({
  turns = [turnId(1)],
  jobs = [],
  session = { status: "started", delete_after: "2099-01-01T00:00:00.000Z" },
  refuseFailureWrite = false,
  doneElsewhere = [],
} = {}) {
  const state = { writes: [], enqueued: [], settled: [], refuse: refuseFailureWrite };
  const service = fakeService((table, calls) => {
    const update = calls.find((c) => c[0] === "update");
    const cols = calls.find((c) => c[0] === "select")?.[1] ?? "";
    if (table === "interview_turns" && update) {
      const id = calls.find((c) => c[0] === "eq" && c[1] === "id")?.[2];
      if (state.refuse) {
        state.refuse = false;
        return { data: null, error: { code: "57014", message: "timeout" } };
      }
      if (doneElsewhere.includes(id)) return { data: [], error: null };
      state.writes.push({ id, ...update[1] });
      return { data: [{ id }], error: null };
    }
    if (table === "interview_turns" && cols === "id, session_id") {
      return { data: turns.map((id) => ({ id, session_id: S1 })), error: null };
    }
    if (table === "interview_turns") {
      // queueLiveTranscription: this session's pending candidate turns.
      return { data: turns.map((id) => ({ id })), error: null };
    }
    if (table === "interview_sessions") {
      if (cols.includes("company_id")) {
        return {
          data: { id: S1, company_id: CO, kind: "live", delete_after: session.delete_after },
          error: null,
        };
      }
      return { data: session, error: null };
    }
    if (table === "background_jobs") {
      assert.equal(call(calls, "eq")?.[1], "type");
      return {
        data: jobs.map((j) => ({
          status: j.status,
          payload: { turnId: j.turnId, sessionId: S1, round: 1 },
        })),
        error: null,
      };
    }
    return { data: [], error: null };
  });
  globalThis.__ltrService = service;
  const deps = {
    enqueue: async (job) => {
      state.enqueued.push(job);
      return { ok: true };
    },
    settle: async (_s, sessionId) => {
      state.settled.push(sessionId);
    },
  };
  return { service, state, deps };
}

const quiet = async (fn) => {
  const lines = [];
  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = (...a) => lines.push(a.join(" "));
  try {
    return { result: await fn(), lines };
  } finally {
    Object.assign(console, saved);
  }
};
const sweep = (w) => quiet(() => runLiveTurnRecovery(w.service, w.deps));

// Negative control: remove the "only finished jobs" branch and these turns stay pending.
test("a turn whose job finished without settling it is marked failed, and the outcome settled", async () => {
  for (const status of ["dead", "failed", "succeeded"]) {
    const w = world({ jobs: [{ turnId: turnId(1), status }] });
    const { result } = await sweep(w);
    assert.deepEqual(
      w.state.writes,
      [
        {
          id: turnId(1),
          transcript_status: "failed",
          transcript_error: LIVE_RECOVERY_FAILED_SENTENCE,
        },
      ],
      status,
    );
    assert.deepEqual(w.state.settled, [S1], `${status}: settled once`);
    assert.equal(result.failed, 1, status);
  }
});

test("a turn with no job is queued through the ingest path, round 1", async () => {
  const w = world();
  const { result } = await sweep(w);
  assert.deepEqual(
    w.state.enqueued.map((j) => [j.type, j.payload.turnId, j.payload.round, j.companyId]),
    [["transcribe", turnId(1), 1, CO]],
  );
  assert.deepEqual(w.state.writes, [], "not marked failed");
  assert.equal(result.queued, 1);
});

test("a queued or running job is left alone", async () => {
  for (const status of ["queued", "running"]) {
    const w = world({
      jobs: [
        { turnId: turnId(1), status: "dead" },
        { turnId: turnId(1), status },
      ],
    });
    const { result } = await sweep(w);
    assert.deepEqual([w.state.writes, w.state.enqueued, w.state.settled], [[], [], []], status);
    assert.equal(result.live, 1);
  }
});

test("restarted first attempts and sessions past retention are left alone", async () => {
  for (const session of [
    { status: "abandoned", delete_after: "2099-01-01T00:00:00.000Z" },
    { status: "started", delete_after: "2000-01-01T00:00:00.000Z" },
    null,
  ]) {
    const w = world({ session, jobs: [{ turnId: turnId(1), status: "dead" }] });
    const { result } = await sweep(w);
    assert.deepEqual([w.state.writes, w.state.enqueued], [[], []], JSON.stringify(session));
    assert.equal(result.skipped, 1);
  }
});

// Negative control: swallow markTurnFailed's error and the first sweep reports
// nothing wrong; there is nothing left to retry.
test("the sweep's own failure write is refused: counted, nothing settled, done on the next tick", async () => {
  const w = world({ jobs: [{ turnId: turnId(1), status: "dead" }], refuseFailureWrite: true });
  const first = await sweep(w);
  assert.equal(first.result.errors, 1);
  assert.deepEqual([w.state.writes, w.state.settled], [[], []]);
  assert.ok(
    first.lines.some((l) =>
      l.includes(
        `session ${S1}: not recovered this tick (live transcribe: failure write failed (57014))`,
      ),
    ),
    first.lines.join("\n"),
  );
  assert.ok(!first.lines.some((l) => l.includes("timeout")), "no database text");

  const second = await sweep(w);
  assert.equal(second.result.failed, 1);
  assert.deepEqual(w.state.settled, [S1]);
});

test("the job's own give-up write refused on its last attempt: the turn is left pending, and the sweep settles it", async () => {
  // The handler: download fails on the last attempt, its failure write is refused.
  const w = world({ jobs: [{ turnId: turnId(1), status: "dead" }] });
  // The handler's own database: its failure write is refused.
  const handlerService = fakeService((table, calls) => {
    if (table === "interview_turns" && calls.some((c) => c[0] === "update")) {
      return { data: null, error: { code: "57014", message: "timeout" } };
    }
    if (table === "interview_turns") {
      return {
        data: {
          id: turnId(1),
          session_id: S1,
          sequence: 2,
          speaker: "candidate",
          media_path: `${S1}/t2.wav`,
          media_mime_type: "audio/wav",
          transcript_status: "pending",
        },
        error: null,
      };
    }
    if (table === "interview_sessions") {
      return { data: { delete_after: "2099-01-01T00:00:00.000Z", status: "started" }, error: null };
    }
    return { data: [], error: null };
  });
  handlerService.storage = {
    from: () => ({ download: async () => ({ data: null, error: { message: "gone" } }) }),
  };
  await assert.rejects(
    quiet(() =>
      handleLiveTurnTranscribe(
        {
          id: "job-last",
          payload: { turnId: turnId(1), sessionId: S1 },
          attempts: 2,
          max_attempts: 3,
        },
        undefined,
        { service: handlerService, transcribe: async () => ({ text: "x", segments: [] }) },
      ),
    ),
    /failure write failed/,
    "the job dies with the turn still pending",
  );

  // Next tick: the job is dead and the turn pending; the sweep marks it.
  const { result } = await sweep(w);
  assert.equal(result.failed, 1);
  assert.equal(w.state.writes[0].transcript_status, "failed");
});

test("the handler says so when its failure write changes nothing, never 'failed for good'", async () => {
  const handlerService = fakeService((table, calls) => {
    if (table === "interview_turns" && calls.some((c) => c[0] === "update")) {
      return { data: [], error: null };
    }
    if (table === "interview_turns") {
      return {
        data: {
          id: turnId(1),
          session_id: S1,
          sequence: 2,
          speaker: "candidate",
          media_path: `${S1}/t2.wav`,
          media_mime_type: "audio/wav",
          transcript_status: "pending",
        },
        error: null,
      };
    }
    if (
      table === "interview_sessions" &&
      calls.find((c) => c[0] === "select")?.[1] === "delete_after, status"
    ) {
      return { data: { delete_after: "2099-01-01T00:00:00.000Z", status: "started" }, error: null };
    }
    if (table === "interview_sessions") return { data: null, error: null };
    return { data: [], error: null };
  });
  handlerService.storage = {
    from: () => ({ download: async () => ({ data: null, error: { message: "gone" } }) }),
  };
  const { lines } = await quiet(() =>
    handleLiveTurnTranscribe(
      {
        id: "job-last",
        payload: { turnId: turnId(1), sessionId: S1 },
        attempts: 2,
        max_attempts: 3,
      },
      undefined,
      { service: handlerService, transcribe: async () => ({ text: "x", segments: [] }) },
    ).catch(() => {}),
  );
  assert.ok(
    lines.some(
      (l) =>
        l ===
        `[job-skip] transcribe job-last: turn ${turnId(1)}: not marked failed, no longer pending`,
    ),
    lines.join("\n"),
  );
  assert.ok(!lines.some((l) => l.includes("failed for good")));
});

test("the worker tick runs the sweep, non-fatal, beside the async one", () => {
  const worker = readFileSync(
    new URL("../../app/api/jobs/worker/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    worker,
    /summary\.liveTurnRecovery = await runLiveTurnRecovery\(createServiceClient\(\)\);/,
  );
  assert.match(
    worker,
    /console\.error\("\[worker\] live turn recovery failed \(non-fatal\):", err\);/,
  );
});

// Negative control: remove `.not("media_path", "is", null)` from
// queueLiveTranscription's pending read and the unrecorded turn is queued too.
test("only a turn with a saved recording is queued; a pending turn without one is not", async () => {
  const { queueLiveTranscription } = await import("./live-transcribe.ts");
  const { fakeLiveDb } = await import("../../test-support/fake-live-db.mjs");
  const turn = (n, media_path) => ({
    id: turnId(n),
    session_id: S1,
    speaker: "candidate",
    transcript_status: "pending",
    media_path,
  });
  const db = fakeLiveDb({
    interview_sessions: [
      { id: S1, company_id: CO, kind: "live", delete_after: "2099-01-01T00:00:00.000Z" },
    ],
    interview_turns: [turn(1, `${S1}/t1.wav`), turn(2, null)],
  });
  const enqueued = [];
  const result = await queueLiveTranscription(db.service, S1, async (job) => {
    enqueued.push(job);
    return { ok: true };
  });
  assert.deepEqual(
    enqueued.map((j) => [j.payload.turnId, j.payload.round]),
    [[turnId(1), 1]],
  );
  assert.deepEqual(result, { queued: 1, alreadyQueued: 0, failed: 0 });
});
