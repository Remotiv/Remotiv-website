/**
 * Recording step 6a: retention, the applicant-delete cleanup and the orphan
 * sweep, against the migration 038/040 database fake and a fake S3 bucket.
 * Nothing live.
 *
 *   node --test src/lib/final-interviews/purge.test.ts
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";
import { fakeS3 } from "../../test-support/fake-s3.mjs";
import {
  APP,
  botWorld,
  CO,
  FI,
  JOB,
  makeBotDb,
  OTHER_CO,
} from "../../test-support/final-bot-world.mjs";

register(new URL("../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../test-support/fake-service-client-hook.mjs", import.meta.url));

const purge = await import("./purge.ts");
const { deleteAfterFor } = await import("./import.ts");
const { deriveRecordingSummary, recordingStatusLine, RECORDING_ORPHAN_GRACE_MS } = await import(
  "./constants.ts"
);
const { TerminalJobError } = await import("../queue/failure-class.ts");

const NOW = Date.parse("2027-03-01T12:00:00.000Z");
const DAY = 24 * 60 * 60_000;
const OLD = NOW - 2 * DAY;
const YOUNG = NOW - 60 * 60_000;
const key = (fi, id) => `${CO}/${fi}/${id}.mp4`;

/** A company's world: interviews fi-1..fi-n on the default job and application. */
function setup({ interviews = 3 } = {}) {
  const db = makeBotDb(NOW);
  for (let i = 2; i <= interviews; i++) {
    db.final_interviews.push({
      ...db.final_interviews[0],
      id: `f0000000-0000-4000-8000-00000000000${i}`,
    });
  }
  const service = botWorld(db);
  const s3 = fakeS3();
  // Supabase storage's remove(), over the same bucket, for removeObjects.
  service.storage = {
    from: () => ({
      async remove(paths) {
        if (service.storageFails) return { data: null, error: { message: "storage down" } };
        const gone = paths.filter((p) => s3.objects.has(p));
        for (const p of gone) s3.objects.delete(p);
        return { data: gone.map((name) => ({ name })), error: null };
      },
    }),
  };
  const enqueued = [];
  const deps = (over = {}) => ({
    service,
    store: s3,
    now: () => NOW,
    live: true,
    enqueue: async (input) => {
      enqueued.push(input);
      return { ok: true, id: randomUUID() };
    },
    ...over,
  });
  return { db, service, s3, deps, enqueued, fis: db.final_interviews.map((f) => f.id) };
}

/** A recording row and, when it has a path, its object. */
function addRecording(t, over = {}, { object = true, at = OLD } = {}) {
  const id = over.id ?? randomUUID();
  const fi = over.final_interview_id ?? FI;
  const row = {
    id,
    final_interview_id: fi,
    company_id: CO,
    job_id: JOB,
    application_id: APP,
    source: "recall_bot",
    vendor_recording_id: randomUUID(),
    storage_path: key(fi, id),
    mime_type: "video/mp4",
    size_bytes: 10,
    status: "ready",
    delete_after: new Date(NOW - DAY).toISOString(),
    deleted_at: null,
    deleted_by: null,
    uploaded_by: null,
    ...over,
  };
  t.db.final_interview_recordings.push(row);
  if (object && row.storage_path) t.s3.putObject(row.storage_path, [1, 2, 3], { at });
  return row;
}
const rec = (t, id) => t.db.final_interview_recordings.find((r) => r.id === id);

/* ── three calendar months ──────────────────────────────────────── */

