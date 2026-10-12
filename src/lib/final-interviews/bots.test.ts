/**
 * The Recall recording bot's lifecycle, run end to end against a database
 * that enforces migration 040's unique indexes and tenant trigger
 * (final-bot-world) and an in-memory Recall that follows the documented rules
 * (fake-recall). No network, no real Recall, no real database.
 *
 *   node --test src/lib/final-interviews/bots.test.ts
 */
// @ts-nocheck — same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { register } from "node:module";
import { test } from "node:test";
import { fakeRecall, httpError, timeoutError } from "../../test-support/fake-recall.mjs";
import {
  BOOKING,
  botWorld,
  CO,
  drain,
  FI,
  MEET,
  makeBotDb,
  makeEnqueue,
  OTHER_CO,
} from "../../test-support/final-bot-world.mjs";

register(new URL("../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../test-support/fake-service-client-hook.mjs", import.meta.url));

const bots = await import("./bots.ts");
const { TerminalJobError } = await import("../queue/failure-class.ts");

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

/** A booked final round three days out, recording on, a fixed clock. */
function setup({ enabled = true, startIn = 3 * DAY } = {}) {
  let clock = Date.now();
  const start = clock + startIn;
  const db = makeBotDb(start);
  const service = botWorld(db);
  const recall = fakeRecall();
  const flag = { on: enabled };
  const enqueue = makeEnqueue(service);
  const deps = {
    service,
    recall,
    enqueue,
    enabled: () => flag.on,
    now: () => clock,
    sleep: async () => {},
  };
  const hook = { service, enqueue, enabled: () => flag.on, now: () => clock, timeoutMs: 300 };
  return {
    db,
    service,
    recall,
    flag,
    deps,
    hook,
    start,
    booking: () => db.interview_bookings[0],
    rows: () => db.final_interview_bots,
    live: () => db.final_interview_bots.find((r) => r.superseded_at === null),
    run: () => drain(db, (job) => bots.processFinalBotJob(deps, job)),
    tick: (ms) => {
      clock += ms;
    },
    now: () => clock,
    reconcile: () =>
      bots.processFinalBotJob(deps, {
        id: "r",
        company_id: null,
        payload: { action: "reconcile" },
      }),
  };
}

/** Book, run the queue, and hand back the one scheduled vendor bot. */
async function booked(t) {
  assert.equal(await bots.onFinalBookingConfirmed(t.booking(), t.hook), "queued");
  await t.run();
  const row = t.live();
  assert.equal(row.status, "scheduled");
  return t.recall.bots.get(row.provider_bot_id);
}

function cancelBooking(t) {
  Object.assign(t.booking(), { status: "cancelled", cancelled_by: "candidate" });
}

function moveBooking(t, byMs) {
  const b = t.booking();
  b.scheduled_start = new Date(Date.parse(b.scheduled_start) + byMs).toISOString();
}

/** Every row the code marked 'deleted' really has no bot left at Recall. */
function assertDeletedMeansGone(t) {
  for (const row of t.rows()) {
    if (row.status === "deleted") {
      assert.ok(
        !t.recall.bots.has(row.provider_bot_id),
        `row ${row.id} deleted but its bot remains`,
      );
    }
  }
}

/* ── the flag ─────────────────────────────────────────────────── */

test("the flag is on only for the exact string true", () => {
  assert.equal(bots.isRecallRecordingEnabled({ RECALL_RECORDING_ENABLED: "true" }), true);
  for (const v of [undefined, "", "TRUE", "True", "1", "yes", " true", "true ", "false"]) {
    assert.equal(bots.isRecallRecordingEnabled({ RECALL_RECORDING_ENABLED: v }), false, String(v));
  }
});

test("flag off: a final booking writes no bot row, queues no job and opens no database client", async () => {
  const t = setup({ enabled: false });
  const before = t.service.queries.length;
  assert.equal(await bots.onFinalBookingConfirmed(t.booking(), t.hook), "disabled");
  assert.equal(t.service.queries.length, before);
  assert.equal(t.rows().length, 0);
  assert.equal(t.db.background_jobs.length, 0);
  assert.equal(
    await bots.finalBotReconcileWanted({ service: t.service, enabled: () => false, now: t.now }),
    false,
    "no reconcile job either",
  );
});

test("flag off later: an existing bot is still removed when the booking is cancelled", async () => {
  const t = setup();
  const bot = await booked(t);
  t.flag.on = false;
  assert.equal(
    await bots.finalBotReconcileWanted({ service: t.service, enabled: () => false, now: t.now }),
    true,
    "a scheduled bot keeps the backstop running",
  );
  cancelBooking(t);
  assert.equal(await bots.onFinalBookingCancelled(t.booking(), t.hook), "queued");
  await t.run();
  assert.equal(t.recall.bots.has(bot.id), false);
  assert.equal(t.rows()[0].status, "deleted");
});

