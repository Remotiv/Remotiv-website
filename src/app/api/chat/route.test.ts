/**
 * The site chat route (src/app/api/chat/route.ts) after the move to Claude
 * Haiku 5.5: the request it sends, and what reaches the visitor when the model
 * answers with a thinking block, with text, or with nothing usable. The model
 * is a fake installed here; next/server is the same minimal stub the worker
 * route tests use, and the rate limiter is a pass-through, because its sweep
 * timer (rate-limit.ts, setInterval) would keep a bare Node process alive.
 * Nothing leaves the machine.
 *
 *   node --test src/app/api/chat/route.test.ts
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../../test-support/node-resolve.mjs", import.meta.url));
const STUBS = {
  "next/server": `export const NextResponse = {
  json(body, init) { return { status: init?.status ?? 200, body, headers: init?.headers ?? {} }; },
};`,
  "@/app/api/_lib/rate-limit": "export function rateLimit() { return { ok: true }; }",
  "@/lib/anthropic": `export function getAnthropic() {
  const client = globalThis.__chatFakeAnthropic;
  if (!client) throw new Error("test: no fake Anthropic client installed");
  return client;
}`,
};
register(
  `data:text/javascript,${encodeURIComponent(`
const STUBS = ${JSON.stringify(STUBS)};
export async function resolve(specifier, context, next) {
  const stub = STUBS[specifier];
  if (stub !== undefined) return { url: "data:text/javascript," + encodeURIComponent(stub), shortCircuit: true };
  return next(specifier, context);
}`)}`,
);

const { POST } = await import("./route.ts");
console.error = () => {};

/** Install a fake client answering with `content` (or throwing `error`); returns the requests. */
function fakeModel({ content, error } = {}) {
  const requests = [];
  globalThis.__chatFakeAnthropic = {
    messages: {
      create: async (params) => {
        requests.push(params);
        if (error) throw error;
        return { content, stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } };
      },
    },
  };
  return requests;
}

/** A request the route can read: a JSON body. */
function chatRequest(messages) {
  return {
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => ({ messages }),
  };
}
const ASK = [{ role: "user", content: "What does Remotiv do?" }];
const THINKING = { type: "thinking", thinking: "the visitor wants the pitch", signature: "sig" };
const text = (t) => ({ type: "text", text: t });

test("the request names claude-haiku-5-5 with thinking disabled and no sampling parameters", async () => {
  const requests = fakeModel({
    content: [text("Remotiv connects companies with vetted remote talent.")],
  });
  const res = await POST(chatRequest(ASK));
  assert.equal(res.status, 200);
  assert.equal(requests.length, 1);
  const req = requests[0];
  assert.equal(req.model, "claude-haiku-5-5");
  assert.deepEqual(req.thinking, { type: "disabled" });
  for (const key of ["temperature", "top_p", "top_k"]) assert.equal(key in req, false, key);
  assert.equal(req.max_tokens, 300);
  assert.match(req.system, /powered by AI \(Claude by Anthropic\)/);
  assert.deepEqual(req.messages, ASK);
});

test("a thinking block before the text: the visitor gets only the text", async () => {
  fakeModel({ content: [THINKING, text("  We connect companies with vetted talent.  ")] });
  const res = await POST(chatRequest(ASK));
  assert.equal(res.status, 200);
  assert.equal(res.body.reply, "We connect companies with vetted talent.");
  assert.ok(!JSON.stringify(res.body).includes("the visitor wants"), "no thinking text leaks");
});

test("a thinking-only reply is today's 502, with the same message", async () => {
  fakeModel({ content: [THINKING] });
  const res = await POST(chatRequest(ASK));
  assert.equal(res.status, 502);
  assert.deepEqual(res.body, { error: "No reply generated. Please try again." });
});

test("a provider failure is today's 500, with the same message", async () => {
  fakeModel({ error: Object.assign(new Error("overloaded"), { status: 529 }) });
  const res = await POST(chatRequest(ASK));
  assert.equal(res.status, 500);
  assert.deepEqual(res.body, { error: "Something went wrong. Please try again." });
});
