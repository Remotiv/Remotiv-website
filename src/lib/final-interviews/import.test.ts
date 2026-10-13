/**
 * Recording step 4: the import, end to end, against the migration 038/040
 * database fake, a fake Recall and a fake S3 bucket. Nothing live.
 *
 *   node --test src/lib/final-interviews/import.test.ts
 *
 * `drive` runs the job the way the worker does: a JobYield puts it straight
 * back, any other error is a retry, a TerminalJobError ends it. `partsPerRun`
 * stands in for the 55-second budget.
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";
import { fakeRecall, httpError, timeoutError } from "../../test-support/fake-recall.mjs";
import { fakeS3 } from "../../test-support/fake-s3.mjs";
import {
  APP,
  BOOKING,
  botWorld,
  CO,
  FI,
  HOST,
  JOB,
  makeBotDb,
  makeEnqueue,
} from "../../test-support/final-bot-world.mjs";

register(new URL("../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../test-support/fake-service-client-hook.mjs", import.meta.url));

const imp = await import("./import.ts");
const bots = await import("./bots.ts");
const alerts = await import("./alerts.ts");
const { JobYield, TerminalJobError } = await import("../queue/failure-class.ts");
const { RecordingStoreError, getRecordingStore } = await import("../storage-s3.ts");
const { RECORDING_IMPORT_PART_BYTES: PART, RECORDING_MAX_BYTES } = await import("./constants.ts");

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.parse("2026-11-05T09:00:00.000Z");
const at = (ms) => new Date(T0 + ms).toISOString();

/** A file whose bytes 4-7 are "ftyp", the rest a pattern, so any misplaced byte shows. */
function mp4(size) {
  const b = new Uint8Array(size);
  for (let i = 0; i < size; i++) b[i] = (i * 31 + 7) & 255;
  b.set([0x66, 0x74, 0x79, 0x70], 4);
  return b;
}
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

function setup({ size = PART + 4321, bytes, row = {}, store = true, media = {} } = {}) {
  const db = makeBotDb(T0);
  const service = botWorld(db);
  const recall = fakeRecall();
  const s3 = fakeS3();
  const providerBotId = randomUUID();
  recall.add({ id: providerBotId });
  const file = bytes ?? mp4(size);
  const recId = recall.addMedia(providerBotId, file, media);
  const bot = {
    id: randomUUID(),
    final_interview_id: FI,
    company_id: CO,
    job_id: JOB,
    application_id: APP,
    booking_id: BOOKING,
    provider: "recall",
    provider_bot_id: providerBotId,
    provider_recording_id: recId,
    join_at: at(-MIN),
    status: "done",
    last_event_code: "done",
    last_event_sub_code: null,
    last_event_at: at(HOUR),
    import_status: "queued",
    import_started_at: null,
    import_error: null,
    lobby_alert_sent_at: null,
    failure_alert_sent_at: null,
    superseded_at: null,
    updated_at: at(HOUR),
    ...row,
  };
  db.final_interview_bots.push(bot);
  const clock = { now: T0 + 2 * HOUR };
  const deps = {
    service,
    recall,
    store: store ? s3 : null,
    enqueue: makeEnqueue(service),
    now: () => clock.now,
  };
  const recRowId = imp.recordingRowId(recId);
  return {
    db,
    service,
    recall,
    s3,
    bot,
    file,
    recId,
    deps,
    clock,
    recRowId,
    key: `${CO}/${FI}/${recRowId}.mp4`,
    row: () => db.final_interview_bots.find((b) => b.id === bot.id),
    recs: () => db.final_interview_recordings,
    rec: () => db.final_interview_recordings.find((r) => r.vendor_recording_id === recId),
    jobs: (type) => db.background_jobs.filter((j) => !type || j.type === type),
    bells: () => db.notifications_company,
    parts: () => Math.ceil(file.length / PART),
  };
}

/** One job, run the way the worker runs it, until it settles. */
async function drive(t, { partsPerRun = Number.POSITIVE_INFINITY, maxRuns = 40 } = {}) {
  let yields = 0;
  const errors = [];
  for (let i = 0; i < maxRuns; i++) {
    const start = t.s3.count("uploadPart");
    const ctx = {
      deadlineAt: 0,
      signal: new AbortController().signal,
      remainingMs: () => (t.s3.count("uploadPart") - start < partsPerRun ? 50_000 : 1_000),
    };
    try {
      const outcome = await imp.runRecordingImport({ ...t.deps, ctx }, { botId: t.bot.id }, CO);
      return { outcome, yields, errors };
    } catch (err) {
      if (err instanceof JobYield) {
        yields += 1;
        continue;
      }
      errors.push(err);
      if (err instanceof TerminalJobError) return { outcome: null, yields, errors, terminal: err };
    }
  }
  throw new Error("the import did not settle");
}

/** Everything a finished import must leave, however it got there. */
function assertImported(t) {
  const recs = t.recs();
  assert.equal(recs.length, 1, "one recording row");
  const rec = recs[0];
  assert.equal(rec.id, t.recRowId);
  assert.equal(rec.status, "ready");
  assert.equal(rec.storage_path, t.key);
  assert.equal(rec.size_bytes, t.file.length);
  assert.ok(same(t.s3.objects.get(t.key), t.file), "the object is the file, byte for byte");
  assert.equal(t.s3.uploads.size, 0, "no upload left open");
  assert.equal(t.row().import_status, "ready");
  assert.equal(t.row().import_error, null);
  assert.equal(t.recall.media.has(t.recId), false, "Recall's copy is deleted");
  const bells = t.bells().filter((b) => b.type === "final_recording_ready");
  assert.equal(bells.length, 1, "one ready bell");
}

/* ── the happy path ───────────────────────────────────────────── */

test("happy path: copied, verified, ready, Recall deleted, then the bot, then one bell", async () => {
  const t = setup({ size: 2 * PART + 99 });
  const { outcome } = await drive(t);
  assert.equal(outcome, "ready");
  assertImported(t);
  const rec = t.rec();
  assert.equal(rec.source, "recall_bot");
  assert.equal(rec.vendor_recording_id, t.recId);
  assert.equal(rec.uploaded_by, null);
  assert.equal(rec.uploaded_by_name, "Remotiv automatic import");
  assert.equal(rec.mime_type, "video/mp4");
  assert.equal(rec.delete_after, "2027-02-05T09:00:00.000Z", "booking start + 3 calendar months");
  assert.equal(t.s3.count("uploadPart"), 3);
  assert.equal(t.recall.count("deleteRecording"), 1);
  const [bell] = t.bells();
  assert.equal(bell.id, alerts.bellNotificationId(t.bot.id, "ready"));
  assert.equal(bell.member_id, HOST);
  assert.equal(bell.company_id, CO);
  assert.equal(bell.application_id, APP);
  assert.equal(bell.title, "The recording of your CTO interview is saved");
  assert.equal(bell.href, `/ai-dashboard/applicants?applicant=${APP}`);
  assert.doesNotMatch(JSON.stringify(bell), /\.mp4|media\.fake|storage/);
  assert.equal(t.jobs("final_bot_lobby_check").length, 0, "no alert");
});

