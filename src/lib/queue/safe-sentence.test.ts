/**
 * isSafeFailureSentence: the gate between a stored `error` and a recruiter's
 * screen (Phase 6, A6-26).
 *
 *   node --test src/lib/queue/safe-sentence.test.ts
 */
// @ts-nocheck — same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyProviderError,
  isSafeFailureSentence,
  safeFailureSentence,
} from "./failure-class.ts";

const sdkError = (status, message) => Object.assign(new Error(message), { status });

test("every sentence safeFailureSentence can produce passes, for both nouns", () => {
  const errors = [
    sdkError(401, "invalid x-api-key"),
    sdkError(403, "forbidden"),
    new Error("OPENAI_API_KEY is not configured"),
    sdkError(400, "Your credit balance is too low"),
    sdkError(400, "temperature is not supported"),
    sdkError(404, "model not found"),
    sdkError(503, "overloaded"),
    new TypeError("fetch failed"),
  ];
  for (const what of ["transcription", "scoring"]) {
    for (const err of errors) {
      const sentence = safeFailureSentence(classifyProviderError(err), what);
      assert.equal(isSafeFailureSentence(sentence), true, `${what}: ${sentence}`);
    }
  }
});

test("the transcribe handler's own fixed sentences pass, including the size template", () => {
  for (const s of [
    "Transcription returned nothing.",
    "Answer has no video to transcribe.",
    "Recording is 31MB, over the 25MB transcription limit.",
    "Scoring didn't complete. The CV is unaffected.",
  ]) {
    assert.equal(isSafeFailureSentence(s), true, s);
  }
});

test("provider bodies, database messages, legacy raw errors and blanks fail", () => {
  for (const s of [
    'provider 400: {"type":"error","error":{"type":"invalid_request_error","message":"…"}}',
    'OpenAI 429 — {"error":{"type":"insufficient_quota"}}',
    'duplicate key value violates unique constraint "application_scores_application_id_key"',
    "Model returned malformed scorecard JSON: overall_score missing (812 chars, model claude-sonnet-4-5).",
    "transcribe: OPENAI_API_KEY is not configured",
    "",
    null,
    undefined,
    "Recording is huge, over the limit.",
  ]) {
    assert.equal(isSafeFailureSentence(s), false, String(s));
  }
});
