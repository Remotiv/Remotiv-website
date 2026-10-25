/**
 * Source pins for migration 049: the wording check's own resolution action on
 * live_interview_actions (F12), and the fake database that mirrors it.
 *
 *   node --test src/lib/supabase/migration-049.test.ts
 *
 * WHAT THIS DOES NOT PROVE. Nothing here runs the SQL; the PGlite run that
 * does is reported with the change. Each check is a pure function over the SQL
 * text, and each is also run against a deliberately broken copy, so a check
 * that cannot fail is caught here rather than trusted.
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

const MIGRATIONS = new URL("migrations/", import.meta.url);
const FILE = "049_live_wording_check.sql";
const sql = readFileSync(new URL(FILE, MIGRATIONS), "utf8");
const fakeDb = readFileSync(
  new URL("../../test-support/fake-live-db.mjs", import.meta.url),
  "utf8",
);

/** SQL without comments: a comment can neither satisfy nor trip a check. */
const code = (text) => text.replace(/--.*$/gm, "");

/** One constraint's definition, from its add line to the closing `);`. */
function constraint(text, name) {
  const body = code(text);
  const at = body.indexOf(`add constraint ${name}`);
  if (at < 0) return "";
  const rest = body.slice(at);
  return rest.slice(0, rest.indexOf(");\n") + 2);
}

/** The quoted names inside the first `action in (...)` after `marker`. */
function listAfter(text, marker) {
  const at = text.indexOf(marker);
  if (at < 0) return [];
  const open = text.indexOf("action in (", at);
  if (open < 0) return [];
  const close = text.indexOf(")", open);
  return [...text.slice(open, close).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

const ACTIONS = [
  "retry_transcription",
  "resolve_needs_check",
  "resolve_repeat_check",
  "resolve_wording_check",
  "resolve_style_check",
  "resolve_failed_transcription",
];
const PER_QUESTION = [
  "resolve_needs_check",
  "resolve_repeat_check",
  "resolve_wording_check",
  "resolve_style_check",
];

/** Every problem with a copy of the migration; empty when it is right. */
function problems(text) {
  const out = [];
  const action = constraint(text, "live_interview_actions_action");
  const listed = [...action.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  if (JSON.stringify(listed) !== JSON.stringify(ACTIONS)) out.push(`action list is ${listed}`);

  const decision = constraint(text, "live_interview_actions_decision");
  if (JSON.stringify(listAfter(decision, "or (")) !== JSON.stringify(PER_QUESTION))
    out.push("the per-question decision rule does not list exactly the four checks");
  if (!/\)\s+and decision in \('score', 'exclude'\)/.test(decision))
    out.push("the per-question checks do not take score or exclude");
  if (!decision.includes("(action = 'retry_transcription' and decision = 'retry')"))
    out.push("retry lost");
  if (!decision.includes("(action = 'resolve_failed_transcription' and decision = 'exclude')"))
    out.push("failed-transcription exclude lost");

  const target = constraint(text, "live_interview_actions_target");
  if (JSON.stringify(listAfter(target, "when ")) !== JSON.stringify(PER_QUESTION))
    out.push("the per-question target rule does not list exactly the four checks");
  if (!/\)\s+then question_position is not null/.test(target))
    out.push("the per-question checks do not require a question");
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

test("049 adds resolve_wording_check to all three constraints, keeps every other action, and changes nothing else", () => {
  assert.deepEqual(problems(sql), []);
});

test("each check fails on a broken copy", () => {
  const broken = [
    ["no action", sql.replace("        'resolve_wording_check',\n", "")],
    ["048's action lost", sql.replace("        'resolve_repeat_check',\n", "")],
    [
      "no decision",
      sql.replace(
        "          'resolve_wording_check',\n          'resolve_style_check'\n        )\n        and decision",
        "          'resolve_style_check'\n        )\n        and decision",
      ),
    ],
    [
      "no target",
      sql.replace(
        "          'resolve_wording_check',\n          'resolve_style_check'\n        )\n          then",
        "          'resolve_style_check'\n        )\n          then",
      ),
    ],
    [
      "any decision",
      sql.replace("and decision in ('score', 'exclude')", "and decision is not null"),
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
    "        'resolve_wording_check',\n",
    "        -- 'resolve_wording_check',\n",
  );
  assert.notEqual(commented, sql);
  assert.ok(problems(commented).length > 0, "comment");
});

test("numbered 049: 047 is access-log retention, 048 is the repeat check, no second 049", () => {
  const files = readdirSync(MIGRATIONS);
  assert.deepEqual(
    files.filter((f) => f.startsWith("047_")),
    ["047_access_log_retention.sql"],
    "047 holds what it was reserved for",
  );
  assert.deepEqual(
    files.filter((f) => f.startsWith("048_")),
    ["048_live_repeat_check.sql"],
  );
  assert.deepEqual(
    files.filter((f) => f.startsWith("049_")),
    [FILE],
  );
});

test("the fake database accepts resolve_wording_check exactly as the migration does", () => {
  const lists = [...fakeDb.matchAll(/\[([^\]]*)\]\.includes\(row\.action\)/g)]
    .map((m) => [...m[1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]))
    .filter((l) => l.includes("resolve_needs_check"));
  assert.equal(lists.length, 2, "decision and target rules");
  for (const l of lists) assert.deepEqual(l, PER_QUESTION);
});
