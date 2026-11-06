/**
 * The orphan sweep's admin actions against a fake database (#72).
 *
 *   node --test src/app/admin/erasure/actions.test.ts
 *
 * Drives the real previewOrphanSweep and runOrphanSweep with a fake service
 * whose rpc() answers are chosen per test, and a stubbed super-admin guard.
 * What is proved: the preview only reads; the sweep passes the operation id,
 * the actor and a cutoff one window back; 23505 is answered by re-reading
 * the record and is a real error when no record exists; nothing raw from
 * the database reaches the caller.
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
import { call, fakeService } from "../../../test-support/fake-postgrest.mjs";

register(new URL("../../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../../test-support/fake-service-client-hook.mjs", import.meta.url));
register(new URL("../../../test-support/admin-erasure-test-hook.mjs", import.meta.url));

const { previewOrphanSweep, runOrphanSweep } = await import("./actions.ts");
const { isOperationId, readSweepCounts, SWEEP_WINDOW_DAYS, sweepCutoff } = await import(
  "../../../lib/erasure/orphan-sweep.ts"
);

const ADMIN = { user: { id: "admin-user-1", email: "ops@remotiv.test" }, role: "super_admin" };
const OP = "0f1e2d3c-4b5a-4968-8777-665544332211";
const COUNTS = { communication_logs: 3, notifications_company: 2 };
const RAW = "permission denied for function erase_orphaned_message_rows";

const ok = (data) => ({ data, error: null });

/**
 * `preview` and `sweep` are the rpc answers; `record` is what the audit
 * table holds for OP (a row, null, or "error").
 */
function world({ preview = ok(COUNTS), sweep = ok(COUNTS), record = null } = {}) {
  const service = fakeService((table) => {
    switch (table) {
      case "rpc:preview_orphaned_message_rows":
        return preview;
      case "rpc:erase_orphaned_message_rows":
        return sweep;
      case "candidate_erasures":
        if (record === "error") return { data: null, error: { message: RAW } };
        return ok(record);
      default:
        throw new Error(`unexpected table ${table}`);
    }
  });
  return service;
}

async function run(service, fn) {
  const saved = console.error;
  console.error = () => {};
  globalThis.__fakeServiceClientForTests = () => service;
  globalThis.__adminCtxForTests = ADMIN;
  try {
    return await fn();
  } finally {
    console.error = saved;
    delete globalThis.__fakeServiceClientForTests;
    delete globalThis.__adminCtxForTests;
  }
}

const reads = (service) => service.queries.map((q) => q.table);
const rpcNames = (service) => service.rpcs.map((r) => r.name);
const withinWindow = (iso, startedMs) => {
  const expected = sweepCutoff(startedMs).getTime();
  return Math.abs(Date.parse(iso) - expected) < 5_000;
};

/* ── the pure parts ──────────────────────────────────────────── */

test("the cutoff is exactly one window back", () => {
  const now = Date.UTC(2026, 10, 6, 12, 0, 0);
  assert.equal(sweepCutoff(now).getTime(), now - SWEEP_WINDOW_DAYS * 86_400_000);
  assert.equal(SWEEP_WINDOW_DAYS, 30, "the window the sweep function enforces");
});

test("only the two-count shape is read as counts", () => {
  assert.deepEqual(readSweepCounts(COUNTS), COUNTS);
  for (const bad of [
    null,
    "3",
    {},
    { communication_logs: 3 },
    { communication_logs: -1, notifications_company: 0 },
    { communication_logs: 1.5, notifications_company: 0 },
    { communication_logs: "3", notifications_company: 2 },
  ]) {
    assert.equal(readSweepCounts(bad), null, JSON.stringify(bad));
  }
});

test("an operation id must be a uuid", () => {
  assert.equal(isOperationId(OP), true);
  for (const bad of ["", "op-1", OP.slice(1), 42, null, `${OP}x`])
    assert.equal(isOperationId(bad), false, String(bad));
});

/* ── the guard ───────────────────────────────────────────────── */

test("without a super admin neither action reaches the database", async () => {
  const service = world();
  globalThis.__fakeServiceClientForTests = () => service;
  try {
    await assert.rejects(previewOrphanSweep(), /super_admin/);
    await assert.rejects(runOrphanSweep(OP), /super_admin/);
  } finally {
    delete globalThis.__fakeServiceClientForTests;
  }
  assert.deepEqual(rpcNames(service), []);
  assert.deepEqual(reads(service), []);
});

