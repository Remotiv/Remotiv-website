/**
 * Migration 074 (#45, #46, 24 Nov): three AI Video Interview settings on each
 * job. Pins the migration's shape, the types beside it, and that the
 * confidential hiring challenges have no path to VoxAgent, the public or a
 * candidate: no reader of jobs selects them, and no query on jobs returns
 * whole rows (no select("*"), no bare .select(), no embedded jobs(*)). The
 * public keep-list itself is pinned by jobs-public.test.ts. Reads source only;
 * nothing leaves the machine.
 *
 *   node --test src/lib/job-live-settings-074.test.ts
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { register } from "node:module";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

register(new URL("../test-support/node-resolve.mjs", import.meta.url));

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SRC = join(ROOT, "src");
const MIGRATIONS = join(SRC, "lib/supabase/migrations");
const SQL = readFileSync(join(MIGRATIONS, "074_job_live_interview_settings.sql"), "utf8");
/** The statements, without the comment lines (the CHECK query at the bottom is all comments). */
const CODE = SQL.split("\n")
  .filter((l) => !l.trimStart().startsWith("--"))
  .join("\n");

const types = await import("../app/ai-dashboard/lib/job-types.ts");

test("074 is this migration's alone, and the next free number after 073", () => {
  const numbered = readdirSync(MIGRATIONS).filter((f) => /^\d{3}_.*\.sql$/.test(f));
  assert.deepEqual(
    numbered.filter((f) => f.startsWith("074_")),
    ["074_job_live_interview_settings.sql"],
  );
  assert.ok(
    numbered.some((f) => f.startsWith("073_")),
    "073 exists",
  );
});

test("shape: line 1 is a comment, one transaction, nothing outside it", () => {
  assert.ok(SQL.startsWith("-- "), "line 1 starts with '-- '");
  const statements = CODE.trim();
  assert.ok(statements.startsWith("begin;"), "begin; first");
  assert.ok(statements.endsWith("commit;"), "commit; last");
  assert.equal((CODE.match(/^begin;$/gm) ?? []).length, 1);
  assert.equal((CODE.match(/^commit;$/gm) ?? []).length, 1);
});

test("shape: the three columns, their types, nullability and defaults", () => {
  const flat = CODE.replace(/\s+/g, " ");
  assert.match(
    flat,
    /add column if not exists live_interview_mode text not null default 'structured',/,
  );
  assert.match(
    flat,
    /add column if not exists live_interview_minutes smallint not null default 30,/,
  );
  assert.match(flat, /add column if not exists live_hiring_challenges text;/);
  assert.doesNotMatch(
    flat,
    /live_hiring_challenges text not null|live_hiring_challenges text default/,
  );
  // Outside quoted text: a column comment may name it to say it is not this.
  assert.doesNotMatch(
    flat.replace(/'[^']*'/g, "''"),
    /interview_duration_minutes/,
    "the Team Call column is not touched",
  );
});

test("shape: the three checks", () => {
  const flat = CODE.replace(/\s+/g, " ");
  assert.match(
    flat,
    /add constraint jobs_live_interview_mode_values check \(live_interview_mode in \('structured', 'ai_guided'\)\);/,
  );
  assert.match(
    flat,
    /add constraint jobs_live_interview_minutes_values check \(live_interview_minutes in \(30, 60\)\);/,
  );
  assert.match(
    flat,
    /add constraint jobs_live_hiring_challenges_length check \(live_hiring_challenges is null or char_length\(live_hiring_challenges\) <= 2000\);/,
  );
});

test("shape: no grant, revoke or policy change, and only public.jobs is altered", () => {
  assert.doesNotMatch(CODE, /\b(grant|revoke)\b/i);
  assert.doesNotMatch(CODE, /\bpolicy\b/i);
  assert.doesNotMatch(CODE, /row level security/i);
  const altered = [...CODE.matchAll(/alter table (\S+)/g)].map((m) => m[1]);
  assert.ok(altered.length > 0 && altered.every((t) => t === "public.jobs"), altered.join(", "));
  assert.doesNotMatch(CODE, /create table/i);
});

test("the CHECK query at the bottom is read-only and checks the grants too", () => {
  const check = SQL.slice(SQL.indexOf("-- CHECK (read-only)"));
  assert.ok(check.length > 0);
  assert.doesNotMatch(check, /\b(insert|update|delete|alter|drop|grant|revoke|truncate)\b/i);
  for (const piece of [
    "information_schema.columns",
    "pg_constraint",
    "existing_jobs_default",
    "role_table_grants",
    "column_privileges",
    "pg_policies",
  ]) {
    assert.ok(check.includes(piece), piece);
  }
});

test("types match the migration: modes, minutes, defaults and the cap", () => {
  assert.deepEqual([...types.LIVE_INTERVIEW_MODES], ["structured", "ai_guided"]);
  assert.equal(types.DEFAULT_LIVE_INTERVIEW_MODE, "structured");
  assert.deepEqual([...types.LIVE_INTERVIEW_MINUTES], [30, 60]);
  assert.equal(types.DEFAULT_LIVE_INTERVIEW_MINUTES, 30);
  assert.equal(types.LIVE_HIRING_CHALLENGES_MAX, 2000);
  assert.ok(CODE.includes(`<= ${types.LIVE_HIRING_CHALLENGES_MAX})`));
});

