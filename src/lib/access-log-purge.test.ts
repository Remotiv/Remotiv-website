/**
 * The daily access-record purge (lib/access-log-purge.ts, migration 047): it
 * only ever asks the database to purge, in batches, and never says what is
 * old. Driven with a fake service; the SQL itself is proven in PGlite.
 *
 *   node --test src/lib/access-log-purge.test.ts
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../test-support/node-resolve.mjs", import.meta.url));
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

const { ACCESS_LOG_PURGE_BATCH, handleAccessLogPurge } = await import("./access-log-purge.ts");

/** A service whose purge answers each call from `answers`, in order. */
function serviceAnswering(answers) {
  const calls = [];
  return {
    calls,
    rpc(name, args) {
      calls.push({ name, args });
      const next = answers[Math.min(calls.length - 1, answers.length - 1)];
      return Promise.resolve(typeof next === "function" ? next() : next);
    },
  };
}
const counts = (a, s) => ({
  data: [{ admin_access_logs_deleted: a, signed_url_logs_deleted: s }],
  error: null,
});

async function run(service, now) {
  const lines = [];
  const orig = { log: console.log, error: console.error };
  console.log = console.error = (...a) => lines.push(a.join(" "));
  try {
    await handleAccessLogPurge({ id: "job-1", payload: {} }, undefined, { service, now });
    return { lines, error: null };
  } catch (error) {
    return { lines, error };
  } finally {
    Object.assign(console, orig);
  }
}

test("calls the purge in batches until both tables come back short, and logs the totals", async () => {
  const full = ACCESS_LOG_PURGE_BATCH;
  const service = serviceAnswering([counts(full, 3), counts(2, full), counts(0, 7)]);
  const { lines, error } = await run(service);
  assert.equal(error, null);
  assert.equal(service.calls.length, 3);
  assert.deepEqual(lines, [
    `[access-log-purge] job job-1: admin_access_logs=${full + 2} signed_url_logs=${3 + full + 7} batches=3`,
  ]);
});

test("never says what is old: every call carries the batch size and nothing else", async () => {
  const service = serviceAnswering([counts(ACCESS_LOG_PURGE_BATCH, 0), counts(0, 0)]);
  await run(service);
  assert.deepEqual(service.calls, [
    { name: "purge_expired_access_logs", args: { p_limit: 1000 } },
    { name: "purge_expired_access_logs", args: { p_limit: 1000 } },
  ]);
  assert.equal(ACCESS_LOG_PURGE_BATCH, 1000);
});

test("stops on its budget and says so; the next run carries on", async () => {
  let t = 0;
  const service = serviceAnswering([
    () => {
      t += 10_000;
      return counts(ACCESS_LOG_PURGE_BATCH, ACCESS_LOG_PURGE_BATCH);
    },
  ]);
  const { lines, error } = await run(service, () => t);
  assert.equal(error, null);
  assert.equal(service.calls.length, 2, "18s budget: two 10s calls, then it stops");
  assert.match(lines[0], /batches=2 \(budget reached - resumes next run\)$/);
});

test("a database error throws a fixed sentence, so the queue retries; the log has the code only", async () => {
  const service = serviceAnswering([
    { data: null, error: { code: "42501", message: "permission denied for secret detail" } },
  ]);
  const { lines, error } = await run(service);
  assert.equal(error?.message, "access log purge: the purge function failed");
  assert.deepEqual(lines, ["[access-log-purge] job job-1: purge failed (42501)"]);
  assert.ok(lines.every((l) => !/secret detail/.test(l)));
});

test("an answer without counts throws rather than reporting zero", async () => {
  for (const answer of [
    { data: [], error: null },
    { data: [{ admin_access_logs_deleted: "2" }], error: null },
  ]) {
    const { error } = await run(serviceAnswering([answer]));
    assert.equal(error?.message, "access log purge: the purge function returned no counts");
  }
});

test("source: no age, date or cutoff is computed in the job", () => {
  const src = readFileSync(new URL("./access-log-purge.ts", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(
    src,
    /months|interval|cutoff|toISOString|new Date|granted_at|created_at|\.delete\(/,
  );
  assert.match(
    src,
    /service\.rpc\("purge_expired_access_logs", \{\s*p_limit: ACCESS_LOG_PURGE_BATCH,\s*\}\)/,
  );
});

test("scheduled daily, registered, and the twentieth job type", () => {
  const queue = readFileSync(new URL("./jobs-queue.ts", import.meta.url), "utf8");
  assert.match(queue, /ACCESS_LOG_PURGE: "access_log_purge",\n\} as const;/);
  assert.match(queue, /registerHandler\(JOB_TYPES\.ACCESS_LOG_PURGE, handleAccessLogPurge\);/);
  assert.match(
    queue,
    /\{ type: JOB_TYPES\.ACCESS_LOG_PURGE, intervalMs: PURGE_INTERVAL_MS \},\n\];/,
  );
  assert.match(queue, /const PURGE_INTERVAL_MS = 24 \* 60 \* 60 \* 1000;/);
});

test("a day with nothing due still runs once and logs its zero counts", async () => {
  const service = serviceAnswering([counts(0, 0)]);
  const { lines, error } = await run(service);
  assert.equal(error, null);
  assert.equal(service.calls.length, 1);
  assert.deepEqual(lines, [
    "[access-log-purge] job job-1: admin_access_logs=0 signed_url_logs=0 batches=1",
  ]);
});
