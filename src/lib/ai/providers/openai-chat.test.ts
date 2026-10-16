/**
 * The OpenAI Chat Completions provider for scoring: request shape, reply
 * mapping, and how its errors land in the queue's existing failure classes.
 * fetch is faked; nothing leaves the machine.
 *
 *   node --test src/lib/ai/providers/openai-chat.test.ts
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../../test-support/node-resolve.mjs", import.meta.url));

const {
  buildOpenAIChatBody,
  createOpenAIChatMessage,
  isOpenAIModel,
  OPENAI_CHAT_URL,
  OPENAI_SCORING_SEED,
  redactKeys,
} = await import("./openai-chat.ts");
const { classifyProviderError, toJobError, TerminalJobError } = await import(
  "../../queue/failure-class.ts"
);
const { assertCompleteStop, extractText, IncompleteModelResponseError } = await import(
  "../model-params.ts"
);

// A fake test value, never a real key.
const FAKE_KEY = "sk-test-fake-0000000000000000";
const CV_TEXT = "Candidate CV text that must never reach a log line.";

const REQUEST = {
  model: "gpt-6-luna",
  max_tokens: 3000,
  system: [
    { type: "text", text: "SYSTEM RUBRIC", cache_control: { type: "ephemeral", ttl: "5m" } },
  ],
  messages: [{ role: "user", content: `JOB + ${CV_TEXT}` }],
};

/** Replace fetch with one that records each call and answers with `reply(call)`. */
function fakeFetch(reply) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const r = typeof reply === "function" ? reply(calls.at(-1)) : reply;
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body };
  };
  return { calls, restore: () => (globalThis.fetch = original) };
}

const ok = (over = {}) => ({
  status: 200,
  body: {
    id: "chatcmpl-1",
    model: "gpt-6-luna",
    choices: [
      { finish_reason: "stop", message: { content: '{"overall_score": 70}', refusal: null } },
    ],
    usage: {
      prompt_tokens: 1200,
      completion_tokens: 300,
      prompt_tokens_details: { cached_tokens: 200 },
    },
    ...over,
  },
});
const errReply = (status, type, code, message = "provider said no") => ({
  status,
  body: { error: { message, type, code } },
});

async function withKey(key, fn) {
  const before = process.env.OPENAI_API_KEY;
  if (key === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = key;
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = before;
  }
}

/** Capture every console line written during `fn`. */
async function captureLogs(fn) {
  const lines = [];
  const orig = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  for (const k of Object.keys(orig)) console[k] = (...a) => lines.push(a.map(String).join(" "));
  try {
    await fn();
  } finally {
    Object.assign(console, orig);
  }
  return lines;
}

test("gpt-* models are OpenAI's; claude-* and anything else are not", () => {
  for (const m of ["gpt-6-luna", " gpt-6-astra", "gpt-5"]) assert.equal(isOpenAIModel(m), true, m);
  for (const m of ["claude-sonnet-4-5", "claude-haiku-5-5", "", "luna", "x-gpt-6"]) {
    assert.equal(isOpenAIModel(m), false, m);
  }
});

test("request: the same system and user text, with the benchmarked settings and store false", () => {
  assert.deepEqual(buildOpenAIChatBody(REQUEST), {
    model: "gpt-6-luna",
    messages: [
      { role: "system", content: "SYSTEM RUBRIC" },
      { role: "user", content: `JOB + ${CV_TEXT}` },
    ],
    reasoning_effort: "none",
    temperature: 0,
    seed: OPENAI_SCORING_SEED,
    store: false,
    response_format: { type: "json_object" },
    max_completion_tokens: 3000,
  });
  assert.equal(OPENAI_SCORING_SEED, 1234);
  // Anthropic-only fields in the request are not forwarded.
  const body = buildOpenAIChatBody({ ...REQUEST, temperature: 0, thinking: { type: "disabled" } });
  assert.equal("thinking" in body, false);
  assert.equal(body.temperature, 0);
});

test("request goes to Chat Completions once, with the key only in the Authorization header", async () => {
  const f = fakeFetch(ok());
  try {
    await withKey(FAKE_KEY, () => createOpenAIChatMessage(REQUEST, { timeout: 10_000 }));
  } finally {
    f.restore();
  }
  assert.equal(f.calls.length, 1, "one call, no retries");
  const [{ url, init, body }] = f.calls;
  assert.equal(url, OPENAI_CHAT_URL);
  assert.equal(init.method, "POST");
  assert.equal(init.headers.Authorization, `Bearer ${FAKE_KEY}`);
  assert.ok(!init.body.includes(FAKE_KEY), "the key is never in the body");
  assert.equal(body.store, false);
  assert.ok(init.signal instanceof AbortSignal, "the timeout becomes an abort signal");
});

test("the caller's abort signal is honoured", async () => {
  const controller = new AbortController();
  controller.abort();
  const f = fakeFetch(ok());
  try {
    await withKey(FAKE_KEY, () => createOpenAIChatMessage(REQUEST, { signal: controller.signal }));
  } finally {
    f.restore();
  }
  assert.equal(f.calls[0].init.signal.aborted, true);
});

