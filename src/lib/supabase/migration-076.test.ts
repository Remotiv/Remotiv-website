/**
 * Migration 076 (#48, 25 Nov): follow-up indexes 1 to 10 can be stored, and
 * the follow-up check gets its own review action. Pins the file's shape, that
 * it changes only those four constraints, that 053's actions are all kept, and
 * that the test database (fake-live-db.mjs) applies the same rules.
 *
 *   node --test src/lib/supabase/migration-076.test.ts
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

const MIGRATIONS = new URL("migrations/", import.meta.url);
const FILE = "076_live_follow_up_check.sql";
const sql = readFileSync(new URL(FILE, MIGRATIONS), "utf8");
const m053 = readFileSync(new URL("053_live_restart_decision.sql", MIGRATIONS), "utf8");
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

test("076 is ours alone; 075 and 077 are not touched", () => {
  const names = readdirSync(MIGRATIONS);
  assert.deepEqual(
    names.filter((f) => f.startsWith("076_")),
    [FILE],
  );
  assert.doesNotMatch(code(sql), /calendar|075|077/);
});

test("shape: line 1 is a comment, one transaction, nothing outside it", () => {
  assert.ok(sql.startsWith("-- "));
  const body = code(sql).trim();
  assert.ok(body.startsWith("begin;"));
  assert.ok(body.endsWith("commit;"));
  assert.equal((code(sql).match(/^begin;$/gm) ?? []).length, 1);
  assert.equal((code(sql).match(/^commit;$/gm) ?? []).length, 1);
});

test("only four constraints change: the follow-up index and the three action rules", () => {
  const altered = [...code(sql).matchAll(/alter table (\S+)/g)].map((m) => m[1]);
  assert.deepEqual(altered, [
    "public.interview_turns",
    "public.live_interview_actions",
    "public.live_interview_actions",
    "public.live_interview_actions",
  ]);
  const added = [...code(sql).matchAll(/add constraint (\w+)/g)].map((m) => m[1]);
  assert.deepEqual(added, [
    "interview_turns_follow_up_index",
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
  ]) {
    assert.doesNotMatch(code(sql), forbidden, String(forbidden));
  }
});

test("the follow-up index: 1 to 10, only on a follow_up, the rest of 021's rule word for word", () => {
  assert.equal(
    flat(constraint(sql, "interview_turns_follow_up_index")),
    "add constraint interview_turns_follow_up_index check ( (kind is not distinct from 'follow_up') = (follow_up_index is not null) and (follow_up_index is null or follow_up_index between 1 and 10) );",
  );
});

test("the action rules are 053's with resolve_follow_up_check added, and nothing else changed", () => {
  for (const name of [
    "live_interview_actions_action",
    "live_interview_actions_decision",
    "live_interview_actions_target",
  ]) {
    const before = quoted(constraint(m053, name));
    const after = quoted(constraint(sql, name));
    assert.ok(after.includes("resolve_follow_up_check"), name);
    assert.deepEqual(
      after.filter((a) => a !== "resolve_follow_up_check"),
      before,
      `${name}: 053's names, in order, kept`,
    );
  }
  // It sits with the per-question resolutions: score or exclude, and a question position.
  assert.match(
    flat(constraint(sql, "live_interview_actions_decision")),
    /'resolve_follow_up_check', 'resolve_style_check' \) and decision in \('score', 'exclude'\)/,
  );
  assert.match(
    flat(constraint(sql, "live_interview_actions_target")),
    /'resolve_follow_up_check', 'resolve_style_check' \) then question_position is not null/,
  );
});

test("the CHECK query at the bottom is read-only", () => {
  const check = sql.slice(sql.indexOf("-- CHECK (read-only)"));
  assert.ok(check.length > 100);
  assert.doesNotMatch(check, /\b(insert|update|delete|alter|drop|grant|revoke|truncate)\b/i);
  for (const piece of ["follow_up_index_1_to_10", "new_action_in_all_three", "old_actions_kept"]) {
    assert.ok(check.includes(piece), piece);
  }
});

test("the test database applies 076: indexes 1 to 10, and the new action beside the per-question ones", () => {
  assert.match(
    fakeDb.replace(/\s+/g, " "),
    /row\.follow_up_index >= 1 && row\.follow_up_index <= 10/,
  );
  const lists = [...fakeDb.matchAll(/\[([^\]]*)\]\.includes\(row\.action\)/g)]
    .map((m) => [...m[1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]))
    .filter((l) => l.includes("resolve_needs_check"));
  assert.equal(lists.length, 2);
  // The fake mirrors the latest schema: 078 added resolve_time_limit_check
  // (pinned exactly in migration-078.test.ts). 076's list is all there.
  for (const l of lists) {
    for (const a of [
      "resolve_needs_check",
      "resolve_repeat_check",
      "resolve_wording_check",
      "resolve_follow_up_check",
      "resolve_style_check",
    ]) {
      assert.ok(l.includes(a), a);
    }
  }
});
