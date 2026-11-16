/**
 * The education dates separator is stored data, not copy.
 *
 *   node --test "src/app/talent/(authed)/dashboard/edit/education-dates-separator.test.ts"
 *
 * Three places agree on one character: the freelancer intake writes
 * `education.dates` as start and end joined by it, the talent profile editor
 * splits the stored string on it to fill Start and End, and the editor's save
 * joins them with it again. It is an en dash (U+2013) with no spaces, because
 * the editor's dates are "YYYY-MM": a hyphen separator could not be split
 * back. The dash sweep (b) changed the intake's join to a hyphen and broke the
 * editor for every new signup; this pins the three together.
 *
 * The em-dash ratchet does not see these: it counts U+2014 only.
 */
// @ts-nocheck - same reason as stage-tabs.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");
const INTAKE = read("../../../../join-as-freelancer/page.tsx");
const EDITOR = read("./_edit-client.tsx");
const SAVE = read("./actions.ts");

/** The one separator a site uses; fails unless the expression appears exactly once. */
function separator(src, pattern, where) {
  const found = [...src.matchAll(pattern)];
  assert.equal(
    found.length,
    1,
    `${where}: expected the expression exactly once, found ${found.length}`,
  );
  return found[0][1];
}

const SITES = {
  "intake join (join-as-freelancer/page.tsx)": separator(
    INTAKE,
    /dates:\s*\[eduStart\.trim\(\), eduEnd\.trim\(\)\]\.filter\(Boolean\)\.join\("([^"]*)"\)/g,
    "intake",
  ),
  "editor split (_edit-client.tsx)": separator(
    EDITOR,
    /\(eduRaw\.dates as string\)\.split\("([^"]*)"\)/g,
    "editor split",
  ),
  "editor save (actions.ts)": separator(
    SAVE,
    /datesOut = \[start, end\]\.filter\(Boolean\)\.join\("([^"]*)"\)/g,
    "editor save",
  ),
};

test("the intake join, the editor split and the editor save use the same separator", () => {
  const chars = new Set(Object.values(SITES));
  assert.equal(chars.size, 1, `separators differ: ${JSON.stringify(SITES)}`);
});

test("that separator is an en dash (U+2013) with no spaces", () => {
  for (const [site, sep] of Object.entries(SITES)) {
    assert.equal(sep, "–", `${site} uses ${JSON.stringify(sep)}`);
  }
});

test("it round-trips both shapes the dates take: years and YYYY-MM", () => {
  const sep = SITES["intake join (join-as-freelancer/page.tsx)"];
  for (const [start, end] of [
    ["2013", "2017"],
    ["2019-09", "2023-06"],
  ]) {
    const parts = [start, end].join(sep).split(SITES["editor split (_edit-client.tsx)"]);
    assert.deepEqual(parts, [start, end], `${start} / ${end}`);
  }
});

test("why not a hyphen: YYYY-MM dates joined by one cannot be split back", () => {
  assert.notDeepEqual(["2019-09", "2023-06"].join("-").split("-"), ["2019-09", "2023-06"]);
});
