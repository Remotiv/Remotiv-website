/**
 * The job wizard's compensation line (#48): a complete range, a partial one,
 * and none at all.
 *
 *   node --test "src/app/ai-dashboard/(gated)/jobs/new/salary-range.test.ts"
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const { salaryRange } = await import("./salary-range.ts");

const range = (min, max, currency = "PKR") => salaryRange({ show: true, min, max, currency });

test("a complete range keeps its formatting", () => {
  assert.deepEqual(range("40000", "60000"), { kind: "range", text: "PKR 40,000 – 60,000" });
  assert.deepEqual(range("2500", "4,000", "USD"), { kind: "range", text: "$ 2,500 – 4,000" });
});

test("a partial range keeps its formatting, the missing bound reading -", () => {
  assert.deepEqual(range("40000", ""), { kind: "range", text: "PKR 40,000 – -" });
  assert.deepEqual(range("", "60000", "USD"), { kind: "range", text: "$ - – 60,000" });
});

// Negative control: return a range for empty bounds and this reads "PKR - – -".
test("both bounds missing is Not specified, never a range of placeholders", () => {
  assert.deepEqual(range("", ""), { kind: "unspecified" });
  assert.deepEqual(range("  ", "abc"), { kind: "unspecified" }, "nothing usable typed");
  assert.deepEqual(salaryRange({ show: false, min: "40000", max: "60000", currency: "PKR" }), {
    kind: "hidden",
  });
});

// Negative control: render "unspecified" through the range branch and "/mo" follows it.
test("the wizard shows Not specified for an empty range, and /mo only after a real one", () => {
  const src = readFileSync(new URL("./_wizard-client.tsx", import.meta.url), "utf8");
  const review = src.slice(src.indexOf('<ReviewCard label="Compensation"'));
  assert.match(
    review.slice(0, 700),
    /compensation\.kind === "range"[\s\S]*?\/mo[\s\S]*?compensation\.kind === "unspecified"[\s\S]*?Not specified[\s\S]*?Not shown publicly/,
  );
  assert.equal(src.match(/\{compensation\.text\}/g)?.length, 2, "both renders use the range text");
  assert.ok(!/\{compensation\}/.test(src), "no render of the object itself");
  assert.match(
    src,
    /compensation\.kind === "unspecified" \? \(\s*<small[^>]*>\s*Compensation not specified/,
  );
});
