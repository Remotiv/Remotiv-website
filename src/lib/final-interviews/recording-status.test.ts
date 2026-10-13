/**
 * Recording step 5: what the Final interviews card says about a recording.
 * deriveRecordingSummary and recordingStatusLine are pure, so every state is
 * checked against the exact words the card shows. The reason lines are
 * checked against the host's email, which must say the same thing.
 *
 *   node --test src/lib/final-interviews/recording-status.test.ts
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../test-support/fake-service-client-hook.mjs", import.meta.url));

const {
  deriveRecordingSummary,
  recordingStatusLine,
  recordingFailureReason,
  RECORDING_ENDED_GRACE_MS,
  RECORDING_ENDED_WITHOUT_MEDIA,
  RECORDING_FAILURE_REASONS,
  RECORDING_SCHEDULE_FAILURE_REASONS,
  RECORDING_UNAVAILABLE,
  SCHEDULE_TIME_FAILURE_CODES,
} = await import("./constants.ts");
const { failureEmail, scheduleFailureEmail } = await import("./alerts.ts");

const NOW = Date.parse("2026-11-05T12:00:00.000Z");
const CURRENT = "booking-now";
const EARLIER = "booking-before";
const STARTS = new Map([
  [CURRENT, "2026-11-05T10:00:00.000Z"],
  [EARLIER, "2026-11-01T09:00:00.000Z"],
]);
/** A visible stand-in for the browser's local time format. */
const fmt = (iso) => `<${iso}>`;

const bot = (over = {}) => ({
  booking_id: CURRENT,
  status: "scheduled",
  join_at: "2026-11-05T09:59:00.000Z",
  import_status: "none",
  last_event_code: null,
  last_event_sub_code: null,
  last_event_at: null,
  provider_recording_id: null,
  superseded_at: null,
  ...over,
});

const ready = (over = {}) => ({
  id: "rec-1",
  source: "recall_bot",
  vendor_recording_id: "vendor-1",
  status: "ready",
  uploaded_at: "2026-11-05T11:30:00.000Z",
  created_at: "2026-11-05T11:00:00.000Z",
  deleted_by: null,
  ...over,
});

const summary = ({
  bots = [],
  readyRow = null,
  recordings = readyRow ? [readyRow] : [],
  current = CURRENT,
  nowMs = NOW,
} = {}) =>
  deriveRecordingSummary({
    currentBookingId: current,
    bots,
    recordings,
    bookingStarts: STARTS,
    nowMs,
  });
const line = (s) => recordingStatusLine(s, fmt);

/* ── each state, in the card's own words ────────────────────────── */

test("each state maps to the right words and tone", () => {
  const cases = [
    [
      [bot({ status: "pending" })],
      "scheduled",
      "info",
      "Remotiv Recorder will join at <2026-11-05T09:59:00.000Z>",
    ],
    [
      [bot({ status: "scheduled" })],
      "scheduled",
      "info",
      "Remotiv Recorder will join at <2026-11-05T09:59:00.000Z>",
    ],
    [
      [bot({ status: "waiting_room" })],
      "waiting",
      "warn",
      "Remotiv Recorder is waiting to be admitted in Google Meet",
    ],
    [[bot({ status: "in_call" })], "in_call", "info", "Remotiv Recorder has joined the call"],
    [[bot({ status: "recording" })], "recording", "info", "Recording in progress"],
    [
      [bot({ status: "call_ended", provider_recording_id: "vendor-1" })],
      "saving",
      "info",
      "Saving recording...",
    ],
    [
      [bot({ status: "done", import_status: "queued", provider_recording_id: "vendor-1" })],
      "saving",
      "info",
      "Saving recording...",
    ],
    [
      [bot({ status: "done", import_status: "importing", provider_recording_id: "vendor-1" })],
      "saving",
      "info",
      "Saving recording...",
    ],
    [
      [bot({ status: "fatal", last_event_sub_code: "google_meet_bot_blocked" })],
      "not_recorded",
      "bad",
      "Not being recorded",
    ],
    [
      [bot({ status: "done", import_status: "failed", provider_recording_id: "vendor-1" })],
      "save_failed",
      "bad",
      "The recording could not be saved",
    ],
  ];
  for (const [bots, state, tone, text] of cases) {
    const s = summary({ bots });
    assert.equal(s.state, state, `${bots[0].status}/${bots[0].import_status}`);
    const l = line(s);
    assert.equal(l.tone, tone, state);
    assert.equal(l.text, text, state);
  }
  const r = line(
    summary({ readyRow: ready(), bots: [bot({ provider_recording_id: "vendor-1" })] }),
  );
  assert.deepEqual(r, {
    tone: "ready",
    text: "Recording ready",
    detail: "Recorded <2026-11-05T10:00:00.000Z>",
  });
  assert.deepEqual(line(RECORDING_UNAVAILABLE), {
    tone: "warn",
    text: "Couldn't load the recording status. Reload to try again.",
    detail: null,
  });
});

