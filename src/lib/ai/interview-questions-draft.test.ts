/**
 * AI-Guided question drafting (draftAiGuidedQuestions, interview-questions.ts):
 * made from the five allowed inputs only, 4 to 8 questions as the recruiter
 * picked, one model call, the question fairness policy in the prompt, and
 * every draft checked before it is returned.
 *
 *   node --test src/lib/ai/interview-questions-draft.test.ts
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
  "@/lib/anthropic": "export const AI_MATCHING_MODEL = 'claude-haiku-5-5'; export function getAnthropic() { return globalThis.__draftClient; }",
};
export async function resolve(specifier, context, next) {
  if (specifier in STUBS) return { url: "data:text/javascript," + encodeURIComponent(STUBS[specifier]), shortCircuit: true };
  return next(specifier, context);
}`)}`,
);

const { draftAiGuidedQuestions, draftJobText, DRAFT_COUNTS } = await import(
  "./interview-questions.ts"
);
const { QUESTION_FAIRNESS_POLICY } = await import("./fairness.ts");

process.env.ANTHROPIC_API_KEY = "test-not-a-key";

/** A fake model answering with these questions (or `count` plain ones); records each request. */
function model(answer) {
  const requests = [];
  globalThis.__draftClient = {
    messages: {
      async create(request) {
        requests.push(request);
        if (answer === "throw") throw new Error("model down");
        const questions =
          typeof answer === "number"
            ? Array.from({ length: answer }, (_, i) => ({
                question: `Tell me about synthetic situation ${i + 1} in this role.`,
                competency: "Ownership",
                rubric: "A strong answer names the situation, the action and the result.",
              }))
            : answer;
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
  description: "SYNTH-DESC lead a small support team for a synthetic product.",
  requiredSkills: "SYNTH-SKILLS ticket triage and coaching.",
  seniority: "SYNTH-SENIORITY Senior",
  hiringChallenges: "SYNTH-CHALLENGES first-response times have slipped.",
  count: 5,
};

test("drafts are made from title, description, required skills, seniority and hiring challenges only", async () => {
  const requests = model(5);
  const extra = {
    ...JOB,
    // Fields a caller might try to pass. The drafter has no slot for them.
    cvText: "SYNTH-CV Alex Example, 10 years at Contoso",
    candidate: { name: "SYNTH-CANDIDATE" },
    rubric: "SYNTH-RUBRIC",
    responsibilities: "SYNTH-RESPONSIBILITIES",
    scoring_must_haves: ["SYNTH-MUSTHAVE"],
  };
  const r = await draftAiGuidedQuestions(extra);
  assert.equal(r.failure, null);
  assert.equal(requests.length, 1, "one model call");
  const sent = JSON.stringify(requests[0]);
  for (const allowed of [
    "Synthetic Support Lead",
    "SYNTH-DESC",
    "SYNTH-SKILLS",
    "SYNTH-SENIORITY",
    "SYNTH-CHALLENGES",
  ]) {
    assert.ok(sent.includes(allowed), `${allowed} reaches the model`);
  }
  for (const never of [
    "SYNTH-CV",
    "SYNTH-CANDIDATE",
    "SYNTH-RUBRIC",
    "SYNTH-RESPONSIBILITIES",
    "SYNTH-MUSTHAVE",
  ]) {
    assert.ok(!sent.includes(never), `${never} never reaches the model`);
  }
  assert.equal(
    requests[0].messages[0].content,
    `Write exactly 5 questions for this role.\n\n${draftJobText(JOB)}`,
  );
});

test("the hiring challenges are included when given, and nothing is invented when empty", async () => {
  const requests = model(4);
  await draftAiGuidedQuestions({ ...JOB, count: 4, hiringChallenges: "" });
  assert.ok(!requests[0].messages[0].content.includes("Hiring challenges"));
  const again = model(4);
  await draftAiGuidedQuestions({ ...JOB, count: 4 });
  assert.match(
    again[0].messages[0].content,
    /Hiring challenges \(private to the recruiter\):\nSYNTH-CHALLENGES/,
  );
});

test("the prompt carries the question fairness policy whole", async () => {
  const requests = model(4);
  await draftAiGuidedQuestions({ ...JOB, count: 4 });
  assert.ok(requests[0].system.includes(QUESTION_FAIRNESS_POLICY));
  for (const topic of [
    "age",
    "pregnancy",
    "religion",
    "union membership",
    "salary history",
    "gaps in employment",
  ]) {
    assert.ok(QUESTION_FAIRNESS_POLICY.includes(topic), topic);
  }
  assert.match(QUESTION_FAIRNESS_POLICY, /double-barreled/);
  assert.match(QUESTION_FAIRNESS_POLICY, /equivalent tools and methods/);
  assert.match(QUESTION_FAIRNESS_POLICY, /no CV/);
  assert.match(QUESTION_FAIRNESS_POLICY, /never prefer or mark down a kind of person/);
});

test("4 to 8: each count is asked for and kept; more are trimmed; other counts refused with no call", async () => {
  assert.deepEqual(DRAFT_COUNTS, [4, 5, 6, 7, 8]);
  for (const count of DRAFT_COUNTS) {
    const requests = model(count + 2);
    const r = await draftAiGuidedQuestions({ ...JOB, count });
    assert.equal(r.questions.length, count, `${count}`);
    assert.match(requests[0].messages[0].content, new RegExp(`^Write exactly ${count} questions`));
  }
  for (const count of [0, 3, 9, 5.5, Number.NaN]) {
    const requests = model(5);
    const r = await draftAiGuidedQuestions({ ...JOB, count });
    assert.deepEqual([r.questions, r.failure], [null, "bad_count"], `${count}`);
    assert.equal(requests.length, 0, "no model call");
  }
});

test("each draft has a competency and a private scoring guide draft", async () => {
  model(5);
  const r = await draftAiGuidedQuestions(JOB);
  for (const q of r.questions) {
    assert.equal(q.competency, "Ownership");
    assert.ok(q.rubric.length > 0);
  }
});

test("every draft is checked before it is returned: the question, or its guide", async () => {
  model([
    {
      question: "Tell me about a support queue you cleared.",
      competency: "Ownership",
      rubric: "Names the queue.",
    },
    {
      question: "Are you planning to start a family soon?",
      competency: "Motivation for the role",
      rubric: "Any.",
    },
    {
      question: "Tell me about coaching an agent.",
      competency: "Leadership",
      rubric: "Prefer a younger candidate who is not too old.",
    },
    {
      question: "Tell me about leading a national support team.",
      competency: "Leadership",
      rubric: "Names the team.",
    },
  ]);
  const r = await draftAiGuidedQuestions({ ...JOB, count: 4 });
  assert.deepEqual(
    r.questions.map((q) => q.issue),
    [
      null,
      { topic: "family or marital status", part: "question" },
      { topic: "age", part: "scoring guide" },
      null,
    ],
  );
});

test("a failed call is a named failure, never a throw; no job text means no call", async () => {
  model("throw");
  const r = await (async () => {
    const saved = console.error;
    console.error = () => {};
    try {
      return await draftAiGuidedQuestions(JOB);
    } finally {
      console.error = saved;
    }
  })();
  assert.deepEqual(r, { questions: null, failure: "model_error" });
  const requests = model(5);
  const empty = await draftAiGuidedQuestions({ ...JOB, description: " ", requiredSkills: "" });
  assert.equal(empty.failure, "no_job_text");
  assert.equal(requests.length, 0);
});
