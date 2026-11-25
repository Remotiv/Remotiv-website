/**
 * Migration 081 (#15, 26 Nov): the order check gets its own review action.
 * Pins the file's shape, that it changes only the three action constraints,
 * that every value 078 named is kept in order, and that the test database
 * (fake-live-db.mjs) applies exactly the same rules.
 *
 *   node --test src/lib/supabase/migration-081.test.ts
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

const MIGRATIONS = new URL("migrations/", import.meta.url);
const FILE = "081_live_order_check.sql";
const sql = readFileSync(new URL(FILE, MIGRATIONS), "utf8");
const m078 = readFileSync(new URL("078_live_time_limit_check.sql", MIGRATIONS), "utf8");
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

test("081 is ours alone; 079 (the other session's) and 080 are not touched", () => {
  const names = readdirSync(MIGRATIONS);
  assert.deepEqual(
    names.filter((f) => f.startsWith("081_")),
    [FILE],
  );
  assert.doesNotMatch(code(sql), /whatsapp|079|080|storage/i);
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

test("each constraint is 078's with resolve_order_check added after the time-limit check, every value kept in order", () => {
  for (const name of [
    "live_interview_actions_action",
    "live_interview_actions_decision",
    "live_interview_actions_target",
  ]) {
    const before = quoted(constraint(m078, name));
    const after = quoted(constraint(sql, name));
    const at = before.indexOf("resolve_time_limit_check") + 1;
    assert.ok(at > 0, `${name}: 078 names the time-limit check`);
    assert.deepEqual(
      after,
      [...before.slice(0, at), "resolve_order_check", ...before.slice(at)],
      name,
    );
    // And the whole constraint is 078's otherwise, word for word.
    assert.equal(
      flat(constraint(sql, name)).replace(/'resolve_order_check', /g, ""),
      flat(constraint(m078, name)),
      `${name}: nothing else changed`,
    );
  }
  assert.match(
    flat(constraint(sql, "live_interview_actions_decision")),
    /'resolve_order_check', 'resolve_style_check' \) and decision in \('score', 'exclude'\)/,
  );
  assert.match(
    flat(constraint(sql, "live_interview_actions_target")),
    /'resolve_order_check', 'resolve_style_check' \) then question_position is not null/,
  );
});

test("the CHECK query at the bottom is read-only", () => {
  const check = sql.slice(sql.indexOf("-- CHECK (read-only)"));
  assert.ok(check.length > 100);
  assert.doesNotMatch(check, /\b(insert|update|delete|alter|drop|grant|revoke|truncate)\b/i);
  for (const piece of ["new_action_in_all_three", "time_limit_action_kept", "old_actions_kept"]) {
    assert.ok(check.includes(piece), piece);
  }
});

test("the test database applies exactly 081's per-question actions", () => {
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
      "resolve_order_check",
      "resolve_style_check",
    ]);
  }
});
