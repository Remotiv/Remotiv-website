/**
 * #87 part 2: a recruiter whose final-interview link fails gets no bell about
 * their own failure, because the action shows them the error. A recruiter's
 * cancellation keeps their bell: that action reports success whatever the email
 * did, so the bell is their only sign. Everyone else who should be told still is.
 *
 *   node --test src/lib/calendar/notify-actor.test.ts
 *
 * Drives the real notify.ts, deliverEmail and the failure bell against a fake
 * database (fake-service-client-hook.mjs) that applies eq and in filters, and a
 * fake `fetch` standing in for Resend. Every outbound email is answered by that
 * stub: nothing leaves the machine.
 *
 * The actor is a membership id. ctx.memberId is company_members.id, read by
 * user_id (ai-dashboard/lib/company-access.ts:99-125), and the bell's
 * recipients are company_members.id and job_hiring_team.member_id
 * (notifications/company.ts:248-270), which the actor is compared against
 * (company.ts:357). The seed uses one id space for both, as production does.
 */
// @ts-nocheck - same reason as send-failure.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";
import { fakeService } from "../../test-support/fake-postgrest.mjs";

register(new URL("../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../test-support/fake-service-client-hook.mjs", import.meta.url));

const { sendCancellationNotices, sendFinalInterviewLinkEmail } = await import("./notify.ts");

const CO = "c0000000-0000-4000-8000-000000000001";
const OTHER_CO = "c0000000-0000-4000-8000-000000000002";
const JOB = "j0000000-0000-4000-8000-000000000001";
const APP = "a0000000-0000-4000-8000-000000000001";

/** The acting recruiter, on this job's hiring team. */
const ACTOR = "m-actor";
const MEMBERS = [
  { id: "m-owner", company_id: CO, role: "owner" },
  { id: "m-admin", company_id: CO, role: "admin" },
  { id: ACTOR, company_id: CO, role: "recruiter" },
  { id: "m-off-team", company_id: CO, role: "recruiter" },
  { id: "x-owner", company_id: OTHER_CO, role: "owner" },
];
const TEAM = [{ job_id: JOB, member_id: ACTOR, company_id: CO }];

const applies = (row, calls) =>
  calls.every(([m, col, val]) => {
    if (m === "eq") return row[col] === undefined || row[col] === val;
    if (m === "in") return row[col] === undefined || val.includes(row[col]);
    return true;
  });

/** The database: bells are stored, the log row is written, members are filtered. */
function world() {
  const bells = [];
  const logs = [];
  const service = fakeService((table, calls) => {
    const has = (m) => calls.some((c) => c[0] === m);
    switch (table) {
      case "communication_logs": {
        if (calls.find((c) => c[0] === "select")?.[2]?.head) {
          return { data: null, count: 0, error: null }; // the daily cap
        }
        const ins = calls.find((c) => c[0] === "insert");
        if (ins) {
          const row = { id: `log-${logs.length + 1}`, ...ins[1] };
          logs.push(row);
          return { data: { id: row.id }, error: null };
        }
        const upd = calls.find((c) => c[0] === "update");
        if (upd) {
          const id = calls.find((c) => c[0] === "eq" && c[1] === "id")?.[2];
          const row = logs.find((r) => r.id === id);
          if (row) Object.assign(row, upd[1]);
          return { data: has("select") && row ? [{ id }] : null, error: null };
        }
        return { data: null, error: null };
      }
      case "job_applications":
        return {
          data: applies({ id: APP, company_id_snapshot: CO }, calls) ? { job_id: JOB } : null,
          error: null,
        };
      case "company_members":
        return { data: MEMBERS.filter((m) => applies(m, calls)), error: null };
      case "job_hiring_team":
        return { data: TEAM.filter((t) => applies(t, calls)), error: null };
      case "notifications_company": {
        const row = calls.find((c) => c[0] === "insert")[1];
        if (bells.some((b) => b.id === row.id)) {
          return { data: null, error: { code: "23505", message: "duplicate key value" } };
        }
        bells.push(row);
        return { data: row, error: null };
      }
      default:
        throw new Error(`test: unexpected table ${table}`);
    }
  });
  return { service, bells, logs };
}

