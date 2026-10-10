/**
 * Recruiter-side booking cancellation, run as shipped against a fake team.
 *
 *   node --test "src/app/ai-dashboard/(gated)/applicants/booking-actions.test.ts"
 *
 * The action, the booking module and the notice builders are the real code.
 * The database, the session, the email path and the bell are fakes, reusing
 * the Final Human Interview world because it already models job_applications
 * and interview_bookings and honours eq() on every column these queries use.
 *
 * The pair below is the point: the drifted case proves the company filter
 * blocks another company's candidate, and the clean case proves it does not
 * block this company's. A mistyped column would pass the first alone.
 */
// @ts-nocheck — same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../../../test-support/final-interview-test-hook.mjs", import.meta.url));

const { APP, CO, JOB, finalInterviewWorld, makeDb } = await import(
  "../../../../test-support/final-interview-world.mjs"
);
const { cancelBookingAsRecruiter } = await import("./booking-actions.ts");

const FUTURE = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

const ctxFor = (role) => ({
  companyId: CO,
  role,
  memberId: "m-rec",
  memberName: "Rae Recruiter",
  user: { id: "u-rec", email: "rae@acme.test" },
  company: { name: "Acme", contact_name: "Olive Owner" },
});

/** A booked screening call: purpose "interview", so no final interview backs it. */
const screeningBooking = (over) => ({
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

async function run(role, act, db) {
  const service = finalInterviewWorld(db);
  globalThis.__fiServiceForTests = () => service;
  globalThis.__fiCtxForTests = ctxFor(role);
  globalThis.__fiCanAccessJob = undefined;
  globalThis.__fiDeliverResult = undefined;
  globalThis.__fiEmails = [];
  globalThis.__fiHostEmails = [];
  globalThis.__fiBell = [];
  const quiet = console.error;
  console.error = () => {};
  try {
    const result = await act();
    return {
      result,
      db,
      emails: globalThis.__fiEmails,
      hostEmails: globalThis.__fiHostEmails,
      bell: globalThis.__fiBell,
    };
  } finally {
    console.error = quiet;
  }
}

test("cancelling reads the candidate through the company filter: a drifted application leaks nothing", async () => {
  const db = makeDb();
  db.interview_bookings.push(screeningBooking({}));
  // The state the filter defends against: the booking is this company's, but
  // its application is not. For purpose = "interview" rows nothing in the
  // database forbids this, which is exactly why the read must filter.
  db.job_applications[0].company_id_snapshot = "other-co";

  const {
    result,
    db: after,
    emails,
    hostEmails,
    bell,
  } = await run("admin", () => cancelBookingAsRecruiter(APP, "Role filled"), db);

  // The cancellation still completes. The filter protects the read, not the
  // write, and the booking is already cancelled by the time it is consulted.
  assert.equal(result.success, true);
  assert.equal(after.interview_bookings[0].status, "cancelled");
  assert.equal(after.interview_bookings[0].cancelled_by, "recruiter");
  assert.equal(after.interview_bookings[0].cancel_reason, "Role filled");

  const sent = JSON.stringify({ emails, hostEmails, bell });
  assert.ok(!sent.includes("sam@example.test"), "another company's email address reached a notice");
  assert.ok(!sent.includes("Sam"), "another company's candidate name reached a notice");
  assert.ok(!sent.includes("Engineer"), "another company's job title reached a notice");
});

test("cancelling a booking in this company still names the candidate", async () => {
  const db = makeDb();
  db.interview_bookings.push(screeningBooking({}));

  const {
    result,
    db: after,
    emails,
    bell,
  } = await run("recruiter", () => cancelBookingAsRecruiter(APP, "Role filled"), db);

  assert.equal(result.success, true);
  assert.equal(after.interview_bookings[0].status, "cancelled");
  const sent = JSON.stringify({ emails, bell });
  assert.ok(sent.includes("sam@example.test"), "the candidate's own notice lost their address");
  assert.ok(sent.includes("Sam"), "the candidate's own notice lost their name");
  assert.ok(sent.includes("Engineer"), "the candidate's own notice lost the job title");
});

test("a hiring manager cannot cancel: refused before any query", async () => {
  const db = makeDb();
  db.interview_bookings.push(screeningBooking({}));
  const {
    result,
    db: after,
    emails,
  } = await run("hiring_manager", () => cancelBookingAsRecruiter(APP), db);
  assert.equal(result.success, false);
  assert.match(result.error, /owner, admin or recruiter/);
  assert.equal(after.interview_bookings[0].status, "booked");
  assert.equal(emails.length, 0);
});
