/**
 * #36: the Messages page's times render the same on the server and in the
 * browser, so hydration never fails on them.
 *
 *   node --test "src/app/ai-dashboard/(gated)/messages/message-time.test.ts"
 *
 * Reproduced on staging before the fix: with the browser in another zone than
 * the server (production: Vercel runs in UTC), every load threw "Hydration
 * failed because the server rendered text didn't match the client", on the
 * When column's stamp ("9 Jan, 17:59" from the server, "9 Jan, 12:59" in the
 * browser). Until hydration both renders now read the server's render time in
 * UTC; after it, the live clock in the reader's zone. This runs the real
 * helpers under several process zones (TZ) to prove the pre-hydration text
 * does not depend on where it is computed. Synthetic data.
 */
// @ts-nocheck - same reason as the other node:test files: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const { exact, relative, whenOf } = await import("./message-time.ts");

const SENT = "2026-01-09T12:59:00.000Z";
const RENDERED = Date.parse("2026-01-09T13:04:30.000Z");
const ZONES = ["UTC", "Asia/Karachi", "America/Los_Angeles", "Pacific/Kiritimati"];
const inZone = (tz, fn) => {
  const saved = process.env.TZ;
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  }
};
const row = (over = {}) => ({
  kind: "automatic",
  sentAt: SENT,
  scheduledFor: null,
  createdAt: SENT,
  ...over,
});

test("T1. before hydration the When text is the same in every zone, from the server's render time", () => {
  const server = { now: RENDERED, local: false };
  const seen = ZONES.map((tz) => inZone(tz, () => whenOf(row(), server)));
  for (const w of seen) assert.deepEqual(w, { rel: "6m ago", exact: "Today 12:59" });
});

test("T2. before hydration the live clock is never read: the same input gives the same text later", () => {
  const server = { now: RENDERED, local: false };
  const first = whenOf(row(), server);
  const realNow = Date.now;
  Date.now = () => RENDERED + 10 * 60_000;
  try {
    assert.deepEqual(whenOf(row(), server), first);
  } finally {
    Date.now = realNow;
  }
});

test("T3. after hydration: the reader's own zone and the clock it is given", () => {
  const live = { now: RENDERED, local: true };
  assert.equal(
    inZone("Asia/Karachi", () => exact(SENT, live)),
    "Today 17:59",
  );
  assert.equal(
    inZone("America/Los_Angeles", () => exact(SENT, live)),
    "Today 04:59",
  );
  assert.equal(
    inZone("Pacific/Kiritimati", () => exact(SENT, live)),
    "Today 02:59",
    "already 10 Jan there, and so is the clock",
  );
  assert.equal(relative(SENT, { now: RENDERED + 3 * 3600_000, local: true }), "3h ago");
});

test("T4. 'Today' is decided in the same zone the time is shown in", () => {
  // 23:30 UTC on 9 Jan is already 10 Jan in Karachi.
  const late = "2026-01-09T23:30:00.000Z";
  const now = Date.parse("2026-01-09T23:45:00.000Z");
  assert.equal(
    inZone("Asia/Karachi", () => exact(late, { now, local: false })),
    "Today 23:30",
  );
  assert.equal(
    inZone("Asia/Karachi", () => exact(late, { now, local: true })),
    "Today 04:30",
  );
  assert.equal(
    inZone("Asia/Karachi", () =>
      exact(late, { now: Date.parse("2026-01-09T18:00:00Z"), local: true }),
    ),
    "10 Jan, 04:30",
  );
});

test("T5. the page passes its render time, and the client renders from the clock", () => {
  const page = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
  assert.match(page, /renderedAt=\{Date\.now\(\)\}/);
  const client = readFileSync(new URL("./_messages-client.tsx", import.meta.url), "utf8");
  assert.match(
    client,
    /const clock = useMemo<PageClock>\(\s*\(\) => \(\{ now: hydrated \? Date\.now\(\) : renderedAt, local: hydrated \}\),\s*\[hydrated, renderedAt\],\s*\);/,
  );
  assert.match(
    client,
    /function useIsHydrated\(\): boolean \{\s*return useSyncExternalStore\(\s*NEVER_CHANGES,\s*\(\) => true,\s*\(\) => false,\s*\);/,
  );
  assert.equal((client.match(/whenOf\(row, clock\)/g) ?? []).length, 2, "the list and the viewer");
  assert.doesNotMatch(client, /whenOf\(row\)/);
  // The helpers read no clock and no zone of their own.
  const helpers = readFileSync(new URL("./message-time.ts", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(helpers, /Date\.now\(\)|new Date\(\)/);
});
