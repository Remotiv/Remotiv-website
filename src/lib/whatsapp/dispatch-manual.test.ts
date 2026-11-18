/**
 * A recruiter's WhatsApp message is sent AT MOST ONCE, and Stop works until
 * the dispatcher claims it (#52, QA-SAFETY-40 M-1, migration 064).
 *
 *   node --test "src/lib/whatsapp/dispatch-manual.test.ts"
 *
 * The real dispatcher and queueManualWhatsApp against test-support's
 * fake-attempt-db (which models queue_manual_whatsapp and
 * claim_manual_communication_log) and a fake Meta. "Sent" means a request
 * reached the fake Meta. No real network: fetch is the fake Meta, and every
 * other path is blocked by the guard. Synthetic data only.
 */
// @ts-nocheck - same reason as stage-tabs.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

import {
  APP_ID,
  attemptDb,
  COMPANY_ID,
  logById,
  stamp,
} from "../../test-support/fake-attempt-db.mjs";
import { blockNetwork } from "../../test-support/no-network.mjs";

const guard = blockNetwork();
register(new URL("../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../test-support/whatsapp-dispatch-test-hook.mjs", import.meta.url));

const { handleWhatsAppMessage, queueManualWhatsApp, UNCERTAIN_NOTE } = await import(
  "./dispatch.ts"
);

const META = {
  ok: () => new Response(JSON.stringify({ messages: [{ id: "wamid.ok" }] }), { status: 200 }),
  terminal: () =>
    new Response(JSON.stringify({ error: { message: "Template does not exist", code: 132001 } }), {
      status: 400,
    }),
  transient: () => new Response("{}", { status: 500 }),
  noId: () => new Response("{}", { status: 200 }),
  timeout: () => {
    throw new DOMException("The operation timed out.", "TimeoutError");
  },
};

/** A row exactly as queue_manual_whatsapp leaves it: queued, unclaimed, a recruiter's. */
const queuedRow = (over = {}) => ({
  id: "log-q",
  company_id: COMPANY_ID,
  application_id: APP_ID,
  event: "interview",
  channel: "whatsapp",
  status: "queued",
  sent_by_name: "Rae",
  error: null,
  attempt_started_at: null,
  ...over,
});

