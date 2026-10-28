/**
 * Negative controls for every measurement assertion.
 *
 *   node --test "scripts/staging/*.test.mjs"
 *
 * Each test below feeds an assertion the exact input it exists to reject and
 * requires it to THROW. A green run here means the instrument discriminates;
 * it says nothing about the dashboard. That separation is the point — the
 * previous harness could have reported success while measuring nothing, and no
 * test in the project would have noticed.
 *
 * The positive cases are here too, and they are the weaker half: an assertion
 * that only ever passes is indistinguishable from one that cannot fail.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertCount,
  assertPartsSumToWhole,
  assertSameIdSet,
  assertTotalOrder,
  classifyLoginRefusal,
  establishedBy,
  requireAttribute,
  requireFilled,
  requireFound,
  stillAtRisk,
  tail,
} from "./assertions.mjs";

/** Requires fn to throw, and the message to name the reason rather than any reason. */
function throwsWith(fn, needle, why) {
  let caught;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  assert.ok(caught, `DID NOT THROW: ${why}`);
  assert.match(
    caught.message,
    needle,
    `threw, but not for the stated reason (${why}): ${caught.message}`,
  );
}

const ids = (n, prefix = "id") => Array.from({ length: n }, (_, i) => `${prefix}-${i}`);

/* ───────────────────────── requireFound ───────────────────────── */

test("requireFound rejects a locator that matched nothing", () => {
  throwsWith(
    () => requireFound(0, "applicant rows"),
    /matched ZERO elements/,
    "zero is the census guard",
  );
});

test("requireFound rejects a non-integer count", () => {
  throwsWith(
    () => requireFound(undefined, "rows"),
    /not an integer/,
    "undefined must not read as zero",
  );
  throwsWith(() => requireFound(Number.NaN, "rows"), /not an integer/, "NaN must not pass");
});

test("requireFound accepts a real count", () => {
  assert.doesNotThrow(() => requireFound(20, "rows"));
});

/* ──────────────────────── classifyLoginRefusal ─────────────────── */

test("classifyLoginRefusal refuses an empty or whitespace-only read", () => {
  for (const read of ["", "   ", "\n\t"]) {
    throwsWith(
      () => classifyLoginRefusal(read),
      /carried NO text/,
      "an empty read must be refused, never classified",
    );
  }
  throwsWith(() => classifyLoginRefusal(null), /not a string/, "a null read is not text");
  throwsWith(
    () => classifyLoginRefusal(undefined),
    /not a string/,
    "an undefined read is not text",
  );
});

test("classifyLoginRefusal maps each fixed refusal to its key and returns no text", () => {
  const cases = [
    ["Invalid email or password.", "credentials"],
    ["Too many attempts. Please try again in a minute.", "rate_limited"],
    [
      "This login is for company accounts only. Please use the portal you were given access to.",
      "not_company",
    ],
    ["We couldn't verify your account just now. Try again in a moment.", "unavailable"],
    ["We couldn't load your workspace just now. Please sign in again in a moment.", "unavailable"],
    ["Something went wrong signing you in. This isn't your password", "error"],
    ["Your company account has been paused. Contact your account manager.", "inactive"],
    ["Your company account isn't active. Contact your account manager.", "inactive"],
  ];
  for (const [text, key] of cases) assert.equal(classifyLoginRefusal(text), key);
});

test("classifyLoginRefusal refuses text that is none of the fixed refusals, by length only", () => {
  throwsWith(
    () => classifyLoginRefusal("*"),
    /1 characters matching none of the fixed refusals/,
    "a required-field marker is not a refusal",
  );
  let caught;
  try {
    classifyLoginRefusal("some candidate's name here");
  } catch (e) {
    caught = e;
  }
  assert.ok(caught);
  assert.doesNotMatch(caught.message, /candidate/, "the message must not carry the text");
});

/* ──────────────────────── requireFilled ─────────────────────────── */

test("requireFilled passes when the field reads back exactly what was set", () => {
  requireFilled("#co-email", "someone@example.invalid", "someone@example.invalid");
});