test("a screening call never reaches the bot code", async () => {
  const t = setup();
  t.booking().purpose = "interview";
  t.booking().final_interview_id = null;
  for (const hook of [
    bots.onFinalBookingConfirmed,
    bots.onFinalBookingRescheduled,
    bots.onFinalBookingCancelled,
  ]) {
    assert.equal(await hook(t.booking(), t.hook), "not_final");
  }
  assert.equal(t.service.queries.length, 0);
  // And a sync for one plans nothing.
  const plan = bots.planSync(
    { booking: t.booking(), finalInterview: t.db.final_interviews[0], rows: [] },
    true,
  );
  assert.equal(plan.insertLive, false);
});

/* ── creating ─────────────────────────────────────────────────── */

test("a final booking creates one scheduled bot with the documented request", async () => {
  const t = setup();
  await booked(t);
  const row = t.live();
  assert.equal(t.recall.count("createBot"), 1);
  const [, request, opts] = t.recall.calls.find((c) => c[0] === "createBot");
  assert.deepEqual(request, {
    meeting_url: MEET,
    bot_name: "Remotiv Recorder",
    join_at: new Date(t.start - MIN).toISOString(),
    recording_config: { video_mixed_mp4: {}, retention: { type: "timed", hours: 72 } },
    automatic_leave: {
      waiting_room_timeout: 600,
      noone_joined_timeout: 900,
      everyone_left_timeout: { timeout: 30 },
      in_call_recording_timeout: 10_800,
    },
    metadata: {
      integration: "remotiv-final-interview",
      botRowId: row.id,
      finalInterviewId: FI,
      companyId: CO,
    },
  });
  assert.equal(opts.idempotencyKey, `remotiv-final-bot-${row.id}`);
  // Recall is asked for an existing bot before one is created.
  const order = t.recall.calls.map((c) => c[0]);
  assert.ok(order.indexOf("listBots") < order.indexOf("createBot"));
  assert.equal(row.join_at, new Date(t.start - MIN).toISOString());
  assert.equal(t.recall.bots.size, 1);
});

test("running the sync and the reconcile again changes nothing", async () => {
  const t = setup();
  await booked(t);
  await t.deps.enqueue({
    type: "final_bot_sync",
    companyId: CO,
    payload: { action: "sync", bookingId: BOOKING },
  });
  await t.run();
  t.tick(3 * MIN);
  await t.reconcile();
  await t.run();
  t.tick(3 * MIN);
  await t.reconcile();
  await t.run();
  assert.equal(t.recall.count("createBot"), 1);
  assert.equal(t.recall.count("deleteScheduledBot"), 0);
  assert.equal(t.recall.bots.size, 1);
  assert.equal(t.rows().length, 1);
});

test("a duplicate enqueue is reported as already queued and never fails the booking", async () => {
  const t = setup();
  assert.equal(await bots.onFinalBookingConfirmed(t.booking(), t.hook), "queued");
  assert.equal(await bots.onFinalBookingConfirmed(t.booking(), t.hook), "already_queued");
  assert.equal(t.rows().length, 1, "one live row: the second insert hit the unique index");
  assert.equal(t.db.background_jobs.length, 1);
});

/* ── rescheduling ─────────────────────────────────────────────── */

test("a reschedule replaces the scheduled bot, with one create per row", async () => {
  const t = setup();
  const old = await booked(t);
  moveBooking(t, 2 * DAY);
  assert.equal(await bots.onFinalBookingRescheduled(t.booking(), t.hook), "queued");
  await t.run();
  assert.equal(t.recall.bots.has(old.id), false, "old scheduled bot deleted");
  assert.equal(t.recall.bots.size, 1);
  const [fresh] = t.recall.bots.values();
  assert.equal(fresh.join_at, new Date(t.start + 2 * DAY - MIN).toISOString());
  assert.equal(t.recall.count("createBot"), 2);
  const oldRow = t.rows().find((r) => r.provider_bot_id === old.id);
  assert.equal(oldRow.status, "deleted");
  assert.ok(oldRow.superseded_at);
  assert.equal(t.live().provider_bot_id, fresh.id);
  assertDeletedMeansGone(t);
});

test("a reschedule whose hook failed is still repaired by the sync itself", async () => {
  const t = setup();
  const old = await booked(t);
  moveBooking(t, 2 * DAY);
  await t.deps.enqueue({
    type: "final_bot_sync",
    companyId: CO,
    payload: { action: "sync", bookingId: BOOKING },
  });
  await t.run();
  assert.equal(t.recall.bots.has(old.id), false);
  assert.equal(t.recall.bots.size, 1);
  assert.equal(t.rows().filter((r) => r.superseded_at === null).length, 1);
});

/* ── cancelling, and the races ────────────────────────────────── */

