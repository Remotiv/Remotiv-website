/**
 * The Final Human Interview actions, run as shipped against a fake team.
 *
 *   node --test "src/app/ai-dashboard/(gated)/applicants/final-interview-actions.test.ts"
 *
 * The actions, the booking module, the eligibility rules and the notice
 * builders are the real code. The database, the session, the email path and
 * the bell are fakes (final-interview-test-hook.mjs). Every write the actions
 * make is recorded, so the tests assert what reached the database and what
 * did not.
 */
// @ts-nocheck — same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../../../test-support/final-interview-test-hook.mjs", import.meta.url));

const { APP, CO, JOB, finalInterviewWorld, makeDb, writes } = await import(
  "../../../../test-support/final-interview-world.mjs"
);
const { HOST_NEEDS_CALENDAR, NOT_A_BOOKING_ROLE, recordingNoticeText } = await import(
  "../../../../lib/final-interviews/constants.ts"
);
const {
  cancelFinalInterview,
  getFinalInterviewOptions,
  listFinalInterviews,
  resendFinalInterviewLink,
  scheduleFinalInterview,
} = await import("./final-interview-actions.ts");

const FUTURE = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

const ctxFor = (role) => ({
  companyId: CO,
  role,
  memberId: "m-rec",
  memberName: "Rae Recruiter",
  user: { id: "u-rec", email: "rae@acme.test" },
  company: { name: "Acme", contact_name: "Olive Owner" },
});

/** Run one action as `role` against `db`, with every side effect recorded. */
async function run(
  role,
  act,
  { db = makeDb(), deliver = undefined, canAccessJob = undefined } = {},
) {
  const service = finalInterviewWorld(db);
  globalThis.__fiServiceForTests = () => service;
  globalThis.__fiCtxForTests = ctxFor(role);
  globalThis.__fiCanAccessJob = canAccessJob;
  globalThis.__fiDeliverResult = deliver;
  globalThis.__fiEmails = [];
  globalThis.__fiHostEmails = [];
  globalThis.__fiBell = [];
  const quiet = console.error;
  console.error = () => {};
  try {
    const result = await act();
    return {
      result,
      service,
      db,
      emails: globalThis.__fiEmails,
      hostEmails: globalThis.__fiHostEmails,
      bell: globalThis.__fiBell,
    };
  } finally {
    console.error = quiet;
  }
}

const VALID = {
  applicationId: APP,
  interviewType: "cto",
  hostMemberId: "m-host",
  interviewerMemberIds: ["m-team"],
  durationMinutes: 45,
};

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

const finalBooking = (over) => ({
  id: "b-fi1",
  company_id: CO,
  application_id: APP,
  job_id: JOB,
  host_member_id: "m-host",
  duration_minutes: 30,
  status: "invited",
  scheduled_start: null,
  scheduled_end: null,
  candidate_timezone: null,
  host_timezone: null,
  meeting_mode: "auto",
  meeting_url: null,
  provider_event_id: null,
  provider: null,
  expires_at: FUTURE,
  cancelled_at: null,
  booked_at: null,
  cancelled_by: null,
  cancel_reason: null,
  purpose: "final",
  final_interview_id: "fi-1",
  recording_notice_acknowledged_at: null,
  recording_notice_version: null,
  created_at: "2026-10-02T00:00:00.000Z",
  ...over,
});

const allWrites = (service) =>
  service.queries.flatMap((q) =>
    q.calls.filter((c) => ["insert", "update", "delete"].includes(c[0])),
  );

/* ── roles ──────────────────────────────────────────────────────── */

test("a hiring manager cannot schedule, resend or cancel: refused before any query", async () => {
  for (const act of [
    () => scheduleFinalInterview(VALID),
    () => resendFinalInterviewLink("fi-1"),
    () => cancelFinalInterview("fi-1"),
  ]) {
    const { result, service, emails } = await run("hiring_manager", act);
    assert.deepEqual(result, { success: false, error: NOT_A_BOOKING_ROLE });
    assert.equal(service.queries.length, 0);
    assert.equal(emails.length, 0);
  }
});