test("a rescheduled interview: delete_after counts from the booking the recording was made in", async () => {
  // The bot recorded the original booking (T0) and was then superseded by a
  // later booking. Retention runs from the call that was recorded.
  const t = setup({
    row: { status: "superseded", superseded_at: at(2 * HOUR) },
  });
  t.db.interview_bookings.push({
    ...t.db.interview_bookings[0],
    id: "b0000000-0000-4000-8000-000000000099",
    scheduled_start: "2026-12-31T09:00:00.000Z",
  });
  assert.equal((await drive(t)).outcome, "ready");
  assert.equal(t.rec().delete_after, "2027-02-05T09:00:00.000Z");
});

test("a failed recording row is terminal: a later run neither revives it nor uploads anything", async () => {
  const t = setup();
  // The row a failed import left: same deterministic id, so any retry finds it.
  t.db.final_interview_recordings.push({
    id: t.recRowId,
    final_interview_id: FI,
    company_id: CO,
    job_id: JOB,
    application_id: APP,
    source: "recall_bot",
    vendor_recording_id: t.recId,
    storage_path: t.key,
    mime_type: "video/mp4",
    size_bytes: t.file.length,
    status: "failed",
    uploaded_by: null,
  });
  const { terminal } = await drive(t);
  assert.ok(terminal instanceof TerminalJobError);
  assert.equal(t.rec().status, "failed", "never back to pending or ready");
  assert.equal(t.rec().storage_path, t.key, "a failed row keeps its path");
  assert.equal(t.s3.count("createUpload") + t.s3.count("uploadPart"), 0);
  assert.equal(t.recall.count("deleteRecording"), 0);
});

test("the order: verify, ready row, Recall delete, bot ready, bell", async () => {
  const t = setup();
  const seen = [];
  t.s3.before("readHead", () => seen.push(["verify", t.rec()?.status]));
  t.recall.before("deleteRecording", () =>
    seen.push(["delete", t.rec().status, t.row().import_status, t.bells().length]),
  );
  await drive(t);
  assert.deepEqual(seen, [
    ["verify", "pending"],
    ["delete", "ready", "importing", 0],
  ]);
  assert.equal(t.row().import_status, "ready");
});

test("resumable: a few parts per run, handed back with JobYield, nothing uploaded twice", async () => {
  const t = setup({ size: 3 * PART + 5 });
  const { outcome, yields } = await drive(t, { partsPerRun: 1 });
  assert.equal(outcome, "ready");
  assert.ok(yields >= 3, `yielded ${yields} times`);
  assert.equal(t.s3.count("uploadPart"), 4, "each of the four parts once");
  assert.equal(t.s3.count("createUpload"), 1, "one upload, found again each run");
  assertImported(t);
});

test("memory stays bounded: no part or range is larger than 8 MiB", async () => {
  const t = setup({ size: 2 * PART + 1 });
  await drive(t, { partsPerRun: 1 });
  assert.ok(t.s3.maxPartBytes() <= PART);
  for (const [start, end] of t.recall.ranges) assert.ok(end - start + 1 <= PART);
  assert.deepEqual(t.recall.ranges, [
    [0, 0],
    [0, PART - 1],
    [PART, 2 * PART - 1],
    [2 * PART, 2 * PART],
  ]);
});

test("a rerun after a finished import is a no-op: no row, upload, delete or bell again", async () => {
  const t = setup();
  await drive(t);
  const counts = () => [
    t.s3.count("uploadPart"),
    t.s3.count("createUpload"),
    t.recall.count("deleteRecording"),
    t.recall.count("downloadRange"),
  ];
  const before = counts();
  assert.equal((await drive(t)).outcome, "already_ready");
  assert.deepEqual(counts(), before);
  assertImported(t);
});

/* ── crashes at every transition (decision 9) ─────────────────── */

const CRASHES = [
  [
    "the claim write lands, its answer is lost",
    (t) => t.service.failNext("final_interview_bots", "update", undefined, { applied: true }),
  ],
  [
    "the recording row insert lands, its answer is lost",
    (t) => t.service.failNext("final_interview_recordings", "insert", undefined, { applied: true }),
  ],
  [
    "CreateMultipartUpload succeeds, its answer is lost",
    (t) => t.s3.failNext("createUpload", new Error("socket hang up"), { after: true }),
  ],
  [
    "a part is stored, its answer is lost",
    (t) => t.s3.failNext("uploadPart", new Error("socket hang up"), { after: true }),
  ],
  ["a part upload fails outright", (t) => t.s3.failNext("uploadPart", new Error("503"))],
  ["a download times out", (t) => t.recall.failNext("downloadRange", timeoutError("download"))],
  [
    "CompleteMultipartUpload succeeds, its answer is lost",
    (t) => t.s3.failNext("completeUpload", new Error("socket hang up"), { after: true }),
  ],
  ["the object check fails", (t) => t.s3.failNext("headObject", new Error("503"))],
  [
    "the ready write lands, its answer is lost",
    (t) =>
      t.s3.before("readHead", () =>
        t.service.failNext("final_interview_recordings", "update", undefined, { applied: true }),
      ),
  ],
  [
    "Recall's delete times out",
    (t) => t.recall.failNext("deleteRecording", timeoutError("delete recording")),
  ],
  [
    "Recall's delete lands, its answer is lost",
    (t) =>
      t.recall.before("deleteRecording", () => {
        t.recall.media.delete(t.recId);
        throw timeoutError("delete recording");
      }),
  ],
  [
    "the bot-ready write lands, its answer is lost",
    (t) =>
      t.recall.before("deleteRecording", () =>
        t.service.failNext("final_interview_bots", "update", undefined, { applied: true }),
      ),
  ],
  ["the bell insert fails", (t) => t.service.failNext("notifications_company", "insert")],
];