test("requireFilled REFUSES a fill that did not land, naming the field and lengths only", () => {
  let caught;
  try {
    requireFilled("#co-password", "", "hunter2hunter2!!");
  } catch (e) {
    caught = e;
  }
  assert.ok(caught, "DID NOT THROW: an empty readback must be refused");
  assert.match(caught.message, /#co-password/);
  assert.match(caught.message, /0 character\(s\) against 16 set/);
  assert.doesNotMatch(caught.message, /hunter2/, "the message must never carry the value");
  throwsWith(
    () => requireFilled("#co-email", "a@b.c", "a@b.cd"),
    /did not land/,
    "a partial fill is a fill that did not land",
  );
});

test("requireFilled refuses an empty expectation: nothing to fill is not a pass", () => {
  throwsWith(() => requireFilled("#co-email", "", ""), /nothing to fill/, "unset variable");
  throwsWith(() => requireFilled("#co-email", "", undefined), /nothing to fill/, "unset variable");
});

/* ──────────────────────── assertTotalOrder ─────────────────────── */

const ORDERED = `
  const { data } = await service
    .from("job_applications")
    .select("id")
    .in("job_id", chunk)
    .order("created_at", { ascending: false })
    .order("id", { ascending: true })
    .range(from, from + PAGE - 1);
`;

test("assertTotalOrder refuses a paged read with no .order() at all", () => {
  const src = ORDERED.replace(/\s+\.order\([^)]*\)/g, "");
  throwsWith(
    () => assertTotalOrder(src, { file: "x.ts", from: '.in("job_id", chunk)' }),
    /NO \.order\(\) at all/,
    "#25's shape: .range() with no ORDER BY",
  );
});

test("assertTotalOrder refuses a final key that is not unique", () => {
  const src = ORDERED.replace(/\s+\.order\("id"[^)]*\)/, "");
  throwsWith(
    () => assertTotalOrder(src, { file: "x.ts", from: '.in("job_id", chunk)' }),
    /final sort key is "created_at", not the unique "id"/,
    "#23's shape: ordered, but ties have no order",
  );
});

test("assertTotalOrder accepts a chain whose LAST key is unique, and reports the keys", () => {
  const r = assertTotalOrder(ORDERED, { file: "x.ts", from: '.in("job_id", chunk)' });
  assert.deepEqual(r.keys, ["created_at", "id"]);
  assert.equal(r.file, "x.ts");
  assert.ok(Number.isInteger(r.line) && r.line > 1);
  // The unique key must be LAST: a unique key followed by a non-unique one is not a total order.
  const swapped = ORDERED.replace(
    '.order("created_at", { ascending: false })\n    .order("id", { ascending: true })',
    '.order("id", { ascending: true })\n    .order("created_at", { ascending: false })',
  );
  throwsWith(
    () => assertTotalOrder(swapped, { file: "x.ts", from: '.in("job_id", chunk)' }),
    /final sort key is "created_at"/,
    "id first and created_at last is not a total order",
  );
});

