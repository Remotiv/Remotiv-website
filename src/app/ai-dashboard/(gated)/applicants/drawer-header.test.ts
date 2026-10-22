/**
 * Class pins for the applicant drawer's header: the identity row, the tab
 * strip, and the header box itself.
 *
 *   node --test "src/app/ai-dashboard/(gated)/applicants/drawer-header.test.ts"
 *
 * **These are source-text pins, not renders, and they make no layout claim.**
 * The header is inline JSX inside a 6,500-line client module that pulls in
 * server actions, so rendering it would mean stubbing most of the app — the
 * same reason stage-tabs.test.ts and chip-strips.test.ts pin their sites from
 * source. There is no DOM or layout engine in this suite, so nothing here
 * asserts a width, a height or a pixel. What a browser settled, and only a
 * browser can: that the name is visible, that nothing overlaps the ring, and
 * that the underline is not clipped. What these tests settle: that the classes
 * those outcomes depend on are still in the file.
 *
 * ── The pins are IDENTIFIED, not positional ─────────────────────────
 *
 * This is the one thing done differently from chip-strips.test.ts, whose
 * docblock records the weakness: that file takes the FIRST element carrying a
 * class pair and cannot tell the chip strip from any other element sharing it.
 * Every pin here anchors on something that is unique in the file and would be
 * absurd to duplicate — `<header`, `{PANEL_TABS.map(`, `<DrawerMiniRing`, the
 * `truncate` h2 — and each anchor is asserted to match exactly once, so a
 * second copy appearing fails loudly rather than pinning the wrong box.
 *
 * ── Why this file exists ────────────────────────────────────────────
 *
 * At a 360px viewport the header demanded 530px of a 421px drawer. The visible
 * symptom was NOT the one reported: the h2 and the email both carry `truncate`
 * inside a `min-w-0` flex item, so they clipped to zero width and were absent
 * rather than overlapping, and the only thing left painting across the score
 * ring was the whitespace-nowrap applied date. Four classes now carry that
 * fix, and two of them (`pb-px`, `-mb-px`) exist solely to keep a 1px
 * underline out of a scroll container's clip. None of the four is self-
 * evidently load-bearing from reading the markup, which is what makes them
 * worth pinning.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

const SRC = readFileSync(new URL("./_applicants-client.tsx", import.meta.url), "utf8");

/** The breakpoint both edits share: the segment's `sm`, scaled by 0.82. */
const BP = "min-\\[525px\\]";

/**
 * The one match for `pattern`, with the class string in group 1.
 *
 * Asserting the count is what makes these pins identified rather than
 * positional: a second `{PANEL_TABS.map(` or a second `<header` means the
 * anchor no longer names one box, and that fails here instead of silently
 * pinning whichever came first.
 */
function one(pattern: RegExp, what: string): string {
  const all = [...SRC.matchAll(new RegExp(pattern.source, `${pattern.flags}g`))];
  assert.equal(
    all.length,
    1,
    `${what}: expected exactly one match for ${pattern}, found ${all.length} — ` +
      "these pins are anchored on unique landmarks, so a second match means the " +
      "anchor stopped identifying one element",
  );
  return all[0][1];
}

/** The <header> box. */
const header = () => one(/<header className="([^"]*)"/, "drawer header");

/** The tab strip: the element whose children are the PANEL_TABS buttons. */
const tabStrip = () =>
  one(/className="([^"]*)"[^>]*>\s*\{PANEL_TABS\.map\(/, "tab strip container");

/** The score-ring block, anchored on the ring it contains. */
const ringBlock = () => one(/<div className="([^"]*)">\s*<DrawerMiniRing/, "score ring block");

/** The divider beside the ring. */
const divider = () => one(/className="([^"]*h-9 w-px[^"]*)"/, "ring divider");

/** The identity text block: the min-w-0 item holding the name and email. */
const textBlock = () =>
  one(/<div className="([^"]*)">\s*<h2 className="[^"]*truncate/, "identity text block");

/** The name itself. */
const nameHeading = () => one(/<h2 className="([^"]*truncate[^"]*)"/, "applicant name h2");

const tabBase = () => one(/const PANEL_TAB_BASE =\s*"([^"]*)";/, "PANEL_TAB_BASE");

describe("identity row", () => {
  test("the score ring is hidden below the breakpoint", () => {
    const cls = ringBlock();
    assert.match(cls, /\bhidden\b/, "the ring block must start hidden on a phone");
    assert.match(
      cls,
      new RegExp(`${BP}:flex`),
      "the ring block must come back as a flex row above the breakpoint, not as a block",
    );
    // A BARE `flex` alongside the `hidden` would be a coin toss: both emit
    // `display`, and which wins is the order Tailwind writes them to the
    // sheet, not the order they appear here. So the only `flex` allowed on
    // this element is the prefixed one.
    assert.doesNotMatch(
      cls,
      /(?:^|\s)flex(?:\s|$)/,
      `an unprefixed flex would fight the hidden rather than defer to it: "${cls}"`,
    );
  });

  test("the divider follows the ring it separates", () => {
    const cls = divider();
    assert.match(cls, /\bhidden\b/, "a divider with nothing beside it is a stray line");
    assert.match(
      cls,
      new RegExp(`${BP}:block`),
      "the divider must return at the SAME breakpoint as the ring",
    );
  });

  test("the name block stays shrinkable", () => {
    assert.match(
      textBlock(),
      /\bmin-w-0\b/,
      "without min-w-0 the text block cannot shrink and the row overflows again — " +
        "hiding the ring buys the width, min-w-0 is what lets the name use it",
    );
  });

  test("the name still truncates rather than wrapping", () => {
    assert.match(
      nameHeading(),
      /\btruncate\b/,
      "truncate is deliberate: a long name shortens to one line instead of " +
        "wrapping and pushing the tab strip down. It was never the bug — the bug " +
        "was truncating inside a zero-width box, which is what the ring was doing",
    );
  });
});