test("cancelled while the sync is still queued: no bot is ever created", async () => {
  const t = setup();
  await bots.onFinalBookingConfirmed(t.booking(), t.hook);
  cancelBooking(t);
  // The hook's own job is already queued, so this one collides and says so.
  assert.equal(await bots.onFinalBookingCancelled(t.booking(), t.hook), "already_queued");
  await t.run();
  assert.equal(t.recall.count("createBot"), 0);
  assert.equal(t.rows()[0].status, "superseded");
});

test("a stale queued job does not recreate the bot for a booking cancelled without its hook", async () => {
  const t = setup();
  await bots.onFinalBookingConfirmed(t.booking(), t.hook);
  cancelBooking(t); // the cancel hook never ran
  await t.run();
  assert.equal(t.recall.count("createBot"), 0);
  assert.equal(t.recall.bots.size, 0);
  assert.ok(t.rows()[0].superseded_at);
});

test("cancelled while the create is out: the new bot is removed before the job ends", async () => {
  const t = setup();
  await bots.onFinalBookingConfirmed(t.booking(), t.hook);
  let hookOutcome = "";
  t.recall.onCreate(async () => {
    cancelBooking(t);
    hookOutcome = await bots.onFinalBookingCancelled(t.booking(), t.hook);
  });
  const [run] = await t.run();
  assert.equal(run.error, null);
  assert.equal(hookOutcome, "already_queued", "the running job is the one that sees it");
  assert.equal(t.recall.count("createBot"), 1);
  assert.equal(t.recall.bots.size, 0, "removed while still scheduled");
  assert.equal(t.rows()[0].status, "deleted");
  assertDeletedMeansGone(t);
});

test("rescheduled while the create is out: one live bot, at the new time", async () => {
  const t = setup();
  await bots.onFinalBookingConfirmed(t.booking(), t.hook);
  let hookOutcome = "";
  t.recall.onCreate(async () => {
    moveBooking(t, 2 * DAY);
    hookOutcome = await bots.onFinalBookingRescheduled(t.booking(), t.hook);
  });
  await t.run();
  assert.equal(hookOutcome, "already_queued");
  assert.equal(t.recall.bots.size, 1);
  const [only] = t.recall.bots.values();
  assert.equal(only.join_at, new Date(t.start + 2 * DAY - MIN).toISOString());
  assert.equal(t.live().provider_bot_id, only.id);
  assertDeletedMeansGone(t);
});

test("cancelled before the bot joins: the scheduled bot is deleted, nothing else", async () => {
  const t = setup();
  const bot = await booked(t);
  cancelBooking(t);
  await bots.onFinalBookingCancelled(t.booking(), t.hook);
  await t.run();
  assert.equal(t.recall.bots.has(bot.id), false);
  assert.equal(t.rows()[0].status, "deleted");
  assert.equal(t.recall.count("leaveCall"), 0);
  assert.equal(t.recall.count("deleteRecording"), 0);
});

test("cancelled while recording: the bot is told to leave and the recording is kept", async () => {
  const t = setup();
  const bot = await booked(t);
  t.recall.advance(bot.id, ["joining_call", "in_waiting_room", "in_call_recording"], {
    recording: true,
  });
  cancelBooking(t);
  await bots.onFinalBookingCancelled(t.booking(), t.hook);
  await t.run();
  assert.equal(t.recall.count("leaveCall"), 1);
  assert.equal(t.recall.count("deleteRecording"), 0);
  assert.equal(t.recall.bots.get(bot.id).recordings.length, 1, "media still at Recall");
  assert.notEqual(t.rows()[0].status, "deleted");
  assert.equal(t.rows()[0].provider_bot_id, bot.id, "the id the import will need is kept");
});

test("a finished recording survives cancellation and rescheduling", async () => {
  for (const change of ["cancel", "reschedule"]) {
    const t = setup();
    const bot = await booked(t);
    t.recall.advance(
      bot.id,
      ["joining_call", "in_call_recording", "call_ended", "recording_done", "done"],
      { recording: true },
    );
    if (change === "cancel") {
      cancelBooking(t);
      await bots.onFinalBookingCancelled(t.booking(), t.hook);
    } else {
      moveBooking(t, 2 * DAY);
      await bots.onFinalBookingRescheduled(t.booking(), t.hook);
    }
    await t.run();
    assert.equal(t.recall.count("deleteScheduledBot"), 0, change);
    assert.equal(t.recall.count("deleteRecording"), 0, change);
    assert.equal(t.recall.bots.get(bot.id).recordings.length, 1, change);
    const row = t.rows().find((r) => r.provider_bot_id === bot.id);
    assert.equal(row.status, "done", change);
    assert.equal(row.import_status, "none", `${change}: never marked ready here`);
  }
});

