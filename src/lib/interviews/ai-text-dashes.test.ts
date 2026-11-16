/**
 * Hyphens in the AI's interview prose, never in the candidate's words.
 *
 *   node --test "src/lib/interviews/ai-text-dashes.test.ts"
 *
 * The interview scorers write em and en dashes, and the copy rule is hyphens.
 * As with the CV scorecard (applicants/actions.ts), the stored text is left
 * alone and plainDashes runs where the server shapes it for the screen:
 *
 *   review.ts          verdict, summary, each answer's reasoning, the claims
 *                      of its strengths and concerns, and its missing points
 *   interview-actions  the drawer's verdict and summary
 *   live-review.ts     each live question's rationale
 *
 * Never a quote, a transcript, a criterion's item (the employer's wording) or
 * a human note: those are verbatim. Source pins, because the loaders need a
 * database; plain-dashes.test.ts covers what the helper does to text.
 */
// @ts-nocheck - same reason as stage-tabs.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const FILES = {
  review: "./review.ts",
  actions: "../../app/ai-dashboard/(gated)/applicants/interview-actions.ts",
  live: "./live-review.ts",
};
const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

/** Every plainDashes / plainDashesOrNull call in a file, with its argument's source text. */
function calls(rel) {
  const src = read(rel);
  const sf = ts.createSourceFile(rel, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out = [];
  const visit = (n) => {
    if (ts.isCallExpression(n) && /^plainDashes(OrNull)?$/.test(n.expression.getText(sf))) {
      out.push(n.arguments.map((a) => a.getText(sf)).join(", "));
    }
    // `.map(plainDashes)` passes the helper itself.
    if (ts.isCallExpression(n) && n.arguments.some((a) => a.getText(sf) === "plainDashes")) {
      out.push(`${n.expression.getText(sf)}(plainDashes)`);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return { src, calls: out };
}

test("review.ts: verdict, summary, reasoning, the two claims and missing go through the helper", () => {
  const { src, calls: c } = calls(FILES.review);
  assert.match(src, /verdict: plainDashesOrNull\(r\.verdict\),/);
  assert.match(src, /summary: deleted \? null : plainDashesOrNull\(r\.summary\),/);
  assert.match(src, /reasoning: wordsDeleted \? null : plainDashesOrNull\(r\.reasoning\),/);
  assert.match(src, /const claim = plainDashes\(item\.trim\(\)\);/);
  assert.match(
    src,
    /const claim = typeof e\.claim === "string" \? plainDashes\(e\.claim\.trim\(\)\) : "";/,
  );
  assert.match(
    src,
    /\.filter\(\(x\): x is string => typeof x === "string"\)\s*\.map\(plainDashes\)/,
  );
  assert.equal(c.length, 6, `expected 6 call sites, found ${c.length}: ${JSON.stringify(c)}`);
});

test("interview-actions.ts: the drawer's verdict and summary go through the helper", () => {
  const { src, calls: c } = calls(FILES.actions);
  assert.match(src, /verdict: plainDashesOrNull\(sc\?\.verdict \?\? null\),/);
  assert.match(src, /summary: plainDashesOrNull\(sc\?\.summary \?\? null\),/);
  assert.equal(c.length, 2, JSON.stringify(c));
});

test("live-review.ts: each question's rationale goes through the helper", () => {
  const { src, calls: c } = calls(FILES.live);
  assert.match(
    src,
    /rationale: counted && entry\.status === "scored" \? plainDashesOrNull\(entry\.rationale\) : null,/,
  );
  assert.equal(c.length, 1, JSON.stringify(c));
});

test("never a quote, a transcript, a criterion item or a human note", () => {
  for (const rel of Object.values(FILES)) {
    for (const arg of calls(rel).calls) {
      assert.doesNotMatch(
        arg,
        /quote|transcript|segment|\bitem\b(?!\.trim)|criteri|feedback|note|answer_text/i,
        `${rel}: ${arg}`,
      );
    }
  }
  const review = read(FILES.review);
  assert.match(review, /const quote = typeof e\.quote === "string" \? e\.quote\.trim\(\) : "";/);
  assert.match(review, /startSeconds: quote \? findQuoteStart\(quote, segs\) : null,/);
});
