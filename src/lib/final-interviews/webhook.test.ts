/**
 * The Recall webhook, end to end below the route: signature, event mapping,
 * ordering, the unknown-bot rule and the alert jobs it queues, against the
 * migration-040 database fake. No network, no real Recall.
 *
 *   node --test src/lib/final-interviews/webhook.test.ts
 */
// @ts-nocheck — same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { register } from "node:module";
import { test } from "node:test";
import {
  APP,
  BOOKING,
  botWorld,
  CO,
  FI,
  JOB,
  MEET,
  makeBotDb,
  makeEnqueue,
  OTHER_CO,
} from "../../test-support/final-bot-world.mjs";

register(new URL("../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../test-support/fake-service-client-hook.mjs", import.meta.url));

const bots = await import("./bots.ts");

const KEY = randomBytes(32);
const SECRET = `whsec_${KEY.toString("base64")}`;
const MIN = 60_000;
const T0 = Date.parse("2026-11-05T09:00:00.000Z");
const at = (offsetMs) => new Date(T0 + offsetMs).toISOString();

/** A world with one live bot row holding a vendor id, and a clock. */
function setup({ row = {} } = {}) {
  const db = makeBotDb(T0 + MIN);
  const service = botWorld(db);
  let clock = T0;
  const botId = randomUUID();
  const bot = {
    id: randomUUID(),
    final_interview_id: FI,
    company_id: CO,
    job_id: JOB,
    application_id: APP,
    booking_id: BOOKING,
    provider: "recall",
    provider_bot_id: botId,
    provider_recording_id: null,
    join_at: at(0),
    status: "scheduled",
    last_event_code: "scheduled",
    last_event_sub_code: null,
    last_event_at: at(-3 * 24 * 60 * MIN),
    import_status: "none",
    lobby_alert_sent_at: null,
    failure_alert_sent_at: null,
    superseded_at: null,
    created_at: at(-3 * 24 * 60 * MIN),
    updated_at: at(-3 * 24 * 60 * MIN),
    ...row,
  };
  db.final_interview_bots.push(bot);
  const t = {
    db,
    service,
    botId,
    row: () => db.final_interview_bots.find((r) => r.id === bot.id),
    jobs: (type) => db.background_jobs.filter((j) => !type || j.type === type),
    enqueue: makeEnqueue(service),
    tick: (ms) => {
      clock += ms;
    },
    now: () => clock,
  };
  t.deliver = (event, opts = {}) => deliver(t, event, opts);
  return t;
}

function sign(id, ts, body, key = KEY) {
  return createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64");
}

/** Sign and hand a JSON event to receiveRecallWebhook, as the route would. */
function deliver(t, event, { secret = SECRET, key = KEY, enqueue, raw } = {}) {
  const body = raw ?? JSON.stringify(event);
  const id = `msg_${randomUUID()}`;
  const ts = String(Math.floor(t.now() / 1000));
  const headers = {
    "webhook-id": id,
    "webhook-timestamp": ts,
    "webhook-signature": `v1,${sign(id, ts, body, key)}`,
  };
  return bots.receiveRecallWebhook(
    { rawBody: body, header: (n) => headers[n] ?? null, secret },
    { service: t.service, enqueue: enqueue ?? t.enqueue, now: t.now },
  );
}

const OURS = (extra = {}) => ({
  integration: "remotiv-final-interview",
  botRowId: randomUUID(),
  finalInterviewId: FI,
  companyId: CO,
  ...extra,
});

function botEvent(name, botId, updatedAt, { sub = null, metadata = {}, code } = {}) {
  return {
    event: name,
    data: {
      data: { code: code ?? name.slice(4), sub_code: sub, updated_at: updatedAt },
      bot: { id: botId, metadata },
    },
  };
}

function recordingEvent(name, botId, recordingId, updatedAt, metadata = {}) {
  return {
    event: name,
    data: {
      data: { code: name.slice("recording.".length), sub_code: null, updated_at: updatedAt },
      recording: { id: recordingId, metadata: {} },
      bot: { id: botId, metadata },
    },
  };
}

/* ── verification gates everything ────────────────────────────── */

