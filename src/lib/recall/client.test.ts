/**
 * The Recall.ai client against a fake fetch: which statuses are outcomes and
 * which are errors, what is retried, what is sent, and that the key and the
 * response bodies never reach an error message. No network.
 *
 *   node --test src/lib/recall/client.test.ts
 */
// @ts-nocheck — same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../test-support/server-only-stub.mjs", import.meta.url));

const { createRecallClient, normaliseRecallBaseUrl } = await import("./client.ts");
const { RecallApiError } = await import("./types.ts");
const { classifyProviderError } = await import("../queue/failure-class.ts");

const BASE = "https://ap-northeast-1.recall.ai/api/v1";
const KEY = "rk_live_SECRET_DO_NOT_LEAK_0123456789";
const BOT = "11111111-2222-4333-8444-555555555555";
const REC = "66666666-7777-4888-8999-000000000000";

/** A fetch that answers from a script and records every request. */
function fakeFetch(answers) {
  const requests = [];
  const impl = async (url, init) => {
    requests.push({ url, init });
    const next = answers.shift();
    if (!next) throw new Error("test: unexpected request");
    if (next instanceof Error) throw next;
    const { status = 200, body = null, headers = {} } = next;
    return new Response(body === null ? null : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });
  };
  return { impl, requests };
}

const client = (answers) => {
  const f = fakeFetch(answers);
  return { recall: createRecallClient({ apiKey: KEY, baseUrl: BASE, fetchImpl: f.impl }), ...f };
};

const createBody = {
  meeting_url: "https://meet.google.com/abc-defg-hij",
  bot_name: "Remotiv Recorder",
  join_at: "2026-11-05T08:59:00.000Z",
  recording_config: { video_mixed_mp4: {}, retention: { type: "timed", hours: 72 } },
  automatic_leave: {
    waiting_room_timeout: 600,
    noone_joined_timeout: 900,
    everyone_left_timeout: { timeout: 30 },
    in_call_recording_timeout: 10800,
  },
  metadata: { integration: "remotiv-final-interview" },
};

async function caught(promise) {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  assert.fail("expected a rejection");
}

test("create posts the body with the token, JSON and the idempotency key", async () => {
  const { recall, requests } = client([{ status: 201, body: { id: BOT } }]);
  const bot = await recall.createBot(createBody, { idempotencyKey: "remotiv-final-bot-x" });
  assert.equal(bot.id, BOT);
  const [{ url, init }] = requests;
  assert.equal(url, `${BASE}/bot/`);
  assert.equal(init.method, "POST");
  assert.equal(init.headers.authorization, `Token ${KEY}`);
  assert.equal(init.headers["idempotency-key"], "remotiv-final-bot-x");
  assert.equal(init.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(init.body), createBody);
});

test("a 2xx create without a bot id is retryable: the bot may exist", async () => {
  const { recall } = client([{ status: 201, body: {} }]);
  const err = await caught(recall.createBot(createBody, { idempotencyKey: "k" }));
  assert.ok(err instanceof RecallApiError);
  assert.equal(err.retryable, true);
});

test("outcomes, not errors: 404 retrieve, 404/405 delete, 400/404 leave, 404 recording", async () => {
  assert.equal(await client([{ status: 404 }]).recall.retrieveBot(BOT), null);
  assert.equal(await client([{ status: 204 }]).recall.deleteScheduledBot(BOT), "deleted");
  assert.equal(await client([{ status: 404 }]).recall.deleteScheduledBot(BOT), "already_gone");
  assert.equal(await client([{ status: 405 }]).recall.deleteScheduledBot(BOT), "not_allowed");
  assert.deepEqual(await client([{ status: 400 }]).recall.leaveCall(BOT), {
    outcome: "not_in_call",
  });
  assert.deepEqual(await client([{ status: 404 }]).recall.leaveCall(BOT), {
    outcome: "already_gone",
  });
  const left = await client([{ status: 200, body: { id: BOT } }]).recall.leaveCall(BOT);
  assert.equal(left.outcome, "left");
  assert.equal(await client([{ status: 204 }]).recall.deleteRecording(REC), "deleted");
  assert.equal(await client([{ status: 404 }]).recall.deleteRecording(REC), "already_gone");
});

test("the paths are Recall's documented ones", async () => {
  const cases = [
    [(r) => r.retrieveBot(BOT), "GET", `${BASE}/bot/${BOT}/`, { id: BOT }],
    [(r) => r.deleteScheduledBot(BOT), "DELETE", `${BASE}/bot/${BOT}/`, null],
    [(r) => r.leaveCall(BOT), "POST", `${BASE}/bot/${BOT}/leave_call/`, { id: BOT }],
    [(r) => r.deleteRecording(REC), "DELETE", `${BASE}/recording/${REC}/`, null],
  ];
  for (const [call, method, url, body] of cases) {
    const { recall, requests } = client([{ status: body ? 200 : 204, body }]);
    await call(recall);
    assert.equal(requests[0].init.method, method);
    assert.equal(requests[0].url, url);
  }
});

test("retryable: 429 with Retry-After, 409, 507, 5xx, network failure and timeout", async () => {
  for (const status of [409, 429, 500, 502, 503, 504, 507]) {
    const err = await caught(
      client([
        { status, headers: status === 429 ? { "retry-after": "7" } : {} },
      ]).recall.retrieveBot(BOT),
    );
    assert.ok(err instanceof RecallApiError, String(status));
    assert.equal(err.retryable, true, String(status));
    assert.equal(classifyProviderError(err).retryable, true, `queue agrees on ${status}`);
    if (status === 429) assert.equal(err.retryAfterSeconds, 7);
  }
  const net = await caught(client([new TypeError("fetch failed")]).recall.retrieveBot(BOT));
  assert.equal(net.status, null);
  assert.equal(net.retryable, true);
  assert.equal(classifyProviderError(net).retryable, true);
});

