/**
 * Source pins for migration 061: application_scores refuses AI writes past the
 * CV's retention date (#91 item B).
 *
 *   node --test src/lib/supabase/migration-061.test.ts
 *
 * Nothing here runs the SQL. Each check is a pure function over the migration
 * text, and each is also run against a deliberately broken copy, so a check
 * that cannot fail is caught here rather than trusted. The trigger's kept
 * columns are pinned against the writers they exist for: the CV purge's
 * cleared set (cv-purge.ts), the human-override columns (cv-scoring.ts),
 * cv-recompute's one-column update. Its SQLSTATE is pinned against the one
 * writeScoreRow maps. The staging negative controls live in the header as
 * comments; their shape is pinned too.
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../test-support/fake-service-client-hook.mjs", import.meta.url));

const { CV_SCORE_WORDS_CLEARED } = await import("../cv-purge.ts");

const MIGRATIONS = new URL("migrations/", import.meta.url);
const FILE = "061_application_scores_retention_guard.sql";
const sql = readFileSync(new URL(FILE, MIGRATIONS), "utf8");
const scorer = readFileSync(new URL("../ai/cv-scoring.ts", import.meta.url), "utf8");
const recompute = readFileSync(new URL("../ai/cv-recompute.ts", import.meta.url), "utf8");

const FN = "application_scores_retention_guard";
const MESSAGE =
  "application_scores: the CV has passed its retention date; an AI scorecard cannot be written";

/** SQL without comments: a comment can neither satisfy nor trip a check. */
const code = (text) => text.replace(/--.*$/gm, "");
const squash = (s) => s.replace(/\s+/g, " ").trim();
const has = (text, snippet) => squash(text).includes(squash(snippet));
const count = (text, snippet) => squash(text).split(squash(snippet)).length - 1;

/** The function, from its create line to its closing `$$;`. */
function fnText(text) {
  const c = code(text);
  const at = c.indexOf(`create or replace function public.${FN}(`);
  if (at < 0) return "";
  const rest = c.slice(at);
  const body = rest.indexOf("$$", rest.indexOf("as $$") + 5);
  return body < 0 ? "" : rest.slice(0, body + 3);
}

/** The kept array literal's members, in order. */
function keptColumns(text) {
  const m = fnText(text).match(/kept constant text\[\] := array\[([\s\S]*?)\];/);
  return m ? [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]) : null;
}

/** The `do $$ ... $$;` invariant block. */
function invariant(text) {
  const c = code(text);
  const at = c.indexOf("do $$");
  if (at < 0) return "";
  const rest = c.slice(at);
  return rest.slice(0, rest.indexOf("$$;") + 3);
}

/** The header's negative-control block, from its begin; to its rollback;, comment markers removed. */
function controlSql(text) {
  const start = text.indexOf("-- ── Negative controls");
  const end = text.indexOf("-- ── Rollback");
  if (start < 0 || end < start) return "";
  const block = text
    .slice(start, end)
    .split("\n")
    .map((l) => l.replace(/^-- ?/, ""))
    .join("\n");
  const at = block.search(/^begin;$/m);
  const stop = block.search(/^rollback;$/m);
  return at < 0 || stop < at ? "" : block.slice(at, stop + "rollback;".length);
}

/** The human-override columns cv-scoring.ts never writes, read from its source. */
function humanColumns() {
  const m = scorer.match(/const HUMAN_OVERRIDE_COLUMNS: readonly string\[\] = \[([\s\S]*?)\];/);
  return m ? [...m[1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]) : [];
}

const WORD_COLUMNS = [
  "summary",
  "verdict",
  "evidence",
  "strengths",
  "concerns",
  "missing_requirements",
  "dimension_scores",
  "must_haves",
];

