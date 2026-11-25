/**
 * Migration 078 (#50, 25 Nov): the time-limit check gets its own review
 * action. Pins the file's shape, that it changes only the three action
 * constraints, that every value 076 named is kept in order, and that the test
 * database (fake-live-db.mjs) applies exactly the same rules.
 *
 *   node --test src/lib/supabase/migration-078.test.ts
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

const MIGRATIONS = new URL("migrations/", import.meta.url);
const FILE = "078_live_time_limit_check.sql";
const sql = readFileSync(new URL(FILE, MIGRATIONS), "utf8");
const m076 = readFileSync(new URL("076_live_follow_up_check.sql", MIGRATIONS), "utf8");
const fakeDb = readFileSync(
  new URL("../../test-support/fake-live-db.mjs", import.meta.url),
  "utf8",
);

/** SQL without comments: a comment can neither satisfy nor trip a check. */
const code = (text) => text.replace(/--.*$/gm, "");
const flat = (text) => code(text).replace(/\s+/g, " ").trim();

/** One constraint's definition, from its add line to the closing `);`. */
function constraint(text, name) {
  const body = code(text);
  const at = body.lastIndexOf(`add constraint ${name}`);
  if (at < 0) return "";
  const rest = body.slice(at);
  return rest.slice(0, rest.indexOf(");\n") + 2);
}
const quoted = (text) => [...text.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);

test("078 is ours alone; 077 is not touched", () => {
  const names = readdirSync(MIGRATIONS);
  assert.deepEqual(
    names.filter((f) => f.startsWith("078_")),
    [FILE],
  );
  assert.doesNotMatch(code(sql), /calendar|077/);
});

test("shape: line 1 is a comment, one transaction, nothing outside it", () => {
  assert.ok(sql.startsWith("-- "));
  const body = code(sql).trim();
  assert.ok(body.startsWith("begin;"));
  assert.ok(body.endsWith("commit;"));
  assert.equal((code(sql).match(/^begin;$/gm) ?? []).length, 1);
  assert.equal((code(sql).match(/^commit;$/gm) ?? []).length, 1);
});

test("only the three action constraints change, and nothing else", () => {
  const altered = [...code(sql).matchAll(/alter table (\S+)/g)].map((m) => m[1]);
  assert.deepEqual(altered, [
    "public.live_interview_actions",
    "public.live_interview_actions",
    "public.live_interview_actions",
  ]);
  const added = [...code(sql).matchAll(/add constraint (\w+)/g)].map((m) => m[1]);
  assert.deepEqual(added, [
    "live_interview_actions_action",
    "live_interview_actions_decision",
    "live_interview_actions_target",
  ]);
  for (const forbidden of [
    /create (table|index|function|trigger|policy)/i,
    /\b(grant|revoke)\b/i,
    /\b(insert|update|delete)\b/i,
    /drop (table|index|function|trigger|column)/i,
    /add column/i,
    /interview_turns/,
  ]) {
    assert.doesNotMatch(code(sql), forbidden, String(forbidden));
  }
});

test("each constraint is 076's with resolve_time_limit_check added after the follow-up check, every value kept in order", () => {
  for (const name of [
    "live_interview_actions_action",
    "live_interview_actions_decision",
    "live_interview_actions_target",
  ]) {
    const before = quoted(constraint(m076, name));
    const after = quoted(constraint(sql, name));
    const at = before.indexOf("resolve_follow_up_check") + 1;
    assert.ok(at > 0, `${name}: 076 names the follow-up check`);
    assert.deepEqual(
      after,
      [...before.slice(0, at), "resolve_time_limit_check", ...before.slice(at)],
      name,
    );
  }
  assert.match(
    flat(constraint(sql, "live_interview_actions_decision")),
    /'resolve_time_limit_check', 'resolve_style_check' \) and decision in \('score', 'exclude'\)/,
  );
  assert.match(
    flat(constraint(sql, "live_interview_actions_target")),
    /'resolve_time_limit_check', 'resolve_style_check' \) then question_position is not null/,
  );
});

test("the CHECK query at the bottom is read-only", () => {
  const check = sql.slice(sql.indexOf("-- CHECK (read-only)"));
  assert.ok(check.length > 100);
  assert.doesNotMatch(check, /\b(insert|update|delete|alter|drop|grant|revoke|truncate)\b/i);
  for (const piece of ["new_action_in_all_three", "follow_up_action_kept", "old_actions_kept"]) {
    assert.ok(check.includes(piece), piece);
  }
});

test("the test database applies exactly 078's per-question actions", () => {
  const lists = [...fakeDb.matchAll(/\[([^\]]*)\]\.includes\(row\.action\)/g)]
    .map((m) => [...m[1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]))
    .filter((l) => l.includes("resolve_needs_check"));
  assert.equal(lists.length, 2, "decision and target rules");
  for (const l of lists) {
    assert.deepEqual(l, [
      "resolve_needs_check",
      "resolve_repeat_check",
      "resolve_wording_check",
      "resolve_follow_up_check",
      "resolve_time_limit_check",
      "resolve_style_check",
    ]);
  }
});