test("405 on the scheduled delete: Recall is asked again, and a dispatched bot leaves instead", async () => {
  const t = setup();
  const bot = await booked(t);
  // Dispatched between our read and our delete.
  t.recall.beforeDelete((id) => t.recall.advance(id, ["joining_call", "in_waiting_room"]));
  cancelBooking(t);
  await bots.onFinalBookingCancelled(t.booking(), t.hook);
  await t.run();
  assert.equal(t.recall.count("deleteScheduledBot"), 1);
  assert.equal(t.recall.count("leaveCall"), 1);
  assert.ok(t.recall.bots.has(bot.id));
  assert.notEqual(t.rows()[0].status, "deleted");
});

test("404 means gone: a bot Recall no longer has is recorded as deleted without an error", async () => {
  const t = setup();
  const bot = await booked(t);
  t.recall.bots.delete(bot.id);
  cancelBooking(t);
  await bots.onFinalBookingCancelled(t.booking(), t.hook);
  const [run] = await t.run();
  assert.equal(run.error, null);
  assert.equal(t.rows()[0].status, "deleted");
  assert.equal(t.rows()[0].last_event_code, "vendor_not_found");
});

/* ── partial failures ─────────────────────────────────────────── */

test("enqueue failure: the booking hook reports it and the reconcile recovers the row", async () => {
  const t = setup();
  const failing = { ...t.hook, enqueue: async () => ({ ok: false, error: "down", code: "08006" }) };
  assert.equal(await bots.onFinalBookingConfirmed(t.booking(), failing), "enqueue_failed");
  assert.equal(t.rows().length, 1);
  assert.equal(t.db.background_jobs.length, 0);
  t.tick(3 * MIN);
  const report = await t.reconcile();
  assert.equal(report.pendingRows, 1);
  assert.equal(report.requeued, 1);
  await t.run();
  assert.equal(t.live().status, "scheduled");
  assert.equal(t.recall.count("createBot"), 1);
});

test("the bot row insert failed too: the reconcile finds the booked round with no row", async () => {
  const t = setup();
  t.service.failNext("final_interview_bots", "insert");
  assert.equal(await bots.onFinalBookingConfirmed(t.booking(), t.hook), "failed");
  assert.equal(t.rows().length, 0);
  t.tick(3 * MIN);
  const report = await t.reconcile();
  assert.equal(report.missingRows, 1);
  await t.run();
  assert.equal(t.live().status, "scheduled");
});

test("Recall made the bot but saving its id failed: the retry adopts it, no second bot", async () => {
  const t = setup();
  await bots.onFinalBookingConfirmed(t.booking(), t.hook);
  // The update after the create is the one that saves the id.
  t.recall.onCreate(async () => t.service.failNext("final_interview_bots", "update"));
  const [first] = await t.run();
  assert.ok(first.error, "the save failure surfaces as a retryable job error");
  assert.ok(!(first.error instanceof TerminalJobError));
  first.job.status = "queued";
  await t.run();
  assert.equal(t.recall.count("createBot"), 1);
  assert.equal(t.recall.bots.size, 1);
  const [only] = t.recall.bots.values();
  assert.equal(t.live().provider_bot_id, only.id);
  assert.equal(t.live().last_event_code, "adopted");
});

test("a create whose response was lost is looked up, not repeated", async () => {
  const t = setup();
  await bots.onFinalBookingConfirmed(t.booking(), t.hook);
  t.recall.ambiguousNextCreate();
  const [first] = await t.run();
  assert.ok(first.error);
  assert.equal(t.live().last_event_code, "create_ambiguous");
  first.job.status = "queued";
  await t.run();
  assert.equal(t.recall.count("createBot"), 1);
  assert.equal(t.recall.bots.size, 1);
  assert.equal(t.live().status, "scheduled");
});

test("a create that failed before reaching Recall is retried with the same idempotency key", async () => {
  const t = setup();
  await bots.onFinalBookingConfirmed(t.booking(), t.hook);
  t.recall.failNext("createBot", timeoutError());
  const [first] = await t.run();
  first.job.status = "queued";
  await t.run();
  const keys = t.recall.calls.filter((c) => c[0] === "createBot").map((c) => c[2].idempotencyKey);
  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1]);
  assert.equal(t.recall.bots.size, 1);
});

test("terminal and retryable Recall errors are told apart", async () => {
  const cases = [
    { error: httpError(400), job: "ok", code: "create_failed", sub: "deterministic_400" },
    { error: httpError(401), job: "terminal", code: "create_failed", sub: "configuration_401" },
    { error: httpError(503), job: "retry", code: "create_ambiguous", sub: "http_503" },
    { error: httpError(429), job: "retry", code: "create_retry", sub: "http_429" },
  ];
  for (const c of cases) {
    const t = setup();
    await bots.onFinalBookingConfirmed(t.booking(), t.hook);
    t.recall.failNext("createBot", c.error);
    const [run] = await t.run();
    const row = t.live();
    assert.equal(row.last_event_code, c.code, c.sub);
    assert.equal(row.last_event_sub_code, c.sub);
    if (c.job === "ok") {
      assert.equal(run.error, null, c.sub);
      assert.equal(row.status, "fatal");
    } else if (c.job === "terminal") {
      assert.ok(run.error instanceof TerminalJobError, c.sub);
      assert.equal(run.error.failureClass, "configuration");
      assert.equal(row.status, "fatal");
    } else {
      assert.ok(run.error && !(run.error instanceof TerminalJobError), c.sub);
      assert.equal(row.status, "pending", "left for the retry");
    }
  }
});