/** Every problem with a copy of the migration; empty when it is right. */
function problems(text) {
  const out = [];
  const c = code(text);
  const fn = fnText(text);

  // ── the function's shape ──
  if (!fn) out.push("no function");
  if (!has(fn, "returns trigger language plpgsql set search_path = public as $$"))
    out.push("not a plpgsql trigger function with search_path");
  if (has(fn, "security definer")) out.push("the function is security definer");

  // ── who it applies to: a company CV past its date, the purge's own test ──
  for (const [what, snippet] of [
    ["the company guard", "a.company_id_snapshot is not null"],
    ["the date guard", "a.cv_delete_after is not null and a.cv_delete_after <= now() into expired"],
    ["the parent", "from public.job_applications a where a.id = new.application_id;"],
    ["silence on a live CV", "if not coalesce(expired, false) then return new; end if;"],
  ]) {
    if (!has(fn, snippet)) out.push(`the function lost ${what}`);
  }

  // ── the refusals: INSERT always, UPDATE outside the kept set or toward words ──
  if (!has(fn, "if tg_op = 'INSERT' then raise exception using errcode = 'RT091'"))
    out.push("an INSERT on an expired CV is not refused");
  if (
    !has(
      fn,
      "if (to_jsonb(new) - kept) is distinct from (to_jsonb(old) - kept) then raise exception",
    )
  )
    out.push("an UPDATE outside the kept columns is not refused");
  for (const col of WORD_COLUMNS) {
    if (!has(fn, `new.${col} is distinct from old.${col}`)) out.push(`${col} may come back`);
  }
  for (const [col, path] of [
    ["dimension_scores", "'$.**.reasoning ? (@ != \"\")'"],
    ["dimension_scores", "'$.**.quote ? (@ != \"\")'"],
    ["must_haves", "'$.**.quote ? (@ != \"\")'"],
  ]) {
    if (!has(fn, `jsonb_path_exists(new.${col}, ${path})`))
      out.push(`${col} words are not checked`);
  }
  if (count(fn, "errcode = 'RT091'") !== 3) out.push("not exactly three RT091 refusals");
  if (count(fn, `message = '${MESSAGE}'`) !== 3) out.push("a refusal message is not the fixed one");
  if (/message = [^;]*(\|\||%|new\.|old\.)/.test(fn))
    out.push("a refusal message carries row data");

  // ── the kept set: exactly what the allowed writers touch ──
  const kept = keptColumns(text);
  const expected = ["overall_score", ...humanColumns(), ...WORD_COLUMNS, "effective_score"];
  if (!kept) out.push("no kept set");
  else {
    if ([...kept].sort().join() !== [...expected].sort().join())
      out.push(`the kept set is not exactly the allowed writers' columns: ${kept.join(",")}`);
    for (const forbidden of [
      "status",
      "confidence",
      "error",
      "ai_model",
      "prompt_version",
      "scored_at",
    ]) {
      if (kept.includes(forbidden)) out.push(`${forbidden} is kept, so a late scorer write passes`);
    }
  }

  // ── the trigger ──
  const trg = c.match(new RegExp(`create trigger ${FN}[\\s\\S]*?;`))?.[0] ?? "";
  if (
    squash(trg) !==
    squash(
      `create trigger ${FN} before insert or update on public.application_scores for each row execute function public.${FN}();`,
    )
  )
    out.push("the trigger is not BEFORE INSERT OR UPDATE, for each row, on every column");
  const dropAt = c.indexOf(`drop trigger if exists ${FN} on public.application_scores;`);
  if (dropAt < 0 || dropAt > c.indexOf(`create trigger ${FN}`))
    out.push("the trigger is not dropped before it is created");
  if (/create\s+(unique\s+)?index/i.test(c)) out.push("an index is created");

  // ── one transaction, fail fast, invariant before commit ──
  if (count(c, "begin;") !== 1 || count(c, "commit;") !== 1)
    out.push("not exactly one begin and commit");
  const lockAt = c.indexOf("set local lock_timeout = '5s';");
  const fnAt = c.indexOf(`create or replace function public.${FN}(`);
  if (lockAt < 0 || lockAt < c.indexOf("begin;") || lockAt > fnAt)
    out.push("no lock timeout before the first change");
  const invAt = c.indexOf("do $$");
  if (invAt < 0 || invAt < c.indexOf(`create trigger ${FN}`) || invAt > c.lastIndexOf("commit;"))
    out.push("the invariant is not between the trigger and the commit");
  const inv = invariant(text);
  for (const [what, snippet] of [
    ["the table", "t.tgrelid = 'public.application_scores'::regclass"],
    ["the name", `t.tgname = '${FN}'`],
    ["enabled", "t.tgenabled = 'O'"],
    ["the function", `t.tgfoid = 'public.${FN}()'::regprocedure`],
    ["BEFORE INSERT OR UPDATE FOR EACH ROW only", "t.tgtype = 23"],
    ["no column list, bound-safe", "cardinality(t.tgattr::int2[]) = 0"],
    ["no WHEN", "t.tgqual is null"],
    ["the count", "if n <> 1 then"],
    ["the search_path", "'search_path=public' = any (proconfig)"],
  ]) {
    if (!has(inv, snippet)) out.push(`the invariant does not check ${what}`);
  }
  if (count(inv, "raise exception") < 2) out.push("the invariant does not raise");

  // ── the staging negative controls ──
  const ctl = controlSql(text);
  if (!ctl) out.push("no negative-control block");
  else {
    if (/^\s*commit;/m.test(ctl)) out.push("the controls can commit");
    if (!has(ctl, "to_regclass('staging_guard.sentinel') is null"))
      out.push("the controls do not refuse off staging");
    if (
      !/raise exception 'REPORT, expected; nothing persists: %', array_to_string\(report, '; '\);\s*end;\s*\$\$;\s*rollback;$/.test(
        ctl,
      )
    )
      out.push("the controls do not always end in an error and a rollback");
    for (const m of ctl.matchAll(/update public\.(application_scores|job_applications)[^;]*;/g)) {
      if (!/where (application_)?id = v_app;$/.test(m[0]))
        out.push("an update is not by a fixture id");
    }
    if (count(ctl, "values ('rh091-fixture', v_company,") !== 2)
      out.push("not exactly two fixture applications");
    for (const label of ["C0", "C1", "C2", "C3", "C4", "C5a", "C5b", "C6", "C7", "C8"]) {
      if (!ctl.includes(`'${label} `) && !ctl.includes(`('${label} `))
        out.push(`no ${label} control`);
    }
    if (count(ctl, "exception when sqlstate 'RT091' then") !== 5)
      out.push("not every refusal control requires RT091 itself");
  }

  return out;
}