test("no secret configured: 503 and nothing is read or written", async () => {
  const t = setup();
  const r = await t.deliver(botEvent("bot.in_call_recording", t.botId, at(0)), { secret: "" });
  assert.equal(r.status, 503);
  assert.equal(t.service.queries.length, 0);
});

test("a bad signature: 401 and nothing is read or written", async () => {
  const t = setup();
  const r = await t.deliver(botEvent("bot.fatal", t.botId, at(0)), { key: randomBytes(32) });
  assert.equal(r.status, 401);
  assert.equal(t.service.queries.length, 0);
  assert.equal(t.row().status, "scheduled");
});

test("a signed body that is not JSON is acknowledged and ignored", async () => {
  const t = setup();
  const r = await t.deliver(null, { raw: "not json" });
  assert.equal(r.status, 200);
  assert.equal(r.outcome, "ignored_malformed");
  assert.equal(t.service.queries.length, 0);
});

/* ── the lifecycle stream ─────────────────────────────────────── */

test("bot.in_waiting_room moves the row and queues one lobby check two minutes later", async () => {
  const t = setup();
  const r = await t.deliver(botEvent("bot.in_waiting_room", t.botId, at(0)));
  assert.equal(r.status, 200);
  assert.equal(r.outcome, "applied");
  assert.equal(t.row().status, "waiting_room");
  assert.equal(t.row().last_event_code, "in_waiting_room");
  assert.equal(t.row().last_event_at, at(0));
  const [job] = t.jobs("final_bot_lobby_check");
  assert.deepEqual(job.payload, { botRowId: t.row().id, kind: "lobby" });
  assert.equal(job.run_after, at(2 * MIN));
  assert.equal(job.company_id, CO);
});

test("a duplicate delivery changes nothing and queues nothing more", async () => {
  const t = setup();
  const event = botEvent("bot.in_waiting_room", t.botId, at(0));
  await t.deliver(event);
  const second = await t.deliver(event);
  assert.equal(second.status, 200);
  assert.equal(second.outcome, "stale_or_duplicate");
  assert.equal(t.jobs("final_bot_lobby_check").length, 1);
});

test("a delayed in_waiting_room never pulls a recording bot back to the lobby", async () => {
  const t = setup();
  await t.deliver(botEvent("bot.in_call_recording", t.botId, at(3 * MIN)));
  const late = await t.deliver(botEvent("bot.in_waiting_room", t.botId, at(1 * MIN)));
  assert.equal(late.outcome, "stale_or_duplicate");
  assert.equal(t.row().status, "recording");
  assert.equal(t.row().last_event_at, at(3 * MIN));
  assert.equal(t.jobs("final_bot_lobby_check").length, 0, "no lobby check for a stale lobby event");
});

test("concurrent deliveries land on the newest state whatever order they run in", async () => {
  for (const order of ["newer-first", "older-first"]) {
    const t = setup();
    const older = botEvent("bot.in_waiting_room", t.botId, at(1 * MIN));
    const newer = botEvent("bot.in_call_recording", t.botId, at(2 * MIN));
    const pair = order === "newer-first" ? [newer, older] : [older, newer];
    await Promise.all(pair.map((e) => t.deliver(e)));
    assert.equal(t.row().status, "recording", order);
    assert.equal(t.row().last_event_at, at(2 * MIN), order);
  }
});

test("fatal is final: a later bot.done does not hide it, and the failure alert is queued once", async () => {
  const t = setup();
  await t.deliver(botEvent("bot.fatal", t.botId, at(1 * MIN), { sub: "google_meet_bot_blocked" }));
  await t.deliver(botEvent("bot.done", t.botId, at(2 * MIN)));
  await t.deliver(botEvent("bot.fatal", t.botId, at(1 * MIN), { sub: "google_meet_bot_blocked" }));
  assert.equal(t.row().status, "fatal");
  assert.equal(t.row().last_event_sub_code, "google_meet_bot_blocked");
  const failures = t.jobs("final_bot_lobby_check").filter((j) => j.payload.kind === "failure");
  assert.equal(failures.length, 1);
});