test("delete_after is three CALENDAR months after the booking start, same time of day", () => {
  const cases = [
    ["2026-11-05T09:00:00.000Z", "2027-02-05T09:00:00.000Z"],
    ["2026-08-31T14:30:00.000Z", "2026-11-30T14:30:00.000Z"], // November has 30 days
    ["2026-11-30T09:00:00.000Z", "2027-02-28T09:00:00.000Z"], // February, not a leap year
    ["2027-11-30T09:00:00.000Z", "2028-02-29T09:00:00.000Z"], // leap year
    ["2026-01-31T23:59:00.000Z", "2026-04-30T23:59:00.000Z"],
    ["2026-12-15T00:00:00.000Z", "2027-03-15T00:00:00.000Z"], // across a year
  ];
  for (const [start, expected] of cases) assert.equal(deleteAfterFor(start), expected, start);
  // 31 January + 90 days is 1 May; three calendar months is 30 April.
  assert.equal(
    new Date(Date.parse("2026-01-31T23:59:00.000Z") + 90 * DAY).toISOString(),
    "2026-05-01T23:59:00.000Z",
  );
  assert.equal(
    deleteAfterFor("2026-01-31T23:59:00.000Z"),
    "2026-04-30T23:59:00.000Z",
    "not 90 days",
  );
  assert.equal(deleteAfterFor("not a date"), null);
});

/* ── retention ──────────────────────────────────────────────────── */

test("a due recording: the file is deleted first, then the row is kept as the deleted record", async () => {
  const t = setup();
  const r = addRecording(t);
  const seen = [];
  t.s3.before("deleteObject", () => seen.push(rec(t, r.id).status));
  const report = await purge.runRecordingPurge(t.deps());
  assert.deepEqual(seen, ["ready"], "the row was still ready when the file went");
  assert.equal(t.s3.objects.has(r.storage_path), false);
  const after = rec(t, r.id);
  assert.equal(after.status, "deleted");
  assert.equal(after.deleted_at, new Date(NOW).toISOString());
  assert.equal(after.deleted_by, null, "null means the retention purge");
  assert.equal(after.storage_path, null);
  assert.equal(report.purged, 1);
});

test("the purged row shows the retention state on the card", async () => {
  const t = setup();
  const r = addRecording(t);
  await purge.runRecordingPurge(t.deps());
  const row = rec(t, r.id);
  const summary = deriveRecordingSummary({
    currentBookingId: "b",
    bots: [
      {
        booking_id: "b",
        status: "done",
        join_at: new Date(NOW).toISOString(),
        import_status: "ready",
        last_event_code: null,
        last_event_sub_code: null,
        last_event_at: null,
        provider_recording_id: row.vendor_recording_id,
        superseded_at: null,
      },
    ],
    recordings: [row],
    bookingStarts: new Map(),
    nowMs: NOW,
  });
  assert.equal(summary.state, "deleted");
  assert.equal(
    recordingStatusLine(summary, (x) => x).text,
    "Recording deleted after the retention period",
  );
});

test("a failed file delete leaves the row ready, and the rest of the batch goes on", async () => {
  const t = setup();
  const stuck = addRecording(t, { id: "00000000-0000-4000-8000-000000000001" });
  const next = addRecording(t, {
    id: "00000000-0000-4000-8000-000000000002",
    final_interview_id: t.fis[1],
  });
  t.s3.failNext("deleteObject", new Error("503"));
  const report = await purge.runRecordingPurge(t.deps({ retentionBatch: 1 }));
  assert.equal(rec(t, stuck.id).status, "ready", "never marked deleted while the file exists");
  assert.equal(rec(t, stuck.id).storage_path, stuck.storage_path);
  assert.ok(t.s3.objects.has(stuck.storage_path));
  assert.equal(rec(t, next.id).status, "deleted", "the row behind it was purged");
  assert.deepEqual([report.purgeFailed, report.purged], [1, 1]);
  // The next run finishes it.
  await purge.runRecordingPurge(t.deps());
  assert.equal(rec(t, stuck.id).status, "deleted");
});

test("interrupted cleanup: the file went, the row update failed; the next run marks it", async () => {
  const t = setup();
  const r = addRecording(t);
  t.service.failNext("final_interview_recordings", "update");
  const first = await purge.runRecordingPurge(t.deps());
  assert.equal(first.purgeFailed, 1);
  assert.equal(t.s3.objects.has(r.storage_path), false);
  assert.equal(rec(t, r.id).status, "ready", "still points at a file that is gone");
  const second = await purge.runRecordingPurge(t.deps());
  assert.equal(second.purged, 1, "a missing file counts as already deleted");
  assert.equal(rec(t, r.id).status, "deleted");
});

