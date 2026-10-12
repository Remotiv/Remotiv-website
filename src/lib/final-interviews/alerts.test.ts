/**
 * Host alerts for the recording bot: who is told, when, with what words, and
 * never twice. Runs the real alert job against the migration-040 database
 * fake, with a fake email sender. The bell is a row in notifications_company.
 * No real email.
 *
 *   node --test src/lib/final-interviews/alerts.test.ts
 */
// @ts-nocheck — same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { register } from "node:module";
import { test } from "node:test";
import {
  APP,
  BOOKING,
  botWorld,
  CO,
  FI,
  HOST,
  JOB,
  makeBotDb,
  OTHER_CO,
  OTHER_MEMBER,
} from "../../test-support/final-bot-world.mjs";

register(new URL("../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../test-support/fake-service-client-hook.mjs", import.meta.url));

const { runFinalBotAlert, bellNotificationId } = await import("./alerts.ts");
const { TerminalJobError } = await import("../queue/failure-class.ts");

const MIN = 60_000;
const T0 = Date.parse("2026-11-05T09:00:00.000Z");
const at = (ms) => new Date(T0 + ms).toISOString();
const NOT_AFFECTED = "The interview itself is not affected";
const PARTIAL = "If any part of it was recorded before this happened, that part is kept.";

/**
 * One bot row in the lobby two minutes ago, a fake sender, a clock.
 * `email` is one result for every send, or a list consumed in order;
 * an entry may be a function run before answering (to inject a fault).
 */
function setup({ row = {}, email = { ok: true } } = {}) {
  const db = makeBotDb(T0 + MIN);
  const service = botWorld(db);
  const bot = {
    id: randomUUID(),
    final_interview_id: FI,
    company_id: CO,
    job_id: JOB,
    application_id: APP,
    booking_id: BOOKING,
    provider: "recall",
    provider_bot_id: randomUUID(),
    provider_recording_id: null,
    join_at: at(0),
    status: "waiting_room",
    last_event_code: "in_waiting_room",
    last_event_sub_code: null,
    last_event_at: at(0),
    import_status: "none",
    lobby_alert_sent_at: null,
    failure_alert_sent_at: null,
    superseded_at: null,
    ...row,
  };
  db.final_interview_bots.push(bot);
  const emails = [];
  const clock = { now: T0 + 2 * MIN };
  const responses = Array.isArray(email) ? [...email] : null;
  const deps = {
    service,
    sendEmail: async (payload, options) => {
      // Recorded when the send starts, so one that never answers is still seen.
      const entry = { ...payload, key: options?.idempotencyKey, accepted: false };
      emails.push(entry);
      let result = responses ? (responses.shift() ?? { ok: true }) : email;
      if (typeof result === "function") result = await result();
      entry.accepted = result.ok;
      return result;
    },
    now: () => clock.now,
    emailTimeoutMs: 50,
  };
  return {
    db,
    service,
    deps,
    emails,
    accepted: () => emails.filter((e) => e.accepted),
    bells: () => db.notifications_company,
    row: () => db.final_interview_bots.find((r) => r.id === bot.id),
    run: (kind = "lobby", attempt) => runFinalBotAlert(deps, { botRowId: bot.id, kind }, attempt),
    setNow: (ms) => {
      clock.now = ms;
    },
  };
}

const notRetryable = (err) => !(err instanceof TerminalJobError);

/* ── the lobby alert ──────────────────────────────────────────── */

test("lobby: two minutes in, still waiting: the host gets the email and one bell row", async () => {
  const t = setup();
  assert.equal(await t.run(), "sent");
  const [mail] = t.emails;
  assert.equal(mail.to, "host@acme.test");
  assert.equal(mail.subject, "Admit Remotiv Recorder to record your interview");
  assert.equal(
    mail.html,
    "<p>Remotiv Recorder is waiting to join your CTO interview with Sam. Admit it in Google Meet so the interview can be recorded.</p>",
  );
  assert.equal(t.bells().length, 1);
  const [bell] = t.bells();
  assert.equal(bell.id, bellNotificationId(t.row().id, "lobby"));
  assert.equal(bell.company_id, CO);
  assert.equal(bell.member_id, HOST);
  assert.equal(bell.type, "final_recording_lobby");
  assert.equal(bell.application_id, APP);
  assert.equal(bell.href, `/ai-dashboard/applicants?applicant=${APP}`);
  assert.ok(t.row().lobby_alert_sent_at);
});