for (const [name, crash] of CRASHES) {
  test(`crash: ${name}; the retries finish with one row, one object, no re-upload`, async () => {
    const t = setup({ size: 2 * PART + 7 });
    crash(t);
    const { outcome, errors } = await drive(t);
    assert.ok(["ready", "already_ready"].includes(outcome), `${outcome}`);
    assert.ok(
      errors.every((e) => !(e instanceof TerminalJobError)),
      "nothing terminal",
    );
    assertImported(t);
    assert.ok(t.s3.count("uploadPart") <= t.parts() + 1, "at most the crashed part again");
  });
}

test("Recall's delete keeps failing: the copy stays ready, the bot importing, and a rerun deletes only", async () => {
  const t = setup();
  t.recall.failNext("deleteRecording", httpError(503, "delete recording"));
  await assert.rejects(
    imp.runRecordingImport(t.deps, { botId: t.bot.id }, CO),
    (e) => !(e instanceof TerminalJobError),
  );
  assert.equal(t.rec().status, "ready", "playable already");
  assert.equal(t.row().import_status, "importing", "never ready before Recall's delete");
  assert.equal(t.bells().length, 0, "no bell before the bot is ready");
  const work = [t.s3.count("uploadPart"), t.recall.count("downloadRange")];
  assert.equal(await imp.runRecordingImport(t.deps, { botId: t.bot.id }, CO), "ready");
  assert.deepEqual([t.s3.count("uploadPart"), t.recall.count("downloadRange")], work);
  assert.equal(t.recall.count("deleteRecording"), 2);
  assertImported(t);
});

test("Recall answers 404 to the delete: done", async () => {
  const t = setup();
  // Gone between the ownership check and the delete, so the delete is a 404.
  t.recall.before("deleteRecording", () => {
    t.recall.media.delete(t.recId);
    for (const b of t.recall.bots.values()) b.recordings = [];
  });
  assert.equal((await drive(t)).outcome, "ready");
  assert.equal(t.recall.count("deleteRecording"), 1);
  assertImported(t);
});

test("Recall no longer has the recording at all: nothing to delete, the bot is ready", async () => {
  const t = setup();
  t.s3.before("readHead", () => t.recall.media.delete(t.recId));
  assert.equal((await drive(t)).outcome, "ready");
  assert.equal(t.recall.count("deleteRecording"), 0);
  assertImported(t);
});

test("the copy is checked again before Recall's delete: missing, and Recall's copy is kept", async () => {
  const t = setup();
  let heads = 0;
  const realHead = t.s3.headObject;
  t.s3.headObject = async (key) => {
    heads += 1;
    // pre-copy, verify, then the check before the delete: lose the object there.
    if (heads === 3) t.s3.objects.delete(key);
    return realHead(key);
  };
  await assert.rejects(imp.runRecordingImport(t.deps, { botId: t.bot.id }, CO));
  assert.equal(t.recall.count("deleteRecording"), 0);
  assert.equal(t.recall.media.has(t.recId), true);
  assert.equal(t.row().import_status, "importing");
});

/* ── verification ─────────────────────────────────────────────── */

test("not an MP4: the object is deleted, the import failed, Recall's copy kept, the host alerted", async () => {
  const bytes = mp4(PART + 10);
  bytes.set([0, 0, 0, 0], 4);
  const t = setup({ bytes });
  const { outcome } = await drive(t);
  assert.equal(outcome, "failed");
  assert.equal(t.row().import_status, "failed");
  assert.equal(t.row().import_error, "not_mp4");
  assert.equal(t.rec().status, "failed", "never ready without verify");
  assert.equal(t.s3.objects.size, 0);
  assert.equal(t.s3.uploads.size, 0);
  assert.equal(t.recall.count("deleteRecording"), 0);
  assert.equal(t.recall.media.has(t.recId), true);
  const [alert] = t.jobs("final_bot_lobby_check");
  assert.deepEqual(alert.payload, { botRowId: t.bot.id, kind: "import_failed" });
  assert.equal(alert.id, bots.importFailedAlertJobId(t.bot.id));
});

test("the stored object is the wrong size: deleted, failed, nothing ready", async () => {
  const t = setup();
  const complete = t.s3.completeUpload;
  t.s3.completeUpload = async (...args) => {
    const r = await complete(...args);
    const o = t.s3.objects.get(t.key);
    t.s3.objects.set(t.key, o.slice(0, o.length - 1));
    return r;
  };
  assert.equal((await drive(t)).outcome, "failed");
  assert.equal(t.row().import_error, "size_mismatch");
  assert.equal(t.rec().status, "failed");
  assert.equal(t.s3.objects.size, 0);
  assert.equal(t.recall.count("deleteRecording"), 0);
});

test("over 2 GiB: refused before any row, upload or delete", async () => {
  const t = setup();
  const download = t.recall.downloadRange;
  t.recall.downloadRange = async (url, start, end) => {
    const r = await download(url, start, end);
    return { ...r, total: RECORDING_MAX_BYTES + 1 };
  };
  assert.equal((await drive(t)).outcome, "failed");
  assert.equal(t.row().import_error, "too_large");
  assert.equal(t.recs().length, 0);
  assert.equal(t.s3.count("createUpload") + t.s3.count("uploadPart"), 0, "nothing uploaded");
  assert.equal(t.s3.objects.size, 0);
  assert.equal(t.recall.count("deleteRecording"), 0);
  assert.equal(t.jobs("final_bot_lobby_check").length, 1, "the host is alerted");
});

test("a range that does not come back as asked fails the part and retries it", async () => {
  const t = setup();
  t.recall.failNext(
    "downloadRange",
    httpError(503, "download recording"), // any non-terminal failure of a part
  );
  assert.equal((await drive(t)).outcome, "ready");
  assertImported(t);
});

/* ── Recall's side ────────────────────────────────────────────── */

test("the download URL expires mid-run: a fresh one is fetched and the copy goes on", async () => {
  const t = setup({ size: 2 * PART + 3 });
  let uploads = 0;
  const upload = t.s3.uploadPart;
  t.s3.uploadPart = async (...args) => {
    uploads += 1;
    if (uploads === 1) t.recall.expireUrls(t.recId);
    return upload(...args);
  };
  assert.equal((await drive(t)).outcome, "ready");
  assert.ok(t.recall.count("retrieveRecording") >= 3, "fetched again after the refusal");
  assertImported(t);
});

