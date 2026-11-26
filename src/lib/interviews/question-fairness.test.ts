/**
 * The question fairness check (question-fairness.ts): every protected topic is
 * blocked, and ordinary job language that shares a word with one is not.
 *
 *   node --test src/lib/interviews/question-fairness.test.ts
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { test } from "node:test";

const { FAIRNESS_TOPICS, fairnessBlockMessage, firstFairnessBlock, questionFairnessIssue } =
  await import("./question-fairness.ts");
const { BLOCKED, ALLOWED, BLOCKED_THIRD_PERSON, ALLOWED_THIRD_PERSON } = await import(
  "../../test-support/question-fairness-examples.mjs"
);

test("the topics: the thirteen the policy names", () => {
  assert.deepEqual([...FAIRNESS_TOPICS].sort(), Object.keys(BLOCKED).sort());
});

test("each protected topic is blocked, by name", () => {
  for (const [topic, questions] of Object.entries(BLOCKED)) {
    for (const q of questions) assert.equal(questionFairnessIssue(q), topic, q);
  }
});

test("the false-positive examples are not blocked", () => {
  for (const q of ALLOWED) assert.equal(questionFairnessIssue(q), null, q);
});

// Negative control: drop the THIRD_PERSON_RULES loop in questionFairnessIssue and this fails.
test("third-person bias is blocked: candidates who do not have children", () => {
  assert.equal(
    questionFairnessIssue("Prefer candidates who do not have children."),
    "family or marital status",
  );
});

test("each third-person bias example is blocked, by topic, in a question or a scoring guide", () => {
  for (const [text, topic] of BLOCKED_THIRD_PERSON) {
    assert.equal(questionFairnessIssue(text), topic, text);
    assert.match(
      firstFairnessBlock([{ question: "Tell me about a project you led.", rubric: text }]),
      new RegExp(`^Question 1's scoring guide .* touches on ${topic}, `),
      text,
    );
  }
});

test("the legitimate job topics next to those phrases are not blocked", () => {
  for (const q of ALLOWED_THIRD_PERSON) assert.equal(questionFairnessIssue(q), null, q);
});

test("the message names the question and the topic, plainly, with hyphens only", () => {
  const m = fairnessBlockMessage(2, "Are you married?", "family or marital status");
  assert.equal(
    m,
    'Question 2 ("Are you married?") touches on family or marital status, which can\'t be used to judge a candidate. Please reword it to focus on the job.',
  );
  assert.doesNotMatch(m, /[–—]/);
  const long = fairnessBlockMessage(
    1,
    `Tell me ${"about this work ".repeat(8)}and your age`,
    "age",
  );
  assert.match(long, /^Question 1 \(".{57}\.\.\."\)/, "a long question is shortened");
});

test("firstFairnessBlock: blank rows skipped, the scoring guide checked too", () => {
  assert.equal(
    firstFairnessBlock([
      { question: "", rubric: "" },
      { question: "Tell me about a project you led.", rubric: "Names the project." },
    ]),
    null,
  );
  assert.match(
    firstFairnessBlock([
      { question: "   " },
      { question: "Tell me about a project you led.", rubric: "Strong: names the result." },
      { question: "What is your nationality?" },
    ]),
    /^Question 2 \("What is your nationality\?"\) touches on nationality or ethnicity/,
  );
  assert.match(
    firstFairnessBlock([
      { question: "Tell me about a project you led.", rubric: "Prefer someone married." },
    ]),
    /^Question 1's scoring guide \("Tell me about a project you led\."\) touches on family or marital status/,
  );
});