test("lobby: before two minutes nothing is sent and the job retries", async () => {
  const t = setup();
  t.setNow(T0 + 90_000);
  await assert.rejects(t.run(), notRetryable);
  assert.equal(t.emails.length, 0);
  assert.equal(t.row().lobby_alert_sent_at, null);
});

test("lobby: admitted, cancelled, retired or moved on: nothing is sent", async () => {
  const cases = [
    ["admitted", (t) => Object.assign(t.row(), { status: "in_call" }), "not_waiting"],
    ["recording", (t) => Object.assign(t.row(), { status: "recording" }), "not_waiting"],
    [
      "booking cancelled",
      (t) => Object.assign(t.db.interview_bookings[0], { status: "cancelled" }),
      "not_active",
    ],
    [
      "interview cancelled",
      (t) => Object.assign(t.db.final_interviews[0], { status: "cancelled" }),
      "not_active",
    ],
    ["retired", (t) => Object.assign(t.row(), { superseded_at: at(MIN) }), "not_live"],
    ["deleted", (t) => Object.assign(t.row(), { status: "deleted" }), "not_live"],
  ];
  for (const [name, change, outcome] of cases) {
    const t = setup();
    change(t);
    assert.equal(await t.run(), outcome, name);
    assert.equal(t.emails.length + t.bells().length, 0, name);
  }
});

test("two lobby jobs racing for the same bot send one alert", async () => {
  const t = setup();
  const outcomes = await Promise.all([t.run(), t.run(), t.run()]);
  assert.equal(outcomes.filter((o) => o === "sent").length, 1, outcomes.join(","));
  assert.equal(t.emails.length, 1);
  assert.equal(t.bells().length, 1);
});

test("a lobby alert already sent is not sent again", async () => {
  const t = setup({ row: { lobby_alert_sent_at: at(MIN) } });
  assert.equal(await t.run(), "already_sent");
  assert.equal(t.emails.length, 0);
});

/* ── the failure alert: vendor failures ───────────────────────── */

test("failure after a vendor event: the reason line, and no partial-recording claim when joining is unproven", async () => {
  for (const [status, sub, reason] of [
    ["fatal", "google_meet_bot_blocked", "Google Meet did not let it join the call."],
    [
      "call_ended",
      "timeout_exceeded_waiting_room",
      "It was not admitted from the waiting room in time.",
    ],
    ["call_ended", "bot_kicked_from_waiting_room", "It was removed from the waiting room."],
  ]) {
    const t = setup({ row: { status, last_event_code: status, last_event_sub_code: sub } });
    assert.equal(await t.run("failure"), "sent", sub);
    const [mail] = t.emails;
    assert.equal(mail.subject, "Your CTO interview is not being recorded");
    assert.ok(mail.html.includes("Remotiv Recorder could not record your CTO interview with Sam."));
    assert.ok(mail.html.includes(reason), sub);
    assert.ok(mail.html.includes(NOT_AFFECTED));
    assert.ok(!mail.html.includes(PARTIAL), `${sub}: never joined, so no partial-recording line`);
    assert.doesNotMatch(mail.html, /lost|deleted|—/);
    assert.equal(t.bells()[0].type, "final_recording_failed");
    assert.ok(t.row().failure_alert_sent_at);
  }
});

test("failure after the bot provably joined keeps the partial-recording line", async () => {
  for (const row of [
    { status: "done", provider_recording_id: randomUUID(), last_event_code: "recording_failed" },
    { status: "recording", last_event_code: "in_call_recording" },
  ]) {
    const t = setup({ row });
    await t.run("failure");
    assert.ok(t.emails[0].html.includes(PARTIAL), JSON.stringify(row));
  }
});