test("a waiting-room timeout ends the call and queues the failure alert; a normal end does not", async () => {
  for (const sub of [
    "timeout_exceeded_waiting_room",
    "call_ended_by_platform_waiting_room_timeout",
    "bot_kicked_from_waiting_room",
  ]) {
    const t = setup();
    await t.deliver(botEvent("bot.call_ended", t.botId, at(MIN), { sub }));
    assert.equal(t.row().status, "call_ended", sub);
    assert.equal(
      t.jobs("final_bot_lobby_check").filter((j) => j.payload.kind === "failure").length,
      1,
      sub,
    );
  }
  const t = setup();
  await t.deliver(botEvent("bot.call_ended", t.botId, at(MIN), { sub: "call_ended_by_host" }));
  assert.equal(t.jobs("final_bot_lobby_check").length, 0);
});

test("no failure alert is queued once one was sent, or for a retired row", async () => {
  const sent = setup({ row: { failure_alert_sent_at: at(0) } });
  await sent.deliver(botEvent("bot.fatal", sent.botId, at(MIN)));
  assert.equal(sent.jobs("final_bot_lobby_check").length, 0);
  const retired = setup({ row: { superseded_at: at(0) } });
  await retired.deliver(botEvent("bot.fatal", retired.botId, at(MIN)));
  await retired.deliver(botEvent("bot.in_waiting_room", retired.botId, at(2 * MIN)));
  assert.equal(retired.jobs("final_bot_lobby_check").length, 0);
});

test("a retired row still records its bot's progress, so cleanup and the import can see it", async () => {
  const t = setup({ row: { superseded_at: at(0), status: "recording" } });
  await t.deliver(botEvent("bot.call_ended", t.botId, at(MIN), { sub: "bot_received_leave_call" }));
  await t.deliver(botEvent("bot.done", t.botId, at(2 * MIN)));
  assert.equal(t.row().status, "done");
});

test("deleted and superseded rows never move", async () => {
  for (const status of ["deleted", "superseded"]) {
    const t = setup({ row: { status, superseded_at: at(0) } });
    await t.deliver(botEvent("bot.in_call_recording", t.botId, at(MIN)));
    assert.equal(t.row().status, status);
  }
});

test("unknown events never mark a bot fatal or deleted", async () => {
  const t = setup();
  const r = await t.deliver(botEvent("bot.something_new", t.botId, at(MIN)));
  assert.equal(r.status, 200);
  assert.equal(t.row().status, "scheduled");
  assert.equal(t.row().last_event_code, "something_new");
  const other = await t.deliver({ event: "transcript.done", data: { bot: { id: t.botId } } });
  assert.equal(other.outcome, "ignored_event");
  assert.equal(t.row().status, "scheduled");
});

test("an event with no usable timestamp changes no status", async () => {
  const t = setup();
  const r = await t.deliver(botEvent("bot.in_call_recording", t.botId, "not-a-date"));
  assert.equal(r.status, 200);
  assert.equal(t.row().status, "scheduled");
});

/* ── the recording stream ─────────────────────────────────────── */

test("recording.done stores the id only: no status, no import, and it waits for no bot event", async () => {
  const t = setup({ row: { status: "recording", last_event_at: at(MIN) } });
  const recId = randomUUID();
  await t.deliver(recordingEvent("recording.done", t.botId, recId, at(5 * MIN)));
  const row = t.row();
  assert.equal(row.provider_recording_id, recId);
  assert.equal(row.status, "recording");
  assert.equal(row.last_event_at, at(MIN), "the lifecycle watermark is untouched");
  assert.equal(row.import_status, "none");
  assert.equal(t.jobs().length, 0, "no import or anything else queued");
  // The bot's own later events still apply.
  await t.deliver(botEvent("bot.done", t.botId, at(3 * MIN)));
  assert.equal(t.row().status, "done");
});

test("recording.done on a superseded, finished row keeps the id the import will need", async () => {
  const t = setup({ row: { superseded_at: at(0), status: "done" } });
  const recId = randomUUID();
  const r = await t.deliver(recordingEvent("recording.done", t.botId, recId, at(MIN)));
  assert.equal(r.outcome, "recording_stored");
  assert.equal(t.row().provider_recording_id, recId);
});

