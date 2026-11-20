import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

/**
 * The Interviews chips must account for every interview `All` counts.
 *
 * **Source-text pins, not renders, and they make no layout claim.** The strip
 * is inline JSX inside a client module that pulls in server actions, so
 * rendering it would mean stubbing most of the app — the same reason
 * chip-strips.test.ts and stage-tabs.test.ts pin their sites from source.
 * There is no DOM and no layout engine here, so nothing below asserts a width,
 * a row count or a pixel. The sixth chip's layout cost was measured in a
 * browser instead: at 360 and 375 design px inside .ai-shell's 0.82 zoom it
 * joins the strip's existing second row, leaving both the row count (2) and the
 * strip height (72.7) unchanged.
 *
 * **What went wrong, and why these pins are shaped the way they are.** `All`
 * read 26 above four chips totalling 25. The missing 1 was a cancelled
 * interview: counted by `All`, deliberately given no chip. Pinning the literal
 * word "cancelled" in five files would close that instance and nothing else, so
 * these tests instead read the `InterviewStatus` union out of its own source and
 * require EVERY member of it to be charted and to have a chip. A sixth status
 * added later goes red here until it does.
 *
 * That is the real invariant: `deriveStatus` is total over `InterviewStatus`, so
 * the per-status buckets sum to `all` as an identity rather than as a property
 * of today's data — but only while every member has a bucket, and only while
 * each bucket filters on its own status. Both halves are pinned below.
 *
 * **The pins are POSITIONAL.** Each block is located by the first match of a
 * declaration-shaped regex, and nothing here asserts the match is the block
 * intended rather than some other one sharing the shape. Today each resolves
 * uniquely. A rename would go RED rather than silently green, because the
 * extraction asserts it found something before testing it.
 *
 *   node --test "src/app/ai-dashboard/(gated)/interviews/counts-reconcile.test.ts"
 */

const CLIENT = readFileSync(new URL("./_interviews-client.tsx", import.meta.url), "utf8");
const TYPES = readFileSync(
  new URL("../../../../lib/interviews/review-types.ts", import.meta.url),
  "utf8",
);
const REVIEW = readFileSync(
  new URL("../../../../lib/interviews/review.ts", import.meta.url),
  "utf8",
);

function block(src: string, re: RegExp, what: string): string {
  const m = re.exec(src);
  assert.ok(m, `could not locate ${what} — these pins read it out of source by shape`);
  return m[1];
}

/** The status vocabulary, read from its own declaration rather than restated. */
const STATUSES = [
  ...block(TYPES, /export type InterviewStatus =([^;]*);/, "the InterviewStatus union").matchAll(
    /"(\w+)"/g,
  ),
].map((m) => m[1]);

/** Keys of the `counts` shape on InterviewListResult. */
const COUNT_KEYS = [
  ...block(TYPES, /counts: \{([\s\S]*?)\n {2}\};/, "the counts type").matchAll(
    /^\s*(\w+): number;/gm,
  ),
].map((m) => m[1]);

/** Keys of the all-zero shape returned for an empty scope. */
const EMPTY_KEYS = [
  ...block(
    REVIEW,
    /const empty: InterviewListResult = \{[\s\S]*?counts: \{([\s\S]*?)\n {4}\},/,
    "the empty counts shape",
  ).matchAll(/(\w+): 0/g),
].map((m) => m[1]);

/**
 * The computation itself. The list counts in SQL, one head count per status
 * through `statusFilter` (#41 part 2), with or without a search (#41
 * follow-up: the search used to count the rows it read, in JavaScript; that
 * path is gone). It must chart every member and define each bucket by its own
 * status.
 */
const COUNT_BLOCKS = [...REVIEW.matchAll(/\n {2}const counts = \{([\s\S]*?)\n {2}\};/g)].map(
  (m) => m[1],
);
const [SQL_COMPUTED] = COUNT_BLOCKS;
const SQL_COMPUTED_KEYS = [...(SQL_COMPUTED ?? "").matchAll(/^\s*(\w+):/gm)].map((m) => m[1]);
/** One `case` of statusFilter, the SQL definition of a bucket. */
const sqlCase = (status: string) =>
  block(
    REVIEW,
    new RegExp(`\\n {4}case "${status}":([\\s\\S]*?);\\n`),
    `statusFilter's ${status} case`,
  );

/** Chip keys, in strip order. */
const TAB_KEYS = [
  ...block(
    CLIENT,
    /const TABS: \{ key: InterviewTab; label: string \}\[\] = \[([\s\S]*?)\n\];/,
    "the TABS list",
  ).matchAll(/key: "(\w+)"/g),
].map((m) => m[1]);

const HIDDEN_AT_ZERO = [
  ...block(
    CLIENT,
    /const HIDDEN_AT_ZERO: readonly InterviewTab\[\] = \[([^\]]*)\]/,
    "the hide-at-zero list",
  ).matchAll(/"(\w+)"/g),
].map((m) => m[1]);

