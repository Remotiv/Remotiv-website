/**
 * The interview expiry job never expires a live interview whose call began
 * (F10 C0): ended, in progress or crashed. A live invite nobody joined, and
 * every async session, expire as before. expiry.ts and the time-cap backstop
 * (live-events.ts) run as shipped; the database is fake-live-db.mjs, whose
 * session update stamps live_ended_at on a terminal status as 044's trigger
 * does. Notifications and the queue are recorded, not sent.
 *
 *   node --test src/lib/interviews/expiry-live.test.ts
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
  "@/lib/supabase/server": "export const createServiceClient = () => globalThis.__expiryService;",
  "@/lib/notifications/company":
    "export async function notifyCompany(n) { globalThis.__expiryNotes.push(n); }",
  "@/lib/jobs-queue":
    "export const JOB_TYPES = { INTERVIEW_EXPIRY: 'interview_expiry' }; export async function enqueue(j) { globalThis.__expiryEnqueued.push(j); return { ok: true, id: 'job-next' }; }",
};
export async function resolve(specifier, context, next) {
  if (specifier in STUBS) return { url: "data:text/javascript," + encodeURIComponent(STUBS[specifier]), shortCircuit: true };
  return next(specifier, context);
}`)}`,
);

const { handleInterviewExpiry, handleInterviewExpirySweep } = await import("./expiry.ts");
const { stampOverdueLiveEnds } = await import("./live-events.ts");
const { fakeLiveDb } = await import("../../test-support/fake-live-db.mjs");

const CO = "c0000000-0000-4000-8000-000000000001";
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const at = (msFromNow) => new Date(Date.now() + msFromNow).toISOString();
const PAST = -DAY;

const session = (id, over = {}) => ({
  id,
  company_id: CO,
  application_id: null,
  job_id: null,
  kind: "live",
  status: "invited",
  expires_at: at(PAST),
  submitted_at: null,
  started_at: null,
  provider_session_id: null,
  live_ended_at: null,
  live_outcome: null,
  live_settings: { max_session_seconds: 1800 },
  ...over,
});

/** A call that began `ago` ms ago, as the start route writes it. */
const began = (ago) => ({
  status: "started",
  started_at: at(-ago),
  provider_session_id: `provider-${ago}`,
});

function world(sessions) {
  const w = fakeLiveDb({ interview_sessions: sessions });
  globalThis.__expiryService = w.service;
  globalThis.__expiryNotes = [];
  globalThis.__expiryEnqueued = [];
  return w;
}

const row = (w, id) => w.tables.interview_sessions.find((s) => s.id === id);
const perSession = (id) => handleInterviewExpiry({ id: `job-${id}`, payload: { sessionId: id } });
const sweep = () => handleInterviewExpirySweep({ id: "job-sweep", payload: {} });

/** Both discovery paths, each on a fresh copy of the same sessions. */
async function bothPaths(sessions, check) {
  for (const [name, run] of [
    ["per-session", (ids) => Promise.all(ids.map(perSession))],
    ["sweep", () => sweep()],
  ]) {
    const w = world(sessions);
    await run(sessions.map((s) => s.id));
    check(w, name);
  }
}

test("a: live, completed (ended, export saved) -> not expired, no notification", async () => {
  const s = session("s-done", {
    ...began(40 * MIN),
    live_ended_at: at(-5 * MIN),
    live_outcome: { outcome: "completed", final: true },
  });
  await bothPaths([s], (w, path) => {
    assert.equal(row(w, "s-done").status, "started", path);
    assert.deepEqual(globalThis.__expiryNotes, [], path);
    assert.deepEqual(globalThis.__expiryEnqueued, [], `${path}: nothing re-armed`);
  });
});