test("a second recording id never replaces the first", async () => {
  const first = randomUUID();
  const t = setup({ row: { provider_recording_id: first } });
  const r = await t.deliver(recordingEvent("recording.done", t.botId, randomUUID(), at(MIN)));
  assert.equal(r.status, 200);
  assert.equal(t.row().provider_recording_id, first);
  const dup = await t.deliver(recordingEvent("recording.done", t.botId, first, at(MIN)));
  assert.equal(dup.outcome, "duplicate");
});

test("recording.failed queues the failure alert and touches nothing else", async () => {
  const t = setup({ row: { status: "done", last_event_at: at(MIN) } });
  await t.deliver(recordingEvent("recording.failed", t.botId, randomUUID(), at(2 * MIN)));
  assert.equal(t.row().status, "done");
  assert.equal(t.row().provider_recording_id, null);
  assert.equal(t.jobs("final_bot_lobby_check")[0].payload.kind, "failure");
});

/* ── the unknown-bot rule ─────────────────────────────────────── */

test("a database outage is a 503, never an unknown bot", async () => {
  const t = setup();
  t.service.failNext("final_interview_bots", "select");
  const r = await t.deliver(botEvent("bot.done", randomUUID(), at(MIN), { metadata: OURS() }));
  assert.equal(r.status, 503);
  assert.equal(t.jobs().length, 0, "no cleanup on a failed lookup");

  // And the second lookup, by the metadata's row id, the same way.
  t.service.failNext("final_interview_bots", "select");
  const meta = OURS();
  const deps = { service: t.service, enqueue: t.enqueue, now: t.now };
  const firstOk = await bots.processRecallEvent(deps, {
    name: "bot.done",
    botId: randomUUID(),
    metadata: meta,
    code: "done",
    subCode: null,
    at: at(MIN),
    recordingId: null,
  });
  assert.equal(firstOk.status, 503);
  assert.equal(t.jobs().length, 0);
});

test("Remotiv's bot whose row is gone: the orphan delete is queued, once", async () => {
  const t = setup();
  const strayBot = randomUUID();
  const recId = randomUUID();
  const event = recordingEvent("recording.done", strayBot, recId, at(MIN), OURS());
  const first = await t.deliver(event);
  const second = await t.deliver(event);
  assert.equal(first.outcome, "queued_cleanup");
  assert.equal(second.status, 200, "a duplicate cleanup enqueue is harmless");
  const cleanups = t.jobs("final_bot_sync").filter((j) => j.payload.action === "delete");
  assert.equal(cleanups.length, 1);
  assert.deepEqual(cleanups[0].payload, {
    action: "delete",
    providerBotId: strayBot,
    providerRecordingId: recId,
  });
  assert.equal(cleanups[0].company_id, null);
});

test("a bot whose row exists but has not saved its id is left for Step 2 to adopt", async () => {
  const t = setup();
  const pending = {
    ...t.row(),
    id: randomUUID(),
    provider_bot_id: null,
    status: "pending",
    superseded_at: at(0),
  };
  t.db.final_interview_bots.push(pending);
  const vendorBot = randomUUID();
  const r = await t.deliver(
    botEvent("bot.in_waiting_room", vendorBot, at(MIN), {
      metadata: OURS({ botRowId: pending.id }),
    }),
  );
  assert.equal(r.status, 200);
  assert.equal(r.outcome, "queued_sync_unsaved_bot");
  const jobs = t.jobs("final_bot_sync");
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].payload.action, "sync");
  assert.equal(jobs[0].payload.bookingId, BOOKING);
  assert.equal(t.db.final_interview_bots.find((r2) => r2.id === pending.id).provider_bot_id, null);
});

test("another integration's bot is never touched, even with look-alike metadata", async () => {
  const t = setup();
  for (const metadata of [
    {},
    { integration: "someone-else" },
    OURS({ integration: "someone-else" }),
    OURS({ botRowId: "not-a-uuid" }),
    OURS({ companyId: "x" }),
  ]) {
    const r = await t.deliver(botEvent("bot.done", randomUUID(), at(MIN), { metadata }));
    assert.equal(r.status, 200, JSON.stringify(metadata));
  }
  assert.equal(t.jobs().length, 0);
});