test("a hiring manager on the job may still read the options and the list", async () => {
  const db = makeDb();
  db.final_interviews.push({ ...FI });
  const options = await run("hiring_manager", () => getFinalInterviewOptions(APP), { db });
  assert.equal(options.result.success, true);
  assert.deepEqual(options.result.data.hosts.map((h) => h.memberId).sort(), [
    "m-admin",
    "m-hm",
    "m-host",
    "m-owner",
    "m-team",
  ]);
  const list = await run("hiring_manager", () => listFinalInterviews(APP), { db });
  assert.equal(list.result.success, true);
  assert.equal(list.result.data[0].label, "CTO interview");
  assert.equal(list.result.data[0].booking.state, "not_sent");
});

test("an applicant outside the viewer's jobs is not found, for reads and writes alike", async () => {
  for (const act of [
    () => scheduleFinalInterview(VALID),
    () => getFinalInterviewOptions(APP),
    () => listFinalInterviews(APP),
  ]) {
    const { result, service } = await run("recruiter", act, { canAccessJob: async () => false });
    assert.deepEqual(result, { success: false, error: "Applicant not found in your workspace." });
    assert.equal(allWrites(service).length, 0);
  }
});

/* ── scheduling ─────────────────────────────────────────────────── */

test("scheduling writes the interview, its interviewers and a final-round link, then emails the candidate", async () => {
  const { result, service, db, emails, bell } = await run("recruiter", () =>
    scheduleFinalInterview(VALID),
  );
  assert.equal(result.success, true, result.error);

  const fi = writes(service, "final_interviews").find((w) => w[0] === "insert")[1];
  assert.deepEqual(fi, {
    company_id: CO,
    job_id: JOB,
    application_id: APP,
    interview_type: "cto",
    custom_label: null,
    host_member_id: "m-host",
    status: "active",
    created_by: "u-rec",
    created_by_name: "Rae Recruiter",
  });
  const extra = writes(service, "final_interview_interviewers").find((w) => w[0] === "insert")[1];
  assert.deepEqual(extra, [
    {
      final_interview_id: result.data.finalInterviewId,
      company_id: CO,
      member_id: "m-team",
      added_by: "u-rec",
    },
  ]);
  const link = writes(service, "interview_bookings").find((w) => w[0] === "insert")[1];
  assert.equal(link.purpose, "final");
  assert.equal(link.final_interview_id, result.data.finalInterviewId);
  assert.equal(link.host_member_id, "m-host", "the chosen host's calendar");
  assert.equal(link.invited_by, "u-rec", "sent by the recruiter");
  assert.equal(link.duration_minutes, 45);
  assert.equal(link.status, "invited");
  assert.equal(db.interview_bookings.length, 1);

  assert.equal(emails.length, 1);
  const [email] = emails;
  assert.equal(email.event, "booking_link");
  assert.equal(email.to, "sam@example.test");
  assert.equal(email.subject, "CTO interview with Acme");
  assert.equal(email.sentByName, "Hana Host", "named sender: outside the automatic-send index");
  assert.match(email.html, /\/book\//);
  // The apostrophe in "Acme's" is HTML-escaped, so the notice is matched in two
  // halves either side of it.
  const [before, after] = recordingNoticeText("Acme").split("Acme's");
  assert.ok(
    email.html.includes(before) && email.html.includes(after),
    "the notice is in the email",
  );
  assert.doesNotMatch(email.html, /—/);
  assert.equal(bell.length, 0, "no notification for sending a link");

  // Nothing here moves a candidate.
  assert.ok(!JSON.stringify(allWrites(service)).includes("pipeline_stage"));
});

test("durations: 30, 45 and 60 are accepted, 20 and 90 refused with nothing written", async () => {
  for (const d of [30, 45, 60]) {
    const { result } = await run("owner", () =>
      scheduleFinalInterview({ ...VALID, durationMinutes: d }),
    );
    assert.equal(result.success, true, `${d}: ${result.error}`);
  }
  for (const d of [20, 90]) {
    const { result, service } = await run("owner", () =>
      scheduleFinalInterview({ ...VALID, durationMinutes: d }),
    );
    assert.deepEqual(result, {
      success: false,
      error: "Final interviews are 30, 45 or 60 minutes.",
    });
    assert.equal(allWrites(service).length, 0);
  }
  const { result } = await run("owner", () =>
    scheduleFinalInterview({ ...VALID, durationMinutes: undefined }),
  );
  assert.equal(result.success, true, "defaults to 60");
});

test("a custom type needs a 1 to 80 character name; no other type takes one", async () => {
  const noName = await run("admin", () =>
    scheduleFinalInterview({ ...VALID, interviewType: "custom" }),
  );
  assert.match(noName.result.error, /Give the custom interview a name \(1 to 80 characters\)/);
  const tooLong = await run("admin", () =>
    scheduleFinalInterview({ ...VALID, interviewType: "custom", customLabel: "x".repeat(81) }),
  );
  assert.equal(tooLong.result.success, false);
  const wrongPlace = await run("admin", () =>
    scheduleFinalInterview({ ...VALID, customLabel: "Founder chat" }),
  );
  assert.deepEqual(wrongPlace.result, {
    success: false,
    error: "Only a custom interview takes a name.",
  });
  for (const r of [noName, tooLong, wrongPlace]) assert.equal(allWrites(r.service).length, 0);

  const ok = await run("admin", () =>
    scheduleFinalInterview({ ...VALID, interviewType: "custom", customLabel: "  Founder chat " }),
  );
  assert.equal(ok.result.success, true, ok.result.error);
  assert.equal(writes(ok.service, "final_interviews")[0][1].custom_label, "Founder chat");
  assert.equal(ok.emails[0].subject, "Founder chat with Acme");
});

test("the host must be on the team or owner/admin, active, and have a calendar", async () => {
  const cases = [
    ["m-team", HOST_NEEDS_CALENDAR, "on the team, no calendar"],
    ["m-admin", HOST_NEEDS_CALENDAR, "admin, no calendar"],
    [
      "m-off",
      /active member of this job's hiring team, or an owner or admin/,
      "calendar, off the team",
    ],
    ["m-gone", /active member/, "removed"],
    ["o-1", /active member/, "another company"],
    ["nobody", /active member/, "unknown"],
  ];
  for (const [host, expected, label] of cases) {
    const { result, service } = await run("recruiter", () =>
      scheduleFinalInterview({ ...VALID, hostMemberId: host, interviewerMemberIds: [] }),
    );
    assert.equal(result.success, false, label);
    if (typeof expected === "string") assert.equal(result.error, expected, label);
    else assert.match(result.error, expected, label);
    assert.equal(allWrites(service).length, 0, label);
  }
  // The owner hosts without being on the team: calendar connected.
  const owner = await run("recruiter", () =>
    scheduleFinalInterview({ ...VALID, hostMemberId: "m-owner", interviewerMemberIds: [] }),
  );
  assert.equal(owner.result.success, true, owner.result.error);
  assert.equal(
    owner.emails[0].sentByName,
    "owner@acme.test",
    "the owner's resolved address stands in for a name",
  );
});

test("interviewers: the host is dropped, duplicates collapse, no calendar needed, six refused", async () => {
  const { result, service } = await run("recruiter", () =>
    scheduleFinalInterview({
      ...VALID,
      interviewerMemberIds: ["m-team", "m-host", "m-team", "m-hm", "m-admin"],
    }),
  );
  assert.equal(result.success, true, result.error);
  assert.deepEqual(
    writes(service, "final_interview_interviewers")[0][1].map((r) => r.member_id),
    ["m-team", "m-hm", "m-admin"],
  );
  const six = await run("recruiter", () =>
    scheduleFinalInterview({
      ...VALID,
      interviewerMemberIds: ["m-team", "m-hm", "m-admin", "m-owner", "x-1", "x-2"],
    }),
  );
  assert.equal(six.result.success, false);
  assert.equal(allWrites(six.service).length, 0);
  const stranger = await run("recruiter", () =>
    scheduleFinalInterview({ ...VALID, interviewerMemberIds: ["m-off"] }),
  );
  assert.match(stranger.result.error, /active member of this job's hiring team/);
});

test("a failed email keeps the interview, deletes the unsent link, and says to resend", async () => {
  const { result, db, service } = await run("recruiter", () => scheduleFinalInterview(VALID), {
    deliver: {
      ok: false,
      kind: "provider",
      message: "The email provider rejected the message.",
      logId: null,
    },
  });
  assert.equal(result.success, false);
  assert.match(
    result.error,
    /created, but the link could not be sent: The email provider rejected the message\. Use Resend link/,
  );
  assert.equal(db.final_interviews.length, 1, "the interview stays");
  assert.equal(db.interview_bookings.length, 0, "the unsent link is gone");
  const del = writes(service, "interview_bookings").find((w) => w[0] === "delete");
  assert.ok(del, "the orphan row was deleted, not left live");
});

/* ── resend ─────────────────────────────────────────────────────── */

test("resend supersedes this interview's live link only, keeps its duration, and mints a new one", async () => {
  const db = makeDb();
  db.final_interviews.push({ ...FI }, { ...FI, id: "fi-2" });
  db.interview_bookings.push(
    finalBooking({ id: "b-old", duration_minutes: 30 }),
    finalBooking({ id: "b-other", final_interview_id: "fi-2" }),
    finalBooking({
      id: "b-screen",
      purpose: "interview",
      final_interview_id: null,
      status: "booked",
      scheduled_start: FUTURE,
    }),
  );
  const {
    result,
    db: after,
    emails,
  } = await run("recruiter", () => resendFinalInterviewLink("fi-1"), { db });
  assert.equal(result.success, true, result.error);
  const by = Object.fromEntries(after.interview_bookings.map((b) => [b.id, b]));
  assert.equal(by["b-old"].status, "expired");
  assert.equal(by["b-other"].status, "invited", "another final interview's link is untouched");
  assert.equal(by["b-screen"].status, "booked", "the screening booking is untouched");
  const fresh = after.interview_bookings.find(
    (b) => !["b-old", "b-other", "b-screen"].includes(b.id),
  );
  assert.equal(fresh.duration_minutes, 30, "same length as before");
  assert.equal(fresh.final_interview_id, "fi-1");
  assert.equal(emails.length, 1);
});

test("resend is refused once the interview is cancelled, or once the candidate has booked", async () => {
  const cancelled = makeDb();
  cancelled.final_interviews.push({ ...FI, status: "cancelled", cancelled_at: FUTURE });
  const a = await run("recruiter", () => resendFinalInterviewLink("fi-1"), { db: cancelled });
  assert.match(a.result.error, /no longer open/);
  assert.equal(allWrites(a.service).length, 0);

  const booked = makeDb();
  booked.final_interviews.push({ ...FI });
  booked.interview_bookings.push(finalBooking({ status: "booked", scheduled_start: FUTURE }));
  const b = await run("recruiter", () => resendFinalInterviewLink("fi-1"), { db: booked });
  assert.match(b.result.error, /already booked this interview\. Cancel it to send a new link/);
  assert.equal(allWrites(b.service).length, 0);
});

/* ── cancel ─────────────────────────────────────────────────────── */

test("cancelling a booked final round cancels the booking, marks the interview, and tells both sides with the type label", async () => {
  const db = makeDb();
  db.final_interviews.push({ ...FI });
  db.interview_bookings.push(
    finalBooking({
      status: "booked",
      scheduled_start: FUTURE,
      scheduled_end: new Date(Date.parse(FUTURE) + 30 * 60 * 1000).toISOString(),
      host_timezone: "Europe/London",
      candidate_timezone: "Asia/Karachi",
    }),
  );
  const {
    result,
    db: after,
    emails,
    hostEmails,
    bell,
  } = await run("admin", () => cancelFinalInterview("fi-1", "Role filled"), { db });
  assert.deepEqual(result, { success: true, data: { removedFromCalendar: true } });
  assert.equal(after.interview_bookings[0].status, "cancelled");
  assert.equal(after.interview_bookings[0].cancelled_by, "recruiter");
  assert.equal(after.interview_bookings[0].cancel_reason, "Role filled");
  assert.equal(after.final_interviews[0].status, "cancelled");
  assert.ok(after.final_interviews[0].cancelled_at);
  assert.equal(emails[0].event, "booking_cancelled");
  assert.equal(emails[0].subject, "CTO interview cancelled - Engineer");
  assert.equal(emails[0].sentByName, "Hana Host");
  assert.match(emails[0].html, /cancelled your\s+CTO interview at Acme/);
  assert.match(hostEmails[0].subject, /^CTO interview cancelled - Engineer$/);
  assert.equal(bell[0].type, "interview_cancelled");
  assert.match(bell[0].title, /Sam Lee's cto interview was cancelled/);
});

test("cancelling an unbooked final round expires its link and marks the interview, with no emails", async () => {
  const db = makeDb();
  db.final_interviews.push({ ...FI });
  db.interview_bookings.push(finalBooking({}));
  const {
    result,
    db: after,
    emails,
    bell,
  } = await run("recruiter", () => cancelFinalInterview("fi-1"), {
    db,
  });
  assert.deepEqual(result, { success: true, data: { removedFromCalendar: null } });
  assert.equal(after.interview_bookings[0].status, "expired");
  assert.equal(after.final_interviews[0].status, "cancelled");
  assert.equal(emails.length, 0);
  assert.equal(bell.length, 0);
});

test("the list derives each interview's state from its newest booking", async () => {
  const db = makeDb();
  db.final_interviews.push(
    { ...FI },
    { ...FI, id: "fi-2", interview_type: "custom", custom_label: "Founder chat" },
  );
  db.interview_bookings.push(
    finalBooking({ id: "b-1", status: "expired", created_at: "2026-10-02T00:00:00.000Z" }),
    finalBooking({
      id: "b-2",
      status: "booked",
      scheduled_start: FUTURE,
      meeting_url: "https://meet.google.com/abc",
      created_at: "2026-10-03T00:00:00.000Z",
    }),
  );
  db.final_interview_interviewers.push({
    final_interview_id: "fi-1",
    company_id: CO,
    member_id: "m-team",
  });
  const { result } = await run("recruiter", () => listFinalInterviews(APP), { db });
  assert.equal(result.success, true);
  const by = Object.fromEntries(result.data.map((v) => [v.id, v]));
  assert.equal(by["fi-1"].booking.state, "booked", "the newest booking wins");
  assert.equal(by["fi-1"].booking.meetingUrl, "https://meet.google.com/abc");
  assert.deepEqual(by["fi-1"].host, { memberId: "m-host", name: "Hana Host" });
  assert.deepEqual(by["fi-1"].interviewers, [{ memberId: "m-team", name: "Tom Team" }]);
  assert.equal(by["fi-2"].label, "Founder chat");
  assert.equal(by["fi-2"].booking.state, "not_sent");
  assert.ok(!("token_hash" in by["fi-1"].booking), "no token ever leaves the server");
});
