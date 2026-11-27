/**
 * #20: how many candidates already hold each interview for a job
 * (inviteCountsOf, job-invite-counts.ts), counted per CANDIDATE.
 *
 *   - a re-send (cancelled + invited) and a restart (abandoned + started) are
 *     one person each;
 *   - an invited row past expires_at is expired; a started one past it still
 *     counts;
 *   - cancelled, expired and abandoned count for nothing; a row with no
 *     application id is skipped;
 *   - open wins over completed, so no one is counted twice; kinds are
 *     independent;
 *   - the read limit makes the counts "at least".
 *
 *   node --test src/lib/interviews/job-invite-counts.test.ts
 *
 * Synthetic data.
 */
// @ts-nocheck - same reason as the other node:test files.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../test-support/node-resolve.mjs", import.meta.url));

const { inviteCountsOf, INVITE_COUNT_READ_LIMIT, NO_INVITE_COUNTS } = await import(
  "./job-invite-counts.ts"
);

const NOW = Date.parse("2026-11-27T12:00:00Z");
const FUTURE = "2026-12-02T12:00:00Z";
const PAST = "2026-11-20T12:00:00Z";

const row = (application_id, status, kind = "async", expires_at = FUTURE) => ({
  application_id,
  kind,
  status,
  expires_at,
});

test("a re-send and a restart are one candidate each, never two", () => {
  const c = inviteCountsOf(
    [
      row("app-a", "cancelled"),
      row("app-a", "invited"),
      row("app-b", "abandoned", "live"),
      row("app-b", "started", "live"),
    ],
    NOW,
  );
  assert.deepEqual(c.async, { open: 1, completed: 0 });
  assert.deepEqual(c.live, { open: 1, completed: 0 });
});

test("an invited row past its expiry is expired; a started one past it still counts", () => {
  const c = inviteCountsOf(
    [
      row("app-a", "invited", "async", PAST),
      row("app-b", "started", "async", PAST),
      row("app-c", "started", "live", PAST),
      row("app-d", "invited", "live", PAST),
    ],
    NOW,
  );
  assert.deepEqual(c.async, { open: 1, completed: 0 }, "app-b only");
  assert.deepEqual(c.live, { open: 1, completed: 0 }, "app-c only");
});

test("cancelled, expired and abandoned count for nothing; no application id is skipped", () => {
  const c = inviteCountsOf(
    [
      row("app-a", "cancelled"),
      row("app-b", "expired"),
      row("app-c", "abandoned"),
      row(null, "invited"),
      row(null, "submitted"),
    ],
    NOW,
  );
  assert.deepEqual(c.async, { open: 0, completed: 0 });
});

test("completed is submitted, per candidate; open wins so nobody is counted twice", () => {
  const c = inviteCountsOf(
    [
      row("app-a", "submitted"),
      row("app-a", "submitted"),
      row("app-b", "submitted"),
      // app-c finished once and holds a newer open invitation: counted open only.
      row("app-c", "submitted"),
      row("app-c", "invited"),
      row("app-d", "submitted", "live"),
    ],
    NOW,
  );
  assert.deepEqual(c.async, { open: 1, completed: 2 });
  assert.deepEqual(c.live, { open: 0, completed: 1 });
});

test("the two kinds are independent: one candidate can hold both", () => {
  const c = inviteCountsOf([row("app-a", "invited"), row("app-a", "submitted", "live")], NOW);
  assert.deepEqual(c.async, { open: 1, completed: 0 });
  assert.deepEqual(c.live, { open: 0, completed: 1 });
});

test("a read that reached the limit gives 'at least' counts; one under it does not", () => {
  const full = Array.from({ length: INVITE_COUNT_READ_LIMIT }, (_, i) =>
    row(`app-${i}`, "invited"),
  );
  assert.equal(INVITE_COUNT_READ_LIMIT, 2000);
  assert.equal(inviteCountsOf(full, NOW).atLeast, true);
  assert.equal(inviteCountsOf(full.slice(1), NOW).atLeast, false);
  assert.equal(inviteCountsOf(full, NOW).async.open, 2000);
});

test("no rows and the failure value both mean no one", () => {
  const c = inviteCountsOf([], NOW);
  assert.deepEqual({ async: c.async, live: c.live, atLeast: c.atLeast }, NO_INVITE_COUNTS);
});
