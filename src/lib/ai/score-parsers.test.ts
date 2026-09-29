/**
 * The two scorers' parsers: a number the model did not give is not zero.
 *
 *   node --test src/lib/ai/score-parsers.test.ts
 */
// @ts-nocheck — same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAnswerJson, parseScoreJson, readScore, SCORE_DIMENSIONS } from "./score-parsers.ts";

const dims = (over = {}) =>
  SCORE_DIMENSIONS.map((dimension, i) => ({
    dimension,
    score: 60 + i,
    reasoning: "r",
    quote: "q",
    ...(over[dimension] ?? {}),
  }));

const good = (over = {}) => ({
  verdict: "Strong match — verify one thing.",
  overall_score: 71,
  dimension_scores: dims(),
  strengths: [{ point: "p", quote: "q" }],
  missing_requirements: ["m"],
  concerns: ["c"],
  confidence: "high",
  summary: "s",
  ...over,
});

test("readScore: only a finite number in 0-100, rounded; everything else is null, never 0", () => {
  assert.equal(readScore(87.4), 87);
  assert.equal(readScore(0), 0);
  assert.equal(readScore(100), 100);
  for (const bad of [
    undefined,
    null,
    "87",
    "",
    Number.NaN,
    Number.POSITIVE_INFINITY,
    -1,
    101,
    true,
    {},
    [],
  ]) {
    assert.equal(readScore(bad), null, `readScore(${JSON.stringify(bad)})`);
  }
});

test("a well-formed CV reply parses, dimensions in canonical order whatever order they arrived", () => {
  const shuffled = good({ dimension_scores: [...dims()].reverse() });
  const out = parseScoreJson(JSON.stringify(shuffled));
  assert.equal(out.ok, true);
  assert.deepEqual(
    out.value.dimension_scores.map((d) => d.dimension),
    [...SCORE_DIMENSIONS],
  );
  assert.equal(out.value.overall_score, 71);
  assert.equal(out.value.confidence, "high");
});

test("markdown fences are tolerated; prose is not", () => {
  assert.equal(parseScoreJson(`\`\`\`json\n${JSON.stringify(good())}\n\`\`\``).ok, true);
  assert.deepEqual(parseScoreJson("I cannot score this candidate."), {
    ok: false,
    reason: "not valid JSON",
  });
  assert.deepEqual(parseScoreJson("[1,2,3]"), { ok: false, reason: "not a JSON object" });
});

test("CV: a missing, null, string, NaN, infinite or out-of-range overall_score fails the parse", () => {
  for (const [label, overall] of [
    ["missing", undefined],
    ["null", null],
    ["string", "87"],
    ["negative", -5],
    ["over 100", 150],
  ]) {
    const out = parseScoreJson(JSON.stringify(good({ overall_score: overall })));
    assert.equal(out.ok, false, label);
    assert.match(out.reason, /overall_score/);
  }
  // NaN and Infinity cannot travel through JSON; a raw string with them is not JSON at all.
  assert.equal(parseScoreJson('{"overall_score": NaN}').ok, false);
});

test("CV: exactly the four dimensions, each once, each with a real score", () => {
  const cases = {
    "three dimensions": { dimension_scores: dims().slice(0, 3) },
    "duplicate dimension": { dimension_scores: [...dims(), dims()[0]] },
    "unknown dimension": { dimension_scores: [...dims(), { dimension: "vibes", score: 50 }] },
    "dimension with missing score": {
      dimension_scores: dims({ experience_depth: { score: undefined } }),
    },
    "dimension with string score": {
      dimension_scores: dims({ domain_relevance: { score: "70" } }),
    },
    "dimension with 101": { dimension_scores: dims({ requirements_match: { score: 101 } }) },
    "dimensions not an array": { dimension_scores: { requirements_match: 70 } },
    "dimensions missing entirely": { dimension_scores: undefined },
  };
  for (const [label, over] of Object.entries(cases)) {
    const out = parseScoreJson(JSON.stringify(good(over)));
    assert.equal(out.ok, false, label);
    assert.match(out.reason, /dimension_scores/, label);
  }
});

test("CV: optional fields degrade, never fail - and a truncated reply that lost the numbers fails", () => {
  const sparse = parseScoreJson(JSON.stringify({ overall_score: 40, dimension_scores: dims() }));
  assert.equal(sparse.ok, true);
  assert.deepEqual(
    {
      v: sparse.value.verdict,
      s: sparse.value.strengths,
      m: sparse.value.missing_requirements,
      c: sparse.value.confidence,
    },
    { v: "", s: [], m: [], c: "low" },
  );
  // A reply cut off before overall_score: the old parser stored this as a 0.
  const truncated = JSON.stringify(good()).replace(/"overall_score":\s*71,/, "");
  const out = parseScoreJson(truncated);
  assert.equal(out.ok, false);
  assert.match(out.reason, /overall_score/);
});

test("CV: caps still apply and bare-string strengths still parse (unquoted, for the gate to drop)", () => {
  const out = parseScoreJson(
    JSON.stringify(
      good({ strengths: ["a", "b", "c", "d", "e", "f"], concerns: ["1", "2", "3", "4", "5"] }),
    ),
  );
  assert.equal(out.ok, true);
  assert.equal(out.value.strengths.length, 4);
  assert.deepEqual(out.value.strengths[0], { point: "a", quote: "" });
  assert.equal(out.value.concerns.length, 3);
});

test("interview: a valid answer reply parses; a missing or non-numeric score fails", () => {
  const ok = parseAnswerJson(
    JSON.stringify({
      score: 64.6,
      confidence: "low",
      reasoning: "r",
      strengths: [{ claim: "c", quote: "q" }],
      concerns: [],
      missing: ["m"],
    }),
  );
  assert.equal(ok.ok, true);
  assert.equal(ok.value.score, 65);
  assert.equal(ok.value.confidence, "low");
  for (const [label, score] of [
    ["missing", undefined],
    ["null", null],
    ["string", "64"],
    ["over", 120],
    ["negative", -1],
  ]) {
    const out = parseAnswerJson(JSON.stringify({ score, confidence: "high", reasoning: "r" }));
    assert.equal(out.ok, false, label);
    assert.match(out.reason, /score/);
  }
  assert.equal(parseAnswerJson("no").ok, false);
});

test("interview: unknown confidence defaults to medium (unchanged behaviour), lists capped at four", () => {
  const out = parseAnswerJson(
    JSON.stringify({
      score: 50,
      confidence: "very",
      strengths: ["a", "b", "c", "d", "e"],
      missing: ["1", "2", "3", "4", "5"],
    }),
  );
  assert.equal(out.ok, true);
  assert.equal(out.value.confidence, "medium");
  assert.equal(out.value.strengths.length, 4);
  assert.equal(out.value.missing.length, 4);
});
