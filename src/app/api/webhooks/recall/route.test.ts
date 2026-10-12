/**
 * The Recall webhook route itself: POST only, the secret, the signature, the
 * body cap, and what a response may say. The database is the migration-040
 * fake behind the stubbed service client.
 *
 *   node --test "src/app/api/webhooks/recall/route.test.ts"
 */
// @ts-nocheck — same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { register } from "node:module";
import { test } from "node:test";
import {
  APP,
  BOOKING,
  botWorld,
  CO,
  FI,
  JOB,
  makeBotDb,
} from "../../../../test-support/final-bot-world.mjs";

register(new URL("../../../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../../../test-support/fake-service-client-hook.mjs", import.meta.url));

const route = await import("./route.ts");

const KEY = randomBytes(32);
const SECRET = `whsec_${KEY.toString("base64")}`;

function world() {
  const db = makeBotDb(Date.now() + 60_000);
  const botId = randomUUID();
  db.final_interview_bots.push({
    id: randomUUID(),
    final_interview_id: FI,
    company_id: CO,
    job_id: JOB,
    application_id: APP,
    booking_id: BOOKING,
    provider: "recall",
    provider_bot_id: botId,
    provider_recording_id: null,
    join_at: new Date().toISOString(),
    status: "scheduled",
    last_event_code: "scheduled",
    last_event_sub_code: null,
    last_event_at: new Date(Date.now() - 86_400_000).toISOString(),
    import_status: "none",
    lobby_alert_sent_at: null,
    failure_alert_sent_at: null,
    superseded_at: null,
  });
  const service = botWorld(db);
  globalThis.__fakeServiceClientForTests = () => service;
  return { db, botId, service };
}

function signedRequest(body, { key = KEY, headers = {} } = {}) {
  const id = `msg_${randomUUID()}`;
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64");
  return new Request("https://remotiv.work/api/webhooks/recall", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "webhook-id": id,
      "webhook-timestamp": ts,
      "webhook-signature": `v1,${sig}`,
      ...headers,
    },
    body,
  });
}

const event = (botId) =>
  JSON.stringify({
    event: "bot.in_call_recording",
    data: {
      data: { code: "in_call_recording", sub_code: null, updated_at: new Date().toISOString() },
      bot: { id: botId, metadata: {} },
    },
  });

async function withSecret(value, fn) {
  const before = process.env.RECALL_WEBHOOK_SECRET;
  if (value === undefined) delete process.env.RECALL_WEBHOOK_SECRET;
  else process.env.RECALL_WEBHOOK_SECRET = value;
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env.RECALL_WEBHOOK_SECRET;
    else process.env.RECALL_WEBHOOK_SECRET = before;
  }
}

test("POST is the only handler; Next answers 405 for the rest", () => {
  assert.equal(typeof route.POST, "function");
  for (const m of ["GET", "PUT", "PATCH", "DELETE"]) assert.equal(route[m], undefined, m);
  assert.equal(route.runtime, "nodejs");
});

test("a signed event is applied and acknowledged", async () => {
  const w = world();
  const res = await withSecret(SECRET, () => route.POST(signedRequest(event(w.botId))));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { received: true });
  assert.equal(w.db.final_interview_bots[0].status, "recording");
});

test("no RECALL_WEBHOOK_SECRET: 503, and the database is never asked", async () => {
  const w = world();
  const res = await withSecret(undefined, () => route.POST(signedRequest(event(w.botId))));
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: "unavailable" });
  assert.equal(w.service.queries.length, 0);
});

test("a bad signature: 401 with nothing but 'unauthorized'", async () => {
  const w = world();
  const res = await withSecret(SECRET, () =>
    route.POST(signedRequest(event(w.botId), { key: randomBytes(32) })),
  );
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: "unauthorized" });
  assert.equal(w.service.queries.length, 0);
  assert.equal(w.db.final_interview_bots[0].status, "scheduled");
});

test("an oversized body is refused before it is verified or parsed", async () => {
  const w = world();
  const big = "x".repeat(300 * 1024);
  const declared = await withSecret(SECRET, () => route.POST(signedRequest(big)));
  assert.equal(declared.status, 413);
  // No content-length to go on: the stream is cut at the cap.
  const stream = new ReadableStream({
    start(c) {
      for (let i = 0; i < 40; i++) c.enqueue(new TextEncoder().encode("y".repeat(10 * 1024)));
      c.close();
    },
  });
  const undeclared = new Request("https://remotiv.work/api/webhooks/recall", {
    method: "POST",
    body: stream,
    duplex: "half",
  });
  const res = await withSecret(SECRET, () => route.POST(undeclared));
  assert.equal(res.status, 413);
  assert.equal(w.service.queries.length, 0);
});

test("a database failure is a 503 the sender will retry, with no detail", async () => {
  const w = world();
  w.service.failNext("final_interview_bots", "select");
  const res = await withSecret(SECRET, () => route.POST(signedRequest(event(w.botId))));
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: "unavailable" });
});
