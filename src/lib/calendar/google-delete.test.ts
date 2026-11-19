/**
 * Google's event delete, and what each answer means (#61). The real provider
 * runs against a fake `fetch` that answers as Google would; nothing leaves the
 * machine.
 *
 *   node --test src/lib/calendar/google-delete.test.ts
 *
 * Google answers 404 both for an event that is not there and for a calendar
 * this token cannot see. Only the first is "already deleted". A 404 is
 * therefore checked against the calendar (calendars.get): reachable means the
 * event is gone (true); not reachable means nothing was deleted (false), so an
 * applicant delete keeps the applicant.
 */
// @ts-nocheck - same reason as the other node:test files: Node's `.ts`
// specifier vs this tsconfig, which does not set allowImportingTsExtensions.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../test-support/fake-service-client-hook.mjs", import.meta.url));

const { google } = await import("./google.ts");

const ARGS = { calendarId: "cal@example.test", eventId: "evt-1" };

/** Google as a fake: the delete answers `del`, the calendar read answers `cal`. */
function fakeGoogle({ del, cal = 200, throws = false }) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ method: init.method ?? "GET", url: String(url) });
    if (throws) throw new TypeError("fetch failed");
    const status = (init.method ?? "GET") === "DELETE" ? del : cal;
    return new Response(status === 204 ? null : "{}", { status });
  };
  return calls;
}

test("G1. 204: deleted, one call; silent asks Google to tell nobody, otherwise everyone", async () => {
  let calls = fakeGoogle({ del: 204 });
  assert.equal(await google.deleteEvent("tok", { ...ARGS, silent: true }), true);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/calendars\/cal%40example\.test\/events\/evt-1\?sendUpdates=none$/);
  calls = fakeGoogle({ del: 204 });
  await google.deleteEvent("tok", ARGS);
  assert.match(calls[0].url, /\?sendUpdates=all$/);
});

test("G2. 410 Gone: already deleted, true, and no second call", async () => {
  const calls = fakeGoogle({ del: 410 });
  assert.equal(await google.deleteEvent("tok", ARGS), true);
  assert.equal(calls.length, 1);
});

test("G3. 404 with the calendar reachable: the event is gone, true", async () => {
  const calls = fakeGoogle({ del: 404, cal: 200 });
  assert.equal(await google.deleteEvent("tok", ARGS), true);
  assert.deepEqual(
    calls.map((c) => c.method),
    ["DELETE", "GET"],
  );
  assert.match(calls[1].url, /\/calendars\/cal%40example\.test\?fields=id$/);
});

test("G4. 404 and the calendar cannot be seen (404 or 403): FAILS CLOSED, false", async () => {
  for (const cal of [404, 403, 401, 500]) {
    fakeGoogle({ del: 404, cal });
    assert.equal(await google.deleteEvent("tok", ARGS), false, `calendar ${cal}`);
  }
});

test("G5. any other answer, or no answer: false, with no calendar read", async () => {
  for (const del of [400, 401, 403, 409, 429, 500, 503]) {
    const calls = fakeGoogle({ del });
    assert.equal(await google.deleteEvent("tok", ARGS), false, `delete ${del}`);
    assert.equal(calls.length, 1);
  }
  fakeGoogle({ del: 204, throws: true });
  assert.equal(await google.deleteEvent("tok", ARGS), false);
});
