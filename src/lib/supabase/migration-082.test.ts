/**
 * Migration 082 (#58, 26 Nov): interview questions get a kind, and both lists
 * of a job save in one transaction. Pins the file's shape: the column and its
 * check, the duplicate check before the unique rule, the old index dropped,
 * the function's signature, validation before any lock or delete, positions
 * from array order, the grants, and that no row is copied or changed.
 *
 * No Postgres runs here: these read the SQL. The function's behaviour is
 * checked on staging with the queries in the #58 commit 1 report.
 *
 *   node --test src/lib/supabase/migration-082.test.ts
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

const MIGRATIONS = new URL("migrations/", import.meta.url);
const FILE = "082_interview_question_kind.sql";
const sql = readFileSync(new URL(FILE, MIGRATIONS), "utf8");

/** SQL without comments: a comment can neither satisfy nor trip a check. */
const code = (text) => text.replace(/--.*$/gm, "");
const flat = (text) => code(text).replace(/\s+/g, " ").trim();
const FLAT = flat(sql);

/** The function body, between its `as $$` and the closing `$$;`. */
const fnAt = FLAT.indexOf("create or replace function public.replace_interview_questions(");
const bodyStart = FLAT.indexOf("as $$", fnAt);
const bodyEnd = FLAT.indexOf("end; $$;", bodyStart);
const BODY = FLAT.slice(bodyStart, bodyEnd);
const OUTSIDE = FLAT.slice(0, fnAt) + FLAT.slice(bodyEnd);

test("082 is ours alone; no 083, and nothing of 079 (the other session's) is touched", () => {
  const names = readdirSync(MIGRATIONS);
  assert.deepEqual(
    names.filter((f) => f.startsWith("082_")),
    [FILE],
  );
  assert.deepEqual(
    names.filter((f) => /^08[3-9]_/.test(f)),
    [],
    "no 083 or later",
  );
  assert.doesNotMatch(code(sql), /whatsapp|079|storage/i);
});

test("shape: line 1 is a comment, one transaction, nothing outside it", () => {
  assert.ok(sql.startsWith("-- "));
  const body = code(sql).trim();
  assert.ok(body.startsWith("begin;"));
  assert.ok(body.endsWith("commit;"));
  assert.equal((code(sql).match(/^begin;$/gm) ?? []).length, 1);
  assert.equal((code(sql).match(/^commit;$/gm) ?? []).length, 1);
});

test("the column: interview_kind text not null default 'async', 'async' or 'live' only", () => {
  assert.match(
    FLAT,
    /alter table public\.interview_questions add column if not exists interview_kind text not null default 'async';/,
  );
  assert.match(
    FLAT,
    /add constraint interview_questions_kind_check check \(interview_kind in \('async', 'live'\)\);/,
  );
});

test("the duplicate check runs before the unique rule, and raises with a count only", () => {
  const check = FLAT.indexOf("group by job_id, interview_kind, position having count(*) > 1");
  const unique = FLAT.indexOf("add constraint interview_questions_job_kind_position_key");
  assert.ok(check > 0 && unique > check, "check, then unique");
  const raise = FLAT.slice(check, unique).match(/raise exception '([^']*)', ([^;]*);/);
  assert.ok(raise, "the check raises");
  assert.equal((raise[1].match(/%/g) ?? []).length, 1, "one placeholder");
  assert.equal(raise[2].trim(), "v_groups", "the count, nothing else");
  assert.match(raise[1], /^IQ082: /);
});

test("unique (job_id, interview_kind, position); idx_iq_job dropped; no other index made", () => {
  assert.match(
    FLAT,
    /add constraint interview_questions_job_kind_position_key unique \(job_id, interview_kind, position\);/,
  );
  assert.match(FLAT, /drop index if exists public\.idx_iq_job;/);
  assert.doesNotMatch(FLAT, /create (unique )?index/);
});

test("the function: (uuid, uuid, jsonb, jsonb) returns jsonb, search_path public, not security definer", () => {
  assert.match(
    FLAT,
    /create or replace function public\.replace_interview_questions\( p_job_id uuid, p_company_id uuid, p_async jsonb, p_live jsonb \) returns jsonb language plpgsql set search_path = public as \$\$/,
  );
  assert.doesNotMatch(FLAT, /security definer/);
  assert.equal((FLAT.match(/create or replace function/g) ?? []).length, 1, "one function");
});