test("a recording that is not this bot's: nothing copied, nothing deleted, failed", async () => {
  const t = setup();
  t.recall.media.get(t.recId).botId = randomUUID();
  assert.equal((await drive(t)).outcome, "failed");
  assert.equal(t.row().import_error, "owner_mismatch");
  assert.equal(t.recs().length, 0);
  assert.equal(t.recall.count("downloadRange"), 0);
  assert.equal(t.recall.count("deleteRecording"), 0);
});

test("still processing at Recall: retried, nothing written", async () => {
  const t = setup({ media: { status: "processing", video: "processing" } });
  await assert.rejects(
    imp.runRecordingImport(t.deps, { botId: t.bot.id }, CO),
    (e) => !(e instanceof TerminalJobError) && /still processing/.test(e.message),
  );
  assert.equal(t.recs().length, 0);
  assert.equal(t.row().import_status, "importing");
});

test("Recall's recording failed, or has no video: failed with that code", async () => {
  for (const [media, code] of [
    [{ status: "failed" }, "recording_failed"],
    [{ video: "failed" }, "no_video"],
  ]) {
    const t = setup({ media });
    assert.equal((await drive(t)).outcome, "failed");
    assert.equal(t.row().import_error, code);
  }
});

/* ── storage's side ───────────────────────────────────────────── */

test("an upload storage dropped after a day: started again cleanly", async () => {
  const t = setup({ size: 2 * PART + 3 });
  await assert.rejects(
    (async () => {
      const r = await drive(t, { partsPerRun: 1, maxRuns: 1 });
      if (r) throw new Error("expected the first run to hand back");
    })(),
  );
  assert.equal(t.s3.count("uploadPart"), 1);
  t.s3.expireUploads();
  assert.equal((await drive(t)).outcome, "ready");
  assert.equal(t.s3.count("createUpload"), 2, "a new upload");
  assert.equal(t.s3.count("uploadPart"), 1 + t.parts(), "every part again, once");
  assertImported(t);
});

test("the upload disappears between finding it and listing its parts: started again", async () => {
  const t = setup();
  t.s3.before("listParts", () => t.s3.expireUploads());
  await t.s3.createUpload(t.key, "video/mp4"); // an upload an earlier run left
  assert.equal((await drive(t)).outcome, "ready");
  assertImported(t);
});

test("storage refusing the keys or the bucket is a configuration error, not a failed import", async () => {
  const t = setup();
  t.s3.failNext("findUploads", new RecordingStoreError("list uploads", 403, "AccessDenied"));
  const { terminal } = await drive(t);
  assert.equal(terminal.failureClass, "configuration");
  assert.equal(t.row().import_status, "importing", "left for a later job");
  assert.equal(t.jobs("final_bot_lobby_check").length, 0);
});

test("no SUPABASE_S3_* configuration: refused before the claim, with a clear error", async () => {
  const t = setup({ store: false });
  await assert.rejects(
    imp.runRecordingImport(t.deps, { botId: t.bot.id }, CO),
    (e) =>
      e instanceof TerminalJobError &&
      e.failureClass === "configuration" &&
      /SUPABASE_S3_ENDPOINT/.test(e.message),
  );
  assert.equal(t.row().import_status, "queued");
  assert.equal(
    getRecordingStore("b", { SUPABASE_S3_ENDPOINT: "https://x.test", SUPABASE_S3_REGION: "r" }),
    null,
  );
  assert.equal(
    getRecordingStore("b", {
      SUPABASE_S3_ENDPOINT: "http://x.test",
      SUPABASE_S3_REGION: "r",
      SUPABASE_S3_ACCESS_KEY_ID: "a",
      SUPABASE_S3_SECRET_ACCESS_KEY: "s",
    }),
    null,
    "https only",
  );
});

/* ── the claim ────────────────────────────────────────────────── */

test("the claim is a compare-and-swap: another run claiming first, from the same read, stops this one", async () => {
  const t = setup();
  // This run reads the row; another run claims it before this one's write.
  t.service.afterNext("final_interview_bots", "select", () => {
    Object.assign(t.row(), { import_status: "importing", import_started_at: at(5 * HOUR) });
  });
  assert.equal(await imp.runRecordingImport(t.deps, { botId: t.bot.id }, CO), "claim_lost");
  assert.equal(t.row().import_started_at, at(5 * HOUR), "the other run's claim stands");
  assert.equal(t.recall.calls.length, 0, "no Recall call at all");
  assert.equal(t.s3.calls.length, 0);
  assert.equal(t.recs().length, 0);
});

test("two runs at once: one finishes, the other stops, nothing is uploaded twice", async () => {
  const t = setup({ size: 2 * PART + 1 });
  const results = await Promise.all([
    imp.runRecordingImport(t.deps, { botId: t.bot.id }, CO),
    imp.runRecordingImport(t.deps, { botId: t.bot.id }, CO),
  ]);
  assert.deepEqual(results.sort(), ["claim_lost", "ready"]);
  assert.equal(t.s3.count("uploadPart"), t.parts());
  assert.equal(t.recall.count("deleteRecording"), 1);
  assertImported(t);
});

test("a run whose claim is taken mid-copy stops before its next part", async () => {
  const t = setup({ size: 2 * PART + 1 });
  t.s3.before("uploadPart", () => {
    t.row().import_started_at = at(9 * HOUR);
  });
  assert.equal(await imp.runRecordingImport(t.deps, { botId: t.bot.id }, CO), "claim_lost");
  assert.equal(t.s3.count("uploadPart"), 1);
  assert.equal(t.rec().status, "pending");
});

/* ── a lost claim: replaced by a newer worker vs the row deleted ─ */

/** The worker's claim is taken by worker B: B's token on the row, as B's claim writes it. */
const takeOver = (t, token = at(9 * HOUR)) => {
  Object.assign(t.row(), { import_status: "importing", import_started_at: token });
};

