/**
 * Dashboard times in the viewer's own time zone, zone named (F10 C7,
 * local-time.tsx): the same instant for viewers in Karachi, New York and
 * London, both sides of a daylight saving change, and a server render that
 * carries no time text at all (so nothing in a server zone, nothing in UTC, and
 * nothing for the hydrating render to disagree with).
 *
 *   node --test src/app/ai-dashboard/_components/local-time.test.ts
 *
 * formatLocalTime and LocalTime are the shipped code. Synthetic instants only.
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("../../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../../test-support/tsx-load.mjs", import.meta.url));

const { createElement, Fragment } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { formatLocalTime, LocalTime } = await import("./local-time.tsx");

// One instant, 13:00 UTC, in each season. New York and London change in March
// and October/November; Karachi has no daylight saving.
const SUMMER = "2026-07-15T13:00:00.000Z";
const WINTER = "2026-01-15T13:00:00.000Z";
const SHOWN = "2026-11-04T13:00:00.000Z";

test("the same instant, for viewers in Karachi, New York and London: local time and zone", () => {
  assert.equal(formatLocalTime(SHOWN, "Asia/Karachi"), "4 Nov, 18:00 GMT+5");
  assert.equal(formatLocalTime(SHOWN, "America/New_York"), "4 Nov, 08:00 EST");
  assert.equal(formatLocalTime(SHOWN, "Europe/London"), "4 Nov, 13:00 GMT");
});

test("daylight saving: New York and London, summer time and winter time", () => {
  const cases = [
    [SUMMER, "America/New_York", "15 Jul, 09:00 EDT"],
    [WINTER, "America/New_York", "15 Jan, 08:00 EST"],
    [SUMMER, "Europe/London", "15 Jul, 14:00 BST"],
    [WINTER, "Europe/London", "15 Jan, 13:00 GMT"],
    [SUMMER, "Asia/Karachi", "15 Jul, 18:00 GMT+5"],
    [WINTER, "Asia/Karachi", "15 Jan, 18:00 GMT+5"],
  ];
  for (const [iso, zone, expected] of cases) {
    assert.equal(formatLocalTime(iso, zone), expected, `${zone} ${iso}`);
  }
  // Each side of the change, minutes apart: the hour and the label move together.
  assert.equal(formatLocalTime("2026-03-08T06:59:00.000Z", "America/New_York"), "8 Mar, 01:59 EST");
  assert.equal(formatLocalTime("2026-03-08T07:00:00.000Z", "America/New_York"), "8 Mar, 03:00 EDT");
  assert.equal(formatLocalTime("2026-10-25T00:59:00.000Z", "Europe/London"), "25 Oct, 01:59 BST");
  assert.equal(formatLocalTime("2026-10-25T01:00:00.000Z", "Europe/London"), "25 Oct, 01:00 GMT");
});

test("a date that differs by zone is the viewer's date", () => {
  const lateUtc = "2026-11-06T22:30:00.000Z";
  assert.equal(formatLocalTime(lateUtc, "Asia/Karachi"), "7 Nov, 03:30 GMT+5");
  assert.equal(formatLocalTime(lateUtc, "America/New_York"), "6 Nov, 17:30 EST");
  assert.equal(formatLocalTime("not a date", "Europe/London"), "");
});

test("the server render has the instant, and no time text: no server zone, no UTC, nothing to mismatch", () => {
  const html = renderToStaticMarkup(
    createElement(Fragment, null, "Deadline ", createElement(LocalTime, { iso: SHOWN }), "."),
  );
  assert.equal(html, `Deadline <time dateTime="${SHOWN}" data-local-time="true"></time>.`);
  assert.doesNotMatch(html.replace(/dateTime="[^"]*"/, ""), /UTC|GMT|\d\d:\d\d/);
});