test("terminal: 400 is deterministic, 401 and 403 are configuration, 402 is billing", async () => {
  const bad = await caught(
    client([{ status: 400 }]).recall.createBot(createBody, { idempotencyKey: "k" }),
  );
  assert.equal(bad.retryable, false);
  assert.equal(classifyProviderError(bad).failureClass, "deterministic");
  for (const status of [401, 403]) {
    const err = await caught(client([{ status }]).recall.retrieveBot(BOT));
    assert.equal(classifyProviderError(err).failureClass, "configuration", String(status));
  }
  // Recall's 402 body is never read, so the billing class comes from the
  // status alone, with and without an error code, on every call shape.
  const calls = [
    (recall) => recall.createBot(createBody, { idempotencyKey: "k" }),
    (recall) => recall.retrieveBot(BOT),
    (recall) => recall.leaveCall(BOT),
  ];
  for (const call of calls) {
    for (const body of [undefined, { code: "insufficient_balance", detail: "pay up" }]) {
      const err = await caught(call(client([{ status: 402, body }]).recall));
      assert.ok(err instanceof RecallApiError);
      assert.equal(err.status, 402);
      assert.equal(err.retryable, false);
      assert.equal(classifyProviderError(err).failureClass, "billing");
      assert.ok(!err.message.includes("pay up"));
    }
  }
});

test("errors carry Recall's code but never the key, the body or the meeting URL", async () => {
  const err = await caught(
    client([
      {
        status: 400,
        body: {
          code: "invalid_meeting_url",
          detail: "https://meet.google.com/abc-defg-hij is not valid",
          echo: KEY,
        },
      },
    ]).recall.createBot(createBody, { idempotencyKey: "k" }),
  );
  assert.equal(err.code, "invalid_meeting_url");
  for (const secret of [KEY, "meet.google.com", "is not valid"]) {
    assert.ok(!err.message.includes(secret), secret);
    assert.ok(!JSON.stringify(err).includes(secret), secret);
  }
});

test("no key or a bad base URL: refused before any request, as configuration", async () => {
  for (const config of [
    { apiKey: "", baseUrl: BASE },
    { apiKey: KEY, baseUrl: "" },
    { apiKey: KEY, baseUrl: "http://ap-northeast-1.recall.ai/api/v1" },
    { apiKey: KEY, baseUrl: "https://evil.example.com/api/v1" },
    { apiKey: KEY, baseUrl: "https://recall.ai.evil.com/api/v1" },
  ]) {
    const f = fakeFetch([]);
    const recall = createRecallClient({ ...config, fetchImpl: f.impl });
    const err = await caught(recall.retrieveBot(BOT));
    assert.equal(f.requests.length, 0, JSON.stringify(config.baseUrl));
    assert.equal(err.retryable, false);
    assert.ok(!err.message.includes(KEY));
  }
  const err = await caught(createRecallClient({ apiKey: "", baseUrl: BASE }).retrieveBot(BOT));
  assert.equal(classifyProviderError(err).failureClass, "configuration");
});

test("normaliseRecallBaseUrl keeps https recall.ai URLs only", () => {
  assert.equal(normaliseRecallBaseUrl(`${BASE}/`), BASE);
  assert.equal(
    normaliseRecallBaseUrl(" https://us-west-2.recall.ai/api/v1 "),
    "https://us-west-2.recall.ai/api/v1",
  );
  for (const bad of [
    "",
    "ftp://x.recall.ai",
    "https://x.recall.ai/api/v1?k=1",
    "https://user:p@x.recall.ai",
  ]) {
    assert.equal(normaliseRecallBaseUrl(bad), null, bad);
  }
});

test("ids are validated before a request is built", async () => {
  for (const id of ["", "../../admin", "abc", `${BOT}/../x`]) {
    const f = fakeFetch([]);
    const recall = createRecallClient({ apiKey: KEY, baseUrl: BASE, fetchImpl: f.impl });
    await caught(recall.retrieveBot(id));
    await caught(recall.deleteRecording(id));
    assert.equal(f.requests.length, 0, id);
  }
});

test("listBots filters on metadata and follows next only on Recall's own listing", async () => {
  const { recall, requests } = client([
    { body: { results: [{ id: BOT }], next: `${BASE}/bot/?cursor=abc` } },
    { body: { results: [{ id: REC }], next: "https://evil.example.com/steal" } },
  ]);
  const { bots, truncated } = await recall.listBots({
    metadata: { integration: "remotiv-final-interview", botRowId: "r1" },
    joinAtAfter: "2026-11-01",
  });
  assert.deepEqual(
    bots.map((b) => b.id),
    [BOT, REC],
  );
  assert.equal(requests.length, 2, "the foreign next link was not followed");
  assert.equal(truncated, true);
  const first = new URL(requests[0].url);
  assert.equal(first.searchParams.get("metadata__integration"), "remotiv-final-interview");
  assert.equal(first.searchParams.get("metadata__botRowId"), "r1");
  assert.equal(first.searchParams.get("join_at_after"), "2026-11-01");
});

test("listBots stops at maxPages and refuses an unsafe metadata key", async () => {
  const { recall, requests } = client([
    { body: { results: [], next: `${BASE}/bot/?cursor=1` } },
    { body: { results: [], next: `${BASE}/bot/?cursor=2` } },
  ]);
  const result = await recall.listBots({ maxPages: 1 });
  assert.equal(requests.length, 1);
  assert.equal(result.truncated, true);
  await caught(client([]).recall.listBots({ metadata: { "a&b": "x" } }));
});
