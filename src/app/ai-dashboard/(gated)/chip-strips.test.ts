import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

/**
 * Class pins for the four badge-segment chip strips outside Applicants:
 * Messages, Interviews, Jobs and Team.
 *
 * **These are source-text pins, not renders, and they make no layout claim.**
 * Each strip is inline JSX inside a 1,400-6,500 line client module that pulls
 * in server actions, so rendering one would mean stubbing most of the app —
 * the same reason stage-tabs.test.ts pins its four pill sites from source.
 * There is no DOM or layout engine in this suite, so nothing here asserts a
 * width, a row count or a pixel: these tests assert only that the classes that
 * make a strip wrap are present and that the classes that make it scroll are
 * absent.
 *
 * All four strips are under test here for the FIRST time. Interviews, Jobs and
 * Team have no test file at all; Messages has four (hydrate-scope, list-scope,
 * aggregates-scope, recipients-scope) and not one of them touches markup.
 *
 * Why pin this at all: Messages had lost `max-w-full` while its three siblings
 * kept it, and nothing in the suite would have caught that happening. The
 * strips are five copies of the same markup with no shared component, so the
 * drift mechanism is still there — these pins are what now notices.
 *
 * **The pin is POSITIONAL, not identified.** `CONTAINER` takes the FIRST
 * element in each file carrying both `bg-[var(--ai-inset)]` and `p-[3px]`, and
 * nothing here asserts that match is the chip strip rather than some other
 * element that happens to share the pair. Today there is exactly one match per
 * file, so it resolves correctly; if a new element above the strip ever claimed
 * both classes, these tests would pin the wrong box. They would go RED rather
 * than silently green — the wrong box will not carry `flex-wrap` — which is the
 * safe direction, but the failure message would name the wrong cause. The
 * durable fix is the shared chip component, not a cleverer regex.
 */

/** The strip container, found by the signature every one of them shares. */
const CONTAINER = /className="([^"]*bg-\[var\(--ai-inset\)\][^"]*p-\[3px\][^"]*)"/;

type Strip = { readonly name: string; readonly file: string };

const STRIPS: ReadonlyArray<Strip> = [
  { name: "Messages", file: "./messages/_messages-client.tsx" },
  { name: "Interviews", file: "./interviews/_interviews-client.tsx" },
  { name: "Jobs", file: "./jobs/_jobs-client.tsx" },
  { name: "Team", file: "./team/_team-client.tsx" },
];

function read(strip: Strip) {
  const src = readFileSync(new URL(strip.file, import.meta.url), "utf8");
  const container = CONTAINER.exec(src);
  assert.ok(
    container,
    `${strip.name}: no chip-strip container found in ${strip.file} — the shared ` +
      "bg-[var(--ai-inset)] + p-[3px] signature is how every pin here locates the strip",
  );
  // The chip is the first template-literal className after the container, which
  // is the <button> the strip maps its tabs onto.
  const after = src.slice(container.index + container[0].length);
  const chip = /className=\{`([^`$]*)/.exec(after);
  assert.ok(chip, `${strip.name}: no chip className found after the strip container`);
  return { container: container[1], chip: chip[1] };
}

for (const strip of STRIPS) {
  describe(`${strip.name} chip strip`, () => {
    test("the container wraps", () => {
      assert.match(
        read(strip).container,
        /flex-wrap/,
        `${strip.name}: the strip must wrap so every chip stays reachable`,
      );
    });

    test("the container never scrolls sideways", () => {
      const { container } = read(strip);
      assert.doesNotMatch(
        container,
        /overflow-x-(?:auto|scroll)/,
        `${strip.name}: sideways scroll hides chips behind a scrollbar phones do not draw`,
      );
      assert.doesNotMatch(
        container,
        /flex-nowrap/,
        `${strip.name}: flex-nowrap would cancel the wrapping`,
      );
    });

    test("the container never widens the page", () => {
      assert.match(
        read(strip).container,
        /max-w-full/,
        `${strip.name}: without max-w-full the strip pushes past its card — this is the ` +
          "exact class Messages had lost while its three siblings kept it",
      );
    });

    test("chips do not compress", () => {
      assert.match(
        read(strip).chip,
        /shrink-0/,
        `${strip.name}: without shrink-0 the chips squeeze rather than moving to the next row`,
      );
    });

    test("padding is the utility, not an alias of it", () => {
      const { chip } = read(strip);
      assert.match(chip, /px-3\.5/, `${strip.name}: chips keep their 14px horizontal padding`);
      assert.doesNotMatch(
        chip,
        /min-\[525px\]:px-\[14px\]/,
        `${strip.name}: px-3.5 already IS 14px, so this breakpoint override never changed ` +
          "anything — dead classes read as intent that is not there",
      );
    });
  });
}
