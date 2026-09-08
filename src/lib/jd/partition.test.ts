/**
 * The partition contract.
 *
 *   node --test src/lib/jd/partition.test.ts
 *
 * This is the check that makes a model call safe to put in front of a
 * recruiter, so it is tested without a model, a network or a server. Every case
 * below is a way a response can be unusable, and every one of them must produce
 * null rather than a repaired result.
 */

// @ts-nocheck — same reason as src/lib/supabase/paging.test.ts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { isUseful, splittableLines, toGroups } from "./partition.ts";

const LINES = ["intro", "duty one", "duty two", "req one", "req two"];
const ok = [
  { kind: "description", start: 1, end: 1 },
  { kind: "responsibilities", start: 2, end: 3 },
  { kind: "requirements", start: 4, end: 5 },
];

test("a valid partition returns the recruiter's own lines", () => {
  const groups = toGroups(ok, LINES);
  assert.deepEqual(groups, [
    { kind: "description", lines: ["intro"] },
    { kind: "responsibilities", lines: ["duty one", "duty two"] },
    { kind: "requirements", lines: ["req one", "req two"] },
  ]);
});

test("the text comes from the input, never from the response", () => {
  /*
   * The reason ranges are asked for instead of text. Even a response carrying
   * a rewritten line cannot put it in the box — there is nowhere for it to go.
   */
  const tampered = ok.map((r) => ({ ...r, lines: ["ENTIRELY DIFFERENT TEXT"] }));
  const groups = toGroups(tampered, LINES);
  assert.deepEqual(
    groups.flatMap((g) => g.lines),
    LINES,
  );
});

test("a gap is rejected, not patched", () => {
  const gap = [
    { kind: "description", start: 1, end: 1 },
    { kind: "requirements", start: 4, end: 5 }, // 2 and 3 unclaimed
  ];
  assert.equal(toGroups(gap, LINES), null);
});

test("an overlap is rejected", () => {
  const overlap = [
    { kind: "responsibilities", start: 1, end: 3 },
    { kind: "requirements", start: 3, end: 5 }, // 3 twice
  ];
  assert.equal(toGroups(overlap, LINES), null);
});

test("stopping short is rejected — a partial answer is not a partial answer", () => {
  const short = [
    { kind: "description", start: 1, end: 1 },
    { kind: "responsibilities", start: 2, end: 3 },
  ];
  assert.equal(toGroups(short, LINES), null);
});

test("running past the end is rejected", () => {
  const over = [
    { kind: "description", start: 1, end: 1 },
    { kind: "responsibilities", start: 2, end: 99 },
  ];
  assert.equal(toGroups(over, LINES), null);
});

test("out-of-order ranges are rejected", () => {
  const jumbled = [
    { kind: "requirements", start: 4, end: 5 },
    { kind: "description", start: 1, end: 1 },
    { kind: "responsibilities", start: 2, end: 3 },
  ];
  assert.equal(toGroups(jumbled, LINES), null);
});

test("an unknown kind is rejected", () => {
  const bad = [{ kind: "benefits", start: 1, end: 5 }];
  assert.equal(toGroups(bad, LINES), null);
});

test("non-integer, missing and non-array responses are rejected", () => {
  assert.equal(toGroups([{ kind: "description", start: 1.5, end: 5 }], LINES), null);
  assert.equal(toGroups([{ kind: "description", start: "1", end: "5" }], LINES), null);
  assert.equal(toGroups([{ start: 1, end: 5 }], LINES), null);
  assert.equal(toGroups([], LINES), null);
  assert.equal(toGroups(null, LINES), null);
  assert.equal(toGroups("groups", LINES), null);
});

test("an empty range is rejected", () => {
  const empty = [
    { kind: "description", start: 1, end: 0 },
    { kind: "responsibilities", start: 1, end: 5 },
  ];
  assert.equal(toGroups(empty, LINES), null);
});

test("one group covering everything is valid but not useful", () => {
  const single = [{ kind: "description", start: 1, end: 5 }];
  const groups = toGroups(single, LINES);
  assert.equal(groups.length, 1, "it is a valid partition");
  assert.equal(isUseful(groups), false, "but it proposes nothing");
  assert.equal(isUseful(toGroups(ok, LINES)), true);
  assert.equal(isUseful(null), false);
});

test("splittableLines drops blanks and trims, so numbering matches the prompt", () => {
  assert.deepEqual(splittableLines("  a  \n\n\n b \r\n\r\nc\n"), ["a", "b", "c"]);
  assert.deepEqual(splittableLines(""), []);
});