/* ── the 10-minute cutoff ─────────────────────────────────────── */

test("under ten minutes to join: no bot, no lookup, no retry until the booking moves", async () => {
  const t = setup({ startIn: 9 * MIN });
  assert.equal(await bots.onFinalBookingConfirmed(t.booking(), t.hook), "queued");
  await t.run();
  assert.equal(t.recall.calls.length, 0, "Recall was not called at all");
  assert.equal(t.live().status, "fatal");
  assert.equal(t.live().last_event_code, "too_late_to_schedule");

  // Another sync and a reconcile leave it alone.
  await t.deps.enqueue({
    type: "final_bot_sync",
    companyId: CO,
    payload: { action: "sync", bookingId: BOOKING },
  });
  await t.run();
  t.tick(3 * MIN);
  await t.reconcile();
  await t.run();
  assert.equal(t.recall.count("createBot"), 0);

  // Moved to a time far enough away: scheduled normally.
  moveBooking(t, 2 * DAY);
  await bots.onFinalBookingRescheduled(t.booking(), t.hook);
  await t.run();
  assert.equal(t.recall.count("createBot"), 1);
  assert.equal(t.live().status, "scheduled");
});

/* ── reconcile ────────────────────────────────────────────────── */

test("the reconcile repairs a cancellation that no job saw", async () => {
  const t = setup();
  const bot = await booked(t);
  cancelBooking(t); // after the last job finished, and no hook
  t.tick(3 * MIN);
  const report = await t.reconcile();
  assert.equal(report.staleLiveRows, 1);
  await t.run();
  assert.equal(t.recall.bots.has(bot.id), false);
});

test("the reconcile adopts a bot whose id was never saved, flag on or off", async () => {
  for (const enabled of [true, false]) {
    const t = setup({ enabled: true });
    await bots.onFinalBookingConfirmed(t.booking(), t.hook);
    const row = t.live();
    Object.assign(row, { last_event_code: "create_requested" });
    const vendor = t.recall.add({ id: randomUUID(), metadata: bots.botMetadata(row) });
    t.flag.on = enabled;
    t.db.background_jobs.length = 0;
    t.tick(3 * MIN);
    const report = await t.reconcile();
    assert.equal(report.vendorAdopted, 1, `enabled=${enabled}`);
    assert.equal(t.live().provider_bot_id, vendor.id);
  }
});

test("the reconcile touches Remotiv's bots only, and deletes only scheduled ones", async () => {
  const t = setup();
  const ours = (extra = {}) => ({
    integration: "remotiv-final-interview",
    finalInterviewId: FI,
    companyId: CO,
    ...extra,
  });
  const foreign = t.recall.add({ id: randomUUID(), metadata: { integration: "someone-else" } });
  const noMeta = t.recall.add({ id: randomUUID(), metadata: {} });
  const badId = t.recall.add({ id: randomUUID(), metadata: ours({ botRowId: "not-a-uuid" }) });
  const orphanScheduled = t.recall.add({
    id: randomUUID(),
    metadata: ours({ botRowId: randomUUID() }),
  });
  const orphanRecorded = t.recall.add({
    id: randomUUID(),
    metadata: ours({ botRowId: randomUUID() }),
    status_changes: [{ code: "joining_call" }, { code: "in_call_recording" }, { code: "done" }],
    recordings: [{ id: randomUUID() }],
  });
  // A real row, but the bot's metadata names another company.
  await bots.onFinalBookingConfirmed(t.booking(), t.hook);
  const row = t.live();
  const mismatch = t.recall.add({
    id: randomUUID(),
    metadata: ours({ botRowId: row.id, companyId: OTHER_CO }),
  });
  t.db.background_jobs.length = 0;

  for (const enabled of [true, false]) {
    t.flag.on = enabled;
    t.tick(3 * MIN);
    await t.reconcile();
  }
  assert.ok(t.recall.bots.has(foreign.id));
  assert.ok(t.recall.bots.has(noMeta.id));
  assert.ok(t.recall.bots.has(badId.id), "unidentified: reported, not deleted");
  assert.ok(!t.recall.bots.has(orphanScheduled.id), "ours, no row, scheduled: removed");
  assert.ok(t.recall.bots.has(orphanRecorded.id), "ours, no row, may hold media: kept");
  assert.equal(t.recall.bots.get(orphanRecorded.id).recordings.length, 1);
  assert.ok(t.recall.bots.has(mismatch.id), "metadata disagrees with the row: kept");
  assert.equal(t.live().provider_bot_id, null, "the mismatched bot was not adopted");
  assert.equal(t.recall.count("deleteRecording"), 0);
  const deleted = t.recall.calls.filter((c) => c[0] === "deleteScheduledBot").map((c) => c[1]);
  assert.deepEqual([...new Set(deleted)], [orphanScheduled.id]);
});

