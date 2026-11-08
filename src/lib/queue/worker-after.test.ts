/**
 * The worker answers the scheduler at once (202, accepted) and runs the tick in
 * Next's after(). cron-job.org gives up at 30 seconds and a busy tick may run for
 * 55, so the answer must not wait. The tick's deadline still counts from the
 * request, the heartbeat is still written at the end of the work, an unauthorised
 * call schedules nothing, and no claimed job is left running.
 *
 *   node --test src/lib/queue/worker-after.test.ts
 *
 * The route and the queue are the shipped code. after() is stubbed by
 * worker-route-test-hook.mjs to hand its callback to the test, which runs it when
 * it chooses, as the platform would after sending the response. background_jobs is
 * the in-memory table the lease tests use, honouring the filters the queue sends.
 * Synthetic data only.
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { register } from "node:module";
import { afterEach, beforeEach, test } from "node:test";
import { fakeService } from "../../test-support/fake-postgrest.mjs";

register(new URL("../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../test-support/fake-service-client-hook.mjs", import.meta.url));
register(new URL("../../test-support/worker-route-test-hook.mjs", import.meta.url));

const queue = await import("../jobs-queue.ts");
const route = await import("../../app/api/jobs/worker/route.ts");
const { TerminalJobError } = await import("./failure-class.ts");
const { FUNCTION_MAX_DURATION_MS, DEADLINE_MARGIN_MS } = await import("./budgets.ts");

/** Every test bounded: a route that waits for the tick would otherwise hang the run. */
const it = (name, fn) => test(name, { timeout: 10_000 }, fn);

const SECRET = "worker-after-test-secret";
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

