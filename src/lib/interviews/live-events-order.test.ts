/**
 * The live end backstop's batch is read oldest first (stampOverdueLiveEnds),
 * so calls still running can never fill the 200-row batch ahead of a call
 * that is due. fake-live-db.mjs answers in insertion order unless the query
 * asks for an order, and the due calls are inserted LAST. Synthetic data.
 *
 *   node --test src/lib/interviews/live-events-order.test.ts
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
  "@/lib/supabase/server": "export function createServiceClient() { throw new Error('test: pass a service'); }",
};
export async function resolve(specifier, context, next) {
  if (specifier in STUBS) return { url: "data:text/javascript," + encodeURIComponent(STUBS[specifier]), shortCircuit: true };
  return next(specifier, context);
}`)}`,
);

const { stampOverdueLiveEnds, BACKSTOP_BATCH } = await import("./live-events.ts");
const { fakeLiveDb } = await import("../../test-support/fake-live-db.mjs");

const NOW = Date.parse("2026-10-30T12:00:00.000Z");
const MIN = 60_000;
const ago = (ms) => new Date(NOW - ms).toISOString();
const key = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** A live call started `minutesAgo`, with no end stamped; 30-minute limit, so due after 40. */
const call = (n, minutesAgo) => ({
  id: key(n),
  company_id: "c0000000-0000-4000-8000-000000000001",
  kind: "live",
  status: "started",
  provider_session_id: `provider-${n}`,
  started_at: ago(minutesAgo * MIN),
  live_ended_at: null,
  live_settings: { max_session_seconds: 1800 },
});

/** 240 running calls (15-35 minutes in: past the grace, not due), then 10 due ones LAST. */
function world() {
  const running = Array.from({ length: 240 }, (_, i) => call(i + 1, 15 + (i % 21)));
  const due = Array.from({ length: 10 }, (_, i) => call(1000 + i, 45 + i));
  return { db: fakeLiveDb({ interview_sessions: [...running, ...due] }, { now: () => NOW }), due };
}

const quiet = async (fn) => {
  const log = console.log;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
  }
};

test("a: 250 match, the 10 due are the oldest and inserted last -> all 10 stamped in one tick", async () => {
  assert.equal(BACKSTOP_BATCH, 200);
  const { db, due } = world();
  assert.equal(await quiet(() => stampOverdueLiveEnds(db.service, () => NOW)), 10);
  const byId = new Map(db.tables.interview_sessions.map((s) => [s.id, s]));
  for (const d of due) assert.notEqual(byId.get(d.id).live_ended_at, null, d.id);
});

test("b: calls still running are never stamped, in a full batch or a small one", async () => {
  const { db, due } = world();
  await quiet(() => stampOverdueLiveEnds(db.service, () => NOW));
  const dueIds = new Set(due.map((d) => d.id));
  const running = db.tables.interview_sessions.filter((s) => !dueIds.has(s.id));
  assert.equal(running.length, 240);
  assert.ok(running.every((s) => s.live_ended_at === null));

  const small = fakeLiveDb(
    { interview_sessions: [call(1, 39), call(2, 12), call(3, 2)] },
    {
      now: () => NOW,
    },
  );
  assert.equal(await quiet(() => stampOverdueLiveEnds(small.service, () => NOW)), 0);
  assert.ok(small.tables.interview_sessions.every((s) => s.live_ended_at === null));
});

test("the read asks for oldest first, then id, before the limit", async () => {
  const { db } = world();
  await quiet(() => stampOverdueLiveEnds(db.service, () => NOW));
  const read = db.service.queries.find(
    (q) => q.table === "interview_sessions" && !q.calls.some((c) => c[0] === "update"),
  );
  const tail = read.calls.filter((c) => c[0] === "order" || c[0] === "limit");
  assert.deepEqual(tail, [
    ["order", "started_at", { ascending: true }],
    ["order", "id", { ascending: true }],
    ["limit", 200],
  ]);
});