test("b: live, crashed (no export) -> not expired before the backstop, nor after it ends the call", async () => {
  for (const path of ["per-session", "sweep"]) {
    const w = world([session("s-crash", began(50 * MIN))]);
    const run = path === "sweep" ? sweep : () => perSession("s-crash");
    await run();
    assert.equal(row(w, "s-crash").status, "started", `${path}: before the backstop`);
    assert.equal(row(w, "s-crash").live_ended_at, null, `${path}: the call is not ended by expiry`);

    // 50 minutes after the start: past the 30-minute limit plus the 10-minute grace.
    assert.equal(await stampOverdueLiveEnds(w.service), 1, "the backstop ends it");
    assert.notEqual(row(w, "s-crash").live_ended_at, null);
    assert.equal(row(w, "s-crash").live_outcome, null, "still no export");

    await run();
    assert.equal(row(w, "s-crash").status, "started", `${path}: after the backstop`);
    assert.deepEqual(globalThis.__expiryNotes, [], path);
  }
});

test("c: live, call in progress at the deadline -> not expired, the call is not cut off", async () => {
  const s = session("s-live", { ...began(5 * MIN), expires_at: at(-MIN) });
  await bothPaths([s], (w, path) => {
    assert.equal(row(w, "s-live").status, "started", path);
    assert.equal(row(w, "s-live").live_ended_at, null, `${path}: video window still open`);
    assert.deepEqual(globalThis.__expiryNotes, [], path);
  });
});

test("d: live invite never joined, past deadline -> expired and notified, as today", async () => {
  await bothPaths([session("s-unjoined")], (w, path) => {
    assert.equal(row(w, "s-unjoined").status, "expired", path);
    assert.equal(globalThis.__expiryNotes.length, 1, path);
    assert.equal(globalThis.__expiryNotes[0].type, "interview_expired", path);
  });
  // Before its deadline it re-arms, as today.
  const w = world([session("s-early", { expires_at: at(DAY) })]);
  await perSession("s-early");
  assert.equal(row(w, "s-early").status, "invited");
  assert.equal(globalThis.__expiryEnqueued.length, 1, "re-armed for the deadline");
});

test("d2: a call that begins between the read and the write is not expired", async () => {
  const w = world([session("s-race")]);
  const from = w.service.from.bind(w.service);
  let reads = 0;
  w.service.from = (table) => {
    // The second interview_sessions call is the expiring UPDATE: the candidate joins just before it.
    if (table === "interview_sessions" && ++reads === 2) Object.assign(row(w, "s-race"), began(0));
    return from(table);
  };
  await perSession("s-race");
  assert.equal(row(w, "s-race").status, "started");
  assert.deepEqual(globalThis.__expiryNotes, []);
});

test("e: live, ended with no export (live_outcome null) -> not expired", async () => {
  const s = session("s-noexport", { ...began(45 * MIN), live_ended_at: at(-2 * MIN) });
  await bothPaths([s], (w, path) => {
    assert.equal(row(w, "s-noexport").status, "started", path);
    assert.equal(row(w, "s-noexport").live_outcome, null, path);
    assert.deepEqual(globalThis.__expiryNotes, [], path);
  });
});

test("f: async sessions past the deadline expire as before, started or not", async () => {
  const sessions = [
    session("a-invited", { kind: "async" }),
    session("a-started", { kind: "async", status: "started", started_at: at(-2 * DAY) }),
  ];
  await bothPaths(sessions, (w, path) => {
    assert.equal(row(w, "a-invited").status, "expired", path);
    assert.equal(row(w, "a-started").status, "expired", path);
    assert.equal(globalThis.__expiryNotes.length, 2, path);
  });
});

test("the sweep is never starved by begun calls: a full batch of them, then real work", async () => {
  const begun = Array.from({ length: 250 }, (_, i) =>
    session(`s-begun-${i}`, {
      ...began(60 * MIN),
      live_ended_at: at(-MIN),
      expires_at: at(-2 * DAY),
    }),
  );
  const w = world([
    ...begun,
    session("a-late", { kind: "async", expires_at: at(-MIN) }),
    session("s-late", { expires_at: at(-MIN) }),
  ]);
  await sweep();
  assert.equal(row(w, "a-late").status, "expired");
  assert.equal(row(w, "s-late").status, "expired");
  assert.equal(w.tables.interview_sessions.filter((s) => s.status === "expired").length, 2);
  assert.equal(globalThis.__expiryNotes.length, 2);
});