test("061 refuses AI writes on an expired CV, allows the purge, recruiters and the recompute, and asserts itself before commit", () => {
  assert.deepEqual(problems(sql), []);
});

test("the SQLSTATE the trigger raises is the one writeScoreRow maps to expired", () => {
  assert.match(scorer, /export const RETENTION_GUARD_SQLSTATE = "RT091";/);
  assert.match(
    scorer,
    /if \(error\?\.code === RETENTION_GUARD_SQLSTATE\) \{[\s\S]{0,300}return \{ error: null, expired: true \};/,
  );
});

test("the kept set covers every column the allowed writers write, and they write nothing else", () => {
  const kept = keptColumns(sql);
  for (const col of Object.keys(CV_SCORE_WORDS_CLEARED)) {
    assert.ok(kept.includes(col), `the CV purge clears ${col}`);
  }
  assert.ok(
    kept.includes("dimension_scores") && kept.includes("must_haves"),
    "the purge rewrites both",
  );
  assert.deepEqual(humanColumns().length, 5, "the five human-override columns were found");
  for (const col of humanColumns()) assert.ok(kept.includes(col), `recruiters write ${col}`);
  assert.match(
    recompute,
    /\.update\(\{ overall_score: next \}\)/,
    "cv-recompute writes overall_score alone",
  );
});

test("each check fails on a broken copy", () => {
  const broken = [
    [
      "company guard",
      sql.replace("  select a.company_id_snapshot is not null\n         and ", "  select "),
    ],
    [
      "date guard",
      sql.replace(
        "         and a.cv_delete_after <= now()\n",
        "         and a.cv_delete_after <= now() - interval '1 year'\n",
      ),
    ],
    ["insert allowed", sql.replace("  if tg_op = 'INSERT' then\n", "  if false then\n")],
    ["status kept", sql.replace("    'overall_score',\n", "    'overall_score', 'status',\n")],
    ["human column missing", sql.replace("'adjusted_by_name', ", "")],
    [
      "update unchecked",
      sql.replace(
        "if (to_jsonb(new) - kept) is distinct from (to_jsonb(old) - kept) then",
        "if false then",
      ),
    ],
    [
      "summary back",
      sql.replace(
        "(new.summary is distinct from old.summary and coalesce(new.summary, '') <> '')",
        "false",
      ),
    ],
    [
      "dimension quotes back",
      sql.replace("or jsonb_path_exists(new.dimension_scores, '$.**.quote ? (@ != \"\")')", ""),
    ],
    [
      "must-have quotes back",
      sql.replace("and jsonb_path_exists(new.must_haves, '$.**.quote ? (@ != \"\")')", "and false"),
    ],
    [
      "other sqlstate",
      sql.replace(
        "  if tg_op = 'INSERT' then\n    raise exception using\n      errcode = 'RT091',",
        "  if tg_op = 'INSERT' then\n    raise exception using\n      errcode = 'P0001',",
      ),
    ],
    [
      "message with data",
      sql.replace(
        "  if tg_op = 'INSERT' then\n    raise exception using\n      errcode = 'RT091',\n      message = 'application_scores: the CV has passed its retention date; an AI scorecard cannot be written';",
        "  if tg_op = 'INSERT' then\n    raise exception using\n      errcode = 'RT091',\n      message = 'application_scores: refused for ' || new.application_id;",
      ),
    ],
    [
      "definer",
      sql.replace(
        "set search_path = public\nas $$",
        "security definer\nset search_path = public\nas $$",
      ),
    ],
    [
      "after trigger",
      sql.replace(
        "  before insert or update on public.application_scores",
        "  after insert or update on public.application_scores",
      ),
    ],
    [
      "insert only",
      sql.replace(
        "  before insert or update on public.application_scores",
        "  before insert on public.application_scores",
      ),
    ],
    ["drop first", sql.replace(`drop trigger if exists ${FN} on public.application_scores;\n`, "")],
    ["lock timeout", sql.replace("set local lock_timeout = '5s';\n\n-- ── 1.", "\n-- ── 1.")],
    ["tgtype", sql.replace("     and t.tgtype = 23\n", "")],
    [
      "tgattr as an array",
      sql.replace(
        "     and cardinality(t.tgattr::int2[]) = 0\n",
        "     and t.tgattr::int2[] = '{}'\n",
      ),
    ],
    ["proconfig", sql.replace("     and 'search_path=public' = any (proconfig);", ";")],
    [
      "controls commit",
      sql.replace("-- $$;\n-- rollback;\n--\n-- Expected:", "-- $$;\n-- commit;\n--\n-- Expected:"),
    ],
    [
      "controls off staging",
      sql.replace(
        "--   if to_regclass('staging_guard.sentinel') is null then",
        "--   if false then",
      ),
    ],
    [
      "refusal on any error",
      sql.replace(
        "--   exception when sqlstate 'RT091' then\n--     report := report || 'C3",
        "--   exception when others then\n--     report := report || 'C3",
      ),
    ],
    [
      "existing row touched",
      sql.replace(
        "--     update public.application_scores set overall_score = 71 where application_id = v_app;",
        "--     update public.application_scores set overall_score = 71 where status = 'scored';",
      ),
    ],
    [
      "always raise",
      sql.replace(
        "--   raise exception 'REPORT, expected; nothing persists: %'",
        "--   raise notice 'REPORT, expected; nothing persists: %'",
      ),
    ],
  ];
  for (const [name, copy] of broken) {
    assert.notEqual(copy, sql, `${name}: the broken copy changed nothing`);
    assert.ok(problems(copy).length > 0, `${name}: not caught`);
  }
});

test("061 is the only 061, after 060", () => {
  const files = readdirSync(MIGRATIONS);
  assert.deepEqual(
    files.filter((f) => f.startsWith("061_")),
    [FILE],
  );
  assert.ok(files.includes("060_interview_sessions_kind_immutable.sql"));
});