test("claim replaced mid-copy: worker A stops and worker B's upload and parts survive; B finishes", async () => {
  const t = setup({ size: 3 * PART + 9 });
  let calls = 0;
  let inB = false;
  const upload = t.s3.uploadPart;
  t.s3.uploadPart = async (...args) => {
    calls += 1;
    if (calls === 2 && !inB) {
      // A has stored part 1 and is sending part 2. Worker B takes over now,
      // stores part 2 into the same upload, and hands its job back.
      inB = true;
      const start = t.s3.count("uploadPart");
      const ctx = {
        deadlineAt: 0,
        signal: new AbortController().signal,
        remainingMs: () => (t.s3.count("uploadPart") - start < 1 ? 50_000 : 1_000),
      };
      await assert.rejects(
        imp.runRecordingImport({ ...t.deps, ctx }, { botId: t.bot.id }, CO),
        (e) => e instanceof JobYield,
      );
      inB = false;
    }
    return upload(...args);
  };
  const tokenBefore = t.row().import_started_at;
  assert.equal(
    await imp.runRecordingImport(t.deps, { botId: t.bot.id }, CO),
    "claim_lost",
    "A stops at its next claim check",
  );
  assert.notEqual(t.row().import_started_at, tokenBefore);
  assert.equal(t.s3.count("abortUpload") + t.s3.count("deleteObject"), 0, "A destroyed nothing");
  assert.equal(t.s3.uploads.size, 1);
  const [u] = [...t.s3.uploads.values()];
  assert.deepEqual([...u.parts.keys()].sort(), [1, 2], "B's part 2 is still there");
  assert.equal(t.row().import_status, "importing", "A wrote nothing on its way out");

  t.s3.uploadPart = upload;
  assert.equal((await drive(t)).outcome, "ready", "B carries on from where it was");
  assert.equal(t.s3.count("createUpload"), 1, "one upload, shared, never restarted");
  assertImported(t);
});

test("claim replaced before A lists uploads, and B's upload is not the oldest: A aborts nothing", async () => {
  const t = setup();
  let bUpload = "";
  // A has claimed and checks for a finished object; meanwhile B takes over
  // and is writing into an upload that is newer than a leftover one.
  t.s3.before("headObject", async () => {
    takeOver(t);
    await t.s3.createUpload(t.key, "video/mp4"); // a leftover, older
    bUpload = await t.s3.createUpload(t.key, "video/mp4");
    await t.s3.uploadPart(t.key, bUpload, 1, t.file.slice(0, PART));
  });
  assert.equal(await imp.runRecordingImport(t.deps, { botId: t.bot.id }, CO), "claim_lost");
  assert.equal(t.s3.count("abortUpload"), 0);
  assert.ok(t.s3.uploads.has(bUpload), "B's upload survives");
  assert.equal(t.s3.uploads.get(bUpload).parts.size, 1);
});

test("the recording row deleted by hand mid-run, bot row still there: the copy is kept", async () => {
  const t = setup();
  t.s3.before("readHead", () => t.db.final_interview_recordings.splice(0));
  assert.equal(await imp.runRecordingImport(t.deps, { botId: t.bot.id }, CO), "interview_gone");
  assert.ok(same(t.s3.objects.get(t.key), t.file), "nothing deleted without proof of orphaning");
  assert.equal(t.s3.count("deleteObject") + t.s3.count("abortUpload"), 0);
  assert.equal(t.recall.count("deleteRecording"), 0);
});

/* ── Recall deleted, the bot-row write failed, then 404 ───────── */

/** Copy verified and ready, Recall's delete answered 204, then the bot-ready write fails. */
async function deletedThenWriteFailed(t) {
  t.recall.before("deleteRecording", () => t.service.failNext("final_interview_bots", "update"));
  await assert.rejects(
    imp.runRecordingImport(t.deps, { botId: t.bot.id }, CO),
    (e) => !(e instanceof TerminalJobError),
  );
  assert.equal(t.recall.count("deleteRecording"), 1);
  assert.equal(t.recall.media.has(t.recId), false, "Recall answered 204: its copy is gone");
  assert.equal(t.rec().status, "ready");
  assert.equal(t.row().import_status, "importing", "the write failed");
}

const work = (t) => ({
  uploadPart: t.s3.count("uploadPart"),
  createUpload: t.s3.count("createUpload"),
  completeUpload: t.s3.count("completeUpload"),
  abortUpload: t.s3.count("abortUpload"),
  deleteObject: t.s3.count("deleteObject"),
  downloadRange: t.recall.count("downloadRange"),
  deleteRecording: t.recall.count("deleteRecording"),
});

test("Recall 204, bot write fails, next run gets 404: the copy is confirmed and the bot made ready, nothing redone", async () => {
  const t = setup({ size: 2 * PART + 5 });
  await deletedThenWriteFailed(t);
  const before = work(t);
  const rec = { ...t.rec() };
  const retrievesBefore = t.recall.count("retrieveRecording");

  assert.equal(await imp.runRecordingImport(t.deps, { botId: t.bot.id }, CO), "ready");
  assert.deepEqual(
    work(t),
    before,
    "no re-upload, no delete of either copy, no second Recall delete",
  );
  assert.equal(t.recall.count("retrieveRecording"), retrievesBefore + 1, "Recall was asked");
  assert.deepEqual(t.rec(), rec, "the ready recording row is untouched");
  assert.ok(
    t.s3.calls.slice(-2).some((c) => c[0] === "readHead"),
    "the copy's header was read",
  );
  assertImported(t);
  assert.equal(t.jobs("final_bot_lobby_check").length, 0, "not failed, nobody alerted");
});

test("Recall 404 with Remotiv's copy missing: never ready, never failed, nothing deleted", async () => {
  const t = setup();
  await deletedThenWriteFailed(t);
  t.s3.objects.delete(t.key);
  await assert.rejects(
    imp.runRecordingImport(t.deps, { botId: t.bot.id }, CO),
    (e) => !(e instanceof TerminalJobError) && /Recall's copy kept/.test(e.message),
  );
  assert.equal(t.row().import_status, "importing");
  assert.equal(t.rec().status, "ready", "the row is not failed either");
  assert.equal(t.bells().length, 0);
  assert.equal(t.jobs("final_bot_lobby_check").length, 0);
});

test("Recall 404 with Remotiv's copy the right size but not an MP4: never ready", async () => {
  const t = setup();
  await deletedThenWriteFailed(t);
  const o = t.s3.objects.get(t.key);
  o.set([0, 0, 0, 0], 4);
  await assert.rejects(imp.runRecordingImport(t.deps, { botId: t.bot.id }, CO));
  assert.equal(t.row().import_status, "importing");
  assert.equal(t.bells().length, 0);
  assert.ok(t.s3.objects.has(t.key), "and it is not deleted");
});

test("the job's company must be the row's", async () => {
  const t = setup();
  await assert.rejects(
    imp.runRecordingImport(t.deps, { botId: t.bot.id }, randomUUID()),
    (e) => e instanceof TerminalJobError,
  );
  assert.equal(t.row().import_status, "queued");
});