test("metadata that disagrees with the row it names: ignored, not cleaned up", async () => {
  const t = setup();
  const r = await t.deliver(
    botEvent("bot.done", randomUUID(), at(MIN), {
      metadata: OURS({ botRowId: t.row().id, companyId: OTHER_CO }),
    }),
  );
  assert.equal(r.outcome, "ignored_metadata_mismatch");
  assert.equal(t.jobs().length, 0);
});

test("an enqueue that fails is a 503, and the redelivery still queues it", async () => {
  const t = setup();
  const down = async () => ({ ok: false, error: "down", code: "08006" });
  const event = botEvent("bot.in_waiting_room", t.botId, at(0));
  const first = await t.deliver(event, { enqueue: down });
  assert.equal(first.status, 503);
  assert.equal(t.row().status, "waiting_room", "the status write itself landed");
  const retry = await t.deliver(event);
  assert.equal(retry.status, 200);
  assert.equal(
    t.jobs("final_bot_lobby_check").length,
    1,
    "the lobby check is queued on redelivery",
  );

  const orphan = setup();
  const r = await orphan.deliver(
    botEvent("bot.done", randomUUID(), at(MIN), { metadata: OURS() }),
    {
      enqueue: down,
    },
  );
  assert.equal(r.status, 503, "an orphan cleanup that was not queued is not acknowledged");
});

test("a status write that fails is a 503", async () => {
  const t = setup();
  t.service.failNext("final_interview_bots", "update");
  const r = await t.deliver(botEvent("bot.in_call_recording", t.botId, at(MIN)));
  assert.equal(r.status, 503);
});

/* ── flag and logs ────────────────────────────────────────────── */

test("webhooks are processed with the recording flag off", async () => {
  const before = process.env.RECALL_RECORDING_ENABLED;
  process.env.RECALL_RECORDING_ENABLED = "false";
  try {
    const t = setup();
    await t.deliver(botEvent("bot.in_call_recording", t.botId, at(MIN)));
    assert.equal(t.row().status, "recording");
    const orphan = await t.deliver(
      botEvent("bot.done", randomUUID(), at(MIN), { metadata: OURS() }),
    );
    assert.equal(orphan.outcome, "queued_cleanup");
  } finally {
    if (before === undefined) delete process.env.RECALL_RECORDING_ENABLED;
    else process.env.RECALL_RECORDING_ENABLED = before;
  }
});

test("logs and results carry no body, secret, meeting link or candidate detail", async () => {
  const lines = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  for (const k of Object.keys(original)) console[k] = (...a) => lines.push(a.map(String).join(" "));
  const results = [];
  try {
    const t = setup();
    const sensitive = { ...OURS(), meeting: MEET, candidate: "Sam Lee", email: "sam@example.test" };
    results.push(
      await t.deliver(botEvent("bot.in_waiting_room", t.botId, at(0), { metadata: sensitive })),
    );
    results.push(
      await t.deliver(botEvent("bot.done", randomUUID(), at(MIN), { metadata: sensitive })),
    );
    results.push(await t.deliver(botEvent("bot.done", t.botId, at(MIN)), { key: randomBytes(32) }));
    results.push(await t.deliver(null, { raw: `{"broken": "${MEET}"` }));
    t.service.failNext("final_interview_bots", "select");
    results.push(await t.deliver(botEvent("bot.done", t.botId, at(2 * MIN))));
  } finally {
    Object.assign(console, original);
  }
  const text = `${lines.join("\n")}\n${JSON.stringify(results)}`;
  for (const secret of [
    MEET,
    "Sam",
    "sam@example.test",
    SECRET,
    KEY.toString("base64"),
    "host@acme.test",
    '"broken"',
    '"integration"',
    "remotiv-final-interview",
  ]) {
    assert.ok(!text.includes(secret), `leaked: ${secret}`);
  }
  assert.ok(lines.length > 0, "something was logged, so the check was not vacuous");
});
