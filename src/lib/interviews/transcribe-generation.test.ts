/**
 * Recording generations (Phase 5, P3/P12): a stale job cannot write to a
 * newer recording, and the legacy path is only reachable by a payload with no
 * generation at all.
 *
 *   node --test src/lib/interviews/transcribe-generation.test.ts
 */
// @ts-nocheck — same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  mayPersist,
  readTranscribePayload,
  resolveGeneration,
  sameInstant,
} from "./transcribe-generation.ts";

/** The database's own formatting versus the application's, for the same instant. */
const DB_FORM = "2026-09-30T10:00:00.123+00:00";
const APP_FORM = "2026-09-30T10:00:00.123Z";
const LATER_DB_FORM = "2026-09-30T10:04:30.5+00:00";

/**
 * An in-memory interview_answers row store that applies the handler's
 * compare-and-set exactly as the SQL does: update where id = ? and
 * recorded_at = ?. Returns the rows it changed.
 */
function table(rows) {
  return {
    rows,
    cas(id, expectedRecordedAt, patch) {
      const hit = rows.filter(
        (r) =>
          r.id === id &&
          (expectedRecordedAt === null || sameInstant(r.recorded_at, expectedRecordedAt)),
      );
      for (const r of hit) Object.assign(r, patch);
      return hit;
    },
  };
}

test("payload reading: recordedAt is optional (legacy) but answerId is not", () => {
  assert.deepEqual(readTranscribePayload({ answerId: "a1", recordedAt: DB_FORM }), {
    answerId: "a1",
    recordedAt: DB_FORM,
  });
  assert.deepEqual(readTranscribePayload({ answerId: "a1" }), { answerId: "a1", recordedAt: null });
  assert.equal(readTranscribePayload({ recordedAt: DB_FORM }), null);
  assert.equal(readTranscribePayload({ answerId: "", recordedAt: DB_FORM }), null);
  assert.equal(readTranscribePayload(undefined), null);
});

test("sameInstant compares the instant, not the string; null never matches", () => {
  assert.equal(sameInstant(DB_FORM, APP_FORM), true);
  assert.equal(sameInstant(DB_FORM, LATER_DB_FORM), false);
  assert.equal(sameInstant(null, null), false);
  assert.equal(sameInstant(DB_FORM, null), false);
  assert.equal(sameInstant("not a date", DB_FORM), false);
});

test("generation: match, stale, legacy", () => {
  assert.equal(resolveGeneration(DB_FORM, DB_FORM), "match");
  assert.equal(resolveGeneration(APP_FORM, DB_FORM), "match");
  assert.equal(resolveGeneration(DB_FORM, LATER_DB_FORM), "stale");
  assert.equal(
    resolveGeneration(DB_FORM, null),
    "stale",
    "a job for a recording the row no longer has",
  );
  assert.equal(resolveGeneration(null, DB_FORM), "legacy");
});

test("a generationed stale job cannot write to a newer recording", () => {
  // The candidate re-recorded: the row now carries LATER_DB_FORM. A worker
  // still holding the job for DB_FORM reaches persistence with a transcript
  // of the OLD video.
  const t = table([
    { id: "a1", recorded_at: LATER_DB_FORM, transcript: null, transcript_status: "pending" },
  ]);
  assert.equal(mayPersist(DB_FORM, LATER_DB_FORM), false);
  const written = t.cas("a1", DB_FORM, { transcript: "old words", transcript_status: "done" });
  assert.equal(written.length, 0);
  assert.equal(t.rows[0].transcript, null);
  assert.equal(t.rows[0].transcript_status, "pending");
  // The job for the CURRENT recording writes normally.
  assert.equal(mayPersist(LATER_DB_FORM, LATER_DB_FORM), true);
  const ok = t.cas("a1", LATER_DB_FORM, { transcript: "new words", transcript_status: "done" });
  assert.equal(ok.length, 1);
  assert.equal(t.rows[0].transcript, "new words");
});

test("legacy handling is unreachable on the post-deploy path: any payload with a generation is checked", () => {
  // Post-deploy every payload has recordedAt (requestTranscription refuses one
  // without). None of these can resolve to "legacy", so the unchecked path
  // cannot affect a normal job.
  for (const [payloadAt, rowAt] of [
    [DB_FORM, DB_FORM],
    [DB_FORM, LATER_DB_FORM],
    [APP_FORM, DB_FORM],
    [DB_FORM, null],
  ]) {
    assert.notEqual(resolveGeneration(payloadAt, rowAt), "legacy");
  }
  // And a legacy job, when one existed, writes without a generation filter -
  // which is why the pre-deploy check requires zero of them live.
  assert.equal(mayPersist(null, LATER_DB_FORM), true);
});

test("the handler pins: check 1 precedes storage, check 3 is a compare-and-set, and recordedAt is required by the helper", () => {
  const src = readFileSync(new URL("./transcribe.ts", import.meta.url), "utf8");
  const firstCheck = src.indexOf("Generation check 1: before ANY storage access");
  const signedUrl = src.indexOf("createSignedUrl(answer.video_path");
  const whisper = src.indexOf("api.openai.com/v1/audio/transcriptions");
  const secondCheck = src.indexOf(
    "Generation check 2: after the download, before paying for Whisper",
  );
  const cas = src.indexOf('if (recordedAt !== null) write = write.eq("recorded_at", recordedAt);');
  assert.ok(firstCheck > 0 && firstCheck < signedUrl, "generation check before the signed URL");
  assert.ok(
    secondCheck > signedUrl && secondCheck < whisper,
    "second check between download and Whisper",
  );
  assert.ok(cas > whisper, "compare-and-set on the write after the call");
  assert.match(
    src,
    /confirmed ZERO\s+\*?\s*queued or running transcribe jobs without recordedAt at this deploy/,
  );
  const helper = readFileSync(new URL("./transcribe-request.ts", import.meta.url), "utf8");
  assert.match(helper, /if \(!input\.recordedAt\)\s+return \{ ok: false/);
});
