/**
 * The retry matrix (Phase 5, P13): which provider failures the queue retries
 * and which it buries on the first attempt.
 *
 *   node --test src/lib/queue/failure-class.test.ts
 */
// @ts-nocheck — same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyProviderError,
  JobYield,
  ProviderHttpError,
  safeFailureSentence,
  TerminalJobError,
  toJobError,
} from "./failure-class.ts";

/** The shape the Anthropic SDK's APIError subclasses expose. */
const sdkError = (status, message, name = "APIError") => {
  const e = new Error(message);
  e.name = name;
  e.status = status;
  return e;
};

test("400: billing when the message names the balance, otherwise deterministic", () => {
  const billing = classifyProviderError(
    sdkError(
      400,
      'Your credit balance is too low to access the Anthropic API. {"type":"invalid_request_error"}',
    ),
  );
  assert.equal(billing.failureClass, "billing");
  assert.equal(billing.retryable, false);
  const bad = classifyProviderError(sdkError(400, "temperature is not supported by this model"));
  assert.equal(bad.failureClass, "deterministic");
  assert.equal(bad.retryable, false);
});

test("401 and 403 are configuration; 404, 413, 415, 422 are deterministic", () => {
  for (const s of [401, 403])
    assert.equal(classifyProviderError(sdkError(s, "x")).failureClass, "configuration");
  for (const s of [404, 413, 415, 422])
    assert.equal(classifyProviderError(sdkError(s, "x")).failureClass, "deterministic");
});

test("429 retries, except OpenAI's insufficient_quota which is billing", () => {
  assert.equal(classifyProviderError(sdkError(429, "rate_limit_error")).retryable, true);
  const quota = classifyProviderError(
    new ProviderHttpError("OpenAI", 429, '{"error":{"type":"insufficient_quota"}}'),
  );
  assert.equal(quota.failureClass, "billing");
  assert.equal(quota.retryable, false);
});

test("408, 409, 5xx, 529 retry", () => {
  for (const s of [408, 409, 500, 502, 503, 529]) {
    assert.equal(classifyProviderError(sdkError(s, "x")).retryable, true, String(s));
  }
});

test("aborts, timeouts, connection errors and unknown errors retry", () => {
  const abort = new DOMException("The operation was aborted", "AbortError");
  assert.equal(classifyProviderError(abort).retryable, true);
  const timeout = new Error("Request timed out.");
  timeout.name = "APIConnectionTimeoutError";
  assert.equal(classifyProviderError(timeout).retryable, true);
  const conn = new Error("Connection error.");
  conn.name = "APIConnectionError";
  assert.equal(classifyProviderError(conn).retryable, true);
  assert.equal(classifyProviderError(new TypeError("fetch failed")).retryable, true);
  assert.equal(classifyProviderError("something odd").retryable, true);
});

test("a missing API key is configuration, from our own pre-call throws", () => {
  assert.equal(
    classifyProviderError(new Error("ANTHROPIC_API_KEY is not set")).failureClass,
    "configuration",
  );
  assert.equal(
    classifyProviderError(new Error("OPENAI_API_KEY is not configured")).failureClass,
    "configuration",
  );
});

test("toJobError wraps only the non-retryable, and is idempotent", () => {
  const retry = sdkError(503, "overloaded");
  assert.equal(toJobError(retry), retry);
  const wrapped = toJobError(sdkError(400, "bad request"));
  assert.ok(wrapped instanceof TerminalJobError);
  assert.equal(wrapped.failureClass, "deterministic");
  assert.equal(toJobError(wrapped), wrapped);
  const y = new JobYield("budget");
  assert.equal(toJobError(y), y);
  const terminal = new TerminalJobError("billing", "no credit");
  assert.equal(classifyProviderError(terminal).failureClass, "billing");
});

test("the summary is one line and never carries a body dump", () => {
  const c = classifyProviderError(sdkError(500, `Internal error\n{"huge":"${"x".repeat(5000)}"}`));
  assert.equal(c.summary.includes("\n"), false);
  assert.ok(c.summary.length < 400);
});

test("safe sentences are fixed text per class", () => {
  const cfg = classifyProviderError(sdkError(401, "invalid api key"));
  assert.equal(
    safeFailureSentence(cfg, "transcription"),
    "The transcription provider rejected our credentials.",
  );
  const key = classifyProviderError(new Error("OPENAI_API_KEY is not configured"));
  assert.equal(
    safeFailureSentence(key, "transcription"),
    "Transcription is not configured on this deployment.",
  );
  const det = classifyProviderError(sdkError(400, "invalid file format"));
  assert.equal(
    safeFailureSentence(det, "transcription"),
    "The transcription provider rejected this recording.",
  );
  const bill = classifyProviderError(sdkError(400, "credit balance is too low"));
  assert.equal(
    safeFailureSentence(bill, "scoring"),
    "The scoring provider declined the request for billing reasons.",
  );
  for (const s of [
    safeFailureSentence(cfg, "transcription"),
    safeFailureSentence(det, "transcription"),
    safeFailureSentence(bill, "transcription"),
  ]) {
    assert.doesNotMatch(
      s,
      /invalid api key|invalid file format|credit balance/,
      "provider text leaked",
    );
  }
});
