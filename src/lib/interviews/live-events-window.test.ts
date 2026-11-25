/**
 * #17: no live event report is stored more than 30 minutes after the call
 * ended, the same window a reserved video piece has to be confirmed (#50).
 * Until this, an old link could keep writing rows until the retention date.
 *
 *   node --test src/lib/interviews/live-events-window.test.ts
 *
 * The event route and handleLiveEvent run as shipped over fake-live-db.mjs,
 * with `now` moved rather than the clock mocked. Synthetic data only.
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
const { effectiveEndMs, handleLiveEvent, REPORT_WINDOW_MS, stampOverdueLiveEnds } = await import(
  "./live-events.ts"
);
const { fakeService } = await import("../../test-support/fake-postgrest.mjs");
const { UPLOAD_WINDOW_MS } = await import("./live-video.ts");
const { hashSessionToken } = await import("./tokens.ts");
const { fakeLiveDb } = await import("../../test-support/fake-live-db.mjs");

const NOW = Date.now();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const iso = (ms) => new Date(ms).toISOString();
const SESSION = "d0000000-0000-4000-8000-0000000000b7";
const TOKEN = "event-window-synthetic-token-0123456789abcdef";

/** A started live call; `over` sets its end and timings. */
function world(over = {}) {
  const db = fakeLiveDb({
    interview_sessions: [
      {
        id: SESSION,
        company_id: "c0000000-0000-4000-8000-0000000000b7",
        application_id: null,
        job_id: null,
        kind: "live",
        attempt: 1,
        previous_attempt_id: null,
        status: "started",
        token_hash: hashSessionToken(TOKEN),
        expires_at: iso(NOW + HOUR),
        started_at: iso(NOW - HOUR),
        live_ended_at: null,
        provider: "mock",
        provider_session_id: "provider-1",
        live_settings: { v: 1, interviewer_name: "Maya", max_session_seconds: 600 },
        live_outcome: null,
        delete_after: iso(NOW + 180 * 24 * HOUR),
        purged_at: null,
        ...over,
      },
    ],
  });
  globalThis.__service = db.service;
  return db;
}

const quiet = async (fn) => {
  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try {
    return await fn();
  } finally {
    Object.assign(console, saved);
  }
};
const report = (db, atMs) =>
  quiet(() =>
    handleLiveEvent(
      { token: TOKEN, kind: "video_saved" },
      { service: db.service, now: () => atMs },
    ),
  );
const rows = (db) => db.tables.live_session_events ?? [];

test("the report window is the #50 upload window: 30 minutes", () => {
  assert.equal(REPORT_WINDOW_MS, 30 * MINUTE);
  assert.equal(REPORT_WINDOW_MS, UPLOAD_WINDOW_MS);
});

// Negative control: remove the live_ended_at window check in closedToReports
// and the late reports below are stored.
test("after the call ended: recorded up to 30 minutes, refused after, nothing stored", async () => {
  const ended = NOW - HOUR;
  for (const [after, expected] of [
    [MINUTE, 200],
    [29 * MINUTE, 200],
    [30 * MINUTE, 200],
    [30 * MINUTE + 1_000, 409],
    [3 * HOUR, 409],
    [90 * 24 * HOUR, 409],
  ]) {
    const db = world({ live_ended_at: iso(ended) });
    const r = await report(db, ended + after);
    assert.equal(r.status, expected, `${after / MINUTE} min after the end`);
    if (expected === 409) {
      assert.deepEqual(r.body, { code: "not_open", error: "This interview is closed." });
      assert.equal(rows(db).length, 0, "nothing stored");
      assert.equal(db.tables.interview_sessions[0].live_ended_at, iso(ended), "the end unmoved");
    } else {
      assert.equal(rows(db).length, 1);
    }
  }
});

test("through the route: an old link an hour after the end stores nothing", async () => {
  const db = world({ live_ended_at: iso(NOW - HOUR) });
  const res = await quiet(() =>
    POST(
      new Request("http://x", {
        method: "POST",
        body: JSON.stringify({ token: TOKEN, kind: "tab_closed" }),
      }),
    ),
  );
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, "not_open");
  assert.equal(rows(db).length, 0);
});

/**
 * A call that ran over and was never stamped: started 6 hours ago, so with the
 * 30-minute limit (the fixture's settings fall back to the default) it ENDED
 * 5 h 30 min ago (#23); the 10-minute grace only decides when the backstop acts.
 */
const SIX_H_AGO = NOW - 6 * HOUR;
const END = SIX_H_AGO + 30 * MINUTE;