/* ── duplicates ───────────────────────────────────────────────── */

const manualReady = () => ({
  id: randomUUID(),
  final_interview_id: FI,
  company_id: CO,
  job_id: JOB,
  application_id: APP,
  source: "manual_upload",
  vendor_recording_id: null,
  storage_path: `${CO}/${FI}/manual.mp4`,
  mime_type: "video/mp4",
  size_bytes: 10,
  status: "ready",
  uploaded_by: randomUUID(),
  delete_after: at(180 * 24 * HOUR),
});

test("a ready recording already exists: ours is failed duplicate_recording, Recall's kept, no alert", async () => {
  const t = setup();
  const manual = manualReady();
  t.db.final_interview_recordings.push(manual);
  assert.equal((await drive(t)).outcome, "duplicate");
  assert.equal(t.row().import_status, "failed");
  assert.equal(t.row().import_error, "duplicate_recording");
  assert.equal(t.recs().length, 1);
  assert.equal(t.recs()[0].status, "ready", "the existing one is untouched");
  assert.equal(t.recall.count("deleteRecording"), 0);
  assert.equal(t.recall.media.has(t.recId), true);
  assert.equal(t.s3.objects.size, 0);
  assert.equal(t.jobs("final_bot_lobby_check").length, 0, "the host is not alerted");
});

test("a ready recording appears while copying: ours fails at ready, its file deleted", async () => {
  const t = setup();
  t.s3.before("readHead", () => t.db.final_interview_recordings.push(manualReady()));
  assert.equal((await drive(t)).outcome, "duplicate");
  assert.equal(t.rec().status, "failed");
  assert.equal(t.s3.objects.has(t.key), false, "our file is deleted");
  assert.equal(t.row().import_error, "duplicate_recording");
  assert.equal(t.recall.count("deleteRecording"), 0);
});

/* ── the applicant is deleted mid-import ──────────────────────── */

/** What the cascade and migration 040's orphan guard do when the applicant goes. */
function deleteApplicant(t) {
  const row = t.row();
  t.db.final_interviews.splice(0);
  t.db.final_interview_recordings.splice(0);
  t.db.final_interview_bots.splice(t.db.final_interview_bots.indexOf(row), 1);
  if (row.import_status !== "ready") {
    t.db.background_jobs.push({
      id: randomUUID(),
      type: "final_bot_sync",
      company_id: null,
      status: "queued",
      payload: {
        action: "delete",
        providerBotId: row.provider_bot_id,
        providerRecordingId: row.provider_recording_id,
      },
    });
  }
}

test("applicant deleted mid-copy: the run stops cleanly, its copy is removed, the orphan path deletes Recall's", async () => {
  const t = setup({ size: 2 * PART + 1 });
  let uploads = 0;
  const upload = t.s3.uploadPart;
  t.s3.uploadPart = async (...args) => {
    uploads += 1;
    if (uploads === 2) deleteApplicant(t);
    return upload(...args);
  };
  const { outcome } = await drive(t);
  assert.equal(outcome, "claim_lost");
  assert.equal(t.s3.uploads.size, 0, "the unfinished upload is aborted");
  assert.equal(t.s3.objects.size, 0);
  const [orphan] = t.jobs("final_bot_sync");
  const botDeps = { ...t.deps, enabled: () => false, sleep: async () => {} };
  await bots.processFinalBotJob(botDeps, orphan);
  assert.equal(t.recall.media.has(t.recId), false, "the orphan delete removed Recall's copy");
  assert.equal((await drive(t)).outcome, "bot_gone");
});

test("applicant deleted after the copy is ready: the import stops, Recall's copy is left to the orphan path", async () => {
  const t = setup();
  let fetches = 0;
  const retrieve = t.recall.retrieveRecording;
  t.recall.retrieveRecording = async (id, o) => {
    fetches += 1;
    // The first fetch is the copy's; the second is the check before the delete.
    if (fetches === 2) deleteApplicant(t);
    return retrieve(id, o);
  };
  assert.equal((await drive(t)).outcome, "claim_lost");
  assert.equal(t.recall.count("deleteRecording"), 0, "the import never deleted it");
  assert.equal(t.jobs("final_bot_sync").length, 1, "040's guard queued the orphan delete");
  assert.equal(t.s3.objects.size, 0, "the copy went with the interview");
});

/* ── the import-failed alert (decision 6, clarification 4) ────── */

function alertDeps(t, email = { ok: true }) {
  const emails = [];
  return {
    emails,
    deps: {
      service: t.service,
      sendEmail: async (payload, options) => {
        emails.push({ ...payload, key: options?.idempotencyKey });
        return typeof email === "function" ? email() : email;
      },
      now: () => t.clock.now,
    },
  };
}

test("import_failed: the email and bell say the recording could not be saved", async () => {
  const t = setup({ row: { import_status: "failed", import_error: "not_mp4" } });
  t.db.interview_bookings[0].status = "completed";
  t.db.final_interviews[0].status = "completed";
  const a = alertDeps(t);
  const outcome = await alerts.runFinalBotAlert(a.deps, {
    botRowId: t.bot.id,
    kind: "import_failed",
  });
  assert.equal(outcome, "sent");
  const [email] = a.emails;
  assert.equal(email.to, "host@acme.test");
  assert.equal(email.subject, "The recording of your CTO interview could not be saved");
  assert.match(email.html, /The recording of your CTO interview with Sam could not be saved\./);
  assert.doesNotMatch(email.html, /\u2014/);
  const [bell] = t.bells();
  assert.equal(bell.type, "final_recording_failed");
  assert.equal(bell.id, alerts.bellNotificationId(t.bot.id, "import_failed"));
  assert.equal(bell.member_id, HOST);
});

