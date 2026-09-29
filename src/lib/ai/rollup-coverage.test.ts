/**
 * The header the rollup reads first, and the sentence the code appends.
 *
 *   node --test src/lib/ai/rollup-coverage.test.ts
 */
// @ts-nocheck — same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildCoverageHeader,
  coverageSentence,
  SKIP_PHRASES,
  summarySentenceLimit,
} from "./rollup-coverage.ts";

test("one question, one answer, one score: the header says ONE and rules out a pattern", () => {
  const header = buildCoverageHeader({
    questionsAsked: 1,
    answersRecorded: 1,
    answersScored: 1,
    unscored: [],
  });
  assert.equal(
    header,
    [
      "Interview of 1 question. 1 answered, 1 scored.",
      "You are given ONE scored answer. There is no cross-answer comparison to make.",
    ].join("\n"),
  );
  assert.equal(
    coverageSentence({ questionsAsked: 1, answersRecorded: 1, answersScored: 1, unscored: [] }),
    "",
  );
  assert.equal(summarySentenceLimit(1), 2);
});

test("eight questions, three unscored: the model is told which, by interview position, in order", () => {
  const c = {
    questionsAsked: 8,
    answersRecorded: 7,
    answersScored: 5,
    unscored: [
      { position: 6, cause: "transcription_failed" },
      { position: 2, cause: "too_little_speech" },
      { position: 8, cause: "not_answered" },
    ],
  };
  assert.equal(
    buildCoverageHeader(c),
    [
      "Interview of 8 questions. 7 answered, 5 scored.",
      "Not scored: question 2 (too little speech to assess), question 6 (transcription failed), question 8 (not answered).",
      "You are given 5 scored answers. Only those. Do not describe the ones listed as not scored.",
    ].join("\n"),
  );
  assert.equal(
    coverageSentence(c),
    " Based on 5 of 8 questions - see the individual answers for why the rest were not scored.",
  );
  assert.equal(summarySentenceLimit(5), 5);
});

test("the denominator is questions asked, not answers recorded - agreeing with the page", () => {
  // One of three recorded and scored: before v8 this printed no coverage note at all.
  const c = {
    questionsAsked: 3,
    answersRecorded: 1,
    answersScored: 1,
    unscored: [
      { position: 2, cause: "not_answered" },
      { position: 3, cause: "not_answered" },
    ],
  };
  assert.match(coverageSentence(c), /Based on 1 of 3 questions/);
  assert.match(buildCoverageHeader(c), /Interview of 3 questions\. 1 answered, 1 scored\./);
});

test("every phrase is fixed text - no placeholder, no bracket, no colon a row value could arrive through", () => {
  for (const [cause, phrase] of Object.entries(SKIP_PHRASES)) {
    assert.match(phrase, /^[a-z ]+$/, `${cause}: "${phrase}"`);
  }
});