describe("tab strip", () => {
  test("it scrolls sideways", () => {
    assert.match(
      tabStrip(),
      /\boverflow-x-auto\b/,
      "six tabs need 453px of a 377px strip at 360px; without a scroller the " +
        "last two are unreachable, which is how Screening stayed hidden",
    );
  });

  test("it does not wrap", () => {
    const cls = tabStrip();
    assert.doesNotMatch(
      cls,
      /\bflex-wrap\b/,
      "wrapping splits the 2px underline across two baselines and costs 57px of " +
        "header height — measured, and rejected in favour of the scroller",
    );
    assert.match(cls, /\bflex\b/, "the strip is still a flex row");
  });

  test("the underline's 1px of clearance is intact", () => {
    // The pair that keeps `after:-bottom-px` out of the scroll container's
    // clip. `overflow-x: auto` forces computed overflow-y from visible to
    // auto, so the 1px of underline below each button became scrollable
    // overflow and was clipped. These two classes are why it is not. Dropping
    // EITHER reintroduces it, so both are asserted separately with their own
    // message rather than as one regex.
    const cls = tabStrip();
    assert.match(
      cls,
      /\bpb-px\b/,
      "without pb-px the active tab's underline is clipped to 1px of its 2px, " +
        "because overflow-x:auto makes this box clip vertically too",
    );
    assert.match(
      cls,
      /-mb-px\b/,
      "without -mb-px the pb-px above adds 1px to the header and lifts the " +
        "underline off the header's own border, which is the whole point of it",
    );
  });

  test("the strip is the tabs' offsetParent", () => {
    assert.match(
      tabStrip(),
      /\brelative\b/,
      "relative is load-bearing for the scroll-into-view, not decoration: it " +
        "makes each tab's offsetLeft content-relative. Rects are unusable here " +
        "because the shell's zoom:0.82 returns them in visual px while " +
        "scrollLeft is layout px",
    );
  });

  test("the reveal still has a tab to find", () => {
    // `data-tab` is how the scroll effect locates the current tab, and losing
    // it fails SILENTLY: querySelector answers null, the effect returns, and
    // the strip simply never scrolls. Nothing else in the file would notice.
    assert.match(SRC, /data-tab=\{t\.key\}/, "every tab must carry the handle");
    assert.match(
      SRC,
      /querySelector<HTMLElement>\(`\[data-tab="\$\{tab\}"\]`\)/,
      "the effect must look the tab up by the same handle",
    );
  });

  test("the underline is still outside each button's box", () => {
    assert.match(
      tabBase(),
      /after:-bottom-px/,
      "this is the class the pb-px/-mb-px pair exists to protect; if the " +
        "underline ever moves inside the button box, that pair is what should " +
        "be reconsidered, not quietly kept",
    );
  });

  test("Communication shortens below the breakpoint but keeps its URL key", () => {
    const entry = one(
      /\{ key: "comm", label: "([^"]*)", short: "([^"]*)" \},/,
      "the Communication tab entry",
    );
    assert.equal(entry, "Communication", "the full label is what desktop still shows");
    assert.match(SRC, /short: "Comms"/, "Comms is the phone label");
    assert.match(
      SRC,
      new RegExp(`className="${BP}:hidden">\\{t\\.short\\}`),
      "the short label must be the one that hides above the breakpoint",
    );
    assert.match(
      SRC,
      new RegExp(`className="hidden ${BP}:inline">\\{t\\.label\\}`),
      "the full label must be the one that appears above the breakpoint",
    );
    assert.match(
      SRC,
      /\{ key: "comm"/,
      "the key is in the URL — every link anyone has sent resolves through it",
    );
  });

  test("Comments keeps its full label at every width", () => {
    assert.match(
      SRC,
      /\{ key: "comments", label: "Comments" \},/,
      'these are the team\'s comments on a candidate; "Notes" means something ' +
        "else in this product, so this label was deliberately left alone",
    );
  });
});

describe("the header box", () => {
  test("it gained no overflow class of its own", () => {
    // The header is where the overflow was MEASURED, not where it is fixed.
    // overflow-hidden here would clip the back arrow and the close button;
    // overflow-x-auto would make the whole header scroll sideways, including
    // the row holding those controls. The overflow goes to zero because the
    // two rows inside stopped demanding more than the drawer has.
    const cls = header();
    assert.doesNotMatch(cls, /\boverflow-/, `the header must not clip or scroll: "${cls}"`);
  });

  test("it is still the drawer's fixed, non-shrinking top", () => {
    assert.match(
      header(),
      /\bshrink-0\b/,
      "the header does not shrink; the body below it is what scrolls",
    );
  });
});