/* ── no path out for the hiring challenges ─────────────────────── */

function sourceFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (["node_modules", "test-support", "__fixtures__", "migrations"].includes(name)) continue;
      sourceFiles(p, out);
    } else if (/\.(ts|tsx|mjs)$/.test(name) && !/\.test\.(ts|tsx|mjs)$/.test(name)) out.push(p);
  }
  return out;
}
const FILES = sourceFiles(SRC).map((p) => ({
  rel: relative(ROOT, p),
  text: readFileSync(p, "utf8"),
}));

/**
 * The only code that may name the three columns: their types and validation,
 * the wizard's save, edit and duplicate (all recruiter-side, behind
 * requireCompanyRole and the job's hiring team), and the wizard's own step.
 * A new file naming them fails here until someone looks at what it does with
 * them. The public keep-list and VoxAgent tests below stay strict.
 */
const ALLOWED_USERS = [
  "src/app/ai-dashboard/(gated)/jobs/[id]/edit/page.tsx",
  "src/app/ai-dashboard/(gated)/jobs/actions.ts",
  "src/app/ai-dashboard/(gated)/jobs/new/_wizard-client.tsx",
  "src/app/ai-dashboard/lib/job-types.ts",
  // The invite gate reads the job's mode and length (never the challenges) to freeze them.
  "src/lib/interviews/live-settings.ts",
];

test("only the recruiter-side save, load, edit and duplicate name the three columns", () => {
  const naming = FILES.filter((f) =>
    /live_hiring_challenges|live_interview_mode|live_interview_minutes/.test(f.text),
  ).map((f) => f.rel);
  assert.deepEqual(naming.sort(), ALLOWED_USERS);
  // The invite gate reads the mode and length only: the challenges never leave the job's editors.
  const challenges = FILES.filter((f) => /live_hiring_challenges/.test(f.text)).map((f) => f.rel);
  assert.ok(!challenges.includes("src/lib/interviews/live-settings.ts"));
});

/**
 * Every query on jobs that returns whole rows: select("*") (or "*" in a
 * column list), a bare .select() (which PostgREST also answers with every
 * column, the usual tail of an insert or update), and an embedded jobs(*).
 * Each query is read up to the next .from(, so a later query's select is never
 * mistaken for this one's.
 */
function wholeRowReads(f) {
  const found = [];
  for (const m of f.text.matchAll(/from\("jobs"\)/g)) {
    const rest = f.text.slice(m.index + m[0].length, m.index + 1200);
    const next = rest.search(/\.from\(/);
    const query = next === -1 ? rest : rest.slice(0, next);
    const line = f.text.slice(0, m.index).split("\n").length;
    const sel = query.match(/\.select\(\s*(\)|(["'`])([^"'`]*)\2)/);
    if (!sel) continue;
    if (sel[1] === ")") found.push(`${f.rel}:${line} bare .select()`);
    else if (/(^|,)\s*\*\s*(,|$)/.test(sel[3])) found.push(`${f.rel}:${line} select("*")`);
  }
  if (/\bjobs(![a-z_]+)?\s*\(\s*\*/.test(f.text)) found.push(`${f.rel} embedded jobs(*)`);
  return found;
}

test('no query on jobs returns whole rows: no select("*"), no bare .select(), no jobs(*)', () => {
  assert.deepEqual(FILES.flatMap(wholeRowReads), []);
});

test("negative control: the scan sees each kind of whole-row read", () => {
  const probe = (text) => wholeRowReads({ rel: "probe.ts", text });
  assert.deepEqual(probe('db.from("jobs").select("*").eq("id", x);'), ['probe.ts:1 select("*")']);
  assert.deepEqual(probe('db.from("jobs").select("id, *");'), ['probe.ts:1 select("*")']);
  assert.deepEqual(probe('db.from("jobs")\n  .update(p)\n  .select()\n  .single();'), [
    "probe.ts:1 bare .select()",
  ]);
  assert.deepEqual(probe('db.from("job_applications").select("id, job:jobs(*)");'), [
    "probe.ts embedded jobs(*)",
  ]);
  // A column list, and a later query's bare select, are not this query's.
  assert.deepEqual(probe('db.from("jobs").select("id, title");'), []);
  assert.deepEqual(probe('db.from("jobs").update(p).eq("id", x); db.from("other").select();'), []);
});

test("VoxAgent's payload has a fixed key list with no job text, and the start path never names the challenges", () => {
  const join = FILES.find((f) => f.rel === "src/lib/interviews/live-provider/join.ts").text;
  const keys = join.match(/const INPUT_KEYS = new Set\(\[([^\]]*)\]\)/)[1];
  assert.deepEqual(
    [...keys.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]),
    [
      "remotiv_session_id",
      "interviewer_name",
      "interview_minutes",
      "max_follow_ups_per_base_question",
      "questions",
      "candidate_first_name",
      "cv_text",
    ],
  );
  for (const f of FILES.filter(
    (x) =>
      x.rel.startsWith("src/lib/interviews/live-provider/") ||
      x.rel === "src/lib/interviews/live-start.ts" ||
      x.rel.startsWith("src/app/api/interview/") ||
      x.rel.startsWith("src/app/interview/"),
  )) {
    assert.doesNotMatch(f.text, /hiring_challenges|hiringChallenges/, f.rel);
  }
});
