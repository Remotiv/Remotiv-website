/**
 * completeJob and failJob write only under the lease this run claimed with
 * (status 'running', same locked_by), as releaseJob, yieldJob and the reclaim
 * already do. The worker counts a job, and raises the dead-job alert, only on
 * a confirmed write. Driven end to end through the real worker route against
 * an in-memory background_jobs table that honours the filters.
 *
 *   node --test src/lib/queue/lease.test.ts
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
import { fakeService } from "../../test-support/fake-postgrest.mjs";

register(new URL("../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../test-support/fake-service-client-hook.mjs", import.meta.url));
register(new URL("../../test-support/worker-route-test-hook.mjs", import.meta.url));

const queue = await import("../jobs-queue.ts");
const route = await import("../../app/api/jobs/worker/route.ts");
const { TerminalJobError } = await import("./failure-class.ts");

const SECRET = "worker-route-test-secret";
process.env.CRON_SECRET = SECRET;

const PAST = new Date(Date.now() - 60_000).toISOString();
const has = (calls, method) => calls.some((c) => c[0] === method);

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

/**
 * The jobs table, the heartbeat, and the admin alerts. `failUpdate(patch)`
 * makes the next matching background_jobs update answer a database error.
 */
function world(jobs) {
  const db = { jobs, heartbeat: null, failUpdate: null };
  const service = fakeService((table, calls) => {
    if (table.startsWith("rpc:")) return { data: [], error: null };
    if (table === "worker_heartbeats") {
      const upsert = calls.find((c) => c[0] === "upsert");
      if (upsert) db.heartbeat = upsert[1];
      return { data: has(calls, "maybeSingle") ? null : [], error: null };
    }
    if (table !== "background_jobs") return { data: [], error: null };
    const update = calls.find((c) => c[0] === "update");
    if (update) {
      if (db.failUpdate?.(update[1])) {
        db.failUpdate = null;
        return { data: null, error: { message: "connection reset" } };
      }
      const hit = db.jobs.filter((r) => matches(r, calls));
      for (const r of hit) Object.assign(r, update[1]);
      return { data: has(calls, "select") ? hit.map((r) => ({ ...r })) : null, error: null };
    }
    // ensureMaintenanceScheduled's "already live?" check: say yes, so no
    // purge is enqueued and only the test's own jobs run.
    if (calls.some((c) => c[0] === "in" && c[1] === "status")) {
      return { data: [{ id: "live" }], error: null };
    }
    const limit = calls.find((c) => c[0] === "limit")?.[1] ?? Infinity;
    const rows = db.jobs.filter((r) => matches(r, calls)).slice(0, limit);
    return { data: rows.map((r) => ({ ...r })), error: null };
  });
  globalThis.__fakeServiceClientForTests = () => service;
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
  return res.body;
}

const alerts = (kind) =>
  globalThis.__adminNotificationsForTests.filter((n) => n.event_type === kind);

/** Capture console output for one block, so logs can be asserted and kept quiet. */
async function captureLogs(fn) {
  const lines = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  for (const k of Object.keys(orig)) console[k] = (...a) => lines.push(a.map(String).join(" "));
  try {
    await fn();
  } finally {
    Object.assign(console, orig);
  }
  return lines;
}

/** One tick with its console output captured: the summary and the log lines. */
async function quietTick() {
  let summary = null;
  const logs = await captureLogs(async () => {
    summary = await tick();
  });
  return { summary, logs };
}

/** Another run reclaimed this job's lease and claimed it again, mid-handler. */
function takeOver(row) {
  Object.assign(row, {
    status: "running",
    attempts: row.attempts + 1,
    locked_by: "worker-other-run",
    locked_at: new Date().toISOString(),
    last_error: "reclaimed: lease expired",
    updated_at: new Date().toISOString(),
  });
  return { ...row };
}

const OUTCOMES = {
  ok: async () => {},
  retry: async () => {
    throw new Error("provider 503");
  },
  terminal: async () => {
    throw new TerminalJobError("deterministic", "bad input");
  },
};

/* ── lease held: as before, for every registered job type ──────── */

test("lease held: every job type succeeds, retries and dies exactly as before", async () => {
  const types = queue.registeredTypes();
  assert.ok(types.length >= 18, `every handler is registered (${types.length})`);
  for (const type of types) {
    for (const [outcome, handler] of Object.entries(OUTCOMES)) {
      const row = job(type);
      const db = world([row]);
      queue.registerHandler(type, handler);
      const { summary } = await quietTick();
      const label = `${type} ${outcome}`;
      assert.equal(summary.claimed, 1, label);
      if (outcome === "ok") {
        assert.equal(summary.succeeded, 1, label);
        assert.equal(row.status, "succeeded", label);
        assert.equal(row.locked_by, null, label);
        assert.equal(row.last_error, null, label);
      } else if (outcome === "retry") {
        assert.equal(summary.failed, 1, label);
        assert.equal(row.status, "queued", label);
        assert.equal(row.attempts, 1, label);
        assert.ok(row.run_after > PAST, `${label}: backed off`);
      } else {
        assert.equal(summary.dead, 1, label);
        assert.equal(row.status, "dead", label);
        assert.equal(alerts("job_dead").length, 1, `${label}: one dead-job alert`);
      }
      if (outcome !== "terminal") assert.equal(alerts("job_dead").length, 0, label);
      assert.deepEqual(
        [db.heartbeat.succeeded, db.heartbeat.failed, db.heartbeat.dead],
        [summary.succeeded, summary.failed, summary.dead],
        label,
      );
    }
  }
});

