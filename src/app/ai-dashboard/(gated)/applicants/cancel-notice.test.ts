/**
 * #59 (QA #104): both recruiter cancels say whether the candidate was told,
 * and the Retry rebuilds the SAME email from the same facts. The actions and
 * the email builder are the real code; the database, the session, the email
 * path and the bell are the Final Human Interview fakes.
 *
 *   node --test "src/app/ai-dashboard/(gated)/applicants/cancel-notice.test.ts"
 *
 * Exactly-once at the email level (concurrent Retries, unknown outcomes, the
 * idempotency key): src/lib/email/candidate/resend-once.test.ts. The claim on
 * a real Postgres: scripts/staging/checks-059-retry-claim.mjs.
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../../../test-support/final-interview-test-hook.mjs", import.meta.url));

const { APP, CO, JOB, finalInterviewWorld, makeDb } = await import(
  "../../../../test-support/final-interview-world.mjs"
);
const { cancelBookingAsRecruiter } = await import("./booking-actions.ts");
const { cancelFinalInterview } = await import("./final-interview-actions.ts");
const { retryCancellationNotice } = await import("./cancel-notice-actions.ts");

/** The world's tables, plus the communication_logs the Retry reads. */
const freshDb = () => Object.assign(makeDb(), { communication_logs: [] });

const FUTURE = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
const NOT_CONFIRMED = "We couldn't confirm the first email, so it was not sent again.";
const NOT_YOURS = "Applicant not found in your workspace.";
const PROVIDER_FAILED = { ok: false, kind: "provider", message: "refused", logId: "log-1" };

const ctxFor = (role, memberName = "Rae Recruiter") => ({
  companyId: CO,
  role,
  memberId: "m-rec",
  memberName,
  user: { id: "u-rec", email: "rae@acme.test" },
  company: { name: "Acme", contact_name: "Olive Owner" },
});

const booking = (over) => ({
  id: "b-1",
  company_id: CO,
  application_id: APP,
  job_id: JOB,
  host_member_id: "m-host",
  duration_minutes: 30,
  status: "booked",
  scheduled_start: FUTURE,
  scheduled_end: new Date(Date.parse(FUTURE) + 30 * 60 * 1000).toISOString(),
  candidate_timezone: "Asia/Karachi",
  host_timezone: "Europe/London",
  meeting_mode: "auto",
  meeting_url: null,
  provider_event_id: null,
  provider: null,
  expires_at: FUTURE,
  cancelled_at: null,
  booked_at: "2026-10-02T00:00:00.000Z",
  cancelled_by: null,
  cancel_reason: null,
  purpose: "interview",
  final_interview_id: null,
  recording_notice_acknowledged_at: null,
  recording_notice_version: null,
  created_at: "2026-10-02T00:00:00.000Z",
  ...over,
});
const FI = {
  id: "fi-1",
  company_id: CO,
  job_id: JOB,
  application_id: APP,
  interview_type: "cto",
  custom_label: null,
  host_member_id: "m-host",
  status: "active",
  created_by: "u-rec",
  created_by_name: "Rae Recruiter",
  created_at: "2026-10-01T00:00:00.000Z",
  cancelled_at: null,
};

async function run(
  act,
  { db, role = "recruiter", deliver, resend, roleAllowsJobAction, memberName } = {},
) {
  db.communication_logs ??= [];
  const service = finalInterviewWorld(db);
  globalThis.__fiServiceForTests = () => service;
  globalThis.__fiCtxForTests = ctxFor(role, memberName);
  globalThis.__fiRoleAllowsJobAction = roleAllowsJobAction;
  globalThis.__fiDeliverResult = deliver;
  globalThis.__fiResendResult = resend;
  globalThis.__fiEmails = [];
  globalThis.__fiResends = [];
  globalThis.__fiHostEmails = [];
  globalThis.__fiBell = [];
  const quiet = console.error;
  console.error = () => {};
  try {
    return {
      result: await act(),
      db,
      emails: globalThis.__fiEmails,
      resends: globalThis.__fiResends,
    };
  } finally {
    console.error = quiet;
  }
}

/** The failed email's row, as deliverEmail would have written it from `email`. */
const logFrom = (email, over = {}) => ({
  id: "log-1",
  company_id: CO,
  application_id: APP,
  event: "booking_cancelled",
  channel: "email",
  to_address: email.to,
  sent_by_name: email.sentByName ?? null,
  status: "failed",
  ...over,
});

/* ── the cancels say what happened to the email ─────────────────── */

