/**
 * Every job type ensureMaintenanceScheduled starts (RECURRING in
 * jobs-queue.ts) is one the admin queue panel counts (QUEUE_TYPES in
 * queue-health.ts) and names (TYPE_LABEL in _queue-panel.tsx), so a daily job
 * added later cannot run, or fail, unseen. The queue-health test stub's
 * JOB_TYPES must carry each one too, or QUEUE_TYPES reads undefined there.
 *
 *   node --test src/lib/queue/scheduled-visible.test.ts
 *
 * Read as text: jobs-queue.ts imports every handler, and RECURRING is not
 * exported. Each check is a pure function over the sources, also run against
 * deliberately broken copies.
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");
/** Code only: a comment can neither satisfy nor trip a check. */
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const SOURCES = {
  queue: read("../jobs-queue.ts"),
  health: read("../queue-health.ts"),
  panel: read("../../app/admin/companies/_queue-panel.tsx"),
  hook: read("../../test-support/queue-health-test-hook.mjs"),
};

/** The JOB_TYPES keys RECURRING schedules. */
function scheduled(queue) {
  const body = code(queue);
  const start = body.indexOf("const RECURRING: readonly RecurringJob[] = [");
  const block = body.slice(start, body.indexOf("\n];", start));
  return [...block.matchAll(/type: JOB_TYPES\.([A-Z_]+)/g)].map((m) => m[1]);
}

/** Every problem across the four sources; empty when they agree. */
function problems({ queue, health, panel, hook }) {
  const out = [];
  const keys = scheduled(queue);
  if (keys.length === 0) out.push("no scheduled types found");
  const jobTypes = code(queue).slice(code(queue).indexOf("export const JOB_TYPES"));
  const listed = (() => {
    const h = code(health);
    const at = h.indexOf("export const QUEUE_TYPES: readonly string[] = [");
    return [...h.slice(at, h.indexOf("];", at)).matchAll(/JOB_TYPES\.([A-Z_]+)/g)].map((m) => m[1]);
  })();
  const labelBlock = (() => {
    const p = code(panel);
    const at = p.indexOf("const TYPE_LABEL: Record<string, string> = {");
    return p.slice(at, p.indexOf("};", at));
  })();
  for (const key of keys) {
    const value = jobTypes.match(new RegExp(`\\b${key}: "([a-z_]+)"`))?.[1];
    if (!value) out.push(`${key}: not in JOB_TYPES`);
    if (!listed.includes(key)) out.push(`${key}: scheduled but not in QUEUE_TYPES`);
    if (value && !new RegExp(`\\b${value}: "[^"]+"`).test(labelBlock))
      out.push(`${value}: no panel label`);
    if (value && !hook.includes(`'  ${key}: "${value}",'`))
      out.push(`${key}: missing from the test stub`);
  }
  return out;
}

test("every type ensureMaintenanceScheduled starts is counted, labelled and stubbed", () => {
  assert.deepEqual(
    scheduled(SOURCES.queue),
    [
      "INTERVIEW_PURGE",
      "CV_PURGE",
      "QUEUE_SWEEP",
      "INTERVIEW_EXPIRY_SWEEP",
      "FINAL_BOT_SYNC",
      "FINAL_RECORDING_PURGE",
      "INTERVIEW_ORPHAN_SWEEP",
      "ACCESS_LOG_PURGE",
    ],
    "the schedule this test was written against",
  );
  assert.deepEqual(problems(SOURCES), []);
});

test("each check fails on a broken copy", () => {
  const broken = [
    [
      "access_log_purge dropped from QUEUE_TYPES",
      { ...SOURCES, health: SOURCES.health.replace("  JOB_TYPES.ACCESS_LOG_PURGE,\n", "") },
    ],
    [
      "a new daily job scheduled but never listed",
      {
        ...SOURCES,
        queue: SOURCES.queue.replace(
          "  { type: JOB_TYPES.ACCESS_LOG_PURGE, intervalMs: PURGE_INTERVAL_MS },\n",
          "  { type: JOB_TYPES.ACCESS_LOG_PURGE, intervalMs: PURGE_INTERVAL_MS },\n  { type: JOB_TYPES.TALENT_RETENTION_PURGE, intervalMs: PURGE_INTERVAL_MS },\n",
        ),
      },
    ],
    [
      "listed only in a comment",
      {
        ...SOURCES,
        health: SOURCES.health.replace(
          "  JOB_TYPES.ACCESS_LOG_PURGE,\n",
          "  // JOB_TYPES.ACCESS_LOG_PURGE,\n",
        ),
      },
    ],
    [
      "no panel label",
      {
        ...SOURCES,
        panel: SOURCES.panel.replace('  access_log_purge: "Access record retention",\n', ""),
      },
    ],
    [
      "missing from the test stub",
      {
        ...SOURCES,
        hook: SOURCES.hook.replace(`    '  ACCESS_LOG_PURGE: "access_log_purge",',\n`, ""),
      },
    ],
  ];
  for (const [label, copy] of broken) {
    const changed = Object.keys(copy).some((k) => copy[k] !== SOURCES[k]);
    assert.ok(changed, `${label}: the copy differs`);
    assert.ok(problems(copy).length > 0, label);
  }
});
