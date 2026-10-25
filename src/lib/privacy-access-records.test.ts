/**
 * The privacy page's access-record promise (migration 047): kept for 24
 * months, then deleted, said in section 2 and section 3, in hyphens only, and
 * backed by a job that is actually scheduled.
 *
 *   node --test src/lib/privacy-access-records.test.ts
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const page = readFileSync(new URL("../app/privacy/page.tsx", import.meta.url), "utf8");
const queue = readFileSync(new URL("./jobs-queue.ts", import.meta.url), "utf8");
const version = readFileSync(new URL("./privacy-version.ts", import.meta.url), "utf8");
/** The page's rendered prose with JSX line breaks collapsed. */
const prose = page.replace(/\s+/g, " ");

const SECTION2 =
  "When a company or Remotiv staff open a CV or a recording, we record who opened which document, and when. These access records are kept for 24 months, then deleted. Opening your own CV from your own profile is not logged.";
const SECTION3_TITLE = "Records of who opened a CV or a recording: 24 months";
const SECTION3_TEXT =
  "We record each time a company or Remotiv staff open a CV or a recording: who opened it and when. These access records are kept for 24 months, then deleted.";

test("section 2 says what is recorded and for how long, with no dash", () => {
  assert.ok(prose.includes(SECTION2), "the sentence as approved");
  assert.ok(!prose.includes("we record that access —"), "the em dash sentence is gone");
});

test("section 3 counts four expiries, and the fourth is the access records", () => {
  assert.ok(
    prose.includes(
      "Four things here expire on their own. Nothing else does. The four that do are enforced",
    ),
  );
  assert.ok(!/Three things here expire on their own/.test(prose));
  assert.ok(prose.includes(`<H3>${SECTION3_TITLE}</H3>`));
  assert.ok(prose.includes(SECTION3_TEXT));
  // In section 3, before the no-expiry callout.
  const s3 = prose.indexOf("3. How long we keep it");
  const s4 = prose.indexOf("4. Why we are allowed to process it");
  const at = prose.indexOf(SECTION3_TITLE);
  assert.ok(s3 < at && at < s4 && at < prose.indexOf("no expiry date</H3>"));
});

test("the new copy uses plain hyphens only", () => {
  for (const text of [SECTION2, SECTION3_TITLE, SECTION3_TEXT])
    assert.doesNotMatch(text, /[–—]/, text);
});

test("the promise is backed: the purge is scheduled daily, and the notice version moved with it", () => {
  assert.match(queue, /\{ type: JOB_TYPES\.ACCESS_LOG_PURGE, intervalMs: PURGE_INTERVAL_MS \}/);
  assert.match(page, /const LAST_UPDATED = "25 October 2026";/);
  assert.match(version, /export const PRIVACY_NOTICE_VERSION = "2026-10-25";/);
});
