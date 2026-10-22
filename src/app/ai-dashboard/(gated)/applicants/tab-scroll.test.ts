/**
 * The drawer tab strip's scroll target, executed rather than pinned.
 *
 *   node --test "src/app/ai-dashboard/(gated)/applicants/tab-scroll.test.ts"
 *
 * This is the one part of the tab-strip change that is real logic rather than a
 * class string, so it is the one part a test can settle. The companion file
 * drawer-header.test.ts pins the classes; neither file can see a layout, so
 * nothing here claims a tab is visible on a phone. These tests assert only
 * that the arithmetic answers the scrollLeft it was asked for.
 *
 * ── What the numbers below are, and are not ─────────────────────────
 *
 * The strip is modelled at a 360px viewport: 377px of visible width, which is
 * measured, and six tabs laid out with the authored 26px gap. Five of the
 * label widths are measured (Profile 40, Review 45, Interviews 66, Timeline
 * 54, Comments 70); "Comms" at 48 is an ESTIMATE, since the short label did
 * not exist to measure until this change. The content width of 453 is derived
 * from that estimate, so treat it as a plausible layout the arithmetic is
 * exercised against, NOT as a pinned measurement. With the full
 * "Communication" label the same strip measured 508.
 */

// @ts-nocheck — same reason as the other node:test files here: Node's `.ts`
// specifier vs this tsconfig, which does not set allowImportingTsExtensions.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../../../test-support/node-resolve.mjs", import.meta.url));

const { TAB_FADE_PX, tabScrollLeft } = await import("./tab-scroll.ts");

/** The strip at a 360px viewport with the short label: 76px of scroll range. */
const STRIP = { scrollLeft: 0, clientWidth: 377, scrollWidth: 453 } as const;
const MAX = STRIP.scrollWidth - STRIP.clientWidth;

const TABS = [
  { name: "Profile", itemLeft: 0, itemWidth: 40 },
  { name: "Review", itemLeft: 66, itemWidth: 45 },
  { name: "Comms", itemLeft: 137, itemWidth: 48 },
  { name: "Interviews", itemLeft: 211, itemWidth: 66 },
  { name: "Timeline", itemLeft: 303, itemWidth: 54 },
  { name: "Comments", itemLeft: 383, itemWidth: 70 },
] as const;

const at = (name: string) => {
  const tab = TABS.find((t) => t.name === name);
  if (!tab) throw new Error(`no such tab: ${name}`);
  return tab;
};

test("a strip with nothing to scroll never scrolls", () => {
  // The desktop case: 1056px of room, measured, for 508px of full-label tabs.
  // Every tab answers 0, including the last, because there is no scrollable
  // range for it to land in. This is the pin that says the change is inert
  // above the breakpoint.
  const wide = { scrollLeft: 0, clientWidth: 1056, scrollWidth: 1056 };
  for (const tab of TABS) {
    assert.equal(
      tabScrollLeft({ ...wide, ...tab }),
      0,
      `${tab.name}: a strip whose content fits has no scroll position but 0`,
    );
  }
});

test("a tab already clear of both edges is left where it is", () => {
  // Review spans 66-111 with the strip at 40, so it clears the left edge by 26
  // and is nowhere near the right. Centring it would slide the strip for
  // nothing.
  assert.equal(tabScrollLeft({ ...STRIP, scrollLeft: 40, ...at("Review") }), 40);
});

test("a tab under the right-edge fade is brought clear of it", () => {
  // Timeline ends at 357 inside a 377px window, so it is ALREADY fully
  // visible - but its last 24px sit under the fade and read as disabled. It
  // comes forward by 4: 303 + 54 + 24 - 377.
  const tab = at("Timeline");
  const target = tabScrollLeft({ ...STRIP, ...tab });
  assert.equal(target, 4);
  assert.ok(
    tab.itemLeft + tab.itemWidth + TAB_FADE_PX <= target + STRIP.clientWidth,
    "Timeline must end at least a fade's width inside the right edge",
  );
});

test("the last tab lands flush at the end, where there is no fade to clear", () => {
  // Comments wants 100 (453 + 24 - 377) and the range only reaches 76. The
  // clamp is not a compromise here: at scrollLeft 76 the strip is scrolled to
  // its end, so there is nothing further right and the fade is off by
  // construction. Flush against the edge is the correct resting place.
  const target = tabScrollLeft({ ...STRIP, ...at("Comments") });
  assert.equal(target, MAX);
  assert.equal(
    target + STRIP.clientWidth,
    STRIP.scrollWidth,
    "at the end of the range the viewport's right edge IS the content's right edge",
  );
});

test("a tab off the left edge comes back with the same clearance", () => {
  // Scrolled to the end, Profile is 76px off the left. It returns to 0 - 24 =
  // -24, clamped to 0, the only position that shows all of it.
  assert.equal(tabScrollLeft({ ...STRIP, scrollLeft: MAX, ...at("Profile") }), 0);
  // Review from the same place has somewhere real to land: 66 - 24 = 42.
  assert.equal(tabScrollLeft({ ...STRIP, scrollLeft: MAX, ...at("Review") }), 42);
});

test("the answer never leaves the scrollable range", () => {
  for (const tab of TABS) {
    for (const scrollLeft of [0, 4, 40, MAX]) {
      const target = tabScrollLeft({ ...STRIP, scrollLeft, ...tab });
      assert.ok(
        target >= 0 && target <= MAX,
        `${tab.name} from ${scrollLeft}: ${target} is outside 0..${MAX}`,
      );
    }
  }
});

test("a tab wider than the strip aligns left, not right", () => {
  // A label longer than the window. Right-aligning it would show its END,
  // which is the half a reader cannot identify it from.
  const narrow = { scrollLeft: 0, clientWidth: 100, scrollWidth: 600 };
  assert.equal(tabScrollLeft({ ...narrow, itemLeft: 200, itemWidth: 300 }), 176);
});

test("the fade clearance is what makes the right-edge answer differ", () => {
  // The discriminating pair, and the reason TAB_FADE_PX is not decorative:
  // Timeline needs NO scroll to be fully visible (357 <= 377), so a zeroed
  // clearance would answer 0 and leave it under the fade. The clearance is
  // the entire difference between 0 and 4.
  const tab = at("Timeline");
  assert.ok(
    tab.itemLeft + tab.itemWidth <= STRIP.clientWidth,
    "Timeline is fully visible without any clearance - that is the premise",
  );
  assert.ok(TAB_FADE_PX > 0, "a zero fade would make the clearance a no-op");
  assert.equal(tabScrollLeft({ ...STRIP, ...tab }), 4);
});
