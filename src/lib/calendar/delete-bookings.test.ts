/**
 * #61: before an applicant is deleted, their upcoming screening calls are
 * cancelled, Google Calendar first and silently; a calendar that does not
 * confirm stops the delete with nothing changed. cancelScreeningBookingsForDeletion
 * runs as shipped against the Final Human Interview fake database; the
 * calendar provider and the token seam are fakes that record their calls.
 *
 *   node --test src/lib/calendar/delete-bookings.test.ts
 *
 * Synthetic data only. Nothing leaves the machine.
 */
// @ts-nocheck - same reason as the other node:test files: Node's `.ts`
// specifier vs this tsconfig, which does not set allowImportingTsExtensions.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../test-support/fake-service-client-hook.mjs", import.meta.url));
register(
  `data:text/javascript,${encodeURIComponent(`
const STUBS = {
  "./provider": "export function getProvider(id) { return globalThis.__delProvider?.(id) ?? null; }",
  "./connections": "export async function getAccessToken(memberId) { globalThis.__delCalls.push(['token', memberId]); return globalThis.__delToken ?? null; }",
};
export async function resolve(specifier, context, next) {
  const parent = String(context.parentURL ?? "");
  if (specifier in STUBS && (parent.includes("/lib/calendar/bookings.ts") || parent.includes("/lib/calendar/cleanups.ts"))) {
    return { url: "data:text/javascript," + encodeURIComponent(STUBS[specifier]), shortCircuit: true };
  }
  return next(specifier, context);
}`)}`,
);

const { CO, APP, JOB, finalInterviewWorld, makeDb } = await import(
  "../../test-support/final-interview-world.mjs"
);
const { cancelBooking, cancelScreeningBookingsForDeletion, findBookingByToken, hashBookingToken } =
  await import("./bookings.ts");

const FUTURE = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
const PAST = new Date(Date.now() - 60 * 60 * 1000).toISOString();

