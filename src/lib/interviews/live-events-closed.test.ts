/**
 * A live event on a session that is finished, closed or past retention is
 * refused: no row, no end stamp. A real call's status stays `started` throughout,
 * so its reports still land, including one past expires_at and a late one after
 * the end. An old restarted link keeps its own 409 link_replaced.
 *
 *   node --test src/lib/interviews/live-events-closed.test.ts
 *
 * The event route and handleLiveEvent are the shipped code. The database is
 * fake-live-db.mjs, which applies 044's and 050's rules. Synthetic data only.
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../test-support/node-resolve.mjs", import.meta.url));
register(
  `data:text/javascript,${encodeURIComponent(`
const STUBS = {
  "server-only": "",
  "next/server": "export const NextResponse = { json: (b, i) => Response.json(b, i) };",
  "@/lib/supabase/server": "export const createServiceClient = () => globalThis.__service;",
  "@/app/api/_lib/rate-limit": "export function rateLimitByKey() { return { ok: true }; }",
};
export async function resolve(specifier, context, next) {
  if (specifier in STUBS) return { url: "data:text/javascript," + encodeURIComponent(STUBS[specifier]), shortCircuit: true };
  return next(specifier, context);
}`)}`,
);

const { POST } = await import("../../app/api/interview/live/event/route.ts");
const { handleLiveEvent } = await import("./live-events.ts");
const { hashSessionToken } = await import("./tokens.ts");
const { fakeLiveDb } = await import("../../test-support/fake-live-db.mjs");

const NOW = Date.now();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const iso = (ms) => new Date(ms).toISOString();
const SESSION = "d0000000-0000-4000-8000-0000000000a1";
const TOKEN = "event-closed-synthetic-token-0123456789abcdef";
const REPORTS = [
  ["conversation_started", null],
  ["end_pressed", null],
  ["provider_end_reported", "completed"],
  ["provider_error", "error"],
  ["connection_lost", null],
  ["tab_closed", null],
  ["timer_reached", null],
  ["video_saved", null],
];
/** A call that began a minute ago, with an hour left on its link. */
const CALLING = {
  status: "started",
  started_at: iso(NOW - MINUTE),
  provider: "mock",
  provider_session_id: "provider-1",
};
/** Long past its time limit plus the grace, so a report would stamp the end. */
const OVERDUE = { ...CALLING, started_at: iso(NOW - 30 * HOUR) };
const PAST_RETENTION = { delete_after: iso(NOW - HOUR) };
const PURGED = { purged_at: iso(NOW - HOUR), delete_after: iso(NOW - HOUR) };

function world(over = {}) {
  const db = fakeLiveDb({
    interview_sessions: [
      {
        id: SESSION,
        company_id: "c0000000-0000-4000-8000-0000000000a1",
        application_id: null,
        job_id: "b0000000-0000-4000-8000-0000000000a1",
        kind: "live",
        attempt: 1,
        previous_attempt_id: null,
        status: "invited",
        token_hash: hashSessionToken(TOKEN),
        expires_at: iso(NOW + HOUR),
        started_at: null,
        live_ended_at: null,
        provider: null,
        provider_session_id: null,
        live_settings: { v: 1, interviewer_name: "Maya", max_session_seconds: 600 },
        delete_after: iso(NOW + 200 * 24 * HOUR),
        purged_at: null,
        ...over,
      },
    ],
  });
  globalThis.__service = db.service;
  return db;
}

async function captured(fn) {
  const lines = [];
  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = (...a) => lines.push(a.join(" "));
  try {
    return { result: await fn(), lines };
  } finally {
    Object.assign(console, saved);
  }
}

async function send(kind = "tab_closed", detail = null) {
  const { result, lines } = await captured(async () => {
    const res = await POST(
      new Request("http://test.local/api/interview/live/event", {
        method: "POST",
        body: JSON.stringify({ token: TOKEN, kind, detail }),
      }),
    );
    return { status: res.status, body: await res.json() };
  });
  return { ...result, lines };
}

const rowsOf = (db) => db.tables.live_session_events ?? [];
const NOT_OPEN = { code: "not_open", error: "This interview is closed." };

