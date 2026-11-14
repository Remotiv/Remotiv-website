/**
 * The Overview greeting is not computed before the page has loaded (F2).
 *
 *   node --test "src/app/ai-dashboard/(gated)/overview-greeting.test.ts"
 *
 * greeting() reads the clock's hour. The server renders in UTC and the
 * browser in the member's own zone, so computing it during the server render
 * put one greeting in the HTML and another in the browser: React error #418
 * (QA 15 Nov, docs/QA-APPLICANTS-SPLIT.md F2). Until hydration the heading says
 * "Welcome back"; the time-of-day greeting appears after. Source pins: the
 * component's data shape is large, and the staging run proves the behaviour.
 */
// @ts-nocheck - same reason as stage-tabs.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const src = readFileSync(new URL("./_overview-client.tsx", import.meta.url), "utf8");
/** Code only: comments may name the things the code must not do. */
const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

test("greeting() has exactly one call, and it waits for hydration", () => {
  const calls = [...code.matchAll(/greeting\(\)/g)].length;
  const defs = [...code.matchAll(/function greeting\(\)/g)].length;
  assert.equal(defs, 1);
  assert.equal(calls - defs, 1, "greeting() is called somewhere else too");
  assert.match(code, /\{hydrated \? greeting\(\) : "Welcome back"\}, \{firstName\(memberName\)\}/);
});

test("hydrated is false on the server and in the hydrating render (useSyncExternalStore)", () => {
  assert.match(
    code,
    /function useIsHydrated\(\): boolean \{\s*return useSyncExternalStore\(\s*NEVER_CHANGES,\s*\(\) => true,\s*\(\) => false,\s*\);/,
  );
  assert.match(code, /const hydrated = useIsHydrated\(\);/);
  assert.doesNotMatch(
    code,
    /useState\(\s*false\s*\)[\s\S]{0,80}setHydrated/,
    "the useEffect pattern flashes after paint",
  );
});

test("the placeholder is plain copy: no em or en dash", () => {
  assert.doesNotMatch("Welcome back", /[–—]/);
});
