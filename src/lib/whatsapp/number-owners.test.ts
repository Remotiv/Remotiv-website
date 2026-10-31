/**
 * #64: `isOnePerson` is the one predicate both the WhatsApp webhook and the
 * applicant drawer use to decide that several applications on one phone are
 * the SAME candidate. It requires the same non-empty normalised email on every
 * match, and nothing else: the name is not consulted. Before #64 either an
 * equal email or an equal name sufficed.
 *
 *   node --test src/lib/whatsapp/number-owners.test.ts
 *
 * Each test is named by the rule it pins, and each rule has a reversion in
 * scripts/staging/negative-controls.mjs that must turn its test red. Synthetic
 * rows throughout.
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../test-support/node-resolve.mjs", import.meta.url));

const { isOnePerson, soleOwnerAt } = await import("./number-owners.ts");

const CO = "c0000000-0000-4000-8000-00000000000a";
const row = (id, over = {}) => ({
  id,
  phone: "0300-1234567",
  email: "x@example.test",
  first_name: "Ex",
  last_name: "Candidate",
  company_id_snapshot: CO,
  ...over,
});

test("#64: two matches with different emails are two people", () => {
  assert.equal(
    isOnePerson([
      row("a"),
      row("b", { email: "z@example.test", first_name: "Zed", last_name: "Other" }),
    ]),
    false,
    "different emails, different names",
  );
  assert.equal(
    isOnePerson([row("a"), row("b", { email: "x2@example.test" })]),
    false,
    "different emails, identical names",
  );
});

test("#64: a blank email on any match refuses, even when every name is identical", () => {
  assert.equal(isOnePerson([row("a"), row("b", { email: null })]), false, "null email");
  assert.equal(isOnePerson([row("a"), row("b", { email: "   " })]), false, "whitespace email");
  assert.equal(
    isOnePerson([row("a", { email: "" }), row("b", { email: "" })]),
    false,
    "both blank",
  );
  assert.equal(isOnePerson([]), false, "an empty set is nobody");
});

test("#64: identical emails differing only in case and surrounding whitespace are one person", () => {
  assert.equal(isOnePerson([row("a"), row("b", { email: "  X@Example.TEST " })]), true);
  assert.equal(isOnePerson([row("a")]), true, "a single match with an email");
});

test("#64: the same name with different emails is two people: the name is not evidence", () => {
  // Before #64 this returned true on the name alone. That is the name collision.
  assert.equal(isOnePerson([row("a"), row("b", { email: "other@example.test" })]), false);
});

test("#64: the same email with a different or blank name is one person: the name is not consulted", () => {
  assert.equal(
    isOnePerson([row("a"), row("b", { first_name: "Muhammad Ex" })]),
    true,
    "a re-applicant whose name was typed differently",
  );
  assert.equal(
    isOnePerson([row("a"), row("b", { first_name: null, last_name: null })]),
    true,
    "a re-applicant with no name on one application",
  );
});

test("#64: soleOwnerAt follows the predicate for a re-applying candidate", () => {
  const sameEmail = [row("a"), row("b", { email: "X@example.test", first_name: "Muhammad Ex" })];
  assert.equal(soleOwnerAt(sameEmail, "a", CO), true, "same email, different name, one company");
  assert.equal(
    soleOwnerAt([row("a"), row("b", { email: "other@example.test" })], "a", CO),
    false,
    "same name, different email: refused",
  );
});