test("import_failed is independent of the 3b failure alert: neither suppresses the other", async () => {
  const t = setup({
    row: { import_status: "failed", import_error: "size_mismatch", status: "fatal" },
  });
  const a = alertDeps(t);
  // The 3b failure alert first: it claims its stamp.
  t.db.interview_bookings[0].status = "booked";
  assert.equal(
    await alerts.runFinalBotAlert(a.deps, { botRowId: t.bot.id, kind: "failure" }),
    "sent",
  );
  assert.ok(t.row().failure_alert_sent_at);
  assert.equal(
    await alerts.runFinalBotAlert(a.deps, { botRowId: t.bot.id, kind: "import_failed" }),
    "sent",
    "the failure stamp does not stop it",
  );
  assert.equal(t.row().lobby_alert_sent_at, null, "no stamp of anyone else's is written");
  assert.equal(a.emails.length, 2);
  assert.notEqual(a.emails[0].key, a.emails[1].key);
  assert.deepEqual(
    t
      .bells()
      .map((b) => b.id)
      .sort(),
    [
      alerts.bellNotificationId(t.bot.id, "failure"),
      alerts.bellNotificationId(t.bot.id, "import_failed"),
    ].sort(),
  );

  // And the other way round: an import_failed job never takes a failure alert's id.
  const u = setup({ row: { status: "fatal", import_status: "failed", import_error: "too_large" } });
  assert.equal(await bots.ensureImportFailedAlert(u.deps, u.bot), "queued");
  assert.equal(await bots.ensureImportFailedAlert(u.deps, u.bot), "exists");
  const failureIds = new Set(bots.failureAlertJobIds(u.bot.id));
  assert.ok(!failureIds.has(bots.importFailedAlertJobId(u.bot.id)));
  u.db.background_jobs[0].status = "succeeded";
  assert.equal(await bots.ensureImportFailedAlert(u.deps, u.bot), "exists", "one ever");
});

test("import_failed: a refused email retries without a bell; the last attempt bells; a rerun adds nothing", async () => {
  const t = setup({ row: { import_status: "failed", import_error: "too_large" } });
  const refused = alertDeps(t, { ok: false });
  await assert.rejects(
    alerts.runFinalBotAlert(refused.deps, { botRowId: t.bot.id, kind: "import_failed" }),
  );
  assert.equal(t.bells().length, 0);
  assert.equal(
    await alerts.runFinalBotAlert(
      refused.deps,
      { botRowId: t.bot.id, kind: "import_failed" },
      { finalAttempt: true },
    ),
    "bell_after_email_failure",
  );
  const ok = alertDeps(t);
  await alerts.runFinalBotAlert(ok.deps, { botRowId: t.bot.id, kind: "import_failed" });
  assert.equal(t.bells().length, 1, "the bell's id refuses a second");
  assert.equal(refused.emails[0].key, ok.emails[0].key, "the same Resend key: no second email");
});

test("import_failed is not sent for a duplicate, or for an import that did not fail", async () => {
  for (const row of [
    { import_status: "failed", import_error: "duplicate_recording" },
    { import_status: "ready" },
  ]) {
    const t = setup({ row });
    const a = alertDeps(t);
    assert.equal(
      await alerts.runFinalBotAlert(a.deps, { botRowId: t.bot.id, kind: "import_failed" }),
      "not_failed",
    );
    assert.equal(a.emails.length + t.bells().length, 0);
  }
});

test("the ready bell waits for import_status 'ready' and goes to an active host only", async () => {
  const t = setup({ row: { import_status: "importing" } });
  assert.equal(await alerts.notifyRecordingReady(t.deps, t.bot.id), "not_ready");
  t.row().import_status = "ready";
  t.db.company_members[0].status = "removed";
  assert.equal(await alerts.notifyRecordingReady(t.deps, t.bot.id), "host_unverified");
  t.db.company_members[0].status = "active";
  assert.equal(await alerts.notifyRecordingReady(t.deps, t.bot.id), "inserted");
  assert.equal(await alerts.notifyRecordingReady(t.deps, t.bot.id), "inserted");
  assert.equal(t.bells().length, 1);
});

/* ── queueing, the cap and the reconcile ──────────────────────── */

function reconcileDeps(t) {
  return { ...t.deps, enabled: () => false, sleep: async () => {} };
}

test("recording.done queues the import once, whatever is redelivered", async () => {
  const t = setup({ row: { import_status: "none", provider_recording_id: null } });
  const deps = { service: t.service, enqueue: t.deps.enqueue, now: t.deps.now };
  const event = {
    name: "recording.done",
    botId: t.bot.provider_bot_id,
    metadata: null,
    code: "done",
    subCode: null,
    at: at(HOUR),
    recordingId: t.recId,
  };
  assert.equal((await bots.processRecallEvent(deps, event)).outcome, "recording_stored");
  assert.equal((await bots.processRecallEvent(deps, event)).outcome, "duplicate");
  assert.equal(t.row().import_status, "queued");
  const [job] = t.jobs("final_recording_import");
  assert.equal(t.jobs("final_recording_import").length, 1);
  assert.equal(job.id, bots.importJobIds(t.bot.id)[0]);
  assert.equal(job.max_attempts, 5);
});

test("an enqueue that fails on recording.done is a 503, so Recall redelivers", async () => {
  const t = setup({ row: { import_status: "none", provider_recording_id: null } });
  const deps = {
    service: t.service,
    enqueue: makeEnqueue(t.service, { fail: () => ({ ok: false, error: "down" }) }),
    now: t.deps.now,
  };
  const r = await bots.processRecallEvent(deps, {
    name: "recording.done",
    botId: t.bot.provider_bot_id,
    metadata: null,
    code: "done",
    subCode: null,
    at: at(HOUR),
    recordingId: t.recId,
  });
  assert.deepEqual(r, { status: 503, outcome: "enqueue_failed" });
});

test("reconcile: a recording never queued gets its first job, with the flag off", async () => {
  const t = setup({ row: { import_status: "none" } });
  assert.equal(
    await bots.finalBotReconcileWanted({ service: t.service, enabled: () => false }),
    true,
  );
  const report = await bots.reconcileFinalBots(reconcileDeps(t));
  assert.equal(report.importsQueued, 1);
  assert.equal(t.row().import_status, "queued");
  assert.equal(t.jobs("final_recording_import")[0].id, bots.importJobIds(t.bot.id)[0]);
  // Again: a live job exists, so nothing more.
  await bots.reconcileFinalBots(reconcileDeps(t));
  assert.equal(t.jobs("final_recording_import").length, 1);
});

test("reconcile: the next job after one dies starts six hours after it ended", async () => {
  const t = setup({ row: { import_status: "importing" } });
  const [first] = bots.importJobIds(t.bot.id);
  t.db.background_jobs.push({
    id: first,
    type: "final_recording_import",
    status: "dead",
    payload: { botId: t.bot.id },
    updated_at: at(HOUR),
  });
  const report = await bots.reconcileFinalBots(reconcileDeps(t));
  assert.equal(report.importsQueued, 1);
  const next = t.jobs("final_recording_import").find((j) => j.id !== first);
  assert.equal(next.id, bots.importJobIds(t.bot.id)[1]);
  assert.equal(next.run_after, at(7 * HOUR));
});