/** Run the job once with a fake Meta; answers Meta calls, whether it threw, and the logs. */
async function run(world, { meta = "ok", attempts = 0, payload = {}, onMeta } = {}) {
  const { service, db } = world;
  const metaCalls = [];
  const saved = {
    fetch: globalThis.fetch,
    token: process.env.WHATSAPP_ACCESS_TOKEN,
    phoneId: process.env.WHATSAPP_PHONE_NUMBER_ID,
    log: console.log,
    warn: console.warn,
    error: console.error,
  };
  const logs = [];
  globalThis.__whatsappDispatchServiceForTests = () => service;
  globalThis.fetch = async (_url, init) => {
    metaCalls.push(init?.body);
    onMeta?.(db);
    return META[meta]();
  };
  process.env.WHATSAPP_ACCESS_TOKEN = "test-token";
  process.env.WHATSAPP_PHONE_NUMBER_ID = "test-phone-id";
  for (const k of ["log", "warn", "error"])
    console[k] = (...a) => logs.push(a.map(String).join(" "));
  let threw = null;
  try {
    await handleWhatsAppMessage({
      id: "job-1",
      attempts,
      payload: {
        applicationId: APP_ID,
        event: "interview",
        channel: "whatsapp",
        sentByName: "Rae",
        logId: "log-q",
        ...payload,
      },
    });
  } catch (err) {
    threw = err;
  } finally {
    delete globalThis.__whatsappDispatchServiceForTests;
    globalThis.fetch = saved.fetch;
    for (const [k, v] of [
      ["WHATSAPP_ACCESS_TOKEN", saved.token],
      ["WHATSAPP_PHONE_NUMBER_ID", saved.phoneId],
    ]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    Object.assign(console, { log: saved.log, warn: saved.warn, error: saved.error });
  }
  // The failure alert resolves its recipients first: the same signal dispatch-claim uses.
  const alerted = service.queries.some((q) => q.table === "company_members");
  return { metaCalls, threw, logs, alerted, db };
}

// ── The queued path ─────────────────────────────────────────

test("claimed then accepted: one Meta call, 'sent' with Meta's id; a second run of the same job sends nothing", async () => {
  const world = attemptDb({ logs: [queuedRow()] });
  const first = await run(world);
  assert.equal(first.metaCalls.length, 1);
  assert.equal(first.threw, null);
  const row = logById(world.db, "log-q");
  assert.equal(row.status, "sent");
  assert.equal(row.provider_message_id, "wamid.ok");
  assert.match(
    row.attempt_started_at,
    /^2026-11-16T10:00:\d\d\.123456\+00:00$/,
    "the database's stamp",
  );
  const second = await run(world);
  assert.equal(second.metaCalls.length, 0, "finished: never sent again");
  assert.equal(second.threw, null);
});

test("Stop BEFORE the claim: 'stopped', nothing sent, the row stays cancelled", async () => {
  const world = attemptDb({
    logs: [queuedRow({ status: "cancelled", error: "Cancelled from Messages." })],
  });
  const r = await run(world);
  assert.equal(r.metaCalls.length, 0);
  assert.equal(r.threw, null);
  assert.equal(logById(world.db, "log-q").status, "cancelled");
});

test("an earlier run claimed it and died (possibly after Meta accepted): 'uncertain', marked not confirmed, someone told, NEVER sent again", async () => {
  const world = attemptDb({ logs: [queuedRow({ attempt_started_at: stamp(3) })] });
  const r = await run(world, { attempts: 1 });
  assert.equal(r.metaCalls.length, 0);
  assert.equal(r.threw, null);
  const row = logById(world.db, "log-q");
  assert.equal(row.status, "failed");
  assert.equal(row.error, UNCERTAIN_NOTE);
  assert.ok(r.alerted, "someone is told");
});

for (const meta of ["timeout", "noId", "transient"]) {
  test(`an uncertain answer from Meta (${meta}): one call, 'failed' as not confirmed, no throw, no retry; a re-run sends nothing`, async () => {
    const world = attemptDb({ logs: [queuedRow()] });
    const r = await run(world, { meta });
    assert.equal(r.metaCalls.length, 1);
    assert.equal(r.threw, null, "never thrown: a throw is a retry, and a retry could send twice");
    const row = logById(world.db, "log-q");
    assert.equal(row.status, "failed");
    assert.equal(row.error, UNCERTAIN_NOTE);
    const again = await run(world, { meta: "ok", attempts: 1 });
    assert.equal(again.metaCalls.length, 0);
  });
}

test("a definite refusal: one call, 'failed' with Meta's reason, no throw", async () => {
  const world = attemptDb({ logs: [queuedRow()] });
  const r = await run(world, { meta: "terminal" });
  assert.equal(r.metaCalls.length, 1);
  assert.equal(r.threw, null);
  const row = logById(world.db, "log-q");
  assert.equal(row.status, "failed");
  assert.notEqual(row.error, UNCERTAIN_NOTE);
  assert.ok(r.alerted);
});

test("Stop landing DURING the call, then Meta fails: the Stop is kept (the failure write is guarded on 'queued')", async () => {
  const world = attemptDb({ logs: [queuedRow()] });
  const r = await run(world, {
    meta: "transient",
    onMeta: (db) => {
      logById(db, "log-q").status = "cancelled";
    },
  });
  assert.equal(r.metaCalls.length, 1);
  assert.equal(logById(world.db, "log-q").status, "cancelled");
});

test("Stop landing DURING the call, then Meta accepts: recorded 'sent' (the accepted, documented race; a send is never un-recorded)", async () => {
  const world = attemptDb({ logs: [queuedRow()] });
  await run(world, {
    onMeta: (db) => {
      logById(db, "log-q").status = "cancelled";
    },
  });
  assert.equal(logById(world.db, "log-q").status, "sent");
});

test("opted out since queueing: 'skipped' at claim time, nothing sent", async () => {
  const world = attemptDb({ logs: [queuedRow()], optedOut: true });
  const r = await run(world);
  assert.equal(r.metaCalls.length, 0);
  assert.equal(logById(world.db, "log-q").status, "skipped");
});

test("the claim itself fails: thrown for the queue to retry, and nothing sent", async () => {
  const world = attemptDb({
    logs: [queuedRow()],
    claimManual: () => ({ data: null, error: { code: "57014", message: "timeout" }, status: 500 }),
  });
  const r = await run(world);
  assert.equal(r.metaCalls.length, 0);
  assert.ok(r.threw);
  assert.equal(logById(world.db, "log-q").status, "queued");
});

test("every write on a queued row is scoped to the company and never carries an attempt stamp", async () => {
  const world = attemptDb({ logs: [queuedRow()] });
  await run(world, { meta: "transient" });
  const updates = world.service.queries.filter(
    (q) => q.table === "communication_logs" && q.calls.some((c) => c[0] === "update"),
  );
  assert.ok(updates.length >= 1);
  for (const q of updates) {
    assert.ok(q.calls.some((c) => c[0] === "eq" && c[1] === "company_id" && c[2] === COMPANY_ID));
    assert.ok(!("attempt_started_at" in q.calls.find((c) => c[0] === "update")[1]));
  }
});

// ── Jobs queued before 064 (no logId) ───────────────────────

test("legacy job on a retry or reclaim (attempts >= 1): never sends, writes nothing", async () => {
  const world = attemptDb({ logs: [] });
  const r = await run(world, { attempts: 1, payload: { logId: undefined } });
  assert.equal(r.metaCalls.length, 0);
  assert.equal(r.threw, null);
  assert.equal(world.db.logs.length, 0);
});

test("legacy job, first run, uncertain answer: one call, 'failed' as not confirmed, NO throw (no retry)", async () => {
  const world = attemptDb({ logs: [] });
  const r = await run(world, { meta: "timeout", attempts: 0, payload: { logId: undefined } });
  assert.equal(r.metaCalls.length, 1);
  assert.equal(r.threw, null);
  assert.equal(world.db.logs.length, 1);
  assert.equal(world.db.logs[0].status, "failed");
  assert.equal(world.db.logs[0].error, UNCERTAIN_NOTE);
});

// ── Queueing: the row and the job together ──────────────────

async function queue(world, over = {}) {
  globalThis.__whatsappDispatchServiceForTests = () => world.service;
  try {
    return await queueManualWhatsApp(world.service, {
      applicationId: APP_ID,
      companyId: COMPANY_ID,
      event: "interview",
      sentByName: "Rae",
      deadline: "20 Nov 2026",
      ...over,
    });
  } finally {
    delete globalThis.__whatsappDispatchServiceForTests;
  }
}

test("queueing writes the row and the job in one call: the job carries the row's id; nothing is sent yet", async () => {
  const world = attemptDb({ logs: [] });
  const r = await queue(world);
  assert.equal(r.kind, "queued");
  assert.equal(world.db.logs.length, 1);
  const row = world.db.logs[0];
  assert.equal(row.status, "queued");
  assert.equal(row.attempt_started_at, null, "unclaimed: Stop still works");
  assert.equal(row.to_address, "923001234567");
  assert.equal(world.db.jobs.length, 1);
  assert.equal(world.db.jobs[0].payload.logId, row.id);
  assert.equal(world.db.jobs[0].payload.deadline, "20 Nov 2026");
  const rpc = world.service.rpcs.filter((c) => c.name === "queue_manual_whatsapp");
  assert.equal(rpc.length, 1);
  assert.equal(rpc[0].args.p_company_id, COMPANY_ID);
});

test("queued, Stopped from Messages, then the job runs: nothing is sent", async () => {
  const world = attemptDb({ logs: [] });
  await queue(world);
  const row = world.db.logs[0];
  row.status = "cancelled";
  const r = await run(world, { payload: { logId: row.id } });
  assert.equal(r.metaCalls.length, 0);
  assert.equal(row.status, "cancelled");
});

test("queueing for an opted-out number writes a skipped row and NO job", async () => {
  const world = attemptDb({ logs: [], optedOut: true });
  const r = await queue(world);
  assert.equal(r.kind, "skipped");
  assert.equal(world.db.jobs.length, 0);
  assert.equal(world.db.logs[0].status, "skipped");
  assert.equal(world.service.rpcs.filter((c) => c.name === "queue_manual_whatsapp").length, 0);
});

test("an application outside the company, or the outbox failing: not queued, nothing written, never thrown", async () => {
  const other = attemptDb({ logs: [] });
  assert.equal(
    (await queue(other, { companyId: "c0000000-0000-4000-8000-0000000000ff" })).kind,
    "not_queued",
  );
  assert.equal(other.db.logs.length + other.db.jobs.length, 0);
  const down = attemptDb({
    logs: [],
    queueManual: () => ({
      data: null,
      error: { code: "PGRST202", message: "missing" },
      status: 404,
    }),
  });
  const r = await queue(down);
  assert.deepEqual(r, { kind: "not_queued", reason: "PGRST202" });
  assert.equal(down.db.logs.length + down.db.jobs.length, 0);
});

test("no test in this file tried the network", () => {
  guard.assertNoNetwork();
});