test("the reconcile is wanted with the flag on, or off while a recent bot is live", async () => {
  const t = setup();
  const wanted = (enabled) =>
    bots.finalBotReconcileWanted({ service: t.service, enabled: () => enabled, now: t.now });
  assert.equal(await wanted(true), true);
  assert.equal(await wanted(false), false);
  await booked(t);
  assert.equal(await wanted(false), true);
  t.tick(5 * DAY); // the interview was days ago
  assert.equal(await wanted(false), false);
});

/* ── orphan delete: the privacy path ──────────────────────────── */

const noDatabase = {
  from(table) {
    throw new Error(`orphan delete must not need the database (touched ${table})`);
  },
};

function orphanDeps(recall) {
  return {
    service: noDatabase,
    recall,
    enqueue: async () => {
      throw new Error("no enqueue");
    },
    enabled: () => false,
    now: Date.now,
    sleep: async () => {},
  };
}

const orphanJob = (providerBotId, providerRecordingId = null) => ({
  id: "o",
  company_id: null,
  payload: { action: "delete", providerBotId, providerRecordingId },
});

test("orphan delete removes a scheduled bot with no parent row, flag off", async () => {
  const recall = fakeRecall();
  const bot = recall.add({ id: randomUUID() });
  const report = await bots.processFinalBotJob(orphanDeps(recall), orphanJob(bot.id));
  assert.equal(report.outcome, "scheduled_deleted");
  assert.equal(recall.bots.size, 0);
});

test("orphan delete deletes every recording of a bot that is done", async () => {
  const recall = fakeRecall();
  const recA = randomUUID();
  const recB = randomUUID();
  const bot = recall.add({
    id: randomUUID(),
    status_changes: [{ code: "joining_call" }, { code: "call_ended" }, { code: "done" }],
    recordings: [{ id: recA }, { id: recB }],
  });
  const report = await bots.processFinalBotJob(orphanDeps(recall), orphanJob(bot.id, recA));
  assert.equal(report.outcome, "media_deleted");
  assert.equal(report.recordings, 2);
  assert.equal(recall.bots.get(bot.id).recordings.length, 0);
});

test("orphan delete: a bot still in its call leaves first, then its media goes", async () => {
  const recall = fakeRecall();
  const bot = recall.add({
    id: randomUUID(),
    status_changes: [{ code: "joining_call" }, { code: "in_call_recording" }],
    recordings: [{ id: randomUUID() }],
  });
  const report = await bots.processFinalBotJob(orphanDeps(recall), orphanJob(bot.id));
  assert.equal(recall.count("leaveCall"), 1);
  assert.equal(report.outcome, "media_deleted");
  assert.equal(recall.bots.get(bot.id).recordings.length, 0);
});

test("orphan delete treats 404s as done", async () => {
  const recall = fakeRecall();
  const report = await bots.processFinalBotJob(
    orphanDeps(recall),
    orphanJob(randomUUID(), randomUUID()),
  );
  assert.equal(report.outcome, "gone");
  assert.equal(
    recall.count("deleteRecording"),
    1,
    "the recording id was tried and was already gone",
  );
});

test("orphan delete refuses a payload without a valid bot id", async () => {
  await assert.rejects(
    bots.processFinalBotJob(orphanDeps(fakeRecall()), orphanJob("nope")),
    TerminalJobError,
  );
});

/* ── hooks are bounded and never throw ────────────────────────── */

test("booking hooks never throw and never hold the response past their bound", async () => {
  const booking = setup().booking();

  const hanging = setup();
  hanging.service.hang("final_interviews");
  const t0 = Date.now();
  assert.equal(await bots.onFinalBookingConfirmed(booking, hanging.hook), "timed_out");
  assert.ok(Date.now() - t0 < 2_000);

  const throwing = setup();
  const boom = {
    ...throwing.hook,
    enqueue: async () => {
      throw new Error("queue down");
    },
  };
  assert.equal(await bots.onFinalBookingConfirmed(booking, boom), "failed");

  const dbDown = setup();
  dbDown.service.failNext("final_interview_bots", "update");
  assert.equal(await bots.onFinalBookingRescheduled(booking, dbDown.hook), "failed");
  dbDown.service.failNext("final_interview_bots", "update");
  assert.equal(await bots.onFinalBookingCancelled(booking, dbDown.hook), "failed");
});