test("grants: revoked from public, anon, authenticated; execute to service_role only", () => {
  const SIG = "public.replace_interview_questions(uuid, uuid, jsonb, jsonb)";
  assert.ok(FLAT.includes(`revoke all on function ${SIG} from public, anon, authenticated;`));
  assert.ok(FLAT.includes(`grant execute on function ${SIG} to service_role;`));
  assert.equal((FLAT.match(/\bgrant\b/g) ?? []).length, 1, "one grant");
  assert.doesNotMatch(FLAT, /\bpolicy\b|row level security/i, "RLS unchanged");
});

test("no data copy: no row is inserted, updated or deleted outside the function", () => {
  assert.doesNotMatch(OUTSIDE, /\binsert into\b|\bupdate public\.|\bdelete from\b/);
  assert.doesNotMatch(FLAT, /\bupdate public\./, "the function updates nothing either");
  const written = [...BODY.matchAll(/(?:insert into|delete from) (\S+)/g)].map((m) => m[1]);
  assert.deepEqual(written, ["public.interview_questions", "public.interview_questions"]);
});

test("NULL leaves a kind untouched in both passes; [] clears it (delete, then an empty insert)", () => {
  assert.equal((BODY.match(/continue when v_list is null;/g) ?? []).length, 2);
  assert.match(
    BODY,
    /delete from public\.interview_questions where job_id = p_job_id and company_id = p_company_id and interview_kind = v_kind;/,
  );
});

test("every list is validated before the job is locked or anything deleted", () => {
  const lastRaise = BODY.lastIndexOf("raise exception 'IQ082: % question %");
  const lock = BODY.indexOf("for update");
  const del = BODY.indexOf("delete from");
  assert.ok(lastRaise > 0 && lock > lastRaise && del > lock, "validate, lock, delete");
  assert.match(
    BODY.slice(lock - 120, lock),
    /from public\.jobs where id = p_job_id and company_id = p_company_id $/,
    "lock scoped by company",
  );
});

test("case: a list that is not a JSON array is refused", () => {
  assert.match(
    BODY,
    /if jsonb_typeof\(v_list\) <> 'array' then raise exception 'IQ082: the % list is not an array', v_kind;/,
  );
});

test("case: 9 items is refused (at most 8)", () => {
  assert.match(
    BODY,
    /if jsonb_array_length\(v_list\) > 8 then raise exception 'IQ082: the % list has % questions; at most 8'/,
  );
});

test("case: an item with empty question text is refused", () => {
  assert.match(
    BODY,
    /if jsonb_typeof\(v_item -> 'question'\) is distinct from 'string' or btrim\(v_item ->> 'question'\) = '' then raise exception 'IQ082: % question % has no question text'/,
  );
});

test("every other field is type- and range-checked against the app's limits", () => {
  for (const [field, rule] of [
    ["question", /char_length\(v_item ->> 'question'\) > 500/],
    ["competency", /char_length\(coalesce\(v_item ->> 'competency', ''\)\) > 80/],
    ["rubric", /char_length\(coalesce\(v_item ->> 'rubric', ''\)\) > 1000/],
    ["prep_seconds", /\(v_item ->> 'prep_seconds'\)::numeric between 5 and 120/],
    ["answer_seconds", /\(v_item ->> 'answer_seconds'\)::numeric between 30 and 300/],
    ["weight", /\(v_item ->> 'weight'\)::numeric in \(1, 2, 4, 6\)/],
    ["required", /jsonb_typeof\(v_item -> 'required'\) <> 'boolean'/],
    ["object", /jsonb_typeof\(v_item\) <> 'object'/],
  ]) {
    assert.match(BODY, rule, field);
  }
});

test("positions are 1..n by array order, never read from the input", () => {
  assert.match(BODY, /jsonb_array_elements\(v_list\) with ordinality as e\(value, ordinality\)/);
  assert.match(BODY, /v_kind, e\.ordinality::integer, btrim\(e\.value ->> 'question'\)/);
  assert.doesNotMatch(BODY, /'position'/);
});

test("it returns the rows saved per kind, null for a kind left untouched", () => {
  assert.match(BODY, /v_saved jsonb := jsonb_build_object\('async', null, 'live', null\);/);
  assert.match(
    BODY,
    /get diagnostics v_n = row_count; v_saved := jsonb_set\(v_saved, array\[v_kind\], to_jsonb\(v_n\)\);/,
  );
  assert.match(BODY, /return v_saved;/);
});

test("hyphens only in the file", () => {
  assert.doesNotMatch(sql, /[–—]/);
});