test("repeated failure events send one failure alert", async () => {
  const t = setup({ row: { status: "fatal" } });
  assert.equal(await t.run("failure"), "sent");
  assert.equal(await t.run("failure"), "already_sent");
  assert.equal(await t.run("failure"), "already_sent");
  assert.equal(t.emails.length, 1);
  assert.equal(t.bells().length, 1);
});

test("failure: suppressed once the interview is cancelled or the bot retired", async () => {
  const cancelled = setup({ row: { status: "fatal" } });
  cancelled.db.interview_bookings[0].status = "cancelled";
  assert.equal(await cancelled.run("failure"), "not_active");
  const retired = setup({ row: { status: "fatal", superseded_at: at(0) } });
  assert.equal(await retired.run("failure"), "not_live");
  assert.equal(cancelled.emails.length + retired.emails.length, 0);
  assert.equal(cancelled.bells().length + retired.bells().length, 0);
});

/* ── the failure alert: schedule-time causes (step 3b) ────────── */

test("each schedule-time cause gets the never-joined wording and its one reason line", async () => {
  const reasons = {
    no_meeting_url: "The calendar event has no Google Meet link.",
    too_late_to_schedule: "It was booked too close to the start time to schedule the recorder.",
    create_failed: "The recording service could not schedule the recorder.",
    vendor_metadata_mismatch: "The recording service could not schedule the recorder.",
  };
  for (const [code, reason] of Object.entries(reasons)) {
    const t = setup({
      row: { status: "fatal", last_event_code: code, last_event_sub_code: "deterministic_400" },
    });
    assert.equal(await t.run("failure"), "sent", code);
    const [mail] = t.emails;
    assert.equal(mail.subject, "Your CTO interview is not being recorded", code);
    assert.equal(
      mail.html,
      `<p>Remotiv Recorder will not be able to join your CTO interview with Sam, so it will not be recorded automatically. ${reason}</p><p>The interview itself is not affected.</p>`,
      code,
    );
    assert.ok(!mail.html.includes("recorded before"), code);
    assert.doesNotMatch(mail.html, /—|meet\.google|https?:/);
    assert.equal(t.bells()[0].title, "Your CTO interview is not being recorded");
  }
});

/* ── recipients and tenancy ───────────────────────────────────── */

test("only the interview's host is told, never another member", async () => {
  const t = setup();
  await t.run();
  assert.deepEqual(
    t.emails.map((e) => e.to),
    ["host@acme.test"],
  );
  assert.deepEqual(
    t.bells().map((b) => [b.member_id, b.company_id]),
    [[HOST, CO]],
  );
});

test("a host that does not match, or cannot be verified, gets nothing and nobody else is guessed", async () => {
  const mismatch = setup();
  mismatch.db.interview_bookings[0].host_member_id = OTHER_MEMBER;
  assert.equal(await mismatch.run(), "host_mismatch");

  const removed = setup();
  removed.db.company_members[0].status = "removed";
  assert.equal(await removed.run(), "host_unverified");

  const otherCompany = setup();
  otherCompany.db.company_members[0].company_id = OTHER_CO;
  assert.equal(await otherCompany.run(), "host_unverified");

  for (const t of [mismatch, removed, otherCompany]) {
    assert.equal(t.emails.length + t.bells().length, 0);
    assert.equal(t.row().lobby_alert_sent_at, null, "no stamp without a delivery");
  }
});

test("the candidate's name is read only through this company's applications", async () => {
  const t = setup();
  t.db.job_applications[0] = { id: APP, company_id_snapshot: OTHER_CO, first_name: "Leaked" };
  await t.run();
  assert.doesNotMatch(t.emails[0].html, /Leaked/);
  assert.match(t.emails[0].html, /with the candidate\./);
});

test("the host's sign-in address is used when the member row has none", async () => {
  const t = setup();
  t.db.company_members[0].email = null;
  await t.run();
  assert.equal(t.emails[0].to, "host-signin@acme.test");
});

/* ── email delivery, retries and idempotency ──────────────────── */

