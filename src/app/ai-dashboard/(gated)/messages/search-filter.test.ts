/**
 * The two escapings of the Messages search text, pinned character by character (#73).
 *
 *   node --test "src/app/ai-dashboard/(gated)/messages/search-filter.test.ts"
 *
 * The LIKE layer and PostgREST's quoting share the backslash, so the
 * composition is pinned here as exact output rather than assumed. Each row is
 * what reaches PostgREST; list-scope.test.ts runs the same strings through
 * fetchMessages and an evaluator of PostgREST's reading of them.
 */
// @ts-nocheck — Node's `.ts` specifier vs this repo's tsconfig. Nothing ships from this file.
import assert from "node:assert/strict";
import { test } from "node:test";
import { plainSubjectPattern, quotedSubjectPattern, subjectOrApplicants } from "./search-filter.ts";

/** [typed, plain parameter, quoted or() value]. Raw strings: what you see is what is sent. */
const PINNED = [
  ["\\", String.raw`%\\%`, String.raw`"%\\\\%"`],
  ["%", String.raw`%\%%`, String.raw`"%\\%%"`],
  ["_", String.raw`%\_%`, String.raw`"%\\_%"`],
  ['"', '%"%', String.raw`"%\"%"`],
  [",", "%,%", '"%,%"'],
  ["(", "%(%", '"%(%"'],
  [")", "%)%", '"%)%"'],
  ["*", "%*%", '"%*%"'],
  ["50%", String.raw`%50\%%`, String.raw`"%50\\%%"`],
  [String.raw`\%`, String.raw`%\\\%%`, String.raw`"%\\\\\\%%"`],
];

test("#73 each special character escapes to exactly the pinned output on both paths", () => {
  for (const [typed, plain, quoted] of PINNED) {
    console.log(`  ${JSON.stringify(typed).padEnd(8)} plain ${plain.padEnd(10)} quoted ${quoted}`);
    assert.equal(plainSubjectPattern(typed), plain, `plain path for ${typed}`);
    assert.equal(quotedSubjectPattern(typed), quoted, `quoted path for ${typed}`);
  }
});

test("#73 a single backslash leaves the quoted path as four", () => {
  // Two for LIKE, each doubled again for the quotes.
  assert.equal(quotedSubjectPattern("\\"), `"%${"\\".repeat(4)}%"`);
});

test("#73 the plain path is never quoted", () => {
  for (const [typed] of PINNED) assert.ok(!plainSubjectPattern(typed).startsWith('"'));
});

test("#73 the disjunction carries the quoted pattern and the id list", () => {
  assert.equal(
    subjectOrApplicants("a,b", ["app-1", "app-2"]),
    'subject.ilike."%a,b%",application_id.in.(app-1,app-2)',
  );
});