test("59-C1. screening cancel, email refused: cancelled, notice failed with the row to retry; bell actor still null", async () => {
  const db = freshDb();
  db.interview_bookings.push(booking({}));
  const { result, emails } = await run(() => cancelBookingAsRecruiter(APP, "Role filled"), {
    db,
    deliver: PROVIDER_FAILED,
  });
  assert.equal(result.success, true);
  assert.deepEqual(result.data.notice, { candidate: "failed", bookingId: "b-1", logId: "log-1" });
  assert.equal(db.interview_bookings[0].status, "cancelled");
  assert.equal(emails[0].actorMemberId, null, "#87: actorMemberId stays null");
  assert.equal(emails[0].sentByName, "Hana Host", "the email's host name, recorded for the Retry");
});

test("59-C2. screening cancel with no candidate address: no_address, nothing to retry", async () => {
  const db = freshDb();
  db.interview_bookings.push(booking({}));
  db.job_applications[0].email = null;
  const { result } = await run(() => cancelBookingAsRecruiter(APP), { db });
  assert.deepEqual(result.data.notice, { candidate: "no_address", bookingId: "b-1", logId: null });
});

test("59-C3. final round cancel, email refused: notice failed with the row; bell actor null", async () => {
  const db = freshDb();
  db.final_interviews.push({ ...FI });
  db.interview_bookings.push(
    booking({ id: "b-fi1", purpose: "final", final_interview_id: "fi-1" }),
  );
  const { result, emails } = await run(() => cancelFinalInterview("fi-1", "Role filled"), {
    db,
    role: "admin",
    deliver: PROVIDER_FAILED,
  });
  assert.deepEqual(result.data.notice, {
    candidate: "failed",
    bookingId: "b-fi1",
    logId: "log-1",
  });
  assert.equal(emails[0].actorMemberId, null);
});

test("59-C4. a sent email: notice sent, no row to retry", async () => {
  const db = freshDb();
  db.interview_bookings.push(booking({}));
  const { result } = await run(() => cancelBookingAsRecruiter(APP), { db });
  assert.deepEqual(result.data.notice, { candidate: "sent", bookingId: "b-1", logId: null });
});

/* ── the Retry rebuilds the same email ──────────────────────────── */

for (const kind of ["screening", "final"]) {
  test(`59-R1. ${kind}: the Retry rebuilds the first email exactly (address, subject, body), whoever presses it`, async () => {
    const db = freshDb();
    const isFinal = kind === "final";
    if (isFinal) db.final_interviews.push({ ...FI });
    db.interview_bookings.push(
      booking(isFinal ? { id: "b-fi1", purpose: "final", final_interview_id: "fi-1" } : {}),
    );
    const first = await run(
      () =>
        isFinal
          ? cancelFinalInterview("fi-1", "Role filled")
          : cancelBookingAsRecruiter(APP, "Role filled"),
      { db, role: "admin", deliver: PROVIDER_FAILED },
    );
    const sent = first.emails[0];
    db.communication_logs.push(logFrom(sent));
    // A different member presses Retry: the email must not change with them.
    const retry = await run(
      () =>
        retryCancellationNotice({ bookingId: first.result.data.notice.bookingId, logId: "log-1" }),
      { db, memberName: "Somebody Else" },
    );
    assert.deepEqual(retry.result, { success: true, data: { alreadySent: false } });
    assert.equal(retry.resends.length, 1);
    const again = retry.resends[0];
    assert.equal(again.logId, "log-1");
    assert.equal(again.to, sent.to);
    assert.equal(again.subject, sent.subject);
    assert.equal(again.html, sent.html, "byte for byte, so Resend's idempotency key accepts it");
    assert.equal(again.companyName, sent.companyName);
    assert.equal(again.replyTo, null);
  });
}

test("59-R1b. an OWNER hosts (no member name): the email names the canceller, and another recruiter's Retry still rebuilds it exactly", async () => {
  const db = freshDb();
  db.interview_bookings.push(booking({ host_member_id: "m-owner" }));
  const first = await run(() => cancelBookingAsRecruiter(APP, "Role filled"), {
    db,
    deliver: PROVIDER_FAILED,
    memberName: "Rae Recruiter",
  });
  const sent = first.emails[0];
  assert.equal(sent.sentByName, "Rae Recruiter", "no host name, so the canceller's");
  assert.ok(sent.html.includes("Rae Recruiter cancelled your"));
  db.communication_logs.push(logFrom(sent));
  const retry = await run(() => retryCancellationNotice({ bookingId: "b-1", logId: "log-1" }), {
    db,
    memberName: "Otto Other",
  });
  assert.deepEqual(retry.result, { success: true, data: { alreadySent: false } });
  const again = retry.resends[0];
  assert.equal(again.html, sent.html, "byte for byte, not the presser's name");
  assert.ok(!again.html.includes("Otto Other"));
  assert.equal(again.subject, sent.subject);
  assert.equal(again.to, sent.to);
});

