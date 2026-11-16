/**
 * The marketplace's experience filter and the server's buckets agree.
 *
 *   node --test "src/app/api/hire-remote/candidates/exp-buckets.test.ts"
 *
 * The client sends the chosen label as `?exp=` and the server looks it up in
 * EXP_BUCKETS by exact key. The dash sweep (b) turned the client's "0–2 yrs"
 * labels into "0-2 yrs" while the server kept en-dash keys, so every bounded
 * bucket missed and the filter silently returned everyone. Fixed in sweep (f):
 * the keys are hyphens, and an en dash in the param (a link made before) is
 * folded to a hyphen. Source pins; the route needs a live database.
 */
// @ts-nocheck - same reason as stage-tabs.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");
const ROUTE = read("./route.ts");
const MARKETPLACE = read("../../../find-freelancers/_marketplace.tsx");

const filters = (() => {
  const m = MARKETPLACE.match(/const EXP_FILTERS = \[([^\]]*)\] as const;/);
  assert.ok(m, "EXP_FILTERS not found in _marketplace.tsx");
  return [...m[1].matchAll(/"([^"]*)"/g)].map((x) => x[1]);
})();
const bucketKeys = (() => {
  const m = ROUTE.match(/const EXP_BUCKETS[^=]*= \{([\s\S]*?)\n\};/);
  assert.ok(m, "EXP_BUCKETS not found in route.ts");
  return [...m[1].matchAll(/^\s*"([^"]*)":/gm)].map((x) => x[1]);
})();

test("every filter the marketplace offers, bar Any, is a bucket the server knows, and no more", () => {
  assert.equal(filters[0], "Any");
  assert.deepEqual(filters.slice(1), bucketKeys);
});

test("the labels use a plain hyphen, never an en or em dash", () => {
  for (const label of [...filters, ...bucketKeys]) {
    assert.doesNotMatch(label, /[–—]/, label);
  }
});

test("a link made before the sweep (en dash) still lands on its bucket", () => {
  assert.match(
    ROUTE,
    /const exp = clip\(sp\.get\("exp"\)\)\.replace\(\/\\u2013\/g, "-"\) \|\| "Any";/,
  );
  for (const key of bucketKeys.filter((k) => k.includes("-"))) {
    const old = key.replace("-", "–");
    assert.ok(bucketKeys.includes(old.replace(/–/g, "-")), `${old} folds to ${key}`);
  }
});