const booking = (over) => ({
  id: "b-1",
  company_id: CO,
  application_id: APP,
  job_id: JOB,
  host_member_id: "m-host",
  duration_minutes: 30,
  status: "booked",
  scheduled_start: FUTURE,
  scheduled_end: FUTURE,
  candidate_timezone: "Asia/Karachi",
  host_timezone: "Europe/London",
  meeting_mode: "auto",
  meeting_url: null,
  provider_event_id: "evt-1",
  provider: "google",
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

/** One world: bookings, a calendar connection, and a provider answering as told. */
function world(
  rows,
  { connected = true, token = "tok", removes = [true], failing, failUpdates = 0 } = {},
) {
  const db = makeDb();
  db.interview_bookings.push(...rows);
  db.calendar_cleanups = [];
  db.calendar_connections = connected
    ? [{ member_id: "m-host", status: "active", provider: "google", calendar_id: "cal-1" }]
    : [];
  const service = finalInterviewWorld(db, { failing });
  // The first `failUpdates` booking UPDATEs fail (the local write after Google).
  let updatesLeft = failUpdates;
  const realFrom = service.from.bind(service);
  service.from = (table) => {
    const q = realFrom(table);
    if (table !== "interview_bookings") return q;
    let isUpdate = false;
    const wrapped = new Proxy(q, {
      get(target, prop) {
        if (prop === "then") {
          return (resolve, reject) => {
            if (isUpdate && updatesLeft > 0) {
              updatesLeft -= 1;
              return Promise.resolve({ data: null, error: { code: "40001" } }).then(
                resolve,
                reject,
              );
            }
            return target.then(resolve, reject);
          };
        }
        return (...args) => {
          if (prop === "update") isUpdate = true;
          target[prop](...args);
          return wrapped;
        };
      },
    });
    return wrapped;
  };
  globalThis.__fakeServiceClientForTests = () => service;
  globalThis.__delCalls = [];
  globalThis.__delToken = token;
  const answers = [...removes];
  globalThis.__delProvider = () => ({
    async deleteEvent(_accessToken, args) {
      globalThis.__delCalls.push(["delete", args]);
      return answers.length > 1 ? answers.shift() : answers[0];
    },
  });
  return { db, service, calls: globalThis.__delCalls };
}
const quiet = async (fn) => {
  const real = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = real;
  }
};

test("61-a. an upcoming booked screening call: the event is deleted SILENTLY, then the booking is cancelled", async () => {
  const w = world([booking({})]);
  const out = await cancelScreeningBookingsForDeletion(CO, APP);
  assert.deepEqual(out, { ok: true, cancelled: 1 });
  const del = w.calls.find((c) => c[0] === "delete");
  assert.deepEqual(del[1], { calendarId: "cal-1", eventId: "evt-1", silent: true });
  assert.equal(w.db.interview_bookings[0].status, "cancelled");
  assert.equal(w.db.interview_bookings[0].cancelled_by, "recruiter");
  assert.equal(w.db.interview_bookings[0].cancel_reason, null);
  const order = w.service.queries.map((q) => q.table);
  assert.ok(
    order.indexOf("calendar_connections") < order.lastIndexOf("interview_bookings"),
    "the calendar goes first",
  );
});

test("61-b. Google does not confirm: refused, and the booking stays booked so a retry starts over", async () => {
  const w = world([booking({})], { removes: [false] });
  assert.deepEqual(await quiet(() => cancelScreeningBookingsForDeletion(CO, APP)), {
    ok: false,
    failure: "calendar",
  });
  assert.equal(w.db.interview_bookings[0].status, "booked");
});

test("61-c. a connected calendar whose token cannot be had: refused, not skipped", async () => {
  const w = world([booking({})], { token: null });
  assert.deepEqual(await quiet(() => cancelScreeningBookingsForDeletion(CO, APP)), {
    ok: false,
    failure: "calendar",
  });
  assert.ok(!w.calls.some((c) => c[0] === "delete"));
  assert.equal(w.db.interview_bookings[0].status, "booked");
});

test("61-d. fail then retry: the second call deletes the event and cancels the booking", async () => {
  const w = world([booking({})], { removes: [false, true] });
  assert.equal((await quiet(() => cancelScreeningBookingsForDeletion(CO, APP))).ok, false);
  assert.deepEqual(await cancelScreeningBookingsForDeletion(CO, APP), { ok: true, cancelled: 1 });
  assert.equal(w.calls.filter((c) => c[0] === "delete").length, 2);
  assert.equal(w.db.interview_bookings[0].status, "cancelled");
  // A third call finds nothing booked: nothing to delete, nothing written.
  assert.deepEqual(await cancelScreeningBookingsForDeletion(CO, APP), { ok: true, cancelled: 0 });
  assert.equal(w.calls.filter((c) => c[0] === "delete").length, 2);
});

test("61-e. nothing reachable to remove (no event id, or no connected calendar): just cancelled", async () => {
  const noEvent = world([booking({ provider_event_id: null })]);
  assert.deepEqual(await cancelScreeningBookingsForDeletion(CO, APP), { ok: true, cancelled: 1 });
  assert.ok(!noEvent.calls.some((c) => c[0] === "delete" || c[0] === "token"));
  const disconnected = world([booking({})], { connected: false });
  // Counted (#56): the event may still be in the host's calendar.
  assert.deepEqual(await cancelScreeningBookingsForDeletion(CO, APP), {
    ok: true,
    cancelled: 1,
    eventsLeft: 1,
  });
  assert.ok(!disconnected.calls.some((c) => c[0] === "delete"));
});

test("61-f. a call already started or past, another applicant's or company's, expired or completed: left alone", async () => {
  // An invited row is no longer left alone: #56 C-2 cancels it (56-a). Nor is
  // a final-round booking since #16 (16-a).
  const w = world([
    booking({ id: "b-past", scheduled_start: PAST }),
    booking({ id: "b-other-app", application_id: "a-other" }),
    booking({ id: "b-other-co", company_id: "other-co" }),
    booking({ id: "b-expired", status: "expired", provider_event_id: null }),
    booking({ id: "b-completed", status: "completed", scheduled_start: PAST }),
    booking({ id: "b-other-cancelled", status: "cancelled", application_id: "a-other" }),
  ]);
  const before = structuredClone(w.db.interview_bookings);
  assert.deepEqual(await cancelScreeningBookingsForDeletion(CO, APP), { ok: true, cancelled: 0 });
  assert.ok(!w.calls.some((c) => c[0] === "delete"));
  assert.deepEqual(w.db.interview_bookings, before, "no row changed at all");
});

test("61-g. the bookings read fails: refused as a database failure, nothing touched", async () => {
  const w = world([booking({})], { failing: "interview_bookings" });
  assert.deepEqual(await quiet(() => cancelScreeningBookingsForDeletion(CO, APP)), {
    ok: false,
    failure: "database",
  });
  assert.ok(!w.calls.some((c) => c[0] === "delete"));
});

test("61-i. Google deletes, the local write fails: refused; the retry's second delete is silent and harmless, and finishes", async () => {
  // Google's own answer to deleting an event already deleted is 410 (or a 404
  // on a calendar it can see): google-delete.test.ts G2/G3 count both as
  // deleted. So the retry repeats the call, silently, and it changes nothing.
  const w = world([booking({})], { failUpdates: 1 });
  assert.deepEqual(await quiet(() => cancelScreeningBookingsForDeletion(CO, APP)), {
    ok: false,
    failure: "database",
  });
  assert.equal(w.db.interview_bookings[0].status, "booked", "nothing written locally");
  assert.deepEqual(await cancelScreeningBookingsForDeletion(CO, APP), { ok: true, cancelled: 1 });
  const deletes = w.calls.filter((c) => c[0] === "delete");
  assert.equal(deletes.length, 2);
  assert.ok(
    deletes.every((c) => c[1].silent === true),
    "both calls tell no attendee",
  );
  assert.equal(w.db.interview_bookings[0].status, "cancelled");
  // Done: a third call finds nothing booked and calls Google no more.
  assert.deepEqual(await cancelScreeningBookingsForDeletion(CO, APP), { ok: true, cancelled: 0 });
  assert.equal(w.calls.filter((c) => c[0] === "delete").length, 2);
});

test("61-j. the applicant delete's booking step sends no email of its own: no notice or email call in it", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("./bookings.ts", import.meta.url), "utf8");
  const body = src.slice(
    src.indexOf("export async function cancelScreeningBookingsForDeletion("),
    src.indexOf("/**\n * Resolve everything needed to act on a booking's provider event"),
  );
  assert.ok(body.length > 500, "the function was found");
  assert.doesNotMatch(body, /Notices|sendEmail|deliverEmail|notifyCompany|resend/i);
});

