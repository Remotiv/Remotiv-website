/**
 * readQueueHealth against a fake service: a failed read must surface as an
 * error CATEGORY, never as a healthy-looking zero, and never as the raw
 * database message.
 *
 *   node --test src/lib/queue-health.test.ts
 *
 * queue-health.ts imports `@/` paths, so this registers the resolve hook and
 * installs a fake builder through the module's test seam
 * (globalThis.__queueHealthServiceForTests) before importing it.
 */
// @ts-nocheck — same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

// Order matters, and it is the REVERSE of reading order: Node calls the most
// recently registered hook first. The companion stub must see the bare
// specifiers (`server-only`, `@/lib/supabase/server`, `@/lib/jobs-queue`)
// before node-resolve.mjs rewrites `@/` paths into file URLs, so it is
// registered LAST. Anything it does not stub falls through to node-resolve.
register(new URL("../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../test-support/queue-health-test-hook.mjs", import.meta.url));

/**
 * A minimal PostgREST-builder impersonator. Every chained call returns the same
 * proxy and records itself; awaiting the proxy resolves to whatever
 * `respond(table, calls)` decides. Thenable, so `await q.limit(1)` and
 * `await q.maybeSingle()` behave exactly as on the real client.
 */
function fakeService(respond) {
  return {
    from(table) {
      const calls = [];
      const q = new Proxy(
        {},
        {
          get(_t, prop) {
            if (prop === "then") {
              return (resolve, reject) =>
                Promise.resolve(respond(table, calls)).then(resolve, reject);
            }
            return (...args) => {
              calls.push([prop, ...args]);
              return q;
            };
          },
        },
      );
      return q;
    },
  };
}

async function withFakeService(respond, fn) {
  globalThis.__queueHealthServiceForTests = () => fakeService(respond);
  try {
    const { readQueueHealth } = await import("./queue-health.ts");
    return await fn(readQueueHealth);
  } finally {
    delete globalThis.__queueHealthServiceForTests;
  }
}

const ok = (data, count = 0) => ({ data, count, error: null });
const RAW = 'relation "public.worker_heartbeats" does not exist';

function healthyResponder(table, calls) {
  if (table === "background_jobs") {
    const sel = calls.find((c) => c[0] === "select");
    if (sel?.[2]?.head) return ok(null, 0);
    return ok([], 0);
  }
  if (table === "worker_heartbeats") return ok({ last_tick_at: "2026-10-01T12:00:00.000Z" });
  return ok([]);
}

const silenced = async (fn) => {
  const orig = console.error;
  const logged = [];
  console.error = (...a) => logged.push(a.join(" "));
  try {
    return await fn(logged);
  } finally {
    console.error = orig;
  }
};

test("healthy idle queue: no read errors, zero totals, heartbeat surfaced", async () => {
  await withFakeService(healthyResponder, async (readQueueHealth) => {
    const h = await readQueueHealth();
    assert.deepEqual(h.readErrors, []);
    assert.equal(h.totals.queued, 0);
    assert.equal(h.totals.dead, 0);
    assert.equal(h.lastTickAt, "2026-10-01T12:00:00.000Z");
    assert.equal(h.oldestQueued, null);
  });
});

test("a failed read is reported by category only; the raw message goes to the server log", async () => {
  const responder = (table, calls) =>
    table === "worker_heartbeats"
      ? { data: null, count: null, error: { message: RAW } }
      : healthyResponder(table, calls);
  await silenced(async (logged) => {
    await withFakeService(responder, async (readQueueHealth) => {
      const h = await readQueueHealth();
      assert.deepEqual(h.readErrors, [{ source: "worker heartbeat" }]);
      assert.equal(h.lastTickAt, null);
      const wire = JSON.stringify(h);
      assert.ok(!wire.includes(RAW), "raw message leaked into QueueHealth");
      assert.ok(!wire.includes("does not exist"));
      assert.ok(
        logged.some((l) => l.includes("read failed (worker heartbeat)") && l.includes(RAW)),
        "raw message must reach the server log",
      );
    });
  });
});

test("a failed status page is named as an error, not rendered as an empty status", async () => {
  const responder = (table, calls) => {
    if (table === "background_jobs") {
      const isHead = calls.some((c) => c[0] === "select" && c[2]?.head);
      const eqDead = calls.some((c) => c[0] === "eq" && c[1] === "status" && c[2] === "dead");
      if (eqDead && !isHead) return { data: null, count: null, error: { message: "connection reset" } };
    }
    return healthyResponder(table, calls);
  };
  await silenced(async () => {
    await withFakeService(responder, async (readQueueHealth) => {
      const h = await readQueueHealth();
      assert.ok(h.readErrors.some((e) => e.source === "dead page"), JSON.stringify(h.readErrors));
      assert.ok(!JSON.stringify(h.readErrors).includes("connection reset"));
    });
  });
});

test("a null count on a SUCCESSFUL read is a legitimate zero, not an error", async () => {
  const responder = (table, calls) =>
    table === "background_jobs" ? { data: [], count: null, error: null } : healthyResponder(table, calls);
  await withFakeService(responder, async (readQueueHealth) => {
    const h = await readQueueHealth();
    assert.deepEqual(h.readErrors, []);
    assert.equal(h.totals.queued, 0);
  });
});
