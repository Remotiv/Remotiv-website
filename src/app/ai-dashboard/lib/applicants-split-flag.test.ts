/**
 * The Applicants Split switch (commit 10a): on by default for every company;
 * APPLICANTS_SPLIT_DISABLED="1" exactly is the kill switch back to the old page.
 *
 *   node --test src/app/ai-dashboard/lib/applicants-split-flag.test.ts
 */
// @ts-nocheck - same reason as company-roles.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { test } from "node:test";
import { isApplicantsSplitOn } from "./applicants-split-flag.ts";

const CO = "c0000000-0000-0000-0000-000000000001";
const OTHER = "c0000000-0000-0000-0000-000000000002";

test("on for every company by default, with no variables at all", () => {
  for (const id of [CO, OTHER, null, undefined]) {
    assert.equal(isApplicantsSplitOn(id, {}), true, `${id}`);
  }
});

test("the kill switch is exactly 1, and it turns Split off for everyone", () => {
  for (const id of [CO, OTHER, null]) {
    assert.equal(isApplicantsSplitOn(id, { APPLICANTS_SPLIT_DISABLED: "1" }), false, `${id}`);
  }
});

test("anything else leaves Split on", () => {
  for (const value of [undefined, "", "0", "true", "yes", " 1", "1 ", "01", "on"]) {
    assert.equal(isApplicantsSplitOn(CO, { APPLICANTS_SPLIT_DISABLED: value }), true, `${value}`);
  }
});

test("the old opt-in variables do nothing now, in either direction", () => {
  assert.equal(isApplicantsSplitOn(CO, { APPLICANTS_SPLIT_ENABLED: "0" }), true);
  assert.equal(isApplicantsSplitOn(OTHER, { APPLICANTS_SPLIT_COMPANIES: CO }), true);
  assert.equal(
    isApplicantsSplitOn(CO, { APPLICANTS_SPLIT_ENABLED: "1", APPLICANTS_SPLIT_DISABLED: "1" }),
    false,
    "the kill switch wins over a leftover opt-in",
  );
});

test("with no env argument it reads process.env, and is on here", () => {
  const saved = process.env.APPLICANTS_SPLIT_DISABLED;
  delete process.env.APPLICANTS_SPLIT_DISABLED;
  try {
    assert.equal(isApplicantsSplitOn(CO), true);
    process.env.APPLICANTS_SPLIT_DISABLED = "1";
    assert.equal(isApplicantsSplitOn(CO), false);
  } finally {
    if (saved === undefined) delete process.env.APPLICANTS_SPLIT_DISABLED;
    else process.env.APPLICANTS_SPLIT_DISABLED = saved;
  }
});
