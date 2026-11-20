/**
 * #15: a live turn's transcription never "says done" without saving, and a
 * failed read of the turn is retried, never taken for a deleted turn. The two
 * guarantees the async handler (transcribe.ts) already has.
 *
 *   node --test src/lib/interviews/live-transcribe-writes.test.ts
 *
 * handleLiveTurnTranscribe runs as shipped. The database is fake-postgrest.mjs
 * answering the handler's own reads and writes, with a storage download; both
 * paths under test return before the outcome is settled, and the ordinary
 * path is covered by live-transcribe.test.ts. Synthetic data only.
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../test-support/node-resolve.mjs", import.meta.url));
register(
  `data:text/javascript,${encodeURIComponent(`
const STUBS = {
  "server-only": "",
  "@/lib/supabase/server": "export function createServiceClient() { return globalThis.__ltwService; }",
};
export async function resolve(specifier, context, next) {
  if (specifier in STUBS) return { url: "data:text/javascript," + encodeURIComponent(STUBS[specifier]), shortCircuit: true };
  return next(specifier, context);
}`)}`,
);

const { handleLiveTurnTranscribe } = await import("./live-transcribe.ts");
const { fakeService } = await import("../../test-support/fake-postgrest.mjs");

const SESSION = "5b0f2c1e-0000-4000-8000-0000000000d4";
const TURN = "7c0f2c1e-0000-4000-8000-0000000000d4";
const PATH = `${SESSION}/t2.wav`;

/**
 * One pending candidate turn. `readFails`: the turn read errors.
 * `matched`: how many rows the transcript write reports changing.
 */
function world({ readFails = false, matched = 1 } = {}) {
  const writes = [];
  const service = fakeService((table, calls) => {
    const update = calls.find((c) => c[0] === "update");
    if (table === "interview_turns" && update) {
      writes.push(update[1]);
      return { data: matched ? [{ id: TURN }] : [], error: null };
    }
    if (table === "interview_turns") {
      if (readFails) return { data: null, error: { code: "57014", message: "timeout" } };
      return {
        data: {
          id: TURN,
          session_id: SESSION,
          sequence: 2,
          speaker: "candidate",
          media_path: PATH,
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
  service.storage = {
    from: () => ({
      download: async () => ({ data: new Blob([new Uint8Array(64)]), error: null }),
    }),
  };
  globalThis.__ltwService = service;
  return { service, writes };
}

const job = {
  id: "job-ltw-1",
  payload: { turnId: TURN, sessionId: SESSION },
  attempts: 0,
  max_attempts: 3,
};
const whisper = { calls: 0 };
const transcribe = async () => {
  whisper.calls += 1;
  return { text: "I led the migration of the ledger service.", segments: [] };
};

async function logged(fn) {
  const lines = [];
  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = (...a) => lines.push(a.join(" "));
  try {
    return { result: await fn(), lines };
  } finally {
    Object.assign(console, saved);
  }
}

// Negative control: put back `const { data } = await service...` (the error
// ignored) and this resolves: the job succeeds and the turn stays pending.
test("a failed read of the turn is retried, never read as a deleted turn", async () => {
  const w = world({ readFails: true });
  whisper.calls = 0;
  await assert.rejects(
    handleLiveTurnTranscribe(job, undefined, { service: w.service, transcribe }),
    /live transcribe: turn .* could not be read \(57014\)/,
  );
  assert.equal(whisper.calls, 0, "nothing sent to the transcriber");
  assert.deepEqual(w.writes, [], "nothing written");
});

// Negative control: drop the written-rows check and the run logs "done" and
// goes on to settle, though nothing was saved.
test("a transcript write that changed no row is a logged skip, never 'done'", async () => {
  const w = world({ matched: 0 });
  const { lines } = await logged(() =>
    handleLiveTurnTranscribe(job, undefined, {
      service: w.service,
      transcribe,
      onDecided: async () => {
        throw new Error("settled though nothing was written");
      },
    }),
  );
  assert.equal(w.writes.length, 1, "the write was attempted once");
  assert.equal(w.writes[0].transcript_status, "done");
  assert.ok(
    lines.some((l) =>
      l.startsWith(
        `[job-skip] transcribe ${job.id}: turn ${TURN}: transcript not written, the turn is no longer pending or failed`,
      ),
    ),
    lines.join("\n"),
  );
  assert.ok(!lines.some((l) => /\[live-transcribe\] turn .*: done;/.test(l)), "never 'done'");
  assert.ok(!lines.some((l) => l.includes("I led the migration")), "no transcript in the log");
});
