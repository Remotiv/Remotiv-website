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
  if (specifier in STUBS && String(context.parentURL ?? "").includes("/lib/calendar/bookings.ts")) {
    return { url: "data:text/javascript," + encodeURIComponent(STUBS[specifier]), shortCircuit: true };
  }
  return next(specifier, context);
}`)}`,
);

const { CO, APP, JOB, finalInterviewWorld, makeDb } = await import(
  "../../test-support/final-interview-world.mjs"
);
const { cancelScreeningBookingsForDeletion } = await import("./bookings.ts");

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
  assert.deepEqual(await cancelScreeningBookingsForDeletion(CO, APP), { ok: true, cancelled: 1 });
  assert.ok(!disconnected.calls.some((c) => c[0] === "delete"));
});

test("61-f. a call already started or past, a final round, another applicant's or company's: left alone", async () => {
  const w = world([
    booking({ id: "b-past", scheduled_start: PAST }),
    booking({ id: "b-final", purpose: "final", final_interview_id: "fi-1" }),
    booking({ id: "b-other-app", application_id: "a-other" }),
    booking({ id: "b-other-co", company_id: "other-co" }),
    booking({ id: "b-invited", status: "invited", scheduled_start: null }),
  ]);
  assert.deepEqual(await cancelScreeningBookingsForDeletion(CO, APP), { ok: true, cancelled: 0 });
  assert.ok(!w.calls.some((c) => c[0] === "delete"));
  assert.ok(w.db.interview_bookings.every((b) => b.status !== "cancelled"));
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
    /async deleteEvent\(accessToken, \{ calendarId, eventId, silent = false \}\)/,
  );
  assert.match(google, /\?sendUpdates=\$\{silent \? "none" : "all"\}/);
  const bookings = readFileSync(new URL("./bookings.ts", import.meta.url), "utf8");
  assert.equal(
    (bookings.match(/silent: true/g) ?? []).length,
    1,
    "only the applicant delete is silent",
  );
});
