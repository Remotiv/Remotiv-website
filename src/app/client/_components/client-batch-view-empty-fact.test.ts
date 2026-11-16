/**
 * The client batch view's empty facts (dash sweep d).
 *
 *   node --test "src/app/client/_components/client-batch-view-empty-fact.test.ts"
 *
 * A FactBlock shows a placeholder for a missing value and greys it out by
 * comparing the value with that same placeholder. The two used to be separate
 * "—" literals, so changing one without the other would have left an empty
 * fact in full black. Both now read one constant, EMPTY_FACT ("-"). Source
 * pins: FactBlock is not exported and the batch view needs a full batch.
 */
// @ts-nocheck - same reason as stage-tabs.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const src = readFileSync(new URL("./client-batch-view.tsx", import.meta.url), "utf8");
/** Code only: comments may still say what the code used to do. */
const code = src
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
  .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

test("one placeholder constant, a hyphen", () => {
  const defs = [...code.matchAll(/const EMPTY_FACT = "([^"]*)";/g)];
  assert.equal(defs.length, 1, "EMPTY_FACT is defined exactly once");
  assert.equal(defs[0][1], "-");
});

test("FactBlock greys out by comparing with that constant, not a literal", () => {
  const fact = code.slice(code.indexOf("function FactBlock("));
  assert.match(fact, /const empty = value === EMPTY_FACT;/);
  assert.doesNotMatch(fact, /value === "/);
});

test("every FactBlock fallback is the constant: the four profile facts", () => {
  const fallbacks = [...code.matchAll(/value=\{candidate\.(\w+) \|\| ([^}]+)\}/g)];
  assert.deepEqual(
    fallbacks.map((m) => m[1]),
    ["current_role", "current_salary", "salary_expectations", "notice_period"],
  );
  for (const [, field, fallback] of fallbacks) {
    assert.equal(fallback.trim(), "EMPTY_FACT", `${field} falls back to ${fallback}`);
  }
});

test("no em or en dash is left in the file's code", () => {
  assert.doesNotMatch(code, /[—–]|&mdash;|&ndash;/);
});
