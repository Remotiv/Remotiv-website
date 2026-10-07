/**
 * The privacy policy's Google user data section, pinned word for word where
 * Google requires it and checked against the calendar code everywhere else.
 *
 *   node --test src/lib/privacy-google-data.test.ts
 *
 * Google's OAuth verification reads this section. Each claim it makes is tied
 * to the code that makes it true, so the test fails if either side drifts: a
 * new scope, an event read, a disconnect that keeps the row, or calendar data
 * reaching an AI provider.
 */
// @ts-nocheck — same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const PAGE = read("src/app/privacy/page.tsx");
const GOOGLE = read("src/lib/calendar/google.ts");
const CONNECTIONS = read("src/lib/calendar/connections.ts");

/** The section's source, from its heading to the next one. */
const SECTION = (() => {
  const start = PAGE.indexOf("<H2>13. Google user data</H2>");
  const end = PAGE.indexOf("<H2>14. Contact</H2>");
  assert.ok(start > 0 && end > start, "section 13 must sit between its heading and Contact");
  return PAGE.slice(start, end);
})();

/** What a reader sees: tags dropped, entities decoded, whitespace collapsed. */
const visible = (jsx) =>
  jsx
    .replace(/\{" "\}/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&apos;/g, "'")
    .replace(/\s+/g, " ")
    .replace(/ ([,.;:])/g, "$1")
    .trim();
const TEXT = visible(SECTION);

const LIMITED_USE =
  "Remotiv's use and transfer of information received from Google APIs will adhere to the Google API Services User Data Policy, including the Limited Use requirements.";

/* ── the sentences Google requires ──────────────────────────────── */

test("the Limited Use sentence appears word for word, linked to Google's policy", () => {
  assert.ok(TEXT.includes(LIMITED_USE), "the exact sentence must be on the page");
  assert.match(
    SECTION,
    /<a\s+href="https:\/\/developers\.google\.com\/terms\/api-services-user-data-policy"[^>]*>\s*Google API Services User Data Policy\s*<\/a>/,
  );
});

test("it says what the data is for, and that it is not sold, used for ads, or used to train AI", () => {
  assert.match(TEXT, /We use Google data for one purpose: scheduling candidate interviews\./);
  assert.match(
    TEXT,
    /We do not sell Google data, we do not use it for advertising, and we do not use it to train AI models, ours or anyone else's\./,
  );
  assert.match(TEXT, /None of it is sent to our AI providers\./);
  assert.match(TEXT, /Only as needed to schedule the interview:/);
  assert.match(TEXT, /We disclose it to anyone else only if the law requires us to\./);
});

/* ── every claim, against the code ──────────────────────────────── */

test("the scopes named are exactly the scopes requested, plus the openid Google adds", () => {
  const requested = [
    ...code(GOOGLE).matchAll(/"https:\/\/www\.googleapis\.com\/auth\/([a-z.]+)"/g),
  ].map((m) => m[1]);
  assert.deepEqual(requested.sort(), ["calendar.events", "calendar.readonly", "userinfo.email"]);
  const named = [
    ...new Set(TEXT.match(/\b(?:calendar|userinfo|drive|gmail|meetings)\.[a-z.]*[a-z]/g)),
  ];
  assert.deepEqual(named.sort(), requested.sort(), "every requested scope named, and no other");
  assert.match(TEXT, /basic openid sign-in identifier/);
});

test("'we do not list or read your events' holds: the only Calendar calls are these", () => {
  const calls = [...code(GOOGLE).matchAll(/\$\{CALENDAR_API\}(\/[^`?]*)/g)].map((m) =>
    m[1].replace(/\$\{[^}]+\}/g, ":id"),
  );
  assert.deepEqual([...new Set(calls)].sort(), [
    "/calendars/:id/events",
    "/calendars/:id/events/:id",
    "/calendars/primary",
    "/freeBusy",
  ]);
  // The event paths are only ever created, moved and deleted, never fetched.
  const eventMethods = [...code(GOOGLE).matchAll(/\/events[^`]*`,\s*\{\s*method: "([A-Z]+)"/g)].map(
    (m) => m[1],
  );
  assert.deepEqual(eventMethods.sort(), ["DELETE", "PATCH", "POST"]);
  assert.doesNotMatch(code(GOOGLE), /singleEvents|timeMin=|\/events\?(?!\$\{params\})/);
  assert.match(TEXT, /We do not list or read your events\./);
});

test("disconnect revokes at Google, then deletes the row whether or not Google confirmed", () => {
  const body = code(CONNECTIONS).slice(
    code(CONNECTIONS).indexOf("export async function disconnect("),
  );
  const revoke = body.indexOf("await impl.revoke(token)");
  const del = body.indexOf('.from("calendar_connections")\n    .delete()');
  assert.ok(revoke > 0 && del > revoke, "revoke first, then delete");
  // The delete is not inside the revocation branch.
  assert.doesNotMatch(body.slice(revoke, del), /return \{ deleted: false/);
  assert.match(TEXT, /We delete it even if Google does not confirm the revocation/);
  // The page promises Settings says so; it does.
  assert.match(
    read("src/app/ai-dashboard/(gated)/settings/_calendar-card.tsx"),
    /Remove Remotiv from your Google account permissions/,
  );
});

test("free/busy is never stored, and no AI module touches calendar data", () => {
  const src = join(ROOT, "src");
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = join(dir, e.name);
      if (e.isDirectory()) return walk(p);
      return /\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
    });
  const files = walk(src).map((p) => ({
    rel: relative(ROOT, p),
    text: code(readFileSync(p, "utf8")),
  }));
  for (const f of files.filter((x) => /\.freeBusy\(/.test(x.text))) {
    assert.doesNotMatch(
      f.text,
      /\.(insert|upsert)\(/,
      `${f.rel} reads free/busy and must not write`,
    );
  }
  for (const f of files.filter((x) => x.rel.startsWith("src/lib/ai/"))) {
    assert.doesNotMatch(
      f.text,
      /calendar_connections|interview_bookings|freeBusy|lib\/calendar/,
      f.rel,
    );
  }
  assert.match(
    TEXT,
    /Free\/busy information is used at the moment it is read and is never stored\./,
  );
});

/* ── house rules ────────────────────────────────────────────────── */

test("the section is numbered, cross-referenced, dated, and uses hyphens only", () => {
  assert.match(
    PAGE,
    /The permissions we request, and exactly what we do with\s+them, are set out in section 13\./,
  );
  assert.doesNotMatch(PAGE, /The permission we request covers calendar events/);
  assert.doesNotMatch(SECTION, /—/);
  assert.match(PAGE, /Google user data \(section 13\)\s+read from src\/lib\/calendar\//);
  assert.doesNotMatch(PAGE, /const LAST_UPDATED = "30 September 2026";/);
});