const deadJobs = (t) =>
  bots.importJobIds(t.bot.id).map((id) => ({
    id,
    type: "final_recording_import",
    status: "dead",
    payload: { botId: t.bot.id },
    updated_at: at(HOUR),
  }));

test("reconcile: every import job used up fails the import, alerts the host, and cleans up", async () => {
  const t = setup({ row: { import_status: "importing" } });
  t.db.background_jobs.push(...deadJobs(t));
  const report = await bots.reconcileFinalBots(reconcileDeps(t));
  assert.equal(report.importsFailed, 1);
  assert.equal(t.row().import_status, "failed");
  assert.equal(t.row().import_error, "retries_exhausted");
  assert.equal(t.jobs("final_bot_lobby_check")[0].payload.kind, "import_failed");
  const cleanup = t.jobs("final_recording_import").find((j) => j.status === "queued");
  assert.ok(cleanup, "one more run, past the cap, to clean up");
  assert.ok(!bots.importJobIds(t.bot.id).includes(cleanup.id));
  // That run cleans what was left and ensures the alert, without a second one.
  await t.s3.createUpload(t.key, "video/mp4");
  assert.equal((await drive(t)).outcome, "already_failed");
  assert.equal(t.s3.uploads.size, 0);
  assert.equal(t.jobs("final_bot_lobby_check").length, 1);
  assert.equal(t.recall.count("deleteRecording"), 0, "Recall's copy is never deleted on a failure");
});

test("reconcile: a ready copy past the cap is never failed; Recall's delete keeps being retried", async () => {
  const t = setup();
  t.recall.failNext("deleteRecording", httpError(503, "delete recording"));
  await assert.rejects(imp.runRecordingImport(t.deps, { botId: t.bot.id }, CO));
  t.row().updated_at = at(HOUR);
  t.db.background_jobs.push(...deadJobs(t));
  const report = await bots.reconcileFinalBots(reconcileDeps(t));
  assert.equal(report.importsFailed, 0);
  assert.equal(report.importDeleteRetries, 1);
  assert.equal(t.row().import_status, "importing");
  assert.equal(t.jobs("final_bot_lobby_check").length, 0, "nothing to alert: the copy is saved");
  assert.equal((await drive(t)).outcome, "ready");
  assertImported(t);
});

test("reconcile: a failed import whose alert was never queued gets it once", async () => {
  const t = setup({
    row: { import_status: "failed", import_error: "not_mp4", updated_at: at(90 * MIN) },
  });
  const r1 = await bots.reconcileFinalBots(reconcileDeps(t));
  const r2 = await bots.reconcileFinalBots(reconcileDeps(t));
  assert.equal(r1.importAlertsQueued, 1);
  assert.equal(r2.importAlertsQueued, 0);
  assert.equal(t.jobs("final_bot_lobby_check").length, 1);
});

/* ── logs ─────────────────────────────────────────────────────── */

test("logs never carry the storage path, the download URL, names or emails", async () => {
  const lines = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  for (const k of Object.keys(orig)) console[k] = (...a) => lines.push(a.join(" "));
  try {
    const ok = setup();
    await drive(ok);
    const bad = setup({ bytes: mp4(PART + 1).fill(0, 4, 8) });
    await drive(bad);
    const gone = setup();
    gone.s3.before("uploadPart", () => deleteApplicant(gone));
    await drive(gone);
  } finally {
    Object.assign(console, orig);
  }
  const text = lines.join("\n");
  assert.ok(lines.length > 0);
  assert.doesNotMatch(text, /\.mp4|media\.fake\.test|https?:\/\/|Sam|@acme\.test/);
  assert.doesNotMatch(text, new RegExp(`${CO}/`));
});

/* ── from the source ──────────────────────────────────────────── */

const src = (rel) => readFileSync(new URL(`../../../${rel}`, import.meta.url), "utf8");
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("source: verify before ready, ready before Recall's delete, the delete before the bot", () => {
  const s = code(src("src/lib/final-interviews/import.ts"));
  const flow = s.slice(s.indexOf("async function copyAndFinish("));
  const verify = flow.indexOf("await verifyObject(run, rec, key);");
  const ready = flow.indexOf("await markReady(run, rec);");
  assert.ok(verify > 0 && ready > verify, "verify, then ready");
  const finish = s.slice(s.indexOf("async function finishWithDelete("));
  const del = finish.indexOf("run.deps.recall.deleteRecording(");
  const botReady = finish.indexOf('import_status: "ready"');
  const bell = finish.indexOf("await sendReadyBell(");
  assert.ok(del > 0 && botReady > del && bell > botReady);
  assert.equal((s.match(/import_status: "ready"/g) ?? []).length, 1, "one place marks it ready");
  assert.equal((s.match(/recall\.deleteRecording\(/g) ?? []).length, 1);
});

test("source: the S3 client is server-only, path-style, checksums only when required, no lib-storage", () => {
  const s = src("src/lib/storage-s3.ts");
  assert.match(s, /^import "server-only";/);
  assert.match(s, /forcePathStyle: true,/);
  assert.match(s, /requestChecksumCalculation: "WHEN_REQUIRED",/);
  assert.match(s, /responseChecksumValidation: "WHEN_REQUIRED",/);
  for (const name of [
    "SUPABASE_S3_ENDPOINT",
    "SUPABASE_S3_REGION",
    "SUPABASE_S3_ACCESS_KEY_ID",
    "SUPABASE_S3_SECRET_ACCESS_KEY",
  ]) {
    assert.match(s, new RegExp(`env\\.${name}\\b`));
  }
  const pkg = JSON.parse(src("package.json"));
  assert.ok(pkg.dependencies["@aws-sdk/client-s3"]);
  assert.equal(pkg.dependencies["@aws-sdk/lib-storage"], undefined);
  assert.doesNotMatch(
    src("src/lib/final-interviews/import.ts"),
    /console\.[a-z]+\([^)]*(key|downloadUrl|storage_path)/,
  );
});

test("source: the download never carries the Recall key", () => {
  const s = code(src("src/lib/recall/client.ts"));
  const download = s.slice(
    s.indexOf("async downloadRange("),
    s.indexOf("};\n}", s.indexOf("async downloadRange(")),
  );
  assert.doesNotMatch(download, /authorization|apiKey|Token /);
  assert.match(download, /headers: \{ range: `bytes=\$\{start\}-\$\{end\}` \}/);
});
