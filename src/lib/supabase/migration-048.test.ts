/**
 * Source pins for migration 048: the repeat check's own resolution action on
 * live_interview_actions, and the fake database that mirrors it.
 *
 *   node --test src/lib/supabase/migration-048.test.ts
 *
 * WHAT THIS DOES NOT PROVE. Nothing here runs the SQL. Each check is a pure
 * function over the SQL text, and each is also run against a deliberately
 * broken copy, so a check that cannot fail is caught here rather than trusted.
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

const MIGRATIONS = new URL("migrations/", import.meta.url);
const FILE = "048_live_repeat_check.sql";
const sql = readFileSync(new URL(FILE, MIGRATIONS), "utf8");
const fakeDb = readFileSync(
  new URL("../../test-support/fake-live-db.mjs", import.meta.url),
  "utf8",
);

/** SQL without comments: a comment can neither satisfy nor trip a check. */
const code = (text) => text.replace(/--.*$/gm, "");

/** One constraint's definition, from its add line to the closing `);`. */
function constraint(text, name) {
  const at = code(text).indexOf(`add constraint ${name}`);
  if (at < 0) return "";
  const body = code(text).slice(at);
  return body.slice(0, body.indexOf(");") + 2);
}

const ACTIONS = [
  "retry_transcription",
  "resolve_needs_check",
  "resolve_repeat_check",
  "resolve_style_check",
  "resolve_failed_transcription",
];

/** Every problem with a copy of the migration; empty when it is right. */
function problems(text) {
  const out = [];
  const action = constraint(text, "live_interview_actions_action");
  for (const a of ACTIONS) if (!action.includes(`'${a}'`)) out.push(`action list lacks ${a}`);
  const decision = constraint(text, "live_interview_actions_decision");
  if (
    !/action in \('resolve_needs_check', 'resolve_repeat_check', 'resolve_style_check'\)\s+and decision in \('score', 'exclude'\)/.test(
      decision,
    )
  ) {
    out.push("the repeat check does not take score or exclude like the other two");
  }
  if (!decision.includes("(action = 'retry_transcription' and decision = 'retry')"))
    out.push("retry lost");
  if (!decision.includes("(action = 'resolve_failed_transcription' and decision = 'exclude')"))
    out.push("failed-transcription exclude lost");
  const target = constraint(text, "live_interview_actions_target");
  if (
    !/when action in \('resolve_needs_check', 'resolve_repeat_check', 'resolve_style_check'\)\s+then question_position is not null/.test(
      target,
    )
  ) {
    out.push("the repeat check does not require a question");
  }
  if (!target.includes("else turn_id is not null and turn_sequence is not null"))
    out.push("turn actions lost their target");
  // Constraint-only: no table, column, data or trigger change.
  if (/\b(create|drop)\s+(table|trigger|function)\b/i.test(code(text)))
    out.push("DDL beyond constraints");
  if (/\badd\s+column\b|\bdrop\s+column\b/i.test(code(text))) out.push("column change");
  if (/\b(insert\s+into|update\s+public\.|delete\s+from|truncate)\b/i.test(code(text)))
    out.push("data change");
  // Re-runnable: every constraint dropped if it exists before it is added.
  for (const name of [
    "live_interview_actions_action",
    "live_interview_actions_decision",
    "live_interview_actions_target",
  ]) {
    if (!code(text).includes(`drop constraint if exists ${name},\n  add constraint ${name}`))
      out.push(`${name} is not dropped before it is added`);
  }
  return out;
}

test("048 adds resolve_repeat_check to all three constraints, keeps the rest, and changes nothing else", () => {
  assert.deepEqual(problems(sql), []);
});

test("each check fails on a broken copy", () => {
  const broken = [
    ["no action", sql.replace("        'resolve_repeat_check',\n", "")],
    [
      "no decision",
      sql.replace(
        "action in ('resolve_needs_check', 'resolve_repeat_check', 'resolve_style_check')\n        and decision",
        "action in ('resolve_needs_check', 'resolve_style_check')\n        and decision",
      ),
    ],
    [
      "no target",
      sql.replace(
        "when action in ('resolve_needs_check', 'resolve_repeat_check', 'resolve_style_check')\n          then",
        "when action in ('resolve_needs_check', 'resolve_style_check')\n          then",
      ),
    ],
    [
      "retry dropped",
      sql.replace("(action = 'retry_transcription' and decision = 'retry')", "false"),
    ],
    ["a column", `${sql}\nalter table public.live_interview_actions add column x int;`],
    ["data", `${sql}\ndelete from public.live_interview_actions;`],
    [
      "not re-runnable",
      sql.replace("drop constraint if exists live_interview_actions_target,\n", ""),
    ],
  ];
  for (const [label, copy] of broken) {
    assert.notEqual(copy, sql, `${label}: the copy differs`);
    assert.ok(problems(copy).length > 0, label);
  }
  // A comment naming the action does not count as the action.
  const commented = sql.replace(
    "        'resolve_repeat_check',\n",
    "        -- 'resolve_repeat_check',\n",
  );
  assert.ok(problems(commented).length > 0, "comment");
});

test("numbered 048: no 047 file (reserved for access-log retention), no second 048", () => {
  const files = readdirSync(MIGRATIONS);
  assert.ok(!files.some((f) => f.startsWith("047_")), "047 stays free");
  assert.deepEqual(
    files.filter((f) => f.startsWith("048_")),
    [FILE],
  );
});

test("the fake database accepts resolve_repeat_check exactly as the migration does", () => {
  const lists = fakeDb.match(
    /\["resolve_needs_check", "resolve_repeat_check", "resolve_style_check"\]\.includes\(row\.action\)/g,
  );
  assert.equal(lists?.length, 2, "decision and target rules both include it");
});