test("assertTotalOrder refuses a missing anchor, a missing .range(), and an empty read", () => {
  throwsWith(
    () => assertTotalOrder(ORDERED, { file: "x.ts", from: '.from("nope")' }),
    /anchor not found/,
    "moved site",
  );
  throwsWith(
    () =>
      assertTotalOrder(ORDERED.replace(".range(from, from + PAGE - 1)", ".limit(10)"), {
        file: "x.ts",
        from: '.in("job_id", chunk)',
      }),
    /no \.range\( after the anchor/,
    "not paged",
  );
  throwsWith(
    () => assertTotalOrder("", { file: "x.ts", from: "x" }),
    /no source was read/,
    "empty",
  );
});

test("establishedBy needs both halves and names each", () => {
  const order = assertTotalOrder(ORDERED, { file: "x.ts", from: '.in("job_id", chunk)' });
  const v = establishedBy({ finding: "#n", completeness: "10 ids across 1 page", order });
  assert.equal(v.verdict, "ESTABLISHED");
  assert.equal(v.isPass, true);
  assert.match(v.completeness, /^complete set, one run: /);
  assert.match(v.order, /^total order, from the query: x\.ts:\d+ orders by created_at then id/);
  throwsWith(
    () => establishedBy({ finding: "#n", completeness: "x" }),
    /missing either half/,
    "no order",
  );
  throwsWith(
    () => establishedBy({ finding: "#n", order }),
    /missing either half/,
    "no completeness",
  );
});

/* ──────────────────────── requireAttribute ─────────────────────── */

test("requireAttribute rejects rows missing the attribute entirely", () => {
  throwsWith(
    () => requireAttribute([null, null, null], "data-applicant-id", "applicants"),
    /3 of 3 elements carry no `data-applicant-id`/,
    "this is today's state: the attribute does not exist yet",
  );
});

test("requireAttribute rejects a PARTIAL attribute rollout", () => {
  // The dangerous case. Nineteen of twenty rows carry an id, so a naive
  // collect-and-compare would silently measure 19 rows and call it a page.
  throwsWith(
    () => requireAttribute([...ids(19), null], "data-applicant-id", "applicants"),
    /1 of 20 elements carry no/,
    "a partial rollout must not be measured",
  );
});

test("requireAttribute rejects an empty-string attribute", () => {
  throwsWith(
    () => requireAttribute(["a", "", "c"], "data-message-id", "messages"),
    /1 of 3 elements carry no/,
    'an empty attribute is absent, and "" would join into a set as a real member',
  );
});

test("requireAttribute rejects an empty element list before looking at attributes", () => {
  throwsWith(
    () => requireAttribute([], "data-applicant-id", "applicants"),
    /matched ZERO/,
    "census first",
  );
});

test("requireAttribute returns the values when every row carries one", () => {
  assert.deepEqual(requireAttribute(["a", "b"], "data-applicant-id", "x"), ["a", "b"]);
});

/* ───────────────────────── assertSameIdSet ─────────────────────── */

test("assertSameIdSet rejects an empty read", () => {
  throwsWith(
    () => assertSameIdSet([], ids(10), "#25"),
    /the read.*matched ZERO/s,
    "an empty set has no duplicates",
  );
});

test("assertSameIdSet rejects an empty EXPECTED set", () => {
  // The self-reference guard. Comparing a real read against an empty
  // expectation is the shape a missing manifest takes.
  throwsWith(
    () => assertSameIdSet(ids(10), [], "#25"),
    /EXPECTED set is empty/,
    "a missing manifest must not pass",
  );
});

test("assertSameIdSet catches a duplicate the counts would hide", () => {
  // THE CASE THAT MATTERS. 2,500 rows read, 2,500 expected, totals agree
  // exactly — one row is missing and another was returned twice. A count
  // comparison passes this. A set comparison cannot.
  const expected = ids(2500);
  const actual = [...expected.slice(0, 2499), "id-0"];
  assert.equal(actual.length, expected.length, "the premise: the counts match");
  throwsWith(
    () => assertSameIdSet(actual, expected, "#25 scoped allow-list"),
    /MORE THAN ONCE/,
    "a duplicate plus a miss cancel numerically",
  );
});

test("assertSameIdSet reports missing and extra separately", () => {
  const expected = ids(100);
  const actual = [...expected.slice(0, 98), "stray-a", "stray-b"];
  let msg = "";
  try {
    assertSameIdSet(actual, expected, "#25");
  } catch (e) {
    msg = e.message;
  }
  assert.match(msg, /MISSING \(2\)/);
  assert.match(msg, /EXTRA {3}\(2\)/);
  assert.match(msg, /differ by 0/, "the message must say the counts cancelled");
});

test("assertSameIdSet catches a dropped page even when nothing repeats", () => {
  const expected = ids(2500);
  throwsWith(
    () => assertSameIdSet(expected.slice(0, 1500), expected, "#25"),
    /MISSING \(1000\)/,
    "a whole dropped page is the #25 failure",
  );
});

test("assertSameIdSet passes only on an exact set match, order-independent", () => {
  const expected = ids(500);
  assert.doesNotThrow(() => assertSameIdSet([...expected].reverse(), expected, "#25"));
});

/* ────────────────────────── assertCount ────────────────────────── */

test("assertCount refuses to compare an unread badge", () => {
  // Number(null) === 0 and Number("") === 0, so against an expected 0 these
  // would pass. The guard is that they are rejected before any arithmetic.
  for (const raw of [null, undefined, ""]) {
    throwsWith(
      () => assertCount(raw, 0, "All chip"),
      /no count was read/,
      `${JSON.stringify(raw)} must not read as 0`,
    );
  }
});

test("assertCount rejects a non-numeric badge", () => {
  throwsWith(
    () => assertCount("1,024", 1024, "All chip"),
    /is not a number/,
    "a formatted badge is not parsed silently",
  );
});

test("assertCount rejects a mismatch and accepts a match", () => {
  throwsWith(
    () => assertCount("9999", 10_000, "All chip"),
    /badge reads 9999, the seed wrote 10000/,
    "off by one",
  );
  assert.equal(assertCount("10000", 10_000, "All chip"), 10_000);
});

/* ─────────────────────── assertPartsSumToWhole ─────────────────── */

test("assertPartsSumToWhole rejects a strip missing a hidden-at-zero chip", () => {
  // Exactly the Interviews case: cancelled and archived are not rendered at
  // zero, so a sum over the chips that appeared reconciles against an
  // incomplete strip.
  const parts = { submitted: "10", started: "10", invited: "10", expired: "10" };
  throwsWith(
    () =>
      assertPartsSumToWhole(
        parts,
        ["submitted", "started", "invited", "expired", "cancelled"],
        40,
        "chips",
      ),
    /1 required chip\(s\) were not rendered at all: cancelled/,
    "a chip that vanished at zero must not be summed around",
  );
});

test("assertPartsSumToWhole rejects a strip that does not reconcile", () => {
  const parts = { a: "10", b: "10" };
  throwsWith(
    () => assertPartsSumToWhole(parts, ["a", "b"], 25, "chips"),
    /parts sum to 20, the whole reads 25/,
    "five rows are in no tab",
  );
});

test("assertPartsSumToWhole rejects a present-but-unreadable badge", () => {
  throwsWith(
    () => assertPartsSumToWhole({ a: "10", b: null }, ["a", "b"], 10, "chips"),
    /no count was read/,
    "a rendered chip with no badge is not a zero",
  );
});

test("assertPartsSumToWhole passes when every part is present and the sum holds", () => {
  const parts = { submitted: "5", started: "5", invited: "5", expired: "3", cancelled: "2" };
  assert.equal(
    assertPartsSumToWhole(
      parts,
      ["submitted", "started", "invited", "expired", "cancelled"],
      20,
      "chips",
    ),
    20,
  );
});

/* ──────────────────────────── reporting ───────────────────────── */

test("tail exposes six characters and never a whole id", () => {
  assert.equal(tail("3f2a9b71-0000-4000-8000-00000012ab34"), "12ab34");
  assert.equal(tail(null), "null");
});

test("stillAtRisk is never a pass and never closes a finding", () => {
  const r = stillAtRisk({
    finding: "#23",
    site: "messages/actions.ts:561",
    observed: "two reads agreed on 5,000 rows",
    toClose: "a unique final sort key on the query, or a reproduction under contention",
  });
  assert.equal(r.isPass, false);
  assert.equal(r.closesFinding, false);
  assert.match(r.verdict, /STILL AT RISK/);
  assert.doesNotMatch(r.verdict, /pass/i);
});

test("stillAtRisk refuses to exist without the evidence that would close it", () => {
  throwsWith(
    () => stillAtRisk({ finding: "#23", site: "x", observed: "clean" }),
    /not optional/,
    "an unresolved finding with no closing criterion is one everyone forgets",
  );
});