test("the hooks are handed no Recall client and make no Recall call", async () => {
  const t = setup();
  await bots.onFinalBookingConfirmed(t.booking(), t.hook);
  moveBooking(t, DAY * 2);
  await bots.onFinalBookingRescheduled(t.booking(), t.hook);
  cancelBooking(t);
  await bots.onFinalBookingCancelled(t.booking(), t.hook);
  assert.equal(t.recall.calls.length, 0);
  assert.equal("recall" in t.hook, false);
});

/* ── tenancy ──────────────────────────────────────────────────── */

test("a sync job for another company's booking is refused outright", async () => {
  const t = setup();
  await assert.rejects(
    bots.processFinalBotJob(t.deps, {
      id: "x",
      company_id: OTHER_CO,
      payload: { action: "sync", bookingId: BOOKING },
    }),
    TerminalJobError,
  );
  assert.equal(t.recall.calls.length, 0);
});

test("an unknown action is terminal, not retried", async () => {
  const t = setup();
  await assert.rejects(
    bots.processFinalBotJob(t.deps, { id: "x", company_id: CO, payload: { action: "explode" } }),
    TerminalJobError,
  );
});

/* ── vendorView ───────────────────────────────────────────────── */

test("vendorView: only a bot with nothing beyond 'ready' counts as scheduled", () => {
  const view = (codes, recordings = []) =>
    bots.vendorView({
      id: randomUUID(),
      status_changes: codes.map((code) => ({ code })),
      recordings,
    });
  assert.equal(view([]).phase, "scheduled");
  assert.equal(view(["ready"]).phase, "scheduled");
  assert.equal(view(["joining_call"]).phase, "in_progress");
  assert.equal(view(["joining_call", "in_call_recording"]).status, "recording");
  assert.equal(view(["joining_call", "call_ended"]).phase, "ended");
  assert.equal(view(["joining_call", "done", "media_expired"]).status, "done");
  const odd = view(["joining_call", "something_new"]);
  assert.equal(odd.phase, "unknown");
  assert.equal(odd.status, null, "an unknown code never maps to a status, least of all deleted");
  for (const codes of [[], ["joining_call"], ["done"], ["fatal"], ["x"]]) {
    assert.notEqual(view(codes).status, "deleted");
  }
});

/* ── step 3b: schedule-time failures alert the host ───────────── */

const failureJobs = (t) =>
  t.db.background_jobs.filter(
    (j) => j.type === "final_bot_lobby_check" && j.payload?.kind === "failure",
  );

/** One failure job, on the row's first fixed id, with five attempts. */
function assertOneFailureJob(t, label) {
  const jobs = failureJobs(t);
  assert.equal(jobs.length, 1, label);
  const row = t.live() ?? t.rows()[0];
  assert.deepEqual(jobs[0].payload, { botRowId: row.id, kind: "failure" }, label);
  assert.equal(jobs[0].id, bots.failureAlertJobIds(row.id)[0], label);
  assert.equal(jobs[0].max_attempts, 5, label);
  assert.equal(jobs[0].company_id, CO, label);
}

test("no Meet link: the row turns fatal and one failure alert is queued", async () => {
  const t = setup();
  t.booking().meeting_url = null;
  await bots.onFinalBookingConfirmed(t.booking(), t.hook);
  await t.run();
  assert.equal(t.live().last_event_code, "no_meeting_url");
  assertOneFailureJob(t, "no_meeting_url");
});

test("too late to schedule: one failure alert, and another sync adds none", async () => {
  const t = setup({ startIn: 9 * MIN });
  await bots.onFinalBookingConfirmed(t.booking(), t.hook);
  await t.run();
  assert.equal(t.live().last_event_code, "too_late_to_schedule");
  assertOneFailureJob(t, "too_late");
  await t.deps.enqueue({
    type: "final_bot_sync",
    companyId: CO,
    payload: { action: "sync", bookingId: BOOKING },
  });
  await t.run();
  assert.equal(failureJobs(t).length, 1);
});

test("create refused: one failure alert, queued before a configuration error is rethrown", async () => {
  for (const status of [400, 401, 402]) {
    const t = setup();
    await bots.onFinalBookingConfirmed(t.booking(), t.hook);
    t.recall.failNext("createBot", httpError(status));
    const [run] = await t.run();
    assert.equal(t.live().last_event_code, "create_failed", String(status));
    assertOneFailureJob(t, String(status));
    // 401 is configuration and is rethrown after the alert is queued. 400 and
    // 402 complete the job: the shared classifier reads Recall's 402 as
    // deterministic, since its message carries no billing wording.
    if (status === 401) assert.ok(run.error instanceof TerminalJobError, "401 still rethrows");
    else assert.equal(run.error, null, String(status));
  }
});