test("59-R2. Resend refused the reused key (the email changed): the agreed message, nothing sent", async () => {
  const db = freshDb();
  db.interview_bookings.push(booking({ status: "cancelled", cancelled_by: "recruiter" }));
  db.communication_logs.push(logFrom({ to: "sam@example.test", sentByName: "Hana Host" }));
  const { result } = await run(
    () => retryCancellationNotice({ bookingId: "b-1", logId: "log-1" }),
    {
      db,
      resend: { kind: "mismatch" },
    },
  );
  assert.deepEqual(result, { success: false, error: NOT_CONFIRMED });
});

test("59-R3. unknown outcome (claim refused, wrong_status): the same message; too old and missing have their own", async () => {
  const cases = [
    [{ kind: "not_retried", reason: "wrong_status" }, NOT_CONFIRMED],
    [
      { kind: "not_retried", reason: "too_old" },
      "This email is more than a day old, so it can no longer be resent safely. Contact the candidate directly.",
    ],
    [{ kind: "not_retried", reason: "missing" }, "There is no cancellation email to resend."],
  ];
  for (const [resend, error] of cases) {
    const db = freshDb();
    db.interview_bookings.push(booking({ status: "cancelled", cancelled_by: "recruiter" }));
    db.communication_logs.push(logFrom({ to: "sam@example.test", sentByName: "Hana Host" }));
    const { result } = await run(
      () => retryCancellationNotice({ bookingId: "b-1", logId: "log-1" }),
      { db, resend },
    );
    assert.deepEqual(result, { success: false, error });
  }
});

test("59-R4. an email already sent: success, nothing sent again", async () => {
  const db = freshDb();
  db.interview_bookings.push(booking({ status: "cancelled", cancelled_by: "recruiter" }));
  db.communication_logs.push(
    logFrom({ to: "sam@example.test", sentByName: "Hana Host" }, { status: "sent" }),
  );
  const { result, resends } = await run(
    () => retryCancellationNotice({ bookingId: "b-1", logId: "log-1" }),
    { db },
  );
  assert.deepEqual(result, { success: true, data: { alreadySent: true } });
  assert.equal(resends.length, 0);
});

test("59-R5. scope first: another job's recruiter, another company's booking, another row: nothing sent", async () => {
  const base = () => {
    const db = freshDb();
    db.interview_bookings.push(booking({ status: "cancelled", cancelled_by: "recruiter" }));
    db.communication_logs.push(logFrom({ to: "sam@example.test", sentByName: "Hana Host" }));
    return db;
  };
  const outside = await run(() => retryCancellationNotice({ bookingId: "b-1", logId: "log-1" }), {
    db: base(),
    roleAllowsJobAction: () => false,
  });
  assert.deepEqual(outside.result, { success: false, error: NOT_YOURS });
  assert.equal(outside.resends.length, 0);

  const other = base();
  other.interview_bookings[0].company_id = "other-co";
  const otherCo = await run(() => retryCancellationNotice({ bookingId: "b-1", logId: "log-1" }), {
    db: other,
  });
  assert.deepEqual(otherCo.result, { success: false, error: NOT_YOURS });

  const wrongRow = base();
  wrongRow.communication_logs[0].event = "offer";
  const r = await run(() => retryCancellationNotice({ bookingId: "b-1", logId: "log-1" }), {
    db: wrongRow,
  });
  assert.deepEqual(r.result, {
    success: false,
    error: "There is no cancellation email to resend.",
  });
  assert.equal(r.resends.length, 0);

  const hm = await run(() => retryCancellationNotice({ bookingId: "b-1", logId: "log-1" }), {
    db: base(),
    role: "hiring_manager",
  });
  assert.equal(hm.result.success, false);
  assert.equal(hm.resends.length, 0);
});

test("59-R6. a booking not cancelled by a recruiter has no cancellation email to resend", async () => {
  const db = freshDb();
  db.interview_bookings.push(booking({ status: "booked" }));
  db.communication_logs.push(logFrom({ to: "sam@example.test", sentByName: "Hana Host" }));
  const { result, resends } = await run(
    () => retryCancellationNotice({ bookingId: "b-1", logId: "log-1" }),
    { db },
  );
  assert.deepEqual(result, { success: false, error: "There is no cancellation email to resend." });
  assert.equal(resends.length, 0);
});