/* ── preview ─────────────────────────────────────────────────── */

test("the preview calls only the read-only function, with a cutoff one window back, and writes nothing", async () => {
  const service = world();
  const started = Date.now();
  const out = await run(service, () => previewOrphanSweep());
  assert.deepEqual(out, { ok: true, counts: COUNTS, cutoff: out.cutoff });
  assert.deepEqual(rpcNames(service), ["preview_orphaned_message_rows"]);
  assert.ok(withinWindow(service.rpcs[0].args.p_orphaned_before, started));
  assert.deepEqual(reads(service), [], "no table is touched");
});

test("a failed preview says so without the database's words", async () => {
  const out = await run(world({ preview: { data: null, error: { message: RAW } } }), () =>
    previewOrphanSweep(),
  );
  assert.deepEqual(out, { ok: false, error: "The preview could not be read." });
  const odd = await run(world({ preview: ok({ rows: 3 }) }), () => previewOrphanSweep());
  assert.equal(odd.ok, false);
  assert.ok(!JSON.stringify(odd).includes(RAW));
});

/* ── sweep ───────────────────────────────────────────────────── */

test("the sweep passes the operation id, the actor and the cutoff, and reports what cleared", async () => {
  const service = world();
  const started = Date.now();
  const out = await run(service, () => runOrphanSweep(OP));
  assert.equal(out.ok, true);
  assert.deepEqual(out.counts, COUNTS);
  assert.equal(out.committed, "now");
  assert.deepEqual(rpcNames(service), ["erase_orphaned_message_rows"]);
  const args = service.rpcs[0].args;
  assert.equal(args.p_operation_id, OP);
  assert.equal(args.p_performed_by, ADMIN.user.id);
  assert.ok(withinWindow(args.p_orphaned_before, started));
  assert.deepEqual(reads(service), [], "no re-read when the function answered");
});

test("a bad operation id is refused before any call", async () => {
  const service = world();
  const out = await run(service, () => runOrphanSweep("not-a-uuid"));
  assert.deepEqual(out, {
    ok: false,
    error: "A sweep needs a client-generated operation id.",
    retry: "none",
  });
  assert.deepEqual(rpcNames(service), []);
});

test("23505 with a record for this operation id means it committed earlier; its counts are the answer", async () => {
  const service = world({
    sweep: {
      data: null,
      error: { code: "23505", message: "duplicate key value violates unique constraint" },
    },
    record: { cleared: { communication_logs: 7, notifications_company: 1 } },
  });
  const out = await run(service, () => runOrphanSweep(OP));
  assert.deepEqual(out, {
    ok: true,
    counts: { communication_logs: 7, notifications_company: 1 },
    cutoff: out.cutoff,
    committed: "earlier",
  });
  const read = service.queries.find((q) => q.table === "candidate_erasures");
  assert.ok(read, "the record was re-read");
  assert.deepEqual(call(read.calls, "select"), ["select", "cleared"]);
  assert.deepEqual(call(read.calls, "eq"), ["eq", "operation_id", OP]);
});

test("23505 with no record is a different constraint and a real error, not a retry", async () => {
  const out = await run(
    world({ sweep: { data: null, error: { code: "23505", message: RAW } }, record: null }),
    () => runOrphanSweep(OP),
  );
  assert.equal(out.ok, false);
  assert.equal(out.retry, "none");
  assert.ok(!JSON.stringify(out).includes(RAW));
});

test("23505 whose record cannot be read asks for a retry with the same id", async () => {
  const out = await run(
    world({ sweep: { data: null, error: { code: "23505", message: RAW } }, record: "error" }),
    () => runOrphanSweep(OP),
  );
  assert.deepEqual(out, {
    ok: false,
    error: "The sweep may have run; its record could not be read. Retry with the same id.",
    retry: "same-id",
  });
});

test("any other failure asks for a retry with the same id and keeps the database's words out", async () => {
  const service = world({ sweep: { data: null, error: { message: RAW } } });
  const out = await run(service, () => runOrphanSweep(OP));
  assert.deepEqual(out, {
    ok: false,
    error: "The sweep did not run. Retry with the same operation id.",
    retry: "same-id",
  });
  assert.deepEqual(reads(service), [], "no re-read without a 23505");
});

test("an answer in an unexpected shape is not reported as a sweep", async () => {
  const out = await run(world({ sweep: ok({ rows: 5 }) }), () => runOrphanSweep(OP));
  assert.equal(out.ok, false);
  assert.equal(out.retry, "none");
});
