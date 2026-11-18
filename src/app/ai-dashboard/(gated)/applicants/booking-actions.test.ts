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

async function run(role, act, db, { canAccessJob } = {}) {
  const service = finalInterviewWorld(db);
  globalThis.__fiServiceForTests = () => service;
  globalThis.__fiCtxForTests = ctxFor(role);
  globalThis.__fiCanAccessJob = canAccessJob;
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
      tables: service.queries.map((q) => q.table),
      emails: globalThis.__fiEmails,
      hostEmails: globalThis.__fiHostEmails,
      bell: globalThis.__fiBell,
    };
  } finally {
    console.error = quiet;
  }
}

test("an application drifted to another company is refused before the booking is read: nothing cancelled, nothing leaked (#59b)", async () => {
  const db = makeDb();
  db.interview_bookings.push(screeningBooking({}));
  // The state a company filter defends against: the booking is this company's,
  // but its application is not. Before #59b this cancelled anyway and only the
  // notice read was filtered; now the application is the first thing checked.
  db.job_applications[0].company_id_snapshot = "other-co";

  const {
    result,
    db: after,
    emails,
    hostEmails,
    bell,
    tables,
  } = await run("admin", () => cancelBookingAsRecruiter(APP, "Role filled"), db);

  assert.deepEqual(result, { success: false, error: NOT_YOURS });
  assert.equal(after.interview_bookings[0].status, "booked");
  assert.ok(!tables.includes("interview_bookings"), "the booking is never read");
  const sent = JSON.stringify({ emails, hostEmails, bell });
  assert.equal(sent, JSON.stringify({ emails: [], hostEmails: [], bell: [] }));
});

/* ── #59b: scope is checked before anything is said about a booking ─────── */

const NOT_YOURS = "Applicant not found in your workspace.";
const outOfScope = { canAccessJob: () => false };

test("59b-1. a recruiter outside the job gets the SAME reply with and without a booking, and the booking is never read", async () => {
  const withBooking = makeDb();
  withBooking.interview_bookings.push(screeningBooking({}));
  const a = await run("recruiter", () => cancelBookingAsRecruiter(APP), withBooking, outOfScope);
  const b = await run("recruiter", () => cancelBookingAsRecruiter(APP), makeDb(), outOfScope);
  assert.deepEqual(a.result, { success: false, error: NOT_YOURS });
  assert.deepEqual(b.result, a.result, "identical with and without a booking");
  assert.deepEqual(a.tables, b.tables, "and the same reads, so timing tells nothing either");
  assert.ok(!a.tables.includes("interview_bookings"));
  assert.equal(a.db.interview_bookings[0].status, "booked");
  assert.equal(a.emails.length + a.hostEmails.length + a.bell.length, 0);
});

test("59b-2. another company's applicant, or none at all: the same reply, with and without a booking", async () => {
  const replies = [];
  for (const booked of [true, false]) {
    for (const app of ["other-company", "missing"]) {
      const db = makeDb();
      if (booked) db.interview_bookings.push(screeningBooking({}));
      if (app === "other-company") db.job_applications[0].company_id_snapshot = "other-co";
      else db.job_applications.length = 0;
      const r = await run("admin", () => cancelBookingAsRecruiter(APP), db);
      replies.push(r.result);
      assert.ok(!r.tables.includes("interview_bookings"));
    }
  }
  for (const r of replies) assert.deepEqual(r, { success: false, error: NOT_YOURS });
});

test("59b-3. in scope and nothing booked: still told there is no booked interview", async () => {
  const r = await run("recruiter", () => cancelBookingAsRecruiter(APP), makeDb(), {
    canAccessJob: (_ctx, jobId) => jobId === JOB,
  });
  assert.deepEqual(r.result, { success: false, error: "There's no booked interview to cancel." });
});

test("59b-4. in scope with a booking: cancels as before", async () => {
  const db = makeDb();
  db.interview_bookings.push(screeningBooking({}));
  const r = await run("recruiter", () => cancelBookingAsRecruiter(APP), db, {
    canAccessJob: (_ctx, jobId) => jobId === JOB,
  });
  assert.equal(r.result.success, true);
  assert.equal(r.db.interview_bookings[0].status, "cancelled");
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