test("a rerun is idempotent: nothing more is deleted or written", async () => {
  const t = setup();
  addRecording(t);
  await purge.runRecordingPurge(t.deps());
  const deletes = t.s3.count("deleteObject");
  const report = await purge.runRecordingPurge(t.deps());
  assert.equal(report.due, 0);
  assert.equal(t.s3.count("deleteObject"), deletes);
});

test("a row edited between the read and the update is not touched", async () => {
  const t = setup();
  const r = addRecording(t);
  t.service.afterNext("final_interview_recordings", "select", () => {
    rec(t, r.id).storage_path = key(FI, "moved");
  });
  const report = await purge.runRecordingPurge(t.deps());
  assert.equal(report.rowChanged, 1);
  assert.equal(rec(t, r.id).status, "ready");
  assert.equal(rec(t, r.id).storage_path, key(FI, "moved"));
});

test("not-yet-due, already-deleted and non-ready rows are skipped", async () => {
  const t = setup();
  const future = addRecording(t, { delete_after: new Date(NOW + DAY).toISOString() });
  const gone = addRecording(
    t,
    {
      final_interview_id: t.fis[1],
      status: "deleted",
      storage_path: null,
      deleted_at: new Date(NOW - DAY).toISOString(),
    },
    { object: false },
  );
  const pending = addRecording(t, { final_interview_id: t.fis[2], status: "pending" });
  const report = await purge.runRecordingPurge(t.deps());
  assert.equal(report.due, 0);
  assert.equal(rec(t, future.id).status, "ready");
  assert.ok(t.s3.objects.has(future.storage_path));
  assert.equal(rec(t, gone.id).deleted_at, new Date(NOW - DAY).toISOString(), "untouched");
  assert.ok(t.s3.objects.has(pending.storage_path), "a live import's file is not retention's");
});

test("dry run: everything is counted, nothing is deleted or written", async () => {
  const t = setup();
  const due = addRecording(t);
  t.s3.putObject(`${OTHER_CO}/gone-interview/x.mp4`, [1], { at: OLD });
  const upload = await t.s3.createUpload(`${CO}/orphan/u.mp4`, "video/mp4");
  t.s3.uploads.get(upload).initiatedAt = OLD;
  const report = await purge.runRecordingPurge(t.deps({ live: false }));
  assert.equal(report.mode, "dry_run");
  assert.deepEqual([report.due, report.orphanObjects, report.orphanUploads], [1, 1, 1]);
  assert.deepEqual(
    [report.purged, report.orphanObjectsDeleted, report.orphanUploadsAborted],
    [0, 0, 0],
  );
  assert.equal(rec(t, due.id).status, "ready");
  assert.equal(t.s3.objects.size, 2);
  assert.equal(t.s3.uploads.size, 1);
  assert.equal(t.s3.count("deleteObject") + t.s3.count("abortUpload"), 0);
});

test("live only when RECORDING_PURGE_LIVE is exactly 'true'", () => {
  assert.equal(purge.isRecordingPurgeLive({}), false);
  assert.equal(purge.isRecordingPurgeLive({ RECORDING_PURGE_LIVE: "1" }), false);
  assert.equal(purge.isRecordingPurgeLive({ RECORDING_PURGE_LIVE: "TRUE" }), false);
  assert.equal(purge.isRecordingPurgeLive({ RECORDING_PURGE_LIVE: "true" }), true);
});

test("no storage configured: due recordings are a configuration error; none due is a quiet run", async () => {
  const empty = setup();
  const quiet = await purge.runRecordingPurge(empty.deps({ store: null }));
  assert.equal(quiet.storageConfigured, false);
  const t = setup();
  addRecording(t);
  await assert.rejects(
    purge.runRecordingPurge(t.deps({ store: null })),
    (e) => e instanceof TerminalJobError && e.failureClass === "configuration",
  );
});