/** Run with Resend refusing or accepting. Every outbound request is recorded, none sent. */
async function run(send, { resend }) {
  const w = world();
  const outbound = [];
  const saved = {
    fetch: globalThis.fetch,
    key: process.env.RESEND_API_KEY,
    log: console.log,
    error: console.error,
    warn: console.warn,
  };
  globalThis.__fakeServiceClientForTests = () => w.service;
  process.env.RESEND_API_KEY = "re_test_key";
  globalThis.fetch = async (url) => {
    outbound.push(String(url));
    return resend === "refuses"
      ? new Response(
          JSON.stringify({ statusCode: 422, name: "validation_error", message: "Invalid `to`" }),
          { status: 422, headers: { "content-type": "application/json" } },
        )
      : new Response(JSON.stringify({ id: "re_sent_1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
  };
  console.log = () => {};
  console.error = () => {};
  console.warn = () => {};
  try {
    const result = await send();
    return { ...w, result, outbound };
  } finally {
    delete globalThis.__fakeServiceClientForTests;
    globalThis.fetch = saved.fetch;
    if (saved.key === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = saved.key;
    Object.assign(console, { log: saved.log, error: saved.error, warn: saved.warn });
  }
}

const bellsFor = (bells, memberId) => bells.filter((b) => b.member_id === memberId).length;

const ROW = {
  id: "booking-1",
  company_id: CO,
  application_id: APP,
  job_id: JOB,
  host_member_id: "m-admin",
  duration_minutes: 30,
  status: "cancelled",
  scheduled_start: "2026-12-01T10:00:00.000Z",
  scheduled_end: "2026-12-01T10:30:00.000Z",
  candidate_timezone: "Europe/London",
  host_timezone: "Europe/London",
  meeting_mode: "google_meet",
  meeting_url: null,
  provider_event_id: null,
  provider: null,
  expires_at: null,
  cancelled_at: "2026-11-20T09:00:00.000Z",
};

const cancellation = (actorMemberId) => () =>
  sendCancellationNotices({
    row: ROW,
    startMs: Date.parse(ROW.scheduled_start),
    hostTimezone: "Europe/London",
    candidateTimezone: "Europe/London",
    candidateEmail: "candidate@example.test",
    candidateName: "Test Candidate",
    hostEmail: "host@example.test",
    hostName: "Host",
    jobTitle: "Engineer",
    companyName: "Acme",
    meetingUrl: null,
    cancelledBy: "recruiter",
    reason: null,
    removedFromCalendar: true,
    actorMemberId,
  });

const finalLink = (actorMemberId) => () =>
  sendFinalInterviewLinkEmail({
    companyId: CO,
    applicationId: APP,
    to: "candidate@example.test",
    candidateFirstName: "Test",
    interviewLabel: "Final interview",
    jobTitle: "Engineer",
    companyName: "Acme",
    durationMinutes: 45,
    url: "https://remotiv.work/book/token-not-real",
    sentByName: "Host",
    actorMemberId,
  });

/* ── a real delivery failure ──────────────────────────────────── */

// Negative control: drop actorMemberId from the deliverEmail call and the actor gets a bell.
test("a final-interview link that Resend refuses: the actor gets no bell, the rest of the team one each, the other company none", async () => {
  const r = await run(finalLink(ACTOR), { resend: "refuses" });
  assert.equal(r.result.ok, false, "the action is told, and shows the error");
  assert.ok(
    r.outbound.length > 0 && r.outbound.every((u) => u.includes("resend")),
    "Resend was called, and only the stub",
  );
  assert.ok(
    r.logs.some((l) => l.status === "failed"),
    "the delivery really failed",
  );
  assert.equal(bellsFor(r.bells, ACTOR), 0, "the actor saw it on screen");
  assert.equal(bellsFor(r.bells, "m-owner"), 1);
  assert.equal(bellsFor(r.bells, "m-admin"), 1);
  assert.equal(bellsFor(r.bells, "m-off-team"), 0, "a recruiter off the job's team is not told");
  assert.equal(bellsFor(r.bells, "x-owner"), 0, "another company is never told");
});

/*
 * The recruiter cancellations pass null, so the canceller's bell stays: the
 * cancel UI reports success whatever the email did. Negative control: pass
 * ctx.memberId again and the caller test below fails.
 */
test("a recruiter cancellation that Resend refuses: the canceller still gets a bell, the team too, the other company none", async () => {
  const r = await run(cancellation(null), { resend: "refuses" });
  assert.equal(r.result.candidate, "failed", "the delivery really failed");
  assert.ok(r.outbound.length > 0 && r.outbound.every((u) => u.includes("resend")));
  assert.deepEqual(
    [ACTOR, "m-owner", "m-admin", "m-off-team", "x-owner"].map((m) => bellsFor(r.bells, m)),
    [1, 1, 1, 0, 0],
  );
});

/* ── the candidate's own booking page: unchanged ──────────────── */

test("a candidate-side failure (no actor) still tells everyone who should know, the recruiter included", async () => {
  const r = await run(cancellation(null), { resend: "refuses" });
  assert.equal(r.result.candidate, "failed");
  assert.deepEqual(
    [ACTOR, "m-owner", "m-admin", "m-off-team", "x-owner"].map((m) => bellsFor(r.bells, m)),
    [1, 1, 1, 0, 0],
  );
});

/* ── success is unaffected ────────────────────────────────────── */

test("a successful send rings no bell and is recorded sent, with or without an actor", async () => {
  for (const actor of [ACTOR, null]) {
    const r = await run(cancellation(actor), { resend: "accepts" });
    assert.equal(r.result.candidate, "sent");
    assert.ok(r.logs.some((l) => l.status === "sent"));
    assert.equal(r.bells.length, 0);
  }
  const link = await run(finalLink(ACTOR), { resend: "accepts" });
  assert.deepEqual(link.result, { ok: true });
  assert.equal(link.bells.length, 0);
});

/* ── the callers pass the right actor ─────────────────────────── */

// Negative control: remove one caller's actorMemberId and the count below is short.
test("the final link passes ctx.memberId, both recruiter cancellations and the candidate's booking route pass null", () => {
  const src = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
  const dashboard =
    src("../../app/ai-dashboard/(gated)/applicants/booking-actions.ts") +
    src("../../app/ai-dashboard/(gated)/applicants/final-interview-actions.ts");
  const call = (fn) =>
    dashboard.match(new RegExp(`await ${fn}\\(\\{[\\s\\S]*?\\n\\s*\\}\\);`, "g")) ?? [];
  const links = call("sendFinalInterviewLinkEmail");
  assert.equal(links.length, 1);
  assert.match(links[0], /actorMemberId: ctx\.memberId,/);
  const cancels = call("sendCancellationNotices");
  assert.equal(cancels.length, 2, "cancelBookingAsRecruiter and cancelFinalInterview");
  for (const c of cancels) {
    assert.match(c, /actorMemberId: null,/);
    assert.ok(!/ctx\.memberId/.test(c.match(/actorMemberId:[^\n]*/)[0]));
  }

  const route = src("../../app/api/book/[token]/route.ts").match(
    /await send(BookingConfirmations|RescheduleNotices|CancellationNotices)\(\{[\s\S]*?\n {2}\}\);/g,
  );
  assert.equal(route.length, 3);
  for (const c of route) assert.match(c, /actorMemberId: null,/, c.slice(0, 60));
});