test("a refused email releases the claim and retries with the same key and payload; one bell", async () => {
  const t = setup({ email: [{ ok: false, error: "provider down" }, { ok: true }] });
  await assert.rejects(t.run(), notRetryable);
  assert.equal(t.row().lobby_alert_sent_at, null, "claim given back");
  assert.equal(t.bells().length, 0, "no bell before the email went");
  assert.equal(await t.run(), "sent");
  assert.equal(await t.run(), "already_sent");
  assert.equal(t.emails.length, 2);
  assert.equal(t.emails[0].key, t.emails[1].key, "the retry reuses the idempotency key");
  assert.equal(t.emails[0].html, t.emails[1].html, "with an identical payload");
  assert.match(
    t.emails[0].key,
    new RegExp(`^remotiv-final-alert-lobby-${t.row().id}-[0-9a-f]{16}$`),
  );
  assert.equal(t.accepted().length, 1);
  assert.equal(t.bells().length, 1);
});

test("a changed email gets a different key, so Resend never sees one key with two payloads", async () => {
  const t = setup({ email: [{ ok: false }, { ok: true }] });
  await assert.rejects(t.run(), notRetryable);
  t.db.job_applications[0].first_name = "Samira";
  await t.run();
  assert.notEqual(t.emails[0].key, t.emails[1].key);
});

test("an email that does not answer within the limit counts as refused", async () => {
  const t = setup({ email: [() => new Promise(() => {}), { ok: true }] });
  const started = Date.now();
  await assert.rejects(t.run(), notRetryable);
  assert.ok(Date.now() - started < 2_000);
  assert.equal(t.row().lobby_alert_sent_at, null);
  assert.equal(await t.run(), "sent");
  assert.equal(t.emails[0].key, t.emails[1].key);
  assert.equal(t.bells().length, 1);
});

test("refused on the final attempt: the bell is sent once, the claim kept, and the job ends", async () => {
  const t = setup({ email: { ok: false } });
  assert.equal(await t.run("lobby", { finalAttempt: true }), "bell_after_email_failure");
  assert.equal(t.bells().length, 1);
  assert.ok(t.row().lobby_alert_sent_at, "stamp kept");
  assert.equal(await t.run("lobby", { finalAttempt: true }), "already_sent");
  assert.equal(t.bells().length, 1);
});

test("a release that reports an error but landed: no bell now, one bell on the retry", async () => {
  const t = setup({
    email: [
      () => {
        t.service.failNext("final_interview_bots", "update", "08006", { applied: true });
        return { ok: false };
      },
      { ok: true },
    ],
  });
  await assert.rejects(t.run(), notRetryable);
  assert.equal(t.row().lobby_alert_sent_at, null, "the release did land");
  assert.equal(t.bells().length, 0);
  assert.equal(await t.run(), "sent");
  assert.equal(t.bells().length, 1);
});

test("a release that truly failed: ownership confirmed, one bell now, claim kept", async () => {
  const t = setup({
    email: () => {
      t.service.failNext("final_interview_bots", "update");
      return { ok: false };
    },
  });
  assert.equal(await t.run(), "bell_after_email_failure");
  assert.equal(t.bells().length, 1);
  assert.ok(t.row().lobby_alert_sent_at);
  assert.equal(await t.run(), "already_sent");
  assert.equal(t.bells().length, 1);
});

test("a release whose ownership cannot be confirmed: no bell, rather than risk a second", async () => {
  const t = setup({
    email: () => {
      t.service.failNext("final_interview_bots", "update");
      t.service.failNext("final_interview_bots", "update");
      return { ok: false };
    },
  });
  await assert.rejects(t.run(), notRetryable);
  assert.equal(t.bells().length, 0);
});

/* ── the bell insert ──────────────────────────────────────────── */

test("a bell that already exists for this alert is never written twice", async () => {
  const t = setup();
  t.db.notifications_company.push({ id: bellNotificationId(t.row().id, "lobby"), company_id: CO });
  assert.equal(await t.run(), "sent");
  assert.equal(t.bells().length, 1);
});