/* ── applicant delete ───────────────────────────────────────────── */

test("deleting an applicant removes their recording files, this company's only", async () => {
  const t = setup();
  const ready = addRecording(t);
  const pending = addRecording(t, { final_interview_id: t.fis[1], status: "pending" });
  // Another company's row carrying the same application id must never be reached.
  const theirs = addRecording(t, { final_interview_id: t.fis[2], company_id: OTHER_CO });
  const result = await purge.removeApplicationRecordings(t.service, CO, APP);
  assert.deepEqual(result, { requested: 2, removed: 2, failed: false });
  assert.equal(t.s3.objects.has(ready.storage_path), false);
  assert.equal(t.s3.objects.has(pending.storage_path), false);
  assert.ok(t.s3.objects.has(theirs.storage_path), "another company's file is untouched");
});

test("a storage or database error is reported, never thrown", async () => {
  const t = setup();
  addRecording(t);
  t.service.storageFails = true;
  const storage = await purge.removeApplicationRecordings(t.service, CO, APP);
  assert.equal(storage.failed, true);
  t.service.storageFails = false;
  t.service.failNext("final_interview_recordings", "select");
  const db = await purge.removeApplicationRecordings(t.service, CO, APP);
  assert.deepEqual(db, { requested: 0, removed: 0, failed: true });
});

