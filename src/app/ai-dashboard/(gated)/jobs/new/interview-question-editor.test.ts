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

/* ── Weight: the four stops step 8 uses, shown as the save rounds ── */

const { WEIGHT_STOPS } = await import("../../../../../lib/weights.ts");

/** The weight select's options for question 1, as [value, label, selected]. */
function weightOptions(html) {
  const at = html.indexOf('aria-label="Weight for question 1"');
  const select = html.slice(at, html.indexOf("</select>", at));
  return [...select.matchAll(/<option value="(\d+)"( selected="")?>([^<]*)<\/option>/g)].map(
    (m) => [m[1], m[3], Boolean(m[2])],
  );
}

test("weight: every option is a real stop, labelled as on step 8 (Less / Normal / More / Most)", () => {
  const options = weightOptions(render({ questions: qs(1) }));
  assert.deepEqual(
    options.map(([value, label]) => [value, label]),
    WEIGHT_STOPS.map((s) => [String(s.stored), s.label]),
  );
  assert.deepEqual(
    options.map(([, label]) => label),
    ["Less", "Normal", "More", "Most"],
  );
});

test("weight: a new question shows Normal", () => {
  const selected = weightOptions(render({ questions: qs(1) })).filter(([, , on]) => on);
  assert.deepEqual(selected, [["2", "Normal", true]]);
});

test("weight: a question at 6 shows Most; one that is not a stop shows Normal, as it would save", () => {
  const at = (weight) =>
    weightOptions(render({ questions: [{ ...qs(1)[0], weight }] }))
      .filter(([, , on]) => on)
      .map(([, label]) => label);
  assert.deepEqual(at("6"), ["Most"]);
  assert.deepEqual(at("1"), ["Less"]);
  assert.deepEqual(at("5"), ["Normal"]);
  assert.deepEqual(at(""), ["Normal"]);
});

test("the live variant (step 6): Sarah's empty-state line and the equal-weight line; the async copy is not shown", () => {
  const empty = render({ questions: [], variant: "live", showWeightAndTiming: false });
  assert.match(empty, /Add 4-8\. Sarah asks each one live, in\s+this order\./);
  assert.doesNotMatch(empty, /on camera in their own time|Leave this empty/);
  const full = render({ questions: qs(4), variant: "live", showWeightAndTiming: false });
  assert.match(full, /Each question counts equally and is marked against its own scoring guide\./);
  assert.doesNotMatch(full, /questions works best|practice round/);
  // The async variant (step 5, the default) keeps its own lines, and no longer says "leave this empty".
  const asyncEmpty = render({ questions: [] });
  assert.match(asyncEmpty, /on camera in their\s+own time - there&#x27;s no call to schedule\./);
  assert.doesNotMatch(asyncEmpty, /Leave this empty/);
});
