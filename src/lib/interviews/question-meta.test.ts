/**
 * Which marking scheme an answer is scored against - frozen, legacy-by-id, or
 * none - and that the position fallback is gone.
 *
 *   node --test src/lib/interviews/question-meta.test.ts
 */
// @ts-nocheck — same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../test-support/node-resolve.mjs", import.meta.url));
const { readScoringSnapshot, resolveQuestionMeta } = await import("./question-meta.ts");
const { CV_WEIGHT_DEFAULT } = await import("../weights.ts");

const questions = [
  { id: "q-a", position: 1, question: "Tell me about a launch." },
  { id: "q-b", position: 2, question: "Describe a conflict." },
];
const frozen = [
  {
    position: 1,
    question_id: "q-a",
    competency: "Delivery",
    rubric: "Names a shipped thing.",
    weight: 4,
  },
  {
    position: 2,
    question_id: "q-b",
    competency: "Collaboration",
    rubric: "Names the other party.",
    weight: 1,
  },
];
/** The job was re-saved with question 2 deleted and a new question inserted first: ids churned, positions shifted. */
const liveAfterReorder = [
  {
    id: "q-new",
    position: 1,
    question: "Why this company?",
    competency: "Motivation",
    rubric: "Says something specific.",
    weight: 6,
  },
  {
    id: "q-a2",
    position: 2,
    question: "Tell me about a launch.",
    competency: "Delivery",
    rubric: "Names a shipped thing.",
    weight: 4,
  },
];
const answer2 = { position: 2, question_text: "Describe a conflict." };

test("with a scoring snapshot, the frozen scheme wins and live rows are never consulted", () => {
  const meta = resolveQuestionMeta(answer2, questions, frozen, liveAfterReorder);
  assert.deepEqual(meta, {
    questionText: "Describe a conflict.",
    competency: "Collaboration",
    rubric: "Names the other party.",
    weight: 1,
    source: "scoring_snapshot",
  });
});

test("legacy session: the original id still exists → that row's scheme applies", () => {
  const liveUnchanged = [
    {
      id: "q-a",
      position: 1,
      question: "Tell me about a launch.",
      competency: "Delivery",
      rubric: "Names a shipped thing.",
      weight: 4,
    },
    {
      id: "q-b",
      position: 2,
      question: "Describe a conflict.",
      competency: "Collaboration",
      rubric: "Names the other party.",
      weight: 1,
    },
  ];
  const meta = resolveQuestionMeta(answer2, questions, null, liveUnchanged);
  assert.equal(meta.source, "live_by_id");
  assert.equal(meta.rubric, "Names the other party.");
  assert.equal(meta.weight, 1);
});

test("legacy session: the original id is gone → NO position fallback; text frozen, no rubric, Normal weight", () => {
  const meta = resolveQuestionMeta(answer2, questions, null, liveAfterReorder);
  assert.deepEqual(meta, {
    questionText: "Describe a conflict.",
    competency: null,
    rubric: null,
    weight: CV_WEIGHT_DEFAULT,
    source: "none",
  });
  // The row now at position 2 has a Delivery rubric and weight 4 - none of it leaks.
  assert.notEqual(meta.rubric, liveAfterReorder[1].rubric);
});

test("question text never comes from a live row", () => {
  const meta = resolveQuestionMeta(
    { position: 2, question_text: null },
    [],
    null,
    liveAfterReorder,
  );
  assert.equal(meta.questionText, "");
  const withAnswerText = resolveQuestionMeta(
    { position: 2, question_text: "From the answer row." },
    [],
    null,
    liveAfterReorder,
  );
  assert.equal(withAnswerText.questionText, "From the answer row.");
});

test("a snapshot that does not cover the position falls back to the legacy rule for that answer only", () => {
  const partial = [frozen[0]];
  const meta = resolveQuestionMeta(answer2, questions, partial, liveAfterReorder);
  assert.equal(meta.source, "none");
});

test("readScoringSnapshot tolerates junk and normalises blanks", () => {
  assert.deepEqual(readScoringSnapshot(null), []);
  assert.deepEqual(readScoringSnapshot([{ position: "1" }, null, 7]), []);
  assert.deepEqual(
    readScoringSnapshot([
      { position: 1, question_id: "x", competency: "  ", rubric: "", weight: "4" },
    ]),
    [{ position: 1, question_id: "x", competency: null, rubric: null, weight: null }],
  );
  // A null weight resolves to Normal at use.
  const meta = resolveQuestionMeta(
    { position: 1, question_text: "t" },
    [],
    readScoringSnapshot([{ position: 1, question_id: "x", weight: null }]),
    [],
  );
  assert.equal(meta.weight, CV_WEIGHT_DEFAULT);
});
