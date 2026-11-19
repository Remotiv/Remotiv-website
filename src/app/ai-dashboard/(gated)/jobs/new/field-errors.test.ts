/**
 * #37: the new-job wizard's errors are linked to their fields and a failed
 * step moves focus to the first field in error.
 *
 *   node --test "src/app/ai-dashboard/(gated)/jobs/new/field-errors.test.ts"
 *
 * field-errors.ts runs as shipped. The wizard is a 4,600-line client module
 * full of server actions, so its wiring is pinned from source: every step
 * field spreads its ARIA attributes, every error message carries the id they
 * point at, and both failure paths (a step that does not validate, a draft
 * with no title) move focus.
 */
// @ts-nocheck - same reason as salary-range.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  fieldErrorId,
  fieldErrorProps,
  firstInvalidFieldId,
  WIZARD_FIELD_IDS,
} from "./field-errors.ts";

const wizard = readFileSync(new URL("./_wizard-client.tsx", import.meta.url), "utf8");

test("a field in error is aria-invalid and described by its message; a valid one carries neither", () => {
  assert.deepEqual(fieldErrorProps("w-title", "Add a job title to continue."), {
    "aria-invalid": true,
    "aria-describedby": "w-title-error",
  });
  assert.deepEqual(fieldErrorProps("w-title", undefined), {});
  assert.deepEqual(fieldErrorProps("w-title", ""), {}, "a cleared error is no error");
});

test("focus goes to the first field in error, in on-screen order", () => {
  assert.equal(firstInvalidFieldId({ title: "Add a job title to continue." }), "w-title");
  assert.equal(firstInvalidFieldId({ salary_max: "x", salary_min: "y" }), "w-min");
  assert.equal(firstInvalidFieldId({ location: "x" }), "w-country");
  assert.equal(firstInvalidFieldId({ description: "" }), null, "a cleared error is skipped");
  assert.equal(firstInvalidFieldId({}), null);
});

const has = (re, msg) => assert.ok(re.test(wizard), msg);

// Negative control: drop the spread or the message id from any field and its pair fails.
test("every step field and its message are wired in the wizard", () => {
  for (const [key, id] of Object.entries(WIZARD_FIELD_IDS)) {
    has(
      new RegExp(`id="${id}"\\s*\\{\\.\\.\\.fieldErrorProps\\("${id}", errors\\.${key}\\)\\}`),
      `${id} carries its ARIA attributes`,
    );
    has(
      new RegExp(`<p id=\\{fieldErrorId\\("${id}"\\)\\}[^>]*>\\s*\\{errors\\.${key}\\}`),
      `${key}'s message has the id ${fieldErrorId(id)}`,
    );
  }
});

// Negative control: drop either focusFirstInvalid call and its path no longer moves focus.
test("a step that fails validation, and a draft with no title, both move focus", () => {
  has(
    /setErrors\(next\);\s*showToast\(Object\.values\(next\)\[0\]\);\s*focusFirstInvalid\(next\);/,
    "validate() moves focus",
  );
  has(
    /setErrors\(draftErrors\);[\s\S]{0,160}focusFirstInvalid\(draftErrors\);/,
    "draft save moves focus",
  );
  has(
    /requestAnimationFrame\(\(\) => document\.getElementById\(id\)\?\.focus\(\)\)/,
    "after the commit",
  );
});
