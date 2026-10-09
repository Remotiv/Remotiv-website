/**
 * The booking module where purpose matters: minting a link supersedes only
 * the live booking of the SAME purpose and scope, and a final-round slot
 * cannot be claimed without the recording acknowledgement.
 *
 *   node --test src/lib/calendar/bookings.test.ts
 */
// @ts-nocheck — same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../test-support/fake-service-client-hook.mjs", import.meta.url));

const { CO, APP, JOB, finalInterviewWorld, makeDb, writes } = await import(
  "../../test-support/final-interview-world.mjs"
);
const { claimSlot, createBookingLink } = await import("./bookings.ts");

const FUTURE = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

function booking(over) {
  return {
    id: over.id,
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
    purpose: "interview",
    final_interview_id: null,
    recording_notice_acknowledged_at: null,
    recording_notice_version: null,
    created_at: "2026-10-01T00:00:00.000Z",
    ...over,
  };
}

function world(rows) {
  const db = makeDb();
  db.interview_bookings.push(...rows);
  const service = finalInterviewWorld(db);
  globalThis.__fakeServiceClientForTests = () => service;
  return { db, service };
}

const liveQuery = (service) =>
  service.queries.find(
    (q) => q.table === "interview_bookings" && q.calls.some((c) => c[0] === "in"),
  );
const filters = (q) => q.calls.filter((c) => ["eq", "in"].includes(c[0]));

const common = {
  companyId: CO,
  applicationId: APP,
  jobId: JOB,
  invitedBy: "u-rec",
  invitedByName: "Rae",
  durationMinutes: 30,
};

/* ── the supersede rule, per purpose ────────────────────────────── */

test("a screening link looks only at screening rows for this application, and leaves a final booking alone", async () => {
  const { db, service } = world([
    booking({ id: "b-screen", purpose: "interview", status: "invited" }),
    booking({
      id: "b-final",
      purpose: "final",
      final_interview_id: "fi-1",
      status: "booked",
      scheduled_start: FUTURE,
    }),
  ]);
  const r = await createBookingLink({ ...common, purpose: "interview", hostMemberId: "m-rec" });
  assert.equal(r.ok, true);
  assert.deepEqual(filters(liveQuery(service)), [
    ["eq", "company_id", CO],
    ["eq", "purpose", "interview"],
    ["eq", "application_id", APP],
    ["in", "status", ["invited", "booked"]],
  ]);
  const by = Object.fromEntries(db.interview_bookings.map((b) => [b.id, b]));
  assert.equal(by["b-screen"].status, "expired", "the old screening link is superseded");
  assert.equal(by["b-final"].status, "booked", "the final booking is untouched");
  const inserted = writes(service, "interview_bookings").find((w) => w[0] === "insert")[1];
  assert.equal(inserted.purpose, "interview");
  assert.equal(inserted.final_interview_id, null);
  assert.equal(inserted.host_member_id, "m-rec");
  assert.equal(inserted.invited_by, "u-rec");
});

test("a final link looks only at this final interview's rows, and leaves the screening booking and other finals alone", async () => {
  const { db, service } = world([
    booking({ id: "b-screen", purpose: "interview", status: "booked", scheduled_start: FUTURE }),
    booking({ id: "b-fi1", purpose: "final", final_interview_id: "fi-1", status: "invited" }),
    booking({ id: "b-fi2", purpose: "final", final_interview_id: "fi-2", status: "invited" }),
  ]);
  const r = await createBookingLink({
    ...common,
    purpose: "final",
    hostMemberId: "m-host",
    finalInterviewId: "fi-1",
  });
  assert.equal(r.ok, true);
  assert.deepEqual(filters(liveQuery(service)), [
    ["eq", "company_id", CO],
    ["eq", "purpose", "final"],
    ["eq", "final_interview_id", "fi-1"],
    ["in", "status", ["invited", "booked"]],
  ]);
  const by = Object.fromEntries(db.interview_bookings.map((b) => [b.id, b]));
  assert.equal(by["b-screen"].status, "booked", "the screening booking is untouched");
  assert.equal(by["b-fi1"].status, "expired", "this final interview's old link is superseded");
  assert.equal(by["b-fi2"].status, "invited", "another final interview's link is untouched");
  const inserted = writes(service, "interview_bookings").find((w) => w[0] === "insert")[1];
  assert.equal(inserted.purpose, "final");
  assert.equal(inserted.final_interview_id, "fi-1");
  assert.equal(inserted.host_member_id, "m-host", "the chosen host, not the sender");
  assert.equal(inserted.invited_by, "u-rec", "the sender, recorded separately");
});

test("a booked row of the same purpose and scope is never superseded", async () => {
  const { db, service } = world([
    booking({
      id: "b-fi1",
      purpose: "final",
      final_interview_id: "fi-1",
      status: "booked",
      scheduled_start: FUTURE,
    }),
  ]);
  const r = await createBookingLink({
    ...common,
    purpose: "final",
    hostMemberId: "m-host",
    finalInterviewId: "fi-1",
  });
  assert.deepEqual(r, { ok: false, reason: "already_booked" });
  assert.equal(writes(service, "interview_bookings").length, 0, "nothing written");
  assert.equal(db.interview_bookings[0].status, "booked");
});

test("a final link without its final interview id is refused before any query", async () => {
  const { service } = world([]);
  const r = await createBookingLink({ ...common, purpose: "final", hostMemberId: "m-host" });
  assert.deepEqual(r, { ok: false, reason: "write_failed" });
  assert.equal(service.queries.length, 0);
});

/* ── the claim: acknowledgement for a final round ───────────────── */

const SLOT = {
  startMs: Date.parse(FUTURE),
  endMs: Date.parse(FUTURE) + 30 * 60 * 1000,
  candidateTimezone: "Asia/Karachi",
  hostTimezone: "Europe/London",
};

test("a final slot cannot be claimed without the acknowledgement; with it, both columns land in the booking update", async () => {
  const row = booking({ id: "b-fi1", purpose: "final", final_interview_id: "fi-1" });
  const refused = await claimSlot({ row, ...SLOT, recordingNotice: null });
  assert.deepEqual(refused, { ok: false, reason: "acknowledgement_required" });
  assert.equal(world([row]).service.queries.length, 0);

  const { service } = world([row]);
  const ok = await claimSlot({ row, ...SLOT, recordingNotice: { version: "v1" } });
  assert.equal(ok.ok, true);
  const update = writes(service, "interview_bookings").find((w) => w[0] === "update")[1];
  assert.equal(update.status, "booked");
  assert.equal(update.recording_notice_version, "v1");
  assert.equal(
    update.recording_notice_acknowledged_at,
    update.booked_at,
    "same instant, same write",
  );
});

test("a screening slot needs no acknowledgement and writes none", async () => {
  const row = booking({ id: "b-screen", purpose: "interview" });
  const { service } = world([row]);
  const ok = await claimSlot({ row, ...SLOT });
  assert.equal(ok.ok, true);
  const update = writes(service, "interview_bookings").find((w) => w[0] === "update")[1];
  assert.equal(update.status, "booked");
  assert.equal("recording_notice_version" in update, false);
  assert.equal("recording_notice_acknowledged_at" in update, false);
});