test("refused: nothing stored and no end stamped, for every report", async () => {
  const cases = [
    ["cancelled", { ...OVERDUE, status: "cancelled" }],
    ["expired", { ...OVERDUE, status: "expired" }],
    ["submitted", { ...OVERDUE, status: "submitted" }],
    ["purged", { ...OVERDUE, ...PURGED }],
    ["past retention", { ...OVERDUE, ...PAST_RETENTION }],
    ["purged, with a future date", { ...OVERDUE, purged_at: iso(NOW - HOUR) }],
    ["invited past its deadline", { ...OVERDUE, status: "invited", expires_at: iso(NOW - HOUR) }],
    ["a status this code does not know", { ...OVERDUE, status: "paused" }],
  ];
  for (const [name, over] of cases) {
    for (const [kind, detail] of REPORTS) {
      const db = world(over);
      const res = await send(kind, detail);
      assert.equal(res.status, 409, `${name}, ${kind}`);
      assert.deepEqual(res.body, NOT_OPEN, `${name}, ${kind}`);
      assert.equal(rowsOf(db).length, 0, `${name}, ${kind}: no row`);
      assert.equal(
        db.tables.interview_sessions[0].live_ended_at,
        null,
        `${name}, ${kind}: no stamp`,
      );
    }
  }
});

test("invited past its deadline with no call is closed, not merely not started", async () => {
  const db = world({ expires_at: iso(NOW - HOUR) });
  assert.deepEqual((await send()).body, NOT_OPEN);
  assert.equal(rowsOf(db).length, 0);
});

test("the refusal logs the session id only: no token, no hash, no stored text", async () => {
  world({ ...CALLING, status: "paused-RAW-STATUS-TEXT" });
  const { lines } = await send();
  assert.deepEqual(lines, [`[live-events] session ${SESSION}: refused, closed`]);
});

test("a normal call in progress: every report is recorded", async () => {
  for (const [kind, detail] of REPORTS) {
    const db = world(CALLING);
    const res = await send(kind, detail);
    assert.deepEqual([res.status, res.body], [200, { ok: true }], kind);
    assert.deepEqual(
      rowsOf(db).map((r) => r.kind),
      [kind],
    );
    assert.equal(db.tables.interview_sessions[0].live_ended_at, null, `${kind}: never ends it`);
    assert.deepEqual(
      res.lines.filter((l) => l.includes("refused")),
      [],
      kind,
    );
  }
});

test("a call that runs past expires_at: every report is still recorded", async () => {
  for (const [kind, detail] of REPORTS) {
    const db = world({ ...CALLING, expires_at: iso(NOW - MINUTE) });
    assert.equal((await send(kind, detail)).status, 200, kind);
    assert.equal(rowsOf(db).length, 1, kind);
  }
});

test("a late report after the end, the export saved: still recorded, the end unmoved", async () => {
  const ended = iso(NOW - MINUTE);
  const db = world({ ...CALLING, live_ended_at: ended, expires_at: iso(NOW - MINUTE) });
  assert.equal((await send("video_saved")).status, 200);
  assert.equal(rowsOf(db).length, 1);
  assert.equal(db.tables.interview_sessions[0].live_ended_at, ended);
});

test("the backstop still ends a real call that runs over, and no delete_after changes nothing", async () => {
  const db = world({ ...OVERDUE, delete_after: null });
  assert.equal((await send()).status, 200);
  assert.equal(rowsOf(db).length, 1);
  assert.notEqual(db.tables.interview_sessions[0].live_ended_at, null);
});

test("invited with time left and no call: not_started, as before", async () => {
  const db = world();
  const res = await send();
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "not_started");
  assert.equal(rowsOf(db).length, 0);
});

test("abandoned: the route's own 409 link_replaced, exactly, even past retention", async () => {
  for (const over of [{}, PAST_RETENTION, PURGED]) {
    const db = world({ ...OVERDUE, status: "abandoned", live_ended_at: iso(NOW - HOUR), ...over });
    const res = await send();
    assert.equal(res.status, 409);
    assert.deepEqual(res.body, { code: "link_replaced", error: "This link was replaced." });
    assert.equal(rowsOf(db).length, 0);
  }
});

test("handleLiveEvent alone refuses abandoned too, should anything skip the route", async () => {
  const db = world({ ...CALLING, status: "abandoned", live_ended_at: iso(NOW - HOUR) });
  const { result } = await captured(() =>
    handleLiveEvent({ token: TOKEN, kind: "tab_closed" }, { service: db.service }),
  );
  assert.equal(result.status, 409);
  assert.equal(result.body.code, "not_open");
  assert.equal(rowsOf(db).length, 0);
});