test("none renders nothing: no bot, only superseded or deleted bots, or a bot for another booking", () => {
  for (const bots of [
    [],
    [bot({ superseded_at: "2026-11-04T00:00:00.000Z", status: "superseded" })],
    [bot({ status: "deleted" })],
    [bot({ booking_id: EARLIER })],
  ]) {
    const s = summary({ bots });
    assert.equal(s.state, "none");
    assert.equal(line(s), null);
  }
  assert.equal(summary({ bots: [bot()], current: null }).state, "none", "no booking at all");
});

test("a ready recording always wins over every bot state", () => {
  for (const b of [
    bot({ status: "scheduled" }),
    bot({ status: "waiting_room" }),
    bot({ status: "recording" }),
    bot({ status: "fatal", last_event_sub_code: "google_meet_bot_blocked" }),
    bot({ status: "done", import_status: "failed" }),
    bot({ status: "done", import_status: "importing" }),
  ]) {
    const s = summary({ bots: [b], readyRow: ready() });
    assert.equal(s.state, "ready", `${b.status}/${b.import_status}`);
    assert.equal(s.recordingId, "rec-1");
  }
});

test("a ready recording from an earlier booking says so and carries that booking's date", () => {
  // Rescheduled: the old booking's bot recorded, the new booking's bot is scheduled.
  const bots = [
    bot({
      booking_id: EARLIER,
      superseded_at: "2026-11-02T00:00:00.000Z",
      status: "superseded",
      provider_recording_id: "vendor-1",
    }),
    bot({ booking_id: CURRENT, status: "scheduled" }),
  ];
  const s = summary({ bots, readyRow: ready() });
  assert.equal(s.state, "ready");
  assert.equal(s.fromEarlierBooking, true);
  assert.equal(s.recordedAt, "2026-11-01T09:00:00.000Z");
  assert.equal(s.origin, "recorder");
  assert.equal(line(s).detail, "From an earlier booking, recorded <2026-11-01T09:00:00.000Z>");

  const same = summary({ bots: [bot({ provider_recording_id: "vendor-1" })], readyRow: ready() });
  assert.equal(same.fromEarlierBooking, false);
  assert.equal(line(same).detail, "Recorded <2026-11-05T10:00:00.000Z>");
});

test("an uploaded recording is dated by its upload, never as a booking's", () => {
  const s = summary({
    readyRow: ready({ source: "manual_upload", vendor_recording_id: null }),
    bots: [bot()],
  });
  assert.equal(s.origin, "upload");
  assert.equal(s.fromEarlierBooking, false);
  assert.equal(line(s).detail, "Uploaded <2026-11-05T11:30:00.000Z>");
});

test("a call that ended with no recording says saving for an hour, then that nothing was recorded", () => {
  const endedAt = NOW - 10 * 60_000;
  const early = summary({
    bots: [bot({ status: "done", last_event_at: new Date(endedAt).toISOString() })],
  });
  assert.equal(early.state, "saving");
  const late = summary({
    bots: [bot({ status: "done", last_event_at: new Date(endedAt).toISOString() })],
    nowMs: endedAt + RECORDING_ENDED_GRACE_MS + 1,
  });
  assert.equal(late.state, "not_recorded");
  assert.equal(line(late).detail, RECORDING_ENDED_WITHOUT_MEDIA);
});

/* ── saved, then no ready row ───────────────────────────────────── */

const savedBot = () =>
  bot({ status: "done", import_status: "ready", provider_recording_id: "vendor-1" });

test("saved, then deleted by the retention purge: says so, with nothing to watch", () => {
  const s = summary({
    bots: [savedBot()],
    recordings: [ready({ status: "deleted", deleted_by: null })],
  });
  assert.equal(s.state, "deleted");
  assert.equal(s.recordingId, null, "no Watch for a deleted recording");
  assert.deepEqual(line(s), {
    tone: "info",
    text: "Recording deleted after the retention period",
    detail: null,
  });
});

