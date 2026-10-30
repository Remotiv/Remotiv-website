// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
/**
 * The interview purge's alarm and the orphan sweep, THROUGH THE WORKER TICK.
 *
 *   node --test src/lib/queue/interview-purge-alarm.test.ts
 *
 * Three things only the real tick can prove (#59b, #59c, #59d):
 *
 *   1. Phase 1b exhausting its slice FAILS the job: the background_jobs row
 *      goes `dead` with `terminal(configuration)` in last_error, one job_dead
 *      notification goes to the admins, readQueueHealth lists it, and no
 *      retry is scheduled. A void wrapper used to record this as succeeded.
 *   2. The orphan sweep's own job is claimed and run even when ten other
 *      jobs are ahead of it in the queue: the batch is ten, so it waits one
 *      tick, not forever.
 *   3. The scheduler carries the previous orphan job's cursor into the next
 *      day's job, which is what lets a budget-stopped sweep resume.
 *
 * Same harness as lease.test.ts: the real route, the real queue, the real
 * handlers, a recording fake for background_jobs that honours every filter
 * the queue uses, and a FakeStorage bucket.
 */
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
import { fakeService } from "../../test-support/fake-postgrest.mjs";

register(new URL("../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../test-support/fake-service-client-hook.mjs", import.meta.url));
register(new URL("../../test-support/worker-route-test-hook.mjs", import.meta.url));

const queue = await import("../jobs-queue.ts");
const route = await import("../../app/api/jobs/worker/route.ts");
const health = await import("../queue-health.ts");
const { FakeStorage } = await import("../supabase/fake-table.ts");

const SECRET = "worker-route-test-secret";
process.env.CRON_SECRET = SECRET;

const PAST = new Date(Date.now() - 60_000).toISOString();
const has = (calls, method) => calls.some((c) => c[0] === method);
const arg = (calls, method) => calls.find((c) => c[0] === method);

