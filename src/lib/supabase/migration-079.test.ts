/**
 * Migration 079 (#67, 25 Nov): the WhatsApp opt-in and its time on each
 * application. Pins the file's shape, that existing applications get no
 * consent, that the tick and its time stay together, and that nothing else
 * changes.
 *
 *   node --test src/lib/supabase/migration-079.test.ts
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

const MIGRATIONS = new URL("migrations/", import.meta.url);
const FILE = "079_whatsapp_opt_in.sql";
const sql = readFileSync(new URL(FILE, MIGRATIONS), "utf8");

/** SQL without comments: a comment can neither satisfy nor trip a check. */
const code = (text) => text.replace(/--.*$/gm, "");
const flat = (text) => code(text).replace(/\s+/g, " ").trim();

test("079 is ours alone", () => {
  assert.deepEqual(
    readdirSync(MIGRATIONS).filter((f) => f.startsWith("079_")),
    [FILE],
  );
});

test("shape: line 1 is a comment, one transaction, says it is not run", () => {
  assert.ok(sql.startsWith("-- "));
  const body = code(sql).trim();
  assert.ok(body.startsWith("begin;"));
  assert.ok(body.endsWith("commit;"));
  assert.match(sql, /NOT RUN anywhere/);
});

test("two columns: the tick defaults to false, the time is nullable", () => {
  const f = flat(sql);
  assert.match(f, /add column if not exists whatsapp_opt_in boolean not null default false/);
  assert.match(f, /add column if not exists whatsapp_opt_in_at timestamptz[,;]/);
});

test("the tick and its time stay together", () => {
  assert.match(
    flat(sql),
    /add constraint job_applications_whatsapp_opt_in_at check \(whatsapp_opt_in = \(whatsapp_opt_in_at is not null\)\)/,
  );
});

test("existing applications get no consent: nothing is backfilled", () => {
  const f = flat(sql);
  assert.doesNotMatch(f, /\bupdate\b/);
  assert.doesNotMatch(f, /\binsert\b/);
  assert.doesNotMatch(f, /default true/);
});

test("nothing else changes: one table, no policy, grant, function, trigger or index", () => {
  const f = flat(sql);
  const tables = [...f.matchAll(/alter table (\S+)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(tables)], ["public.job_applications"]);
  assert.doesNotMatch(
    f,
    /create (or replace )?(function|trigger|policy|index|table)|\bgrant\b|\brevoke\b|\bdrop column\b/,
  );
});
