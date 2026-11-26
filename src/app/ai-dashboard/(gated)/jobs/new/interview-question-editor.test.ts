/**
 * The interview question editor (_interview-question-editor.tsx), moved out of
 * step 5 unchanged (#58 commit 2): by default it renders every control step 5
 * always had; the two props step 6 will use hide weight, thinking time and
 * answer limit, and lower the cap. Rendered with react-dom/server.
 *
 *   node --test "src/app/ai-dashboard/(gated)/jobs/new/interview-question-editor.test.ts"
 *
 * Synthetic questions.
 */
// @ts-nocheck - same reason as the other node:test files.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../../../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../../../../test-support/tsx-load.mjs", import.meta.url));

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { InterviewQuestionEditor } = await import("./_interview-question-editor.tsx");
const { EMPTY_QUESTION_INPUT, MAX_QUESTIONS } = await import(
  "../../../../../lib/interviews/types.ts"
);

const qs = (n) =>
  Array.from({ length: n }, (_, i) => ({
    ...EMPTY_QUESTION_INPUT,
    id: `q-${i}`,
    question: `Synthetic question ${i + 1}`,
  }));
const render = (props) =>
  renderToStaticMarkup(
    createElement(InterviewQuestionEditor, {
      onChange: () => {},
      otherCompetencyIds: new Set(),
      onOtherCompetency: () => {},
      ...props,
    }),
  );

test("default: every step 5 control, in step 5's order", () => {
  const html = render({ questions: qs(2) });
  const order = [
    'aria-label="Interview question 1"',
    'aria-label="Competency for question 1"',
    'aria-label="Weight for question 1"',
    'aria-label="Rubric for question 1"',
    'aria-label="Thinking time for question 1, seconds"',
    'aria-label="Answer limit for question 1, seconds"',
    "Required - the candidate can&#x27;t submit without it",
    'aria-label="Interview question 2"',
    "Add a question",
    "questions works best - long enough to judge",
  ];
  let at = -1;
  for (const s of order) {
    const next = html.indexOf(s, at + 1);
    assert.ok(next > at, `${s} after the one before`);
    at = next;
  }
});

test("default cap is MAX_QUESTIONS (8): the button says so and is disabled", () => {
  assert.equal(MAX_QUESTIONS, 8);
  const html = render({ questions: qs(8) });
  assert.match(html, /<button type="button" disabled=""[^>]*>.*That&#x27;s the maximum of 8/);
  assert.doesNotMatch(render({ questions: qs(7) }), /That&#x27;s the maximum/);
});

test("showWeightAndTiming false: no weight, thinking time or answer limit; everything else stays", () => {
  const html = render({ questions: qs(1), showWeightAndTiming: false });
  for (const gone of [
    "Weight for question",
    "Thinking time for question",
    "Answer limit for question",
  ]) {
    assert.ok(!html.includes(gone), gone);
  }
  for (const kept of [
    'aria-label="Interview question 1"',
    'aria-label="Competency for question 1"',
    'aria-label="Rubric for question 1"',
    "Required - the candidate",
  ]) {
    assert.ok(html.includes(kept), kept);
  }
});

test("maxQuestions lowers the cap", () => {
  assert.match(render({ questions: qs(4), maxQuestions: 4 }), /That&#x27;s the maximum of 4/);
});

test("empty list: the empty state", () => {
  assert.match(render({ questions: [] }), /No interview questions yet/);
});