test("saved, but the recording row is missing or not ready: shown as no longer available, never hidden", () => {
  const cases = [
    ["no row at all", []],
    [
      "a row for another recording only",
      [ready({ vendor_recording_id: "vendor-2", status: "failed" })],
    ],
    ["the row is pending", [ready({ status: "pending" })]],
    ["the row is failed", [ready({ status: "failed" })]],
    // Not the retention purge, so the purge's wording would be untrue.
    ["deleted by a person", [ready({ status: "deleted", deleted_by: "u-1" })]],
  ];
  for (const [name, recordings] of cases) {
    const s = summary({ bots: [savedBot()], recordings });
    assert.equal(s.state, "gone", name);
    assert.equal(s.recordingId, null, name);
    assert.notEqual(line(s), null, `${name}: something is shown`);
    assert.deepEqual(line(s), {
      tone: "warn",
      text: "Recording no longer available",
      detail: null,
    });
  }
  const noId = summary({ bots: [bot({ status: "done", import_status: "ready" })] });
  assert.equal(noId.state, "gone", "a saved bot with no recording id is inconsistent too");
});

test("a ready row still wins over a saved bot, and a deleted row never counts as ready", () => {
  assert.equal(summary({ bots: [savedBot()], readyRow: ready() }).state, "ready");
  const both = summary({
    bots: [savedBot()],
    recordings: [
      ready({ status: "deleted" }),
      ready({ id: "rec-2", vendor_recording_id: "v-up", source: "manual_upload" }),
    ],
  });
  assert.equal(both.state, "ready");
  assert.equal(both.recordingId, "rec-2");
});

test("Recording in progress only once recording has started, not when the bot has only joined", () => {
  assert.equal(
    line(summary({ bots: [bot({ status: "in_call" })] })).text,
    "Remotiv Recorder has joined the call",
  );
  assert.equal(
    line(summary({ bots: [bot({ status: "recording" })] })).text,
    "Recording in progress",
  );
  for (const status of [
    "pending",
    "scheduled",
    "waiting_room",
    "in_call",
    "call_ended",
    "done",
    "fatal",
  ]) {
    const l = line(summary({ bots: [bot({ status })] }));
    assert.notEqual(l?.text, "Recording in progress", status);
  }
});

/* ── playback URLs carry the object key: it must hold no PII ───── */

test("the recording's object key holds ids only, so a signed URL carries no name or email", async () => {
  const { recordingStoragePath } = await import("./import.ts");
  const key = recordingStoragePath(
    {
      company_id: "c0000000-0000-4000-8000-000000000001",
      final_interview_id: "f0000000-0000-4000-8000-000000000001",
    },
    "a0000000-0000-4000-8000-000000000009",
  );
  assert.match(key, /^[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.mp4$/);
});

/* ── the reason line is the email's ─────────────────────────────── */

test("not_recorded gives the same reason line the host's email uses", () => {
  for (const [sub, reason] of Object.entries(RECORDING_FAILURE_REASONS)) {
    const s = summary({ bots: [bot({ status: "fatal", last_event_sub_code: sub })] });
    assert.equal(s.reason, reason);
    assert.equal(line(s).detail, reason);
    assert.ok(failureEmail("CTO interview", "Sam", reason, false).html.includes(reason), sub);
  }
  for (const code of SCHEDULE_TIME_FAILURE_CODES) {
    const s = summary({ bots: [bot({ status: "fatal", last_event_code: code })] });
    const reason = RECORDING_SCHEDULE_FAILURE_REASONS[code];
    assert.equal(s.reason, reason);
    assert.ok(scheduleFailureEmail("CTO interview", "Sam", code).html.includes(reason), code);
  }
  assert.equal(recordingFailureReason({ last_event_code: "x", last_event_sub_code: "y" }), null);
  const unknown = summary({
    bots: [bot({ status: "fatal", last_event_sub_code: "something_new" })],
  });
  assert.equal(line(unknown).detail, null, "an unknown code adds no invented reason");
});

test("alerts.ts keeps no reason map of its own: one source for the email and the card", () => {
  const alerts = readFileSync(new URL("./alerts.ts", import.meta.url), "utf8");
  assert.doesNotMatch(alerts, /const (FAILURE_REASONS|SCHEDULE_TIME_REASONS)\b/);
  assert.match(alerts, /RECORDING_FAILURE_REASONS\[row\.last_event_sub_code/);
  assert.match(alerts, /RECORDING_SCHEDULE_FAILURE_REASONS\[code\]/);
});

test("hyphens, never em dashes, in the card's recording copy", () => {
  const constants = readFileSync(new URL("./constants.ts", import.meta.url), "utf8");
  const section = constants.slice(
    constants.indexOf("recording status on the card (recording step 5)"),
    constants.indexOf("/* ── fixed copy"),
  );
  assert.ok(section.length > 500, "the section was found");
  assert.ok(!section.includes(String.fromCharCode(0x2014)), "no em dash");
});