const EMPTY_COPY_KEYS = [
  ...block(
    CLIENT,
    /const EMPTY_COPY: Partial<Record<InterviewTab, EmptyCopy>> = \{([\s\S]*?)\n\};/,
    "the per-tab empty copy",
  ).matchAll(/^ {2}(\w+): \{/gm),
].map((m) => m[1]);

describe("Interviews counts reconcile", () => {
  test("the union was read, not guessed", () => {
    // Guards every test below: an empty extraction would make them all vacuous.
    assert.ok(STATUSES.length >= 5, `expected the InterviewStatus members, got ${STATUSES}`);
    assert.ok(STATUSES.includes("cancelled"), "cancelled is the member this suite exists for");
  });

  for (const status of STATUSES) {
    test(`${status} is charted in counts`, () => {
      assert.ok(
        COUNT_KEYS.includes(status),
        `${status} is an InterviewStatus with no counts field, so 'all' counts rows that no ` +
          "other figure does and the chips total less than the number beside them",
      );
    });

    test(`${status} has a chip`, () => {
      assert.ok(
        TAB_KEYS.includes(status),
        `${status} is counted but has no chip, which is exactly the bug this file pins: 'All' ` +
          "read 26 above chips totalling 25 and nothing on the page accounted for the 1",
      );
    });

    test(`the ${status} bucket filters on ${status}`, () => {
      // The buckets summing to 'all' is an identity only while each one
      // filters on its own member: the key is read through that status's own
      // filter...
      assert.match(SQL_COMPUTED, new RegExp(`\\b${status}: countOf\\("${status}"\\),`));
      // ...and the filter names that status (unknown: everything that is not a stored status).
      const body = sqlCase(status);
      if (status === "unknown") {
        assert.match(body, /status\.is\.null,status\.not\.in\.\$\{STORED_STATUSES\}/);
      } else {
        assert.match(body, new RegExp(`"${status}"|status\\.eq\\.${status}`));
      }
    });
  }

  test("the empty shape charts the same keys as the type", () => {
    assert.deepEqual(
      [...EMPTY_KEYS].sort(),
      [...COUNT_KEYS].sort(),
      "a key missing from the all-zero shape is a TypeScript error today, but a key with a " +
        "stale literal is not — compare the sets rather than trusting the compiler",
    );
  });

  test("the computation charts the same keys as the type", () => {
    assert.equal(COUNT_BLOCKS.length, 1, "one computation, with or without a search");
    assert.deepEqual([...SQL_COMPUTED_KEYS].sort(), [...COUNT_KEYS].sort());
  });

  test("the SQL path's stored statuses are every member but unknown, plus abandoned", () => {
    const stored = block(REVIEW, /const STORED_STATUSES = "\(([^)]*)\)";/, "STORED_STATUSES")
      .split(",")
      .sort();
    assert.deepEqual(stored, [...STATUSES.filter((s) => s !== "unknown"), "abandoned"].sort());
  });

  test("every chip is either a status, or one of the two that are not", () => {
    // `all` is the total and `archived` cuts across statuses; everything else
    // must be a member, or the strip offers a filter the counts cannot fill.
    const extras = TAB_KEYS.filter((k) => !STATUSES.includes(k));
    assert.deepEqual(extras, ["all", "archived"], `unexpected non-status chips: ${extras}`);
  });

  test("cancelled, needs-check and archived hide at zero", () => {
    assert.deepEqual(
      [...HIDDEN_AT_ZERO].sort(),
      ["archived", "cancelled", "unknown"],
      "all three sit off the normal path (unknown, #47, should never happen), and at zero the " +
        "visible chips already total 'All' — a permanently empty chip invites people to look " +
        "for a feature they are not using",
    );
  });

  test("a chip that can be the only one shown has its own empty copy", () => {
    for (const key of HIDDEN_AT_ZERO) {
      assert.ok(
        EMPTY_COPY_KEYS.includes(key),
        `${key} can be selected with nothing in it, so it needs copy of its own rather than ` +
          "the generic 'Nothing matches these filters' fallback",
      );
    }
  });
});