test("metadata that disagrees with the row: fatal, one failure alert, nothing adopted", async () => {
  const t = setup();
  await bots.onFinalBookingConfirmed(t.booking(), t.hook);
  const row = t.live();
  t.recall.add({ id: randomUUID(), metadata: { ...bots.botMetadata(row), companyId: OTHER_CO } });
  await t.run();
  assert.equal(t.live().last_event_code, "vendor_metadata_mismatch");
  assert.equal(t.live().provider_bot_id, null);
  assert.equal(t.recall.count("createBot"), 0);
  assertOneFailureJob(t, "mismatch");
});

test("retryable create failures never alert", async () => {
  for (const error of [httpError(503), httpError(429), timeoutError()]) {
    const t = setup();
    await bots.onFinalBookingConfirmed(t.booking(), t.hook);
    t.recall.failNext("createBot", error);
    await t.run();
    assert.equal(t.live().status, "pending");
    assert.equal(failureJobs(t).length, 0);
  }
});

test("an alert enqueue that fails never fails the sync; the reconcile queues it", async () => {
  const t = setup({ startIn: 9 * MIN });
  await bots.onFinalBookingConfirmed(t.booking(), t.hook);
  const real = t.deps.enqueue;
  t.deps.enqueue = async (input) =>
    input.type === "final_bot_lobby_check"
      ? { ok: false, error: "down", code: "08006" }
      : real(input);
  const [run] = await t.run();
  assert.equal(run.error, null, "the sync completed");
  assert.equal(t.live().status, "fatal");
  assert.equal(failureJobs(t).length, 0);
  t.deps.enqueue = real;
  const report = await t.reconcile();
  assert.equal(report.failureAlertsQueued, 1);
  assertOneFailureJob(t, "backstop");
});

/* ── step 3b: the bounded backstop ────────────────────────────── */

/** A live fatal row with no alert sent and no job yet. */
async function fatalWithoutJob() {
  const t = setup({ startIn: 9 * MIN });
  await bots.onFinalBookingConfirmed(t.booking(), t.hook);
  const real = t.deps.enqueue;
  t.deps.enqueue = async (input) =>
    input.type === "final_bot_lobby_check" ? { ok: false, error: "down" } : real(input);
  await t.run();
  t.deps.enqueue = real;
  assert.equal(failureJobs(t).length, 0);
  return t;
}

const finish = (t, status) => {
  for (const j of failureJobs(t))
    if (j.status === "queued" || j.status === "running") j.status = status;
};

test("the backstop queues a missed alert once, and at most three jobs per bot, ever, whatever their ending", async () => {
  const t = await fatalWithoutJob();
  assert.equal((await t.reconcile()).failureAlertsQueued, 1);
  assert.equal((await t.reconcile()).failureAlertsQueued, 0, "one is still queued");
  // Each job ends without delivering (say, the host could not be verified).
  for (const ending of ["succeeded", "dead", "succeeded"]) {
    finish(t, ending);
    await t.reconcile();
  }
  finish(t, "failed");
  const last = await t.reconcile();
  assert.equal(last.failureAlertsQueued, 0);
  assert.equal(last.failureAlertsCapped, 1);
  const ids = failureJobs(t).map((j) => j.id);
  assert.equal(ids.length, 3);
  assert.deepEqual(new Set(ids), new Set(bots.failureAlertJobIds(t.live().id)));
  for (let i = 0; i < 5; i++) {
    finish(t, "succeeded");
    await t.reconcile();
  }
  assert.equal(failureJobs(t).length, 3, "never a fourth");
});

test("concurrent reconciles cannot take a bot past three failure-alert jobs", async () => {
  const t = await fatalWithoutJob();
  for (let round = 0; round < 4; round++) {
    await Promise.all(Array.from({ length: 6 }, () => t.reconcile()));
    assert.ok(failureJobs(t).length <= 3, `round ${round}: ${failureJobs(t).length}`);
    finish(t, "succeeded");
  }
  assert.equal(failureJobs(t).length, 3);
});

test("failure-alert jobs from before the cap count toward it", async () => {
  const t = await fatalWithoutJob();
  const row = t.live();
  t.db.background_jobs.push({
    id: randomUUID(),
    type: "final_bot_lobby_check",
    payload: { botRowId: row.id, kind: "failure" },
    company_id: CO,
    status: "dead",
  });
  for (let i = 0; i < 5; i++) {
    await t.reconcile();
    finish(t, "succeeded");
  }
  assert.equal(failureJobs(t).length, 3, "one older job plus two fixed ids");
});

test("the backstop never queues for a retired bot", async () => {
  const t = await fatalWithoutJob();
  t.live().superseded_at = new Date(t.now()).toISOString();
  const report = await t.reconcile();
  assert.equal(report.failureAlertsQueued, 0);
  assert.equal(failureJobs(t).length, 0);
});