test("61-h. Google's delete is silent only when asked: the provider sends sendUpdates=none or all", async () => {
  const { readFileSync } = await import("node:fs");
  const google = readFileSync(new URL("./google.ts", import.meta.url), "utf8");
  assert.match(
    google,
    /async deleteEvent\(accessToken, \{ calendarId, eventId, silent = false, signal \}\)/,
  );
  assert.match(google, /\?sendUpdates=\$\{silent \? "none" : "all"\}/);
  const bookings = readFileSync(new URL("./bookings.ts", import.meta.url), "utf8");
  assert.equal(
    (bookings.match(/silent: true/g) ?? []).length,
    1,
    "only the applicant delete is silent",
  );
});

/* ── #56: invited links and events a recruiter's cancel left behind ── */

const invited = (over) =>
  booking({
    status: "invited",
    scheduled_start: null,
    scheduled_end: null,
    provider_event_id: null,
    ...over,
  });
const leftover = (over) =>
  booking({
    id: "b-left",
    status: "cancelled",
    cancelled_at: PAST,
    cancelled_by: "recruiter",
    ...over,
  });

test("56-a. an invited, never-booked link is cancelled with the applicant: no calendar call, no email", async () => {
  const w = world([invited({ id: "b-inv" })]);
  assert.deepEqual(await cancelScreeningBookingsForDeletion(CO, APP), { ok: true, cancelled: 1 });
  assert.equal(w.db.interview_bookings[0].status, "cancelled");
  assert.ok(!w.calls.some((c) => c[0] === "delete" || c[0] === "token"));
});

test("56-b. a cancelled row still holding an event id: removed SILENTLY now, and the id cleared", async () => {
  const w = world([leftover({ provider_event_id: "evt-left" })]);
  assert.deepEqual(await cancelScreeningBookingsForDeletion(CO, APP), { ok: true, cancelled: 0 });
  const del = w.calls.find((c) => c[0] === "delete");
  assert.deepEqual(del[1], { calendarId: "cal-1", eventId: "evt-left", silent: true });
  assert.equal(w.db.interview_bookings[0].provider_event_id, null);
  assert.equal(
    w.db.interview_bookings[0].status,
    "cancelled",
    "still cancelled, nothing else changed",
  );
  assert.equal(w.db.interview_bookings[0].cancelled_at, PAST);
});

test("56-c. that event cannot be removed (Google says no, or no token): the delete STOPS, the id is kept; retry finishes", async () => {
  for (const opts of [{ removes: [false, true] }, { token: null }]) {
    const w = world([leftover({ provider_event_id: "evt-left" }), invited({ id: "b-inv" })], opts);
    assert.deepEqual(await quiet(() => cancelScreeningBookingsForDeletion(CO, APP)), {
      ok: false,
      failure: "calendar",
    });
    assert.equal(w.db.interview_bookings[0].provider_event_id, "evt-left", "kept for the retry");
    if (opts.token === null) continue;
    assert.deepEqual(await cancelScreeningBookingsForDeletion(CO, APP), { ok: true, cancelled: 1 });
    assert.equal(w.db.interview_bookings[0].provider_event_id, null);
    assert.equal(w.db.interview_bookings[1].status, "cancelled");
    // Done: a third call removes nothing and calls Google no more.
    const before = w.calls.filter((c) => c[0] === "delete").length;
    assert.deepEqual(await cancelScreeningBookingsForDeletion(CO, APP), { ok: true, cancelled: 0 });
    assert.equal(w.calls.filter((c) => c[0] === "delete").length, before);
  }
});