test("reply: text, stop reasons and usage in the shape the scorers read", async () => {
  const cases = [
    [ok(), "end_turn", '{"overall_score": 70}'],
    [
      ok({ choices: [{ finish_reason: "length", message: { content: '{"over' } }] }),
      "max_tokens",
      '{"over',
    ],
    [
      ok({ choices: [{ finish_reason: "content_filter", message: { content: "" } }] }),
      "refusal",
      "",
    ],
    [
      ok({
        choices: [{ finish_reason: "stop", message: { content: null, refusal: "I can't help" } }],
      }),
      "refusal",
      "",
    ],
  ];
  for (const [reply, stop, text] of cases) {
    const f = fakeFetch(reply);
    let r = null;
    try {
      r = await withKey(FAKE_KEY, () => createOpenAIChatMessage(REQUEST));
    } finally {
      f.restore();
    }
    assert.equal(r.stop_reason, stop, stop);
    assert.deepEqual(r.content, [{ type: "text", text }]);
  }
  const f = fakeFetch(ok());
  let r = null;
  try {
    r = await withKey(FAKE_KEY, () => createOpenAIChatMessage(REQUEST));
  } finally {
    f.restore();
  }
  // prompt_tokens includes the cached ones: input + cache_read is the whole prompt.
  assert.deepEqual(r.usage, {
    input_tokens: 1000,
    output_tokens: 300,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 200,
  });
  assert.equal(extractText(r), '{"overall_score": 70}');
});

test("a cut-off or refused reply is caught by the existing assertCompleteStop", async () => {
  for (const [finish, stop] of [
    ["length", "max_tokens"],
    ["content_filter", "refusal"],
  ]) {
    const f = fakeFetch(ok({ choices: [{ finish_reason: finish, message: { content: "{" } }] }));
    let r = null;
    try {
      r = await withKey(FAKE_KEY, () => createOpenAIChatMessage(REQUEST));
    } finally {
      f.restore();
    }
    assert.throws(
      () => assertCompleteStop(r, "gpt-6-luna"),
      (e) => e instanceof IncompleteModelResponseError && e.stopReason === stop,
    );
  }
});

test("errors land in the existing failure classes; quota and credit are billing, explicitly", async () => {
  const table = [
    [errReply(401, "invalid_request_error", "invalid_api_key"), "configuration"],
    [
      errReply(403, "invalid_request_error", "unsupported_country_region_territory"),
      "configuration",
    ],
    [errReply(429, "rate_limit_error", "rate_limit_exceeded"), "retryable"],
    [errReply(429, "rate_limit_error", "slow_down"), "retryable"],
    [
      errReply(429, "insufficient_quota", "insufficient_quota", "You exceeded your current quota."),
      "billing",
    ],
    [
      errReply(
        429,
        "invalid_request_error",
        "credit_balance_exhausted",
        "No prepaid credits remaining.",
      ),
      "billing",
    ],
    [errReply(400, "invalid_request_error", "invalid_value"), "deterministic"],
    [errReply(500, "server_error", null), "retryable"],
    [errReply(503, "service_unavailable_error", "server_is_overloaded"), "retryable"],
  ];
  for (const [reply, expected] of table) {
    const f = fakeFetch(reply);
    let thrown = null;
    try {
      await withKey(FAKE_KEY, () => createOpenAIChatMessage(REQUEST));
    } catch (err) {
      thrown = err;
    } finally {
      f.restore();
    }
    assert.ok(thrown, `${reply.status} must throw`);
    assert.equal(f.calls.length, 1, "never retried in-process");
    const cls = classifyProviderError(toJobError(thrown));
    assert.equal(cls.failureClass, expected, `${reply.status} ${reply.body.error.code}`);
    if (expected === "billing") assert.ok(thrown instanceof TerminalJobError);
  }
});

test("a key fragment in OpenAI's own error message is redacted before it goes anywhere", async () => {
  const f = fakeFetch(
    errReply(
      401,
      "invalid_request_error",
      "invalid_api_key",
      `Incorrect API key provided: ${FAKE_KEY.slice(0, 12)}****abcd.`,
    ),
  );
  let thrown = null;
  try {
    await withKey(FAKE_KEY, () => createOpenAIChatMessage(REQUEST));
  } catch (err) {
    thrown = err;
  } finally {
    f.restore();
  }
  assert.ok(!/sk-/.test(thrown.message), thrown.message);
  assert.ok(!/sk-/.test(classifyProviderError(toJobError(thrown)).summary));
  assert.equal(redactKeys("key sk-proj-AbC_123*** end"), "key [redacted] end");
});

test("no key configured: a configuration failure before any request", async () => {
  const f = fakeFetch(ok());
  let thrown = null;
  try {
    await withKey(undefined, () => createOpenAIChatMessage(REQUEST));
  } catch (err) {
    thrown = err;
  } finally {
    f.restore();
  }
  assert.equal(f.calls.length, 0);
  assert.equal(classifyProviderError(toJobError(thrown)).failureClass, "configuration");
});

test("nothing is logged: no key, no request body, no CV text, on success or failure", async () => {
  for (const reply of [ok(), errReply(500, "server_error", null)]) {
    const f = fakeFetch(reply);
    const lines = await captureLogs(async () => {
      await withKey(FAKE_KEY, () => createOpenAIChatMessage(REQUEST)).catch(() => {});
    });
    f.restore();
    assert.deepEqual(lines, [], "the provider writes no log lines of its own");
  }
});