/** The jobs table and the heartbeat; `order` records each write, in order. */
function world(jobs, { failClaim = false } = {}) {
  const db = { jobs, heartbeat: null, order: [] };
  const service = fakeService((table, calls) => {
    if (table.startsWith("rpc:")) return { data: [], error: null };
    if (table === "worker_heartbeats") {
      const upsert = calls.find((c) => c[0] === "upsert");
      if (upsert) {
        db.heartbeat = upsert[1];
        db.order.push("heartbeat");
      }
      return { data: has(calls, "maybeSingle") ? null : [], error: null };
    }
    if (table !== "background_jobs") return { data: [], error: null };
    const update = calls.find((c) => c[0] === "update");
    if (update) {
      const hit = db.jobs.filter((r) => matches(r, calls));
      for (const r of hit) {
        Object.assign(r, update[1]);
        db.order.push(`job:${r.status}`);
      }
      return { data: has(calls, "select") ? hit.map((r) => ({ ...r })) : null, error: null };
    }
    // ensureMaintenanceScheduled's "already live?" check: yes, so only the test's jobs run.
    if (calls.some((c) => c[0] === "in" && c[1] === "status")) {
      return { data: [{ id: "live" }], error: null };
    }
    if (failClaim && calls.some((c) => c[0] === "lte" && c[1] === "run_after")) {
      throw new Error("RAW-DB-TEXT connection to 10.0.0.9 refused");
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

const call = (method = "POST", auth = `Bearer ${SECRET}`) =>
  route[method](
    new Request("http://localhost/api/jobs/worker", {
      method,
      headers: auth ? { authorization: auth } : {},
    }),
  );
const scheduled = () => (globalThis.__afterCallbacksForTests ?? []).splice(0);

let lines = [];
let saved = null;
let realNow = null;

beforeEach(() => {
  process.env.CRON_SECRET = SECRET;
  globalThis.__afterCallbacksForTests = [];
  lines = [];
  saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = (...a) => lines.push(a.map(String).join(" "));
  realNow = Date.now;
});

afterEach(() => {
  Object.assign(console, saved);
  Date.now = realNow;
});

it("202 at once, accepted not done, while the tick is still running", async () => {
  let release = null;
  let started = false;
  queue.registerHandler("send_message", async () => {
    started = true;
    await new Promise((r) => {
      release = r;
    });
  });
  const row = job("send_message");
  world([row]);

  const res = await call();
  assert.equal(res.status, 202);
  assert.deepEqual(res.body, { ok: true, accepted: true }, "no counts and no durationMs");
  assert.equal(row.status, "queued", "nothing ran before the answer");

  const [tick] = scheduled();
  assert.ok(tick, "the tick was handed to after()");
  const running = tick();
  while (!started) await new Promise((r) => setImmediate(r));
  assert.equal(row.status, "running", "the work is under way after the answer");
  release();
  const summary = await running;
  assert.equal(row.status, "succeeded");
  assert.equal(summary.succeeded, 1);
});

it("GET answers the same way: 202, one tick scheduled", async () => {
  world([]);
  const res = await call("GET");
  assert.equal(res.status, 202);
  assert.deepEqual(res.body, { ok: true, accepted: true });
  assert.equal(scheduled().length, 1);
});

it("the deadline counts from the request, not from when after() begins", async () => {
  let deadline = null;
  queue.registerHandler("send_message", async (_job, ctx) => {
    deadline = ctx.deadlineAt;
  });
  world([job("send_message")]);

  const before = realNow();
  await call();
  const answered = realNow();
  const [tick] = scheduled();
  // The platform starts after() a little later; here, 30 seconds later.
  Date.now = () => realNow() + 30_000;
  await tick();

  const budget = FUNCTION_MAX_DURATION_MS - DEADLINE_MARGIN_MS;
  assert.ok(deadline >= before + budget && deadline <= answered + budget, "from the request");
});

it("late in the budget, a long job is released, not started: nothing is left running", async () => {
  const ran = [];
  for (const t of ["transcribe", "send_message", "ai_cv_score"]) {
    queue.registerHandler(t, async () => {
      ran.push(t);
    });
  }
  const rows = [job("transcribe"), job("send_message"), job("ai_cv_score")];
  world(rows);
  await call();
  const [tick] = scheduled();
  // 30 of the 55 seconds gone before after() begins: too little for a 35-second job.
  Date.now = () => realNow() + 30_000;
  const summary = await tick();

  assert.deepEqual(ran, ["send_message"], "only the job that fits ran");
  assert.equal(summary.released, 2);
  assert.ok(
    rows.every((r) => r.status !== "running"),
    "no claimed job abandoned",
  );
  assert.deepEqual(
    rows.map((r) => r.attempts),
    [0, 0, 0],
    "a release charges no attempt",
  );
});

it("nothing abandoned: every claimed job ends succeeded, queued for retry or dead", async () => {
  const handlers = {
    send_message: async () => {},
    interview_reminder: async () => {
      throw new Error("provider 503");
    },
    interview_expiry: async () => {
      throw new TerminalJobError("deterministic", "bad input");
    },
  };
  for (const [t, h] of Object.entries(handlers)) queue.registerHandler(t, h);
  const rows = Object.keys(handlers).map((t) => job(t));
  const db = world(rows);
  await call();
  const summary = await scheduled()[0]();

  assert.equal(summary.claimed, 3);
  assert.deepEqual(
    rows.map((r) => r.status),
    ["succeeded", "queued", "dead"],
  );
  assert.ok(
    rows.every((r) => r.locked_by === null),
    "no lease left held",
  );
  assert.equal(db.order.at(-1), "heartbeat", "the heartbeat is the last write");
  assert.ok(db.order.indexOf("heartbeat") > db.order.lastIndexOf("job:dead"), "after the work");
  assert.equal(db.heartbeat.claimed, 3);
  assert.ok(
    lines.some((l) => l.startsWith("[worker] tick done: ") && l.includes('"claimed":3')),
    "the outcome is logged at the end",
  );
});

it("an error inside the tick is logged by name only; the answer already sent stands", async () => {
  const db = world([job("send_message")], { failClaim: true });
  const res = await call();
  assert.equal(res.status, 202);
  const outcome = await scheduled()[0]();
  assert.equal(outcome, null);
  assert.ok(lines.includes("[worker] drain failed (Error)"), lines.join(" | "));
  assert.doesNotMatch(lines.join(" "), /RAW-DB-TEXT|10\.0\.0\.9/);
  assert.equal(db.heartbeat, null, "a tick that failed writes no heartbeat");
});

it("unauthorised: 401 and nothing scheduled, for POST, GET and OPTIONS", async () => {
  world([job("send_message")]);
  for (const method of ["POST", "GET", "OPTIONS"]) {
    for (const auth of [null, "Bearer wrong-secret"]) {
      const res = await call(method, auth);
      assert.equal(res.status, 401, `${method} ${auth ?? "no header"}`);
    }
  }
  assert.equal(scheduled().length, 0);
});

it("OPTIONS is unchanged: the registered types, at once, nothing scheduled", async () => {
  world([]);
  const res = await call("OPTIONS");
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.deepEqual(res.body.registeredTypes, queue.registeredTypes());
  assert.equal(scheduled().length, 0);
});
