/**
 * The Applicants Split switch: off by default, on only by the exact value,
 * narrowed by the optional pilot list.
 *
 *   node --test src/app/ai-dashboard/lib/applicants-split-flag.test.ts
 */
// @ts-nocheck - same reason as company-roles.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { test } from "node:test";
import { isApplicantsSplitOn } from "./applicants-split-flag.ts";

const CO = "c0000000-0000-0000-0000-000000000001";
const OTHER = "c0000000-0000-0000-0000-000000000002";

test("off when the variable is missing, empty, or anything but exactly 1", () => {
  for (const value of [undefined, "", "0", "true", "yes", " 1", "1 ", "01", "on"]) {
    assert.equal(isApplicantsSplitOn(CO, { APPLICANTS_SPLIT_ENABLED: value }), false, `${value}`);
  }
});

test("on for every company when enabled and no pilot list is set", () => {
  assert.equal(isApplicantsSplitOn(CO, { APPLICANTS_SPLIT_ENABLED: "1" }), true);
  assert.equal(
    isApplicantsSplitOn(OTHER, { APPLICANTS_SPLIT_ENABLED: "1", APPLICANTS_SPLIT_COMPANIES: "" }),
    true,
  );
  assert.equal(
    isApplicantsSplitOn(OTHER, {
      APPLICANTS_SPLIT_ENABLED: "1",
      APPLICANTS_SPLIT_COMPANIES: " , ",
    }),
    true,
    "a list of only separators names nobody, so it does not narrow",
  );
});

test("the pilot list narrows on to the companies it names", () => {
  const env = { APPLICANTS_SPLIT_ENABLED: "1", APPLICANTS_SPLIT_COMPANIES: ` ${CO} , x ` };
  assert.equal(isApplicantsSplitOn(CO, env), true);
  assert.equal(isApplicantsSplitOn(OTHER, env), false);
  assert.equal(isApplicantsSplitOn(null, env), false);
  assert.equal(isApplicantsSplitOn(undefined, env), false);
});

test("the pilot list cannot turn Split on by itself", () => {
  assert.equal(isApplicantsSplitOn(CO, { APPLICANTS_SPLIT_COMPANIES: CO }), false);
  assert.equal(
    isApplicantsSplitOn(CO, { APPLICANTS_SPLIT_ENABLED: "0", APPLICANTS_SPLIT_COMPANIES: CO }),
    false,
  );
});

test("with no env argument it reads process.env, and is off here", () => {
  const saved = process.env.APPLICANTS_SPLIT_ENABLED;
  delete process.env.APPLICANTS_SPLIT_ENABLED;
  try {
    assert.equal(isApplicantsSplitOn(CO), false);
  } finally {
    if (saved !== undefined) process.env.APPLICANTS_SPLIT_ENABLED = saved;
  }
});