function matches(row, calls) {
  return calls.every(([op, col, val]) => {
    const v = col === "payload->>action" ? row.payload?.action : row[col];
    if (op === "eq") return v === val;
    if (op === "in") return val.includes(v);
    if (op === "lte") return v <= val;
    if (op === "lt") return v !== null && v < val;
    return true;
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A world: background_jobs rows, a bucket, and per-table responders for the
 * handlers under test. `sessionsLate` makes the interview_sessions late-words
 * read return that many stamped sessions after `lateDelayMs` of real time.
 */
function world(jobs, opts = {}) {
  const db = { jobs, inserted: [], heartbeat: null, storage: new FakeStorage({}) };
  let seq = 0;
  const service = fakeService((table, calls) => {
    if (table.startsWith("rpc:")) return { data: [], error: null };
    if (table === "worker_heartbeats") {
      const upsert = arg(calls, "upsert");
      if (upsert) db.heartbeat = upsert[1];
      return { data: has(calls, "maybeSingle") ? null : [], error: null };
    }
    if (table === "interview_sessions") {
      const lateRead = calls.some((c) => c[0] === "not" && c[1] === "purged_at");
      if (lateRead && opts.sessionsLate) {
        return sleep(opts.lateDelayMs ?? 0).then(() => ({
          data: Array.from({ length: opts.sessionsLate }, (_, i) => ({ id: `s-${i}` })),
          error: null,
        }));
      }
      return { data: [], error: null };
    }
    if (table !== "background_jobs") return { data: [], error: null };

    const insert = arg(calls, "insert");
    if (insert) {
      seq += 1;
      const now = new Date().toISOString();
      const row = {
        id: `00000000-0000-4000-8000-${String(900 + seq).padStart(12, "0")}`,
        company_id: null,
        status: "queued",
        attempts: 0,
        max_attempts: 3,
        run_after: now,
        locked_at: null,
        locked_by: null,
        last_error: null,
        created_at: now,
        updated_at: now,
        ...insert[1],
      };
      db.jobs.push(row);
      db.inserted.push(structuredClone(row));
      return { data: has(calls, "single") ? { id: row.id } : [{ id: row.id }], error: null };
    }
    const update = arg(calls, "update");
    if (update) {
      const hit = db.jobs.filter((r) => matches(r, calls));
      for (const r of hit) Object.assign(r, update[1]);
      return { data: has(calls, "select") ? hit.map((r) => ({ ...r })) : null, error: null };
    }
    let rows = db.jobs.filter((r) => matches(r, calls));
    const order = arg(calls, "order");
    if (order) {
      const [, col, o] = order;
      const asc = o?.ascending !== false;
      rows = [...rows].sort(
        (a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * (asc ? 1 : -1),
      );
    }
    const limit = arg(calls, "limit")?.[1] ?? Infinity;
    const select = arg(calls, "select");
    const count = select?.[2]?.count ? rows.length : null;
    const page = rows.slice(0, limit).map((r) => ({ ...r }));
    return { data: select?.[2]?.head ? null : page, error: null, count };
  });
  service.storage = db.storage;
  globalThis.__fakeServiceClientForTests = () => service;
  globalThis.__queueHealthServiceForTests = () => service;
  globalThis.__adminNotificationsForTests = [];
  return db;
}

let seq = 0;
function job(type, over = {}) {
  seq += 1;
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    company_id: null,
    type,
    payload: {},
    status: "queued",
    attempts: 0,
    max_attempts: 3,
    run_after: PAST,
    locked_at: null,
    locked_by: null,
    last_error: null,
    created_at: PAST,
    updated_at: PAST,
    ...over,
  };
}

async function tick() {
  const res = await route.POST(
    new Request("http://localhost/api/jobs/worker", {
      headers: { authorization: `Bearer ${SECRET}` },
    }),
  );
  assert.equal(res.status, 200, "the tick never throws");
  // The route hook's NextResponse carries the body as an object.
  return res.body;
}

const alerts = (kind) =>
  globalThis.__adminNotificationsForTests.filter((n) => n.event_type === kind);

async function quiet(fn) {
  const orig = { log: console.log, warn: console.warn, error: console.error };
  for (const k of Object.keys(orig)) console[k] = () => {};
  try {
    return await fn();
  } finally {
    Object.assign(console, orig);
  }
}

/* ── 1. the alarm fails the job ───────────────────────────── */

test("#59b: Phase 1b exhausting its slice makes the interview_purge job DEAD with terminal(configuration), notifies the admins, shows on queue-health, and is not retried", async () => {
  // Twenty stamped sessions whose read takes longer than the 6 s slice.
  const row = job("interview_purge");
  world([row], { sessionsLate: 20, lateDelayMs: 6_500 });

  // The tick also schedules and runs the other daily jobs against this empty
  // world; only the purge row is under test.
  const summary = await quiet(tick);
  assert.equal(summary.dead, 1, "the tick reports one dead job");
  assert.notEqual(row.status, "succeeded", "the old void wrapper recorded this run as succeeded");

  assert.equal(row.status, "dead");
  assert.equal(row.attempts, 1, "buried on the first attempt");
  assert.match(
    row.last_error,
    /^terminal\(configuration\): \[purge\] job .* ALARM, PHASE 1B DID NOT FINISH INSIDE ITS SLICE/,
  );
  assert.match(row.last_error, /ALL PURGING HALTED THIS RUN/);
  assert.equal(row.locked_by, null);

  const dead = alerts("job_dead");
  assert.equal(dead.length, 1, "one job_dead notification to the admins");
  assert.match(JSON.stringify(dead[0]), /configuration/);

  const h = await health.readQueueHealth();
  const serialised = JSON.stringify(h);
  assert.ok(serialised.includes(row.id), "the dead row is on the queue-health page");
  assert.ok(serialised.includes("terminal(configuration)"), "with its class");

  // The chosen class is terminal: a second tick finds nothing to retry.
  const again = await quiet(tick);
  assert.equal(again.claimed, 0, "no retry was scheduled");
  assert.equal(row.status, "dead");
  assert.equal(row.attempts, 1);
});

/* ── 2. the orphan job gets its turn ──────────────────────── */

test("#59c: the orphan sweep job is claimed and run behind ten other jobs: one tick later, not never", async () => {
  queue.registerHandler("queue_sweep", async () => {});
  const fillers = Array.from({ length: 10 }, () => job("queue_sweep"));
  const orphan = job("interview_orphan_sweep", {
    run_after: new Date(Date.parse(PAST) + 1_000).toISOString(),
  });
  world([...fillers, orphan]);

  const first = await quiet(tick);
  assert.equal(first.claimed, 10, "the batch is ten: the fillers, which were due first");
  assert.equal(orphan.status, "queued", "the orphan job waits");

  const second = await quiet(tick);
  assert.ok(second.claimed >= 1);
  assert.equal(orphan.status, "succeeded", "and runs on the next tick");
  assert.equal(orphan.last_error, null);
  assert.equal(orphan.payload.cursor, null, "an empty bucket: full pass, cursor cleared");
});

/* ── 3. the cursor is carried into tomorrow's job ─────────── */

test("#59d: ensureMaintenanceScheduled copies the latest orphan job's cursor into the one it enqueues", async () => {
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString();
  const previous = job("interview_orphan_sweep", {
    status: "succeeded",
    attempts: 1,
    payload: { cursor: "s-0042" },
    created_at: twoDaysAgo,
    run_after: twoDaysAgo,
  });
  const db = world([previous]);

  const summary = await quiet(tick);
  assert.ok(
    summary.purgesScheduled.includes("interview_orphan_sweep"),
    summary.purgesScheduled.join(","),
  );
  const enqueued = db.inserted.filter((r) => r.type === "interview_orphan_sweep");
  assert.equal(enqueued.length, 1);
  assert.deepEqual(
    enqueued[0].payload,
    { cursor: "s-0042" },
    "the cursor travelled into the new job",
  );

  // The other recurring types start empty: nothing to carry.
  const others = db.inserted.filter((r) => r.type !== "interview_orphan_sweep");
  assert.ok(others.length > 0);
  for (const r of others) assert.equal("cursor" in (r.payload ?? {}), false, r.type);
});