// Negative control: count the window from live_ended_at only (the first
// version of #17) and the second report lands, because fake-live-db stores the
// stamp at its own clock (now), as migration 044 does.
test("an overrun call: the window runs from the interview's end, and a late stamp can never restart it", async () => {
  const db = world({ started_at: iso(SIX_H_AGO) });
  assert.equal((await report(db, END + 20 * MINUTE)).status, 200, "inside 30 minutes of the end");
  const stored = Date.parse(db.tables.interview_sessions[0].live_ended_at);
  assert.ok(stored > END + HOUR, "044 stored the moment it was noticed, not the end");
  assert.equal((await report(db, END + 31 * MINUTE)).status, 409, "31 minutes after the end");
  assert.equal((await report(db, NOW)).status, 409, "hours later");
  assert.equal(rows(db).length, 1, "only the first report");
});

test("an overrun call reported long after: the end is stamped, and the report refused", async () => {
  const db = world({ started_at: iso(SIX_H_AGO) });
  const r = await report(db, NOW);
  assert.deepEqual(r.body, { code: "not_open", error: "This interview is closed." });
  assert.notEqual(db.tables.interview_sessions[0].live_ended_at, null, "the backstop still stamps");
  assert.equal(rows(db).length, 0);
});

/** A database that records what each backstop writes to live_ended_at. */
function recording(sessionRow) {
  const written = [];
  const service = fakeService((table, calls) => {
    const update = calls.find((c) => c[0] === "update");
    if (table === "interview_sessions" && update) {
      written.push(update[1].live_ended_at);
      return { data: [{ id: SESSION }], error: null };
    }
    if (table === "interview_sessions") {
      const single = calls.some((c) => c[0] === "maybeSingle");
      return { data: single ? sessionRow : [sessionRow], error: null };
    }
    return { data: [], error: null };
  });
  return { service, written };
}

// Negative control: pass `now` instead of `() => end` to stampLiveEnded.
test("every backstop writes the interview's end, not the moment it noticed or the grace", async () => {
  const row = {
    id: SESSION,
    company_id: "c0000000-0000-4000-8000-0000000000b7",
    kind: "live",
    status: "started",
    expires_at: iso(NOW + HOUR),
    started_at: iso(SIX_H_AGO),
    live_ended_at: null,
    provider_session_id: "provider-1",
    live_settings: null,
    delete_after: iso(NOW + 180 * 24 * HOUR),
    purged_at: null,
  };
  const viaReport = recording(row);
  await quiet(() =>
    handleLiveEvent(
      { token: TOKEN, kind: "tab_closed" },
      { service: viaReport.service, now: () => NOW },
    ),
  );
  assert.deepEqual(viaReport.written, [iso(END)], "the report's backstop");

  const viaSweep = recording(row);
  await quiet(() => stampOverdueLiveEnds(viaSweep.service, () => NOW));
  assert.deepEqual(viaSweep.written, [iso(END)], "the worker's sweep");

  const video = readFileSync(new URL("./live-video.ts", import.meta.url), "utf8");
  assert.match(
    video,
    /await stampLiveEnded\(deps\.service, session\.id, \(\) => end\);/,
    "the video backstop",
  );
  assert.equal(
    effectiveEndMs({ ...row, live_ended_at: iso(NOW) }, NOW),
    END,
    "the earlier of stamp and end",
  );
  assert.equal(effectiveEndMs({ ...row, live_ended_at: iso(END - MINUTE) }, NOW), END - MINUTE);
});

test("migration 069 keeps a past end within the call, and nothing else", () => {
  const sql = readFileSync(
    new URL("../supabase/migrations/069_live_ended_at_backstop_due_time.sql", import.meta.url),
    "utf8",
  ).replace(/--.*$/gm, "");
  assert.match(
    sql,
    /raise exception 'interview_sessions: live_ended_at is set once and never changed or cleared'/,
  );
  assert.match(
    sql,
    /if not \(new\.started_at is not null\s+and new\.live_ended_at >= new\.started_at\s+and new\.live_ended_at <= now\(\)\) then\s+new\.live_ended_at := now\(\);/,
  );
  assert.match(
    sql,
    /elsif new\.status in \('submitted', 'expired', 'cancelled', 'abandoned'\) then\s+new\.live_ended_at := now\(\);/,
  );
  assert.doesNotMatch(sql, /drop trigger|create trigger|alter table/i, "the function only");
});

test("a call still in progress is unaffected", async () => {
  const db = world({ started_at: iso(NOW - MINUTE) });
  assert.equal((await report(db, NOW)).status, 200);
  assert.equal(db.tables.interview_sessions[0].live_ended_at, null);
});

// Negative control: put back `const { data } = await service...` in sessionFor
// and a failed read answers 404 "This interview link isn't valid." for a real link.
test("a failed session read is 'not recorded, try again', never 'this link isn't valid'", async () => {
  const db = world({ started_at: iso(NOW - MINUTE) });
  db.failNext("interview_sessions", "select");
  const r = await report(db, NOW);
  assert.deepEqual(
    [r.status, r.body],
    [502, { code: "not_recorded", error: "Couldn't record that. Please try again." }],
  );
  assert.equal(rows(db).length, 0);
});
