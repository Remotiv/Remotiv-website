/**
 * #12: the job wizard's AI Video Interview words, as approved on 23 Nov, and
 * the wizard showing exactly them, with no CV promise left in the option.
 *
 *   node --test "src/app/ai-dashboard/(gated)/jobs/new/ai-video-copy.test.ts"
 */
// @ts-nocheck - same reason as the other node:test files.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../../../../test-support/node-resolve.mjs", import.meta.url));

const {
  AI_VIDEO_OPTION_DESCRIPTION,
  AI_VIDEO_QUESTION_COUNT_WARNING,
  AI_VIDEO_QUESTIONS_HINT,
  aiVideoQuestionCountOutOfRange,
} = await import("./ai-video-copy.ts");

test("the three approved strings, exactly", () => {
  assert.equal(
    AI_VIDEO_OPTION_DESCRIPTION,
    "The AI interviewer asks all approved job questions in order. In AI-Guided mode, Sarah can ask up to 2 relevant follow-up questions per question.",
  );
  assert.equal(
    AI_VIDEO_QUESTIONS_HINT,
    "4 to 8 questions. Estimated duration: 30 minutes. Candidates using the same approved question set receive identical questions in the same order.",
  );
  assert.equal(
    AI_VIDEO_QUESTION_COUNT_WARNING,
    "AI Video Interview requires 4 to 8 questions. Please update the job's interview questions to continue.",
  );
});

test("the warning shows below 4 and above 8, matching the send's refusal", () => {
  for (const n of [0, 1, 3, 9, 20]) assert.equal(aiVideoQuestionCountOutOfRange(n), true, `${n}`);
  for (const n of [4, 5, 6, 7, 8]) assert.equal(aiVideoQuestionCountOutOfRange(n), false, `${n}`);
});

const WIZARD = readFileSync(new URL("./_wizard-client.tsx", import.meta.url), "utf8");

/** The AI Video Interview OptionRow, from its title to its closing tag. */
function aiVideoRow() {
  const start = WIZARD.lastIndexOf("<OptionRow", WIZARD.indexOf('title="AI Video Interview"'));
  const end = WIZARD.indexOf("</OptionRow>", start);
  assert.ok(start > 0 && end > start);
  return WIZARD.slice(start, end);
}

test("the wizard renders exactly these: description, hint, and the warning on the same count", () => {
  const row = aiVideoRow();
  assert.match(row, /desc=\{AI_VIDEO_OPTION_DESCRIPTION\}/);
  assert.match(row, /<p className=\{HINT_CLS\}>\{AI_VIDEO_QUESTIONS_HINT\}<\/p>/);
  assert.match(
    row,
    /\{aiVideoQuestionCountOutOfRange\(\s*state\.interview_questions\.filter\(\(q\) => q\.question\.trim\(\)\)\.length,\s*\) && \(\s*<p className="[^"]+">\s*\{AI_VIDEO_QUESTION_COUNT_WARNING\}\s*<\/p>\s*\)\}/,
  );
});

test("no CV promise and no 'the first 4' left in the option, or anywhere in the wizard's AI Video copy", () => {
  const row = aiVideoRow();
  // The interviewer-name field's own hint is the only other text in the row.
  assert.doesNotMatch(row, /CV/);
  assert.doesNotMatch(WIZARD, /CV-based|the first\{" "\}|describeQuestionMix|questionMixFor/);
  for (const s of [
    AI_VIDEO_OPTION_DESCRIPTION,
    AI_VIDEO_QUESTIONS_HINT,
    AI_VIDEO_QUESTION_COUNT_WARNING,
  ]) {
    assert.doesNotMatch(s, /CV|first 4|[\u2013\u2014]/);
  }
});