test("56-d. a leftover event on a calendar that is no longer connected: nothing we can reach, left as it is, the delete goes on", async () => {
  const w = world([leftover({ provider_event_id: "evt-left" })], { connected: false });
  assert.deepEqual(await cancelScreeningBookingsForDeletion(CO, APP), {
    ok: true,
    cancelled: 0,
    eventsLeft: 1,
  });
  assert.equal(w.db.interview_bookings[0].provider_event_id, "evt-left");
  assert.ok(!w.calls.some((c) => c[0] === "delete"));
});

test("56-e. an upcoming booking's confirmed delete clears its event id in the cancel write", async () => {
  const w = world([booking({})]);
  await cancelScreeningBookingsForDeletion(CO, APP);
  assert.equal(w.db.interview_bookings[0].status, "cancelled");
  assert.equal(w.db.interview_bookings[0].provider_event_id, null);
});

test("56-f. a recruiter's cancel: the id is cleared only when Google confirmed; otherwise kept for the applicant delete", async () => {
  let w = world([booking({})]);
  let out = await cancelBooking({
    row: { ...w.db.interview_bookings[0] },
    cancelledBy: "recruiter",
  });
  assert.equal(out.ok && out.removedFromCalendar, true);
  assert.equal(w.db.interview_bookings[0].provider_event_id, null);

  w = world([booking({})], { removes: [false] });
  out = await quiet(() =>
    cancelBooking({ row: { ...w.db.interview_bookings[0] }, cancelledBy: "recruiter" }),
  );
  assert.equal(out.ok && out.removedFromCalendar, false);
  assert.equal(w.db.interview_bookings[0].status, "cancelled");
  assert.equal(w.db.interview_bookings[0].provider_event_id, "evt-1", "kept");
  // ... and the applicant's delete later removes it.
  assert.deepEqual(await cancelScreeningBookingsForDeletion(CO, APP), {
    ok: false,
    failure: "calendar",
  });
  w.calls.length = 0;
});

test("56-g. /book refuses a link whose applicant is gone, on every method (findBookingByToken reads it as no such link)", async () => {
  const w = world([
    invited({ id: "b-orphan", application_id: null, token_hash: hashBookingToken("tok-orphan") }),
    invited({ id: "b-live", token_hash: hashBookingToken("tok-live") }),
  ]);
  assert.deepEqual(await findBookingByToken("tok-orphan"), { ok: true, value: null });
  const live = await findBookingByToken("tok-live");
  assert.equal(live.ok && live.value?.id, "b-live");
  const route = (await import("node:fs")).readFileSync(
    new URL("../../app/api/book/[token]/route.ts", import.meta.url),
    "utf8",
  );
  // All four methods resolve the link through findBookingByToken and 404 on null.
  assert.equal((route.match(/const read = await findBookingByToken\(token\);/g) ?? []).length, 4);
  assert.equal((route.match(/if \(!row\) return fail\(404, "not_found"\);/g) ?? []).length, 4);
  assert.ok(w);
});

test("56-h. the deletion step sends no email of its own and reads only this applicant's rows, of every purpose (#16)", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("./bookings.ts", import.meta.url), "utf8");
  const body = src.slice(
    src.indexOf("export async function cancelScreeningBookingsForDeletion("),
    src.indexOf("/**\n * Resolve everything needed to act on a booking's provider event"),
  );
  assert.doesNotMatch(body, /Notices|sendEmail|deliverEmail|notifyCompany|resend/i);
  assert.match(
    body,
    /\.eq\("company_id", companyId\)\s*\.eq\("application_id", applicationId\)\s*\.in\("status", \["booked", "invited", "cancelled"\]\);/,
  );
  assert.doesNotMatch(body, /\.eq\("purpose"/, "no purpose filter: final rounds too");
});

