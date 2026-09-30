/**
 * The two worker alerts, every branch.
 *
 *   node --test src/lib/queue/alerts.test.ts
 *
 * The module imports only a type from failure-class, which erases, so no
 * resolve hook is needed.
 */
// @ts-nocheck — same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { test } from "node:test";
import { QUEUE_PANEL_LINK, staleGapNotice, summariseDeadJobs } from "./alerts.ts";

/* ── job_dead ───────────────────────────────────────────────── */

test("no dead jobs -> null, so the caller sends nothing", () => {
  assert.equal(summariseDeadJobs([]), null);
});

test("one dead job -> singular title, type and class named, link to the panel", () => {
  const c = summariseDeadJobs([{ type: "ai_cv_score", failureClass: "billing" }]);
  assert.equal(c.title, "1 background job died");
  assert.match(c.message, /^1 ai_cv_score\. Failure class: 1 billing - check the provider's credit balance/);
  assert.equal(c.link, QUEUE_PANEL_LINK);
  assert.deepEqual(c.metadata, {
    deadCount: 1,
    byType: { ai_cv_score: 1 },
    byClass: { billing: 1 },
  });
});

test("the 17 August shape: thirteen deaths in one tick become ONE notification with counts", () => {
  const entries = Array.from({ length: 13 }, () => ({ type: "ai_cv_score", failureClass: "billing" }));
  const c = summariseDeadJobs(entries);
  assert.equal(c.title, "13 background jobs died");
  assert.match(c.message, /^13 ai_cv_score\./);
  assert.match(c.message, /13 billing/);
  assert.equal(c.metadata.deadCount, 13);
});

test("mixed types and classes are counted separately and ordered deterministically", () => {
  const a = summariseDeadJobs([
    { type: "transcribe", failureClass: "retryable" },
    { type: "ai_cv_score", failureClass: "billing" },
    { type: "ai_cv_score", failureClass: "configuration" },
  ]);
  const b = summariseDeadJobs([
    { type: "ai_cv_score", failureClass: "configuration" },
    { type: "transcribe", failureClass: "retryable" },
    { type: "ai_cv_score", failureClass: "billing" },
  ]);
  // Same set, different arrival order, byte-identical text.
  assert.deepEqual(a, b);
  assert.match(a.message, /^2 ai_cv_score, 1 transcribe\./);
  assert.deepEqual(a.metadata.byClass, { billing: 1, configuration: 1, retryable: 1 });
});

test("the message carries no raw diagnostics: only counts, types, classes and the hint text", () => {
  const raw = 'duplicate key value violates unique constraint "x"; Anthropic 402 credit balance too low';
  // The function is never GIVEN raw text - that is the design - so assert its
  // inputs cannot smuggle any in: an unknown class string is echoed as itself
  // only if the caller passes it, and the type set forbids that at compile time.
  const c = summariseDeadJobs([{ type: "ai_cv_score", failureClass: "billing" }]);
  assert.ok(!c.message.includes(raw));
  assert.ok(!JSON.stringify(c.metadata).includes("last_error"));
  for (const forbidden of [/duplicate key/, /constraint/, /\b40[0-9]\b/, /anthropic/i, /postgres/i]) {
    assert.doesNotMatch(c.message, forbidden);
  }
});

/* ── worker_stale ───────────────────────────────────────────── */

const TEN_MIN = 10 * 60_000;
const t0 = Date.parse("2026-10-01T12:00:00Z");

test("no previous heartbeat -> null (first tick after migration 035 is not an outage)", () => {
  assert.equal(staleGapNotice(null, t0, TEN_MIN), null);
  assert.equal(staleGapNotice("", t0, TEN_MIN), null);
});

test("previous heartbeat within threshold -> null", () => {
  assert.equal(staleGapNotice(new Date(t0 - 60_000).toISOString(), t0, TEN_MIN), null);
  assert.equal(staleGapNotice(new Date(t0 - TEN_MIN).toISOString(), t0, TEN_MIN), null, "exactly at threshold is not stale");
});

test("previous heartbeat past threshold -> a notice with the gap in minutes", () => {
  const n = staleGapNotice(new Date(t0 - 47 * 60_000).toISOString(), t0, TEN_MIN);
  assert.equal(n.title, "Background worker was not running");
  assert.equal(n.gapMinutes, 47);
  assert.match(n.message, /about 47 minutes/);
  assert.match(n.message, /configured outside\s+the repository/);
  assert.equal(n.link, QUEUE_PANEL_LINK);
  assert.equal(n.metadata.gapMinutes, 47);
  assert.equal(n.metadata.thresholdMinutes, 10);
});

test("an unparseable previous timestamp -> null rather than a NaN-minute notice", () => {
  assert.equal(staleGapNotice("not a date", t0, TEN_MIN), null);
});
