import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

/**
 * Class pins for the applicants toolbar search box.
 *
 * **Source-text pins, not renders, and they make no layout claim.** The box is
 * inline JSX inside a 6,500-line client module that pulls in server actions, so
 * rendering it would mean stubbing most of the app — the same reason
 * chip-strips.test.ts and stage-tabs.test.ts pin their sites from source. There
 * is no DOM and no layout engine in this suite, so nothing here asserts a
 * width, a row count or a pixel.
 *
 * The behaviour behind the pins was measured in a browser at a 360px viewport,
 * in design px inside .ai-shell's 0.82 zoom: with `min-w-0` the box collapsed
 * to 68px between the two selects while Add candidate sat orphaned on a row of
 * its own. The 160px floor is what moves both onto that row together, where the
 * box resolves to 219px of the 370px available.
 *
 * **The pin is POSITIONAL, not identified.** `CONTAINER` takes the first
 * element carrying both `focus-within:border-remotiv-purple` and
 * `min-[630px]:w-[210px]`, and nothing here asserts that match is the search
 * box rather than some other element sharing the pair. Today there is exactly
 * one match; if another element ever claimed both, these tests would pin the
 * wrong box. They would go RED rather than silently green — the wrong box will
 * not carry the floor — but the failure message would name the wrong cause.
 *
 *   node --test "src/app/ai-dashboard/(gated)/applicants/search-floor.test.ts"
 */

const SRC = new URL("./_applicants-client.tsx", import.meta.url);

/** The search box, found by the signature only it carries. */
const CONTAINER =
  /className="([^"]*focus-within:border-remotiv-purple[^"]*min-\[630px\]:w-\[210px\][^"]*)"/;

function searchContainer() {
  const src = readFileSync(SRC, "utf8");
  const match = CONTAINER.exec(src);
  assert.ok(
    match,
    "no search-box container found in _applicants-client.tsx — the " +
      "focus-within:border-remotiv-purple + min-[630px]:w-[210px] signature is how " +
      "these pins locate it",
  );
  return match[1];
}

describe("applicants toolbar search box", () => {
  test("carries a width floor", () => {
    assert.match(
      searchContainer(),
      /min-w-\[160px\]/,
      "without the floor the box is flex-1 against a zero minimum, so it collapses to " +
        "68px at 360px and leaves Add candidate orphaned on its own row",
    );
  });

  test("the floor is not cancelled by a second min-width", () => {
    assert.doesNotMatch(
      searchContainer(),
      /min-w-0/,
      "two min-width utilities on one element are two rules of equal specificity, so " +
        "which one wins depends on stylesheet order rather than this class list — the " +
        "floor would be silently dead",
    );
  });
});
