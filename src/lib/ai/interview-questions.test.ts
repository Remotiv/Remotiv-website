/**
 * The AI question suggester's lengths (lib/ai/interview-questions.ts and
 * INTERVIEW_LENGTHS in lib/interviews/types.ts): 4, 5, 6, 7 or 8 questions,
 * never more than the save accepts (MAX_QUESTIONS, 8), and never a silent
 * fallback for a length it does not know.
 *
 *   node --test src/lib/ai/interview-questions.test.ts
 *
 * The model is a fake client that records every request. Synthetic job text.
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../test-support/node-resolve.mjs", import.meta.url));
register(
  `data:text/javascript,${encodeURIComponent(`
const STUBS = {
  "server-only": "export {};",
  "@/lib/anthropic": "export const AI_MATCHING_MODEL = 'claude-haiku-5-5'; export function getAnthropic() { return globalThis.__suggestClient; }",
};
export async function resolve(specifier, context, next) {
  if (specifier in STUBS) return { url: "data:text/javascript," + encodeURIComponent(STUBS[specifier]), shortCircuit: true };
  return next(specifier, context);
}`)}`,
);

const { generateInterviewQuestions } = await import("./interview-questions.ts");
const { INTERVIEW_LENGTHS, MAX_QUESTIONS } = await import("../interviews/types.ts");

process.env.ANTHROPIC_API_KEY = "test-not-a-key";

/** A fake model that answers with `count` usable questions and records each request. */
function model(count) {
  const requests = [];
  globalThis.__suggestClient = {
    messages: {
      async create(request) {
        requests.push(request);
        const questions = Array.from({ length: count }, (_, i) => ({
          question: `Tell me about synthetic situation ${i + 1}.`,
          competency: "Ownership",
          rubric: "A strong answer names the situation, the action and the result.",
        }));
        return {
          content: [{ type: "text", text: JSON.stringify({ questions }) }],
          stop_reason: "end_turn",
        };
      },
    },
  };
  return requests;
}

const JOB = {
  title: "Synthetic Support Lead",
  description: "Lead a small support team for a synthetic product.",
  requirements: "Three years leading support.",
};

test("the lengths offered: 4, 5, 6, 7 and 8 questions; the first three exactly as before", () => {
  assert.deepEqual(
    INTERVIEW_LENGTHS.map((l) => [l.id, l.label, l.questions, l.answerSeconds]),
    [
      ["short", "About 5 minutes", 4, 60],
      ["standard", "About 10 minutes", 5, 120],
      ["depth", "About 15 minutes", 6, 150],
      ["extended", "About 18 minutes", 7, 150],
      ["full", "About 20 minutes", 8, 150],
    ],
  );
  for (const l of INTERVIEW_LENGTHS) {
    assert.ok(l.questions <= MAX_QUESTIONS, `${l.id}: within the save's cap`);
  }
  assert.equal(MAX_QUESTIONS, 8);
});

test("4 to 6 unchanged: each asks for its own count and keeps at most that many", async () => {
  for (const [id, n] of [
    ["short", 4],
    ["standard", 5],
    ["depth", 6],
  ]) {
    const requests = model(n + 2);
    const out = await generateInterviewQuestions({ ...JOB, length: id });
    assert.equal(out.failure, null, id);
    assert.equal(out.questions.length, n, id);
    assert.match(requests[0].messages[0].content, new RegExp(`^Write exactly ${n} questions`));
  }
});

test("7 and 8 are accepted: asked for, and kept whole", async () => {
  for (const [id, n] of [
    ["extended", 7],
    ["full", 8],
  ]) {
    const requests = model(n);
    const out = await generateInterviewQuestions({ ...JOB, length: id });
    assert.equal(out.failure, null, id);
    assert.equal(out.questions.length, n, id);
    assert.match(requests[0].messages[0].content, new RegExp(`^Write exactly ${n} questions`));
  }
});

test("9 is never offered: a reply of 9 for the 8 length keeps 8, and no length asks for more", async () => {
  model(9);
  const out = await generateInterviewQuestions({ ...JOB, length: "full" });
  assert.equal(out.questions.length, 8);
  assert.ok(INTERVIEW_LENGTHS.every((l) => l.questions < 9));
});

test("a length it does not know is refused before any model call, not swapped for another", async () => {
  for (const length of ["nine", "", undefined, null, 9]) {
    const requests = model(5);
    const out = await generateInterviewQuestions({ ...JOB, length });
    assert.deepEqual(out, { questions: null, failure: "bad_length" }, String(length));
    assert.equal(requests.length, 0, String(length));
  }
});