test("a retryable failure on its last attempt dies and alerts, as before", async () => {
  const row = job("send_message", { attempts: 2 });
  world([row]);
  queue.registerHandler("send_message", OUTCOMES.retry);
  const { summary } = await quietTick();
  assert.equal(summary.dead, 1);
  assert.equal(row.status, "dead");
  assert.equal(alerts("job_dead").length, 1);
});

/* ── lease taken over: the other run's job untouched, nothing counted ── */

for (const [outcome, fail] of [
  ["succeeds", null],
  ["fails, retryable", new Error("provider 503")],
  ["fails, terminal (would be dead)", new TerminalJobError("deterministic", "bad input")],
  ["fails on its last attempt (would be dead)", new Error("provider 503")],
]) {
  test(`lease taken over while the handler ran, which then ${outcome}: no write, no count, no alert, no throw`, async () => {
    const row = job("send_message", outcome.includes("last attempt") ? { attempts: 2 } : {});
    const db = world([row]);
    let theirs = null;
    queue.registerHandler("send_message", async () => {
      theirs = takeOver(row);
      if (fail) throw fail;
    });
    const { summary, logs } = await quietTick();
    assert.deepEqual(row, theirs, "the other run's job is exactly as it left it");
    assert.deepEqual(
      [summary.succeeded, summary.failed, summary.dead],
      [0, 0, 0],
      "nothing counted",
    );
    assert.deepEqual([db.heartbeat.succeeded, db.heartbeat.failed, db.heartbeat.dead], [0, 0, 0]);
    assert.equal(alerts("job_dead").length, 0, "no dead-job alert");
    const lost = logs.filter((l) => l.includes("lease lost"));
    assert.equal(lost.length, 1);
    assert.match(lost[0], new RegExp(`lease lost on ${row.id};`));
  });
}

test("lease taken over and the job already reclaimed to the queue: left queued for the next run", async () => {
  const row = job("send_message");
  world([row]);
  let theirs = null;
  queue.registerHandler("send_message", async () => {
    Object.assign(row, { status: "queued", locked_by: null, locked_at: null, attempts: 1 });
    theirs = { ...row };
  });
  const { summary } = await quietTick();
  assert.deepEqual(row, theirs);
  assert.equal(summary.succeeded, 0);
});

test("the lease-lost log carries the job id only", async () => {
  const row = job("send_message", { payload: { email: "someone@example.com" } });
  world([row]);
  queue.registerHandler("send_message", async () => {
    takeOver(row);
  });
  const logs = await captureLogs(async () => {
    await tick();
  });
  const lost = logs.filter((l) => l.includes("lease lost"));
  assert.deepEqual(lost, [
    `[jobs-queue] completeJob: lease lost on ${row.id}; not marked succeeded`,
  ]);
});

/* ── a database error stays visible, and is not counted as done ── */

test("db_error on completion: logged, not counted, the lease left for the reclaim", async () => {
  const row = job("send_message");
  const db = world([row]);
  queue.registerHandler("send_message", OUTCOMES.ok);
  db.failUpdate = (patch) => patch.status === "succeeded";
  const { summary, logs } = await quietTick();
  assert.equal(summary.succeeded, 0);
  assert.equal(row.status, "running", "still this run's lease");
  assert.ok(
    logs.some((l) => l.startsWith("[jobs-queue] completeJob failed:")),
    "visible",
  );
  assert.ok(!logs.some((l) => l.includes("lease lost")), "not mistaken for a lost lease");
});

test("db_error on a terminal failure: logged, not counted dead, no alert", async () => {
  const row = job("send_message");
  const db = world([row]);
  queue.registerHandler("send_message", OUTCOMES.terminal);
  db.failUpdate = (patch) => patch.status === "dead";
  const { summary, logs } = await quietTick();
  assert.deepEqual([summary.dead, summary.failed], [0, 0]);
  assert.equal(alerts("job_dead").length, 0);
  assert.equal(row.status, "running");
  assert.ok(
    logs.some((l) => l.startsWith("[jobs-queue] failJob failed:")),
    "visible",
  );
  assert.ok(!logs.some((l) => l.includes("lease lost")));
});

/* ── the functions themselves ─────────────────────────────────── */

test("completeJob and failJob answer what the write did", async () => {
  const mine = { ...job("send_message"), status: "running", locked_by: "worker-me" };
  const db = world([{ ...mine }]);
  await captureLogs(async () => {
    assert.equal(await queue.completeJob(mine), "succeeded");
    db.jobs[0] = { ...mine };
    assert.equal(await queue.failJob(mine, new Error("x")), "queued");
    db.jobs[0] = { ...mine };
    assert.equal(await queue.failJob(mine, new TerminalJobError("deterministic", "x")), "dead");
    db.jobs[0] = { ...mine, locked_by: "worker-other" };
    assert.equal(await queue.completeJob(mine), "lease_lost");
    assert.equal(await queue.failJob(mine, new Error("x")), "lease_lost");
    db.jobs[0] = { ...mine, locked_by: null };
    assert.equal(await queue.completeJob({ ...mine, locked_by: null }), "lease_lost");
    db.jobs[0] = { ...mine };
    db.failUpdate = () => true;
    assert.equal(await queue.completeJob(mine), "db_error");
    db.failUpdate = () => true;
    assert.equal(await queue.failJob(mine, new Error("x")), "db_error");
  });
  assert.equal(db.jobs[0].status, "running", "neither error wrote anything");
});