test("a bell insert that reports an error but landed counts as delivered, once", async () => {
  const t = setup();
  t.service.failNext("notifications_company", "insert", "08006", { applied: true });
  assert.equal(await t.run(), "sent");
  assert.equal(t.bells().length, 1);
});

test("a bell that failed after the email went: reported, not hidden, and not retried", async () => {
  const t = setup();
  t.service.failNext("notifications_company", "insert");
  assert.equal(await t.run(), "email_sent_bell_failed");
  assert.equal(t.bells().length, 0);
  assert.ok(t.row().lobby_alert_sent_at, "the email was the delivery");
});

test("a bell that failed with no email: the claim is given back and the retry delivers it once", async () => {
  const t = setup();
  t.db.company_members[0].email = null;
  t.db.auth_users = {};
  t.service.failNext("notifications_company", "insert");
  await assert.rejects(t.run(), notRetryable);
  assert.equal(t.row().lobby_alert_sent_at, null);
  assert.equal(await t.run(), "sent_bell_only");
  assert.equal(await t.run(), "already_sent");
  assert.equal(t.bells().length, 1);
});

test("a bell whose result cannot be read is unconfirmed: never retried blindly", async () => {
  const t = setup();
  t.service.failNext("notifications_company", "insert");
  t.service.failNext("notifications_company", "select");
  assert.equal(await t.run(), "bell_unconfirmed");
  assert.ok(t.row().lobby_alert_sent_at, "claim kept: nothing is resent");
});

test("however the retries fall, an alert never has a second bell", async () => {
  const t = setup({
    email: [{ ok: false }, { ok: false }, { ok: false }, { ok: false }, { ok: false }],
  });
  for (let i = 0; i < 4; i++) await assert.rejects(t.run(), notRetryable);
  assert.equal(await t.run("lobby", { finalAttempt: true }), "bell_after_email_failure");
  assert.equal(await t.run("lobby", { finalAttempt: true }), "already_sent");
  assert.equal(t.bells().length, 1);
  assert.equal(new Set(t.emails.map((e) => e.key)).size, 1, "one key across all five attempts");
});

/* ── misc ─────────────────────────────────────────────────────── */

test("no address for the host: the bell alone is the delivery, and it is not repeated", async () => {
  const t = setup();
  t.db.company_members[0].email = null;
  t.db.auth_users = {};
  assert.equal(await t.run(), "sent_bell_only");
  assert.equal(t.emails.length, 0);
  assert.equal(t.bells().length, 1);
  assert.equal(await t.run(), "already_sent");
  assert.equal(t.bells().length, 1);
});

test("a malformed payload is terminal", async () => {
  const t = setup();
  for (const payload of [
    {},
    { botRowId: "x", kind: "lobby" },
    { botRowId: randomUUID(), kind: "other" },
  ]) {
    await assert.rejects(runFinalBotAlert(t.deps, payload), TerminalJobError);
  }
});

test("a final interview reads 'final interview' mid-sentence; CTO keeps its capitals", async () => {
  const t = setup();
  t.db.final_interviews[0].interview_type = "final";
  await t.run();
  assert.match(t.emails[0].html, /your final interview with Sam/);
  const f = setup({ row: { status: "fatal" } });
  f.db.final_interviews[0].interview_type = "final";
  await f.run("failure");
  assert.equal(f.emails[0].subject, "Your final interview is not being recorded");
});

test("alert logs name the row only, never the candidate or the address", async () => {
  const lines = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  for (const k of Object.keys(original)) console[k] = (...a) => lines.push(a.map(String).join(" "));
  try {
    const t = setup({ email: [{ ok: false }, { ok: true }] });
    await t.run().catch(() => {});
    await t.run();
    const u = setup();
    u.service.failNext("notifications_company", "insert");
    await u.run();
  } finally {
    Object.assign(console, original);
  }
  assert.ok(lines.length > 0);
  for (const s of ["Sam", "host@acme.test", "host-signin@acme.test"]) {
    assert.ok(!lines.join("\n").includes(s), s);
  }
});