test("the applicant delete calls it before the row delete, with its own company, and never blocks", () => {
  const src = readFileSync(
    new URL("../../app/ai-dashboard/(gated)/applicants/actions.ts", import.meta.url),
    "utf8",
  );
  const fn = src.slice(
    src.indexOf("export async function deleteApplication("),
    src.indexOf("// ── Team comments"),
  );
  const call = fn.indexOf(
    "await removeApplicationRecordings(service, ctx.companyId, applicationId)",
  );
  const rowDelete = fn.indexOf('.from("job_applications")\n    .delete()');
  assert.ok(call > 0 && rowDelete > call, "removed before the row (and its cascade) goes");
  const block = fn.slice(fn.lastIndexOf("try {", call), fn.indexOf("// 2. The row.", call));
  assert.match(block, /\} catch \{/, "a throw is caught");
  assert.doesNotMatch(block, /return \{ success: false/, "a failure never stops the delete");
  assert.doesNotMatch(block, /storage_path|path:/, "logs carry ids only");
});

/* ── the sweep ──────────────────────────────────────────────────── */

test("objects: unreferenced and old deleted; referenced or young kept; failed rows protect nothing", async () => {
  const t = setup();
  const ready = addRecording(t, { delete_after: new Date(NOW + DAY).toISOString() });
  const pending = addRecording(t, { final_interview_id: t.fis[1], status: "pending" });
  const failed = addRecording(t, { final_interview_id: t.fis[2], status: "failed" });
  const orphanOld = `${CO}/${FI}/orphan-old.mp4`;
  const orphanYoung = `${CO}/${FI}/orphan-young.mp4`;
  t.s3.putObject(orphanOld, [1], { at: OLD });
  t.s3.putObject(orphanYoung, [1], { at: YOUNG });
  const report = await purge.runRecordingPurge(t.deps());
  assert.ok(t.s3.objects.has(ready.storage_path));
  assert.ok(t.s3.objects.has(pending.storage_path), "a live import's object is referenced");
  assert.equal(t.s3.objects.has(failed.storage_path), false, "a failed copy's leftover goes");
  assert.equal(t.s3.objects.has(orphanOld), false);
  assert.ok(t.s3.objects.has(orphanYoung), "under 24 hours is kept");
  assert.deepEqual([report.orphanObjectsDeleted, report.youngObjectsKept], [2, 1]);
});

test("a failed row's leftover file: kept under 24 hours, deleted after; failed rows are never protected", async () => {
  // A failed row keeps its storage_path, and failed is terminal (import.ts),
  // so its file is garbage: the sweep must not keep it forever.
  const t = setup();
  const young = addRecording(t, { status: "failed" }, { at: YOUNG });
  const old = addRecording(t, { final_interview_id: t.fis[1], status: "failed" }, { at: OLD });
  const report = await purge.runRecordingPurge(t.deps());
  assert.ok(t.s3.objects.has(young.storage_path), "under 24 hours, kept for now");
  assert.equal(t.s3.objects.has(old.storage_path), false, "over 24 hours, deleted");
  assert.equal(rec(t, old.id).status, "failed", "the row itself is left as the record");
  assert.deepEqual([report.youngObjectsKept, report.orphanObjectsDeleted], [1, 1]);
  // A day later the young one goes too.
  await purge.runRecordingPurge(t.deps({ now: () => NOW + RECORDING_ORPHAN_GRACE_MS }));
  assert.equal(t.s3.objects.has(young.storage_path), false);
  // Its upload, if one was left, is aborted the same way.
  const leftover = await t.s3.createUpload(old.storage_path, "video/mp4");
  t.s3.uploads.get(leftover).initiatedAt = OLD;
  await purge.runRecordingPurge(t.deps());
  assert.equal(t.s3.uploads.has(leftover), false);
});

/* ── a pending row left by a cleanup that never got through ─────── */

/** The recording's bot, with its import status and the time of its last write. */
function addBot(t, row, importStatus, updatedAgoMs) {
  t.db.final_interview_bots.push({
    id: randomUUID(),
    final_interview_id: row.final_interview_id,
    company_id: row.company_id,
    provider_recording_id: row.vendor_recording_id,
    import_status: importStatus,
    status: "done",
    superseded_at: null,
    updated_at: new Date(NOW - updatedAgoMs).toISOString(),
  });
}

test("a pending row under a bot failed 6 days ago still protects its file and upload", async () => {
  const t = setup();
  const row = addRecording(t, { status: "pending" });
  addBot(t, row, "failed", 6 * DAY);
  const upload = await t.s3.createUpload(row.storage_path, "video/mp4");
  t.s3.uploads.get(upload).initiatedAt = OLD;
  await purge.runRecordingPurge(t.deps());
  assert.ok(t.s3.objects.has(row.storage_path));
  assert.ok(t.s3.uploads.has(upload));
});

test("past 7 days failed, the pending row stops protecting: its file and upload are swept", async () => {
  const t = setup();
  const row = addRecording(t, { status: "pending" });
  addBot(t, row, "failed", 7 * DAY + 60_000);
  const upload = await t.s3.createUpload(row.storage_path, "video/mp4");
  t.s3.uploads.get(upload).initiatedAt = OLD;
  const report = await purge.runRecordingPurge(t.deps());
  assert.equal(t.s3.objects.has(row.storage_path), false);
  assert.equal(t.s3.uploads.has(upload), false);
  assert.deepEqual([report.orphanObjectsDeleted, report.orphanUploadsAborted], [1, 1]);
  assert.equal(rec(t, row.id).status, "pending", "the row itself is not changed by the sweep");
});

test("a pending row under an importing, queued or live bot is always protected, however old", async () => {
  for (const importStatus of ["importing", "queued", "none"]) {
    const t = setup();
    const row = addRecording(t, { status: "pending" });
    addBot(t, row, importStatus, 60 * DAY);
    await purge.runRecordingPurge(t.deps());
    assert.ok(t.s3.objects.has(row.storage_path), importStatus);
  }
  // No bot row at all: kept, nothing proves it was abandoned.
  const t = setup();
  const lonely = addRecording(t, { status: "pending" });
  await purge.runRecordingPurge(t.deps());
  assert.ok(t.s3.objects.has(lonely.storage_path));
});

test("a ready row is never swept, even under a bot failed long ago", async () => {
  const t = setup();
  const row = addRecording(t, { delete_after: new Date(NOW + 30 * DAY).toISOString() });
  addBot(t, row, "failed", 60 * DAY);
  await purge.runRecordingPurge(t.deps());
  assert.ok(t.s3.objects.has(row.storage_path));
  assert.equal(rec(t, row.id).status, "ready");
});

test("another company's failed bot never unprotects this company's pending row", async () => {
  const t = setup();
  const row = addRecording(t, { status: "pending" });
  addBot(t, { ...row, company_id: OTHER_CO }, "failed", 60 * DAY);
  await purge.runRecordingPurge(t.deps());
  assert.ok(t.s3.objects.has(row.storage_path));
});

test("fail closed: if the bot read fails, the pending row's file is kept", async () => {
  const t = setup();
  const row = addRecording(t, { status: "pending" });
  addBot(t, row, "failed", 60 * DAY);
  t.service.failNext("final_interview_bots", "select");
  const report = await purge.runRecordingPurge(t.deps());
  assert.equal(report.referenceReadFailed, true);
  assert.ok(t.s3.objects.has(row.storage_path));
});

test("files of a deleted company, interview or applicant are found without any company row", async () => {
  const t = setup();
  const keys = [
    "c9999999-0000-4000-8000-000000000009/f9999999-0000-4000-8000-000000000009/a.mp4",
    `${CO}/f8888888-0000-4000-8000-000000000008/b.mp4`,
  ];
  for (const k of keys) t.s3.putObject(k, [1], { at: OLD });
  await purge.runRecordingPurge(t.deps());
  for (const k of keys) assert.equal(t.s3.objects.has(k), false, k);
});

test("multipart: an old orphan upload is aborted; a live import's upload or a young one is kept", async () => {
  const t = setup();
  const pending = addRecording(t, { status: "pending" }, { object: false });
  const live = await t.s3.createUpload(pending.storage_path, "video/mp4");
  t.s3.uploads.get(live).initiatedAt = OLD; // stalled for days, still referenced
  const orphan = await t.s3.createUpload(`${CO}/${FI}/left-behind.mp4`, "video/mp4");
  t.s3.uploads.get(orphan).initiatedAt = OLD;
  const young = await t.s3.createUpload(`${CO}/${FI}/just-started.mp4`, "video/mp4");
  t.s3.uploads.get(young).initiatedAt = YOUNG;
  const report = await purge.runRecordingPurge(t.deps());
  assert.ok(t.s3.uploads.has(live));
  assert.equal(t.s3.uploads.has(orphan), false);
  assert.ok(t.s3.uploads.has(young));
  assert.deepEqual([report.orphanUploadsAborted, report.youngUploadsKept], [1, 1]);
});

test("fail closed: a failed reference read deletes nothing and is reported", async () => {
  const t = setup();
  const orphan = `${CO}/${FI}/orphan.mp4`;
  t.s3.putObject(orphan, [1], { at: OLD });
  // The retention read succeeds; the first reference read fails.
  t.service.afterNext("final_interview_recordings", "select", () =>
    t.service.failNext("final_interview_recordings", "select"),
  );
  const report = await purge.runRecordingPurge(t.deps());
  assert.equal(report.referenceReadFailed, true);
  assert.ok(t.s3.objects.has(orphan), "nothing on that page was deleted");
  assert.equal(t.s3.count("abortUpload"), 0, "and the sweep stopped");
});

test("the job fails when references could not be read, so the queue records it", () => {
  const src = readFileSync(new URL("./purge.ts", import.meta.url), "utf8");
  const handler = src.slice(src.indexOf("export async function handleFinalRecordingPurge("));
  assert.match(handler, /if \(report\.referenceReadFailed\) \{\s*throw new Error/);
});

test("paged: never more than a page in hand, and every page is reached", async () => {
  const t = setup();
  for (let i = 0; i < 7; i++) t.s3.putObject(`${CO}/${FI}/o${i}.mp4`, [1], { at: OLD });
  for (let i = 0; i < 5; i++) {
    const id = await t.s3.createUpload(`${CO}/${FI}/u${i}.mp4`, "video/mp4");
    t.s3.uploads.get(id).initiatedAt = OLD;
  }
  const report = await purge.runRecordingPurge(t.deps({ sweepPage: 2 }));
  assert.equal(report.objectsScanned, 7);
  assert.equal(report.uploadsScanned, 5);
  assert.equal(t.s3.objects.size + t.s3.uploads.size, 0);
  for (const c of t.s3.calls.filter(
    (c) => c[0] === "listObjectsPage" || c[0] === "listUploadsPage",
  )) {
    assert.equal(c[c.length - 1], 2, "page size");
  }
});

test("out of budget: a continuation carries the cursor and the next run finishes the bucket", async () => {
  const t = setup();
  for (let i = 0; i < 6; i++) t.s3.putObject(`${CO}/${FI}/o${i}.mp4`, [1], { at: OLD });
  let steps = 0;
  const ctx = {
    deadlineAt: 0,
    signal: new AbortController().signal,
    remainingMs: () => (++steps > 5 ? 1_000 : 50_000),
  };
  const first = await purge.runRecordingPurge(t.deps({ ctx, sweepPage: 2 }));
  assert.equal(first.continued, true);
  assert.equal(t.enqueued.length, 1);
  const [cont] = t.enqueued;
  assert.equal(cont.type, "final_recording_purge");
  assert.equal(cont.payload.resume.phase, "objects");
  const left = t.s3.objects.size;
  assert.ok(left > 0 && left < 6, `${left} left after the first run`);
  const second = await purge.runRecordingPurge(t.deps({ sweepPage: 2 }), cont.payload);
  assert.equal(second.continued, false);
  assert.equal(t.s3.objects.size, 0);
});

/* ── concurrent deletion and upload ─────────────────────────────── */

test("an applicant deleted mid-upload: the upload and any late object are swept once 24 hours old", async () => {
  const t = setup();
  const pending = addRecording(t, { status: "pending" }, { object: false });
  const upload = await t.s3.createUpload(pending.storage_path, "video/mp4");
  t.s3.uploads.get(upload).initiatedAt = NOW - 60_000; // started a minute ago
  // The applicant is deleted: the cascade takes the recording row with it.
  t.db.final_interview_recordings.splice(0);
  // A late part completes into an object after the delete.
  const late = `${CO}/${FI}/late-object.mp4`;
  t.s3.putObject(late, [1], { at: NOW });
  const soon = await purge.runRecordingPurge(t.deps());
  assert.ok(t.s3.uploads.has(upload), "within 24 hours, left alone");
  assert.ok(t.s3.objects.has(late));
  assert.equal(soon.youngUploadsKept + soon.youngObjectsKept, 2);
  const later = await purge.runRecordingPurge(
    t.deps({ now: () => NOW + RECORDING_ORPHAN_GRACE_MS + 1 }),
  );
  assert.equal(t.s3.uploads.has(upload), false);
  assert.equal(t.s3.objects.has(late), false);
  assert.deepEqual([later.orphanUploadsAborted, later.orphanObjectsDeleted], [1, 1]);
});

/* ── logs and copy ──────────────────────────────────────────────── */

test("logs carry counts and ids, never storage paths", async () => {
  const lines = [];
  const orig = { log: console.log, error: console.error, warn: console.warn };
  for (const k of Object.keys(orig)) console[k] = (...a) => lines.push(a.join(" "));
  try {
    const t = setup();
    const r = addRecording(t);
    t.s3.failNext("deleteObject", new Error("503"));
    await purge.runRecordingPurge(t.deps());
    assert.ok(
      lines.some((l) => l.includes(r.id)),
      "the recording id is logged",
    );
    assert.ok(!lines.join("\n").includes(r.storage_path));
    assert.ok(!lines.join("\n").includes(".mp4"));
  } finally {
    Object.assign(console, orig);
  }
});

test("hyphens, never em dashes, in purge.ts", () => {
  const src = readFileSync(new URL("./purge.ts", import.meta.url), "utf8");
  assert.ok(!src.includes(String.fromCharCode(0x2014)));
});