test("56-i. disconnected: an event id is counted (the recruiter is told); no event id is a plain delete; connected-but-failing still blocks", async () => {
  // Disconnected, with event ids on a booked and a cancelled row: both counted, nothing refused.
  world([booking({ id: "b-up" }), leftover({ id: "b-old", provider_event_id: "evt-old" })], {
    connected: false,
  });
  assert.deepEqual(await cancelScreeningBookingsForDeletion(CO, APP), {
    ok: true,
    cancelled: 1,
    eventsLeft: 2,
  });
  // Disconnected, no event ids: a plain delete, no count at all.
  world([booking({ provider_event_id: null }), invited({ id: "b-inv" })], { connected: false });
  assert.deepEqual(await cancelScreeningBookingsForDeletion(CO, APP), { ok: true, cancelled: 2 });
  // Connected but Google does not confirm: refused, as #61.
  world([booking({})], { removes: [false] });
  assert.deepEqual(await quiet(() => cancelScreeningBookingsForDeletion(CO, APP)), {
    ok: false,
    failure: "calendar",
  });
});

/* ── #16: final rounds, and "Delete anyway" ───────────────────────────── */

const finalRound = (over = {}) =>
  booking({
    id: "b-final",
    purpose: "final",
    final_interview_id: "fi-1",
    provider_event_id: "evt-final",
    recording_notice_acknowledged_at: "2026-10-02T00:00:00.000Z",
    recording_notice_version: "v1",
    ...over,
  });

test("16-a. a final-round booking is cleared like a screening one: event removed silently, row cancelled", async () => {
  const w = world([finalRound()]);
  assert.deepEqual(await cancelScreeningBookingsForDeletion(CO, APP), { ok: true, cancelled: 1 });
  const [del] = w.calls.filter((c) => c[0] === "delete");
  assert.equal(del[1].eventId, "evt-final");
  assert.equal(del[1].silent, true);
  assert.equal(w.db.interview_bookings[0].status, "cancelled");
  assert.equal(w.db.interview_bookings[0].provider_event_id, null);
  // As 071's Close leaves it: already cancelled, event id kept. Cleared now.
  const w2 = world([finalRound({ status: "cancelled" })]);
  assert.deepEqual(await cancelScreeningBookingsForDeletion(CO, APP), { ok: true, cancelled: 0 });
  assert.equal(w2.db.interview_bookings[0].provider_event_id, null);
});

test("16-b. connected, Google does not confirm, the ordinary delete: STOPPED, nothing recorded, nothing written (#61 kept)", async () => {
  for (const opts of [{ removes: [false] }, { token: null }]) {
    const w = world([finalRound({ status: "cancelled" }), booking({ id: "b-2" })], opts);
    const before = structuredClone(w.db.interview_bookings);
    assert.deepEqual(await quiet(() => cancelScreeningBookingsForDeletion(CO, APP)), {
      ok: false,
      failure: "calendar",
    });
    assert.deepEqual(w.db.calendar_cleanups, [], "no alert recorded: no silent bypass");
    assert.deepEqual(w.db.interview_bookings, before);
    // The default and an explicit false are the same thing.
    const w2 = world([finalRound({ status: "cancelled" })], opts);
    assert.equal(
      (await quiet(() => cancelScreeningBookingsForDeletion(CO, APP, { anyway: false }))).ok,
      false,
    );
    assert.deepEqual(w2.db.calendar_cleanups, []);
  }
});

test("16-c. Delete anyway: each event Google still will not remove is recorded for the lasting alert, and the step goes on", async () => {
  for (const opts of [{ removes: [false] }, { token: null }]) {
    const w = world([finalRound({ status: "cancelled" }), booking({ id: "b-2" })], opts);
    const out = await quiet(() => cancelScreeningBookingsForDeletion(CO, APP, { anyway: true }));
    assert.deepEqual(out, { ok: true, cancelled: 1, eventsLeft: 2 });
    assert.deepEqual(
      w.db.calendar_cleanups.map((c) => [c.provider_event_id, c.status, c.pending_application_id]),
      [
        ["evt-final", "pending", APP],
        ["evt-1", "pending", APP],
      ],
    );
    // The event ids stay on the rows: the alert, not the row, now points at them.
    assert.equal(w.db.interview_bookings[0].provider_event_id, "evt-final");
  }
});

test("16-d. Delete anyway, but Google can remove it now: removed, no alert", async () => {
  const w = world([finalRound({ status: "cancelled" })], { removes: [true] });
  assert.deepEqual(await cancelScreeningBookingsForDeletion(CO, APP, { anyway: true }), {
    ok: true,
    cancelled: 0,
  });
  assert.deepEqual(w.db.calendar_cleanups, []);
  assert.equal(w.db.interview_bookings[0].provider_event_id, null);
});
