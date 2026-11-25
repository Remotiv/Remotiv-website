/**
 * Migration 080 (#55 part 2, 26 Nov): server-written live turn audio (t
 * paths) is refused once the session's delete_after is due. Pins that 080 is
 * 066's function with exactly one condition added to the t-path branch and
 * every other byte identical, that nothing else in the database changes (no
 * trigger, grant, table or data), and that the CHECK at the bottom is
 * read-only. Not applied by this commit: Waleed applies it.
 *
 *   node --test src/lib/supabase/migration-080.test.ts
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

const MIGRATIONS = new URL("migrations/", import.meta.url);
const FILE = "080_turn_audio_refused_when_due.sql";
const sql = readFileSync(new URL(FILE, MIGRATIONS), "utf8");
const m066 = readFileSync(
  new URL("066_interview_upload_open_session_only.sql", MIGRATIONS),
  "utf8",
);

/** SQL without comments: a comment can neither satisfy nor trip a check. */
const code = (text) => text.replace(/--.*$/gm, "");

/** The function's definition, from `create or replace function` to its closing `$$;`. */
function fn(text) {
  const at = text.indexOf("create or replace function public.interview_upload_open_session_only()");
  assert.ok(at >= 0, "the function is defined");
  return text.slice(at, text.indexOf("$$;", at) + 3);
}

const T_066 = `            and ses.kind = 'live'
            and ses.purged_at is null) then`;
const T_080 = `            and ses.kind = 'live'
            and ses.purged_at is null
            and (ses.delete_after is null or ses.delete_after > pg_catalog.now())) then`;

test("080 is ours alone; 079 is the other session's and is not touched", () => {
  const names = readdirSync(MIGRATIONS);
  assert.deepEqual(
    names.filter((f) => f.startsWith("080_")),
    [FILE],
  );
  assert.doesNotMatch(code(sql), /079|whatsapp/i);
});

test("shape: line 1 is a comment, one transaction, nothing outside it", () => {
  assert.ok(sql.startsWith("-- "));
  const body = code(sql).trim();
  assert.ok(body.startsWith("begin;"));
  assert.ok(body.endsWith("commit;"));
  assert.equal((code(sql).match(/^begin;$/gm) ?? []).length, 1);
  assert.equal((code(sql).match(/^commit;$/gm) ?? []).length, 1);
});

test("the function is 066's, byte for byte, with ONE condition added to the t-path branch", () => {
  const before = fn(m066);
  const after = fn(sql);
  assert.equal(before.split(T_066).length, 2, "066's t-path condition, once");
  assert.equal(after, before.replace(T_066, T_080), "every other byte identical");
  // The other branches, by their own text, still there in 080.
  for (const kept of [
    "if new.bucket_id is distinct from 'interview-videos' then",
    "or s.kind is distinct from 'async'",
    "or (s.delete_after is not null and s.delete_after <= pg_catalog.now())",
    "and p.status = 'pending')",
    "and pg_catalog.now() > s.live_ended_at + interval '30 minutes')",
    "if new.name ~ '/[qv][0-9]+' and new.name !~",
    "security definer\nset search_path = ''",
  ]) {
    assert.ok(after.includes(kept), kept);
  }
  // And the t-path rule now has the v path's delete_after test.
  const tBranch = after.slice(after.indexOf("-- live turn audio (server)"));
  assert.match(
    tBranch.slice(0, tBranch.indexOf("return new;")),
    /ses\.delete_after > pg_catalog\.now\(\)/,
  );
});

test("nothing else changes: no trigger, grant, table, column, policy or data", () => {
  const outside = code(sql).replace(code(fn(sql)), "");
  assert.deepEqual(
    outside
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean),
    ["begin;", "set local lock_timeout = '5s';", "commit;"],
  );
  assert.doesNotMatch(code(sql), /create trigger|drop trigger|drop function/i);
  assert.doesNotMatch(code(sql), /\b(grant|revoke)\b/i);
  assert.doesNotMatch(code(sql), /\b(insert|update|delete)\b(?! on)/i);
});

test("the CHECK at the bottom is read-only and asks for the trigger, the definer and the new rule", () => {
  const check = sql.slice(sql.indexOf("-- ── CHECK (read-only)"));
  assert.ok(check.length > 200);
  // "BEFORE INSERT" is the trigger definition the check expects to read back.
  assert.doesNotMatch(
    check.replace(/BEFORE INSERT/g, ""),
    /\b(insert|update|delete|alter|drop|grant|revoke|truncate|create)\b/i,
  );
  for (const piece of [
    "tgname",
    "prosecdef",
    "t_path_delete_after",
    "v_window_kept",
    "v_delete_after_kept",
  ]) {
    assert.ok(check.includes(piece), piece);
  }
});

test("066 itself is untouched: its t-path rule still reads only purged_at", () => {
  assert.ok(fn(m066).includes(T_066));
  assert.ok(!fn(m066).includes("ses.delete_after > pg_catalog.now()"));
});