/* ── once per booking EVENT, and every distinct event can notify ── */

test("59-E1. two cancels of ONE booking at the same moment: one cancels and emails, the other sends nothing", async () => {
  const db = freshDb();
  db.communication_logs = [];
  db.interview_bookings.push(booking({}));
  const service = finalInterviewWorld(db);
  globalThis.__fiServiceForTests = () => service;
  globalThis.__fiCtxForTests = ctxFor("recruiter");
  globalThis.__fiRoleAllowsJobAction = undefined;
  globalThis.__fiDeliverResult = undefined;
  globalThis.__fiEmails = [];
  globalThis.__fiHostEmails = [];
  globalThis.__fiBell = [];
  const quiet = console.error;
  console.error = () => {};
  try {
    const [a, b] = await Promise.all([
      cancelBookingAsRecruiter(APP),
      cancelBookingAsRecruiter(APP),
    ]);
    assert.equal([a, b].filter((r) => r.success).length, 1, "one cancel won");
    assert.equal(globalThis.__fiEmails.length, 1, "one candidate email");
  } finally {
    console.error = quiet;
  }
});

test("59-E2. a SECOND booking for the same applicant, cancelled later, emails the candidate again", async () => {
  const db = freshDb();
  db.interview_bookings.push(
    booking({ id: "b-old", status: "cancelled", cancelled_by: "recruiter" }),
  );
  db.interview_bookings.push(booking({ id: "b-new", created_at: "2026-10-05T00:00:00.000Z" }));
  const { result, emails } = await run(() => cancelBookingAsRecruiter(APP), { db });
  assert.equal(result.success, true);
  assert.equal(emails.length, 1);
  assert.equal(emails[0].event, "booking_cancelled");
});

test("59-E3. migration 067: the three booking events leave the unique index; the claim is service_role only", () => {
  const sql = readFileSync(
    new URL("../../../../lib/supabase/migrations/067_booking_notice_retry.sql", import.meta.url),
    "utf8",
  );
  assert.match(
    sql,
    /where sent_by_name is null\s+and event not in \('booking_confirmed', 'booking_rescheduled', 'booking_cancelled'\);/,
  );
  assert.match(sql, /drop index public\.communication_logs_auto_event_uniq;/);
  assert.match(sql, /rename to communication_logs_auto_event_uniq;/);
  assert.match(sql, /security definer\s+set search_path = ''/);
  assert.match(
    sql,
    /grant execute on function public\.claim_failed_email_log\(uuid, uuid\) to service_role;/,
  );
  assert.match(
    sql,
    /revoke all on function public\.claim_failed_email_log\(uuid, uuid\) from anon, authenticated;/,
  );
  assert.match(
    sql,
    /and l\.status = 'failed'\s+and l\.created_at > pg_catalog\.now\(\) - interval '24 hours'/,
  );
});

test("59-E4. each booking event is ONE conditional update, so it has one winner and one email", () => {
  const src = readFileSync(
    new URL("../../../../lib/calendar/bookings.ts", import.meta.url),
    "utf8",
  );
  const fn = (start, end) => src.slice(src.indexOf(start), src.indexOf(end));
  const claim = fn("export async function claimSlot(", "export async function overlapsExisting(");
  const resched = fn(
    "export async function rescheduleBooking(",
    "export async function cancelBooking(",
  );
  const cancel = src.slice(src.indexOf("export async function cancelBooking("));
  assert.match(claim, /\.eq\("status", "invited"\)/);
  assert.match(resched, /\.eq\("status", "booked"\)\s*\.eq\("scheduled_start", previousStart\)/);
  assert.match(cancel, /\.eq\("status", "booked"\)/);
});

test("59-E5. the UI copy, word for word, no dashes", () => {
  const ui = readFileSync(new URL("./_cancel-notice.tsx", import.meta.url), "utf8");
  const actions = readFileSync(new URL("./cancel-notice-actions.ts", import.meta.url), "utf8");
  assert.ok(ui.includes("Interview cancelled, but the candidate notification failed."));
  assert.ok(
    ui.includes("Interview cancelled. The candidate has no email address, so they were not told."),
  );
  assert.ok(actions.includes(NOT_CONFIRMED));
  for (const text of [ui, actions]) {
    const strings = text.match(/"[^"\n]*"|>[^<>{}\n]+</g) ?? [];
    assert.deepEqual(
      strings.filter((x) => /[–—]/.test(x)),
      [],
    );
  }
});
