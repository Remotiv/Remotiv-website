/**
 * Source pins for migration 060: interview_sessions.kind is immutable (#103).
 *
 *   node --test src/lib/supabase/migration-060.test.ts
 *
 * Nothing here runs the SQL. Each check is a pure function over the migration
 * text, and each is also run against a deliberately broken copy, so a check
 * that cannot fail is caught here rather than trusted. The function body and
 * the trigger are pinned against 017's own text, so 060 cannot drift from the
 * rule it restores. The staging negative controls live in 060's header as
 * comments; their shape is pinned too, because they are what proves the
 * trigger (not a CHECK) refuses the change.
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

const MIGRATIONS = new URL("migrations/", import.meta.url);
const FILE = "060_interview_sessions_kind_immutable.sql";
const sql = readFileSync(new URL(FILE, MIGRATIONS), "utf8");
const sql017 = readFileSync(new URL("017_interview_session_kind.sql", MIGRATIONS), "utf8");

const FN = "interview_sessions_kind_immutable";
const MESSAGE_PREFIX = "interview_sessions.kind is set at invite and cannot be changed";

/** SQL without comments: a comment can neither satisfy nor trip a check. */
const code = (text) => text.replace(/--.*$/gm, "");
const squash = (s) => s.replace(/\s+/g, " ").trim();
const has = (text, snippet) => squash(text).includes(squash(snippet));
const count = (text, snippet) => squash(text).split(squash(snippet)).length - 1;

/** The function's header, from its create line to `as $$`. */
function fnHeader(text) {
  const c = code(text);
  const at = c.indexOf(`create or replace function public.${FN}(`);
  if (at < 0) return "";
  const rest = c.slice(at);
  return rest.slice(0, rest.indexOf("$$") + 2);
}

/** The function's dollar-quoted body. */
function fnBody(text) {
  const c = code(text);
  const at = c.indexOf(`create or replace function public.${FN}(`);
  if (at < 0) return "";
  const m = c.slice(at).match(/\$\$([\s\S]*?)\$\$;/);
  return m ? m[1] : "";
}

/** The create trigger statement. */
function triggerStmt(text) {
  const m = code(text).match(new RegExp(`create trigger ${FN}[\\s\\S]*?;`));
  return m ? m[0] : "";
}

/** The `do $$ ... $$;` invariant block. */
function invariant(text) {
  const c = code(text);
  const at = c.indexOf("do $$");
  if (at < 0) return "";
  const rest = c.slice(at);
  return rest.slice(0, rest.indexOf("$$;") + 3);
}

/** The header's negative-control block, comment markers removed. */
function controls(text) {
  const start = text.indexOf("-- ── Negative controls");
  const end = text.indexOf("-- ── Rollback");
  if (start < 0 || end < start) return "";
  return text
    .slice(start, end)
    .split("\n")
    .map((l) => l.replace(/^-- ?/, ""))
    .join("\n");
}

/** The runnable part of the control block: from its begin; to its rollback;. */
function controlSql(text) {
  const block = controls(text);
  const at = block.search(/^begin;$/m);
  const end = block.search(/^rollback;$/m);
  if (at < 0 || end < at) return "";
  return block.slice(at, end + "rollback;".length);
}

/** One control's sub-block, from its comment to the next control's. */
function control(text, label) {
  const c = controlSql(text);
  const at = c.indexOf(`-- ${label}`);
  if (at < 0) return "";
  const next = c.slice(at + 3).search(/-- C\d|-- Always raise/);
  return next < 0 ? c.slice(at) : c.slice(at, at + 3 + next);
}

/** Every problem with a copy of the migration; empty when it is right. */
function problems(text) {
  const out = [];
  const c = code(text);

  // ── the function: 017's body, with search_path ──
  const body = fnBody(text);
  if (!body) out.push("no function");
  else if (squash(body) !== squash(fnBody(sql017)))
    out.push("the function body differs from 017's");
  if (!body.includes(MESSAGE_PREFIX)) out.push("the refusal message is not 017's");
  if (!has(body, "using errcode = 'check_violation'"))
    out.push("the refusal is not check_violation");
  const header = fnHeader(text);
  if (!has(header, "returns trigger language plpgsql")) out.push("not a plpgsql trigger function");
  if (!has(header, "set search_path = public")) out.push("no search_path on the function");
  if (has(header, "security definer")) out.push("the function is security definer");

  // ── the trigger: 017's, dropped first ──
  const trg = triggerStmt(text);
  if (!trg) out.push("no trigger");
  else if (squash(trg) !== squash(triggerStmt(sql017))) out.push("the trigger differs from 017's");
  const dropAt = c.indexOf(`drop trigger if exists ${FN} on public.interview_sessions;`);
  if (dropAt < 0 || dropAt > c.indexOf(`create trigger ${FN}`))
    out.push("the trigger is not dropped before it is created");

  // ── no index: the equivalent one already exists ──
  if (/create\s+(unique\s+)?index/i.test(c)) out.push("an index is created");
  if (c.includes("idx_is_application_kind")) out.push("017's index name appears in the SQL");

  // ── one transaction, fail fast, invariant before commit ──
  if (count(c, "begin;") !== 1 || count(c, "commit;") !== 1)
    out.push("not exactly one begin and commit");
  const beginAt = c.indexOf("begin;");
  const lockAt = c.indexOf("set local lock_timeout = '5s';");
  const fnAt = c.indexOf(`create or replace function public.${FN}(`);
  const invAt = c.indexOf("do $$");
  const commitAt = c.lastIndexOf("commit;");
  if (lockAt < 0 || lockAt < beginAt || lockAt > fnAt)
    out.push("no lock timeout before the first change");
  if (invAt < 0 || invAt < c.indexOf(`create trigger ${FN}`) || invAt > commitAt)
    out.push("the invariant is not between the trigger and the commit");
  const inv = invariant(text);
  for (const [what, snippet] of [
    ["the table", "t.tgrelid = 'public.interview_sessions'::regclass"],
    ["the name", `t.tgname = '${FN}'`],
    ["enabled", "t.tgenabled = 'O'"],
    ["the function", `t.tgfoid = 'public.${FN}()'::regprocedure`],
    ["BEFORE UPDATE FOR EACH ROW only", "t.tgtype = 19"],
    ["OF kind only", "t.tgattr::text = kind_attnum::text"],
    ["no WHEN", "t.tgqual is null"],
    ["the count", "if n <> 1 then"],
    ["the search_path", "'search_path=public' = any (proconfig)"],
  ]) {
    if (!has(inv, snippet)) out.push(`the invariant does not check ${what}`);
  }
  if (count(inv, "raise exception") < 2) out.push("the invariant does not raise");

  // ── the staging negative controls, in the header ──
  const ctl = controlSql(text);
  if (!ctl) out.push("no negative-control block");
  else {
    if (/^\s*commit;/m.test(ctl)) out.push("the controls can commit");
    if (!has(ctl, "to_regclass('staging_guard.sentinel') is null"))
      out.push("the controls do not refuse off staging");
    if (!has(ctl, `expected_prefix constant text := '${MESSAGE_PREFIX}'`))
      out.push("the controls do not expect the trigger's own message");
    if (
      !/raise exception 'REPORT, expected; nothing persists: %', array_to_string\(report, '; '\);\s*end;\s*\$\$;\s*rollback;$/.test(
        ctl,
      )
    )
      out.push("the controls do not always end in an error and a rollback");
    for (const m of ctl.matchAll(/update public\.interview_sessions[^;]*;/g)) {
      if (!/where id = v_(async|live);$/.test(m[0])) out.push("an update is not by a fixture id");
    }
    if (count(ctl, "insert into public.interview_sessions") !== 2)
      out.push("not exactly two fixtures");
    if (count(ctl, "'rh103-") !== 2) out.push("a fixture token is not marked rh103-");

    const c0 = control(text, "C0");
    if (!has(c0, `disable trigger ${FN}`)) out.push("C0 does not disable the trigger");
    if (!has(c0, "errcode = 'P0103'")) out.push("C0 does not undo itself");
    if (count(ctl, "disable trigger") !== 1 || ctl.includes("enable trigger"))
      out.push("the trigger is disabled outside C0");
    const c1 = control(text, "C1");
    if (!has(c1, "set kind = 'live', live_settings = '{}'::jsonb where id = v_async"))
      out.push("C1 does not make async -> live valid for the CHECKs");
    const c2 = control(text, "C2");
    if (!has(c2, "set kind = 'async', live_settings = null where id = v_live"))
      out.push("C2 does not make live -> async valid for the CHECKs");
    for (const [label, ctlText] of [
      ["C1", c1],
      ["C2", c2],
    ]) {
      if (!has(ctlText, "msg like expected_prefix || '%' and coalesce(cname, '') = ''"))
        out.push(`${label} passes on the SQLSTATE alone`);
    }
    if (!has(control(text, "C3"), "set kind = 'async' where id = v_async"))
      out.push("no same-value control");
    if (
      !has(
        control(text, "C4"),
        "set expires_at = expires_at + interval '1 hour' where id = v_async",
      )
    )
      out.push("no ordinary-update control");
    if (
      !has(
        control(text, "C5"),
        "(id = v_async and kind = 'async') or (id = v_live and kind = 'live')",
      )
    )
      out.push("no kept-kind control");
  }

  return out;
}

test("060 restores 017's trigger and function, with search_path, no index, and asserts them before commit", () => {
  assert.deepEqual(problems(sql), []);
});

test("each check fails on a broken copy", () => {
  const broken = [
    ["body", sql.replace("if new.kind is distinct from old.kind then", "if false then")],
    [
      "message",
      sql.replace(
        "'interview_sessions.kind is set at invite and cannot be changed (session %",
        "'kind cannot change (session %",
      ),
    ],
    [
      "errcode",
      sql.replace(
        "      using errcode = 'check_violation';\n  end if;\n  return new;",
        "      using errcode = 'raise_exception';\n  end if;\n  return new;",
      ),
    ],
    [
      "search_path",
      sql.replace("language plpgsql\nset search_path = public\nas $$", "language plpgsql\nas $$"),
    ],
    [
      "definer",
      sql.replace(
        "set search_path = public\nas $$",
        "security definer\nset search_path = public\nas $$",
      ),
    ],
    [
      "timing",
      sql.replace(
        "  before update of kind on public.interview_sessions",
        "  after update of kind on public.interview_sessions",
      ),
    ],
    [
      "column",
      sql.replace(
        "  before update of kind on public.interview_sessions",
        "  before update on public.interview_sessions",
      ),
    ],
    [
      "per row",
      sql.replace("  for each row\n  execute function", "  for each statement\n  execute function"),
    ],
    [
      "drop first",
      sql.replace(
        "drop trigger if exists interview_sessions_kind_immutable on public.interview_sessions;\n",
        "",
      ),
    ],
    [
      "index",
      sql.replace(
        "-- ── 3. THE INVARIANT",
        "create index if not exists idx_is_application_kind\n  on public.interview_sessions (application_id, kind, created_at desc);\n\n-- ── 3. THE INVARIANT",
      ),
    ],
    ["lock timeout", sql.replace("set local lock_timeout = '5s';\n\n-- ── 1.", "\n-- ── 1.")],
    [
      "invariant after commit",
      sql
        .replace("\ncommit;\n\n-- ── After running", "\n-- ── After running")
        .replace(
          "-- ── 3. THE INVARIANT, asserted before commit",
          "commit;\n-- ── 3. THE INVARIANT, asserted before commit",
        ),
    ],
    ["enabled", sql.replace("     and t.tgenabled = 'O'\n", "")],
    ["tgtype", sql.replace("     and t.tgtype = 19\n", "")],
    ["tgattr", sql.replace("     and t.tgattr::text = kind_attnum::text\n", "")],
    [
      "tgattr as a 1-based array",
      sql.replace(
        "     and t.tgattr::text = kind_attnum::text\n",
        "     and t.tgattr::int2[] = array[kind_attnum]\n",
      ),
    ],
    ["tgqual", sql.replace("     and t.tgqual is null;", ";")],
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
      "C1 premise",
      sql.replace(
        "--     update public.interview_sessions set kind = 'live', live_settings = '{}'::jsonb where id = v_async;\n--     report := report || 'C1",
        "--     update public.interview_sessions set kind = 'live' where id = v_async;\n--     report := report || 'C1",
      ),
    ],
    [
      "C2 premise",
      sql.replace(
        "--     update public.interview_sessions set kind = 'async', live_settings = null where id = v_live;\n--     report := report || 'C2",
        "--     update public.interview_sessions set kind = 'async' where id = v_live;\n--     report := report || 'C2",
      ),
    ],
    [
      "C1 SQLSTATE only",
      sql
        .replace(
          "then 'C1 async->live refused by the trigger: PASS'",
          "then 'C1 async->live refused by the trigger: PASS' when true then 'C1 async->live refused by the trigger: PASS'",
        )
        .replace(
          "--     report := report || (case when msg like expected_prefix || '%' and coalesce(cname, '') = ''\n--                               then 'C1",
          "--     report := report || (case when true\n--                               then 'C1",
        ),
    ],
    [
      "existing session",
      sql.replace(
        "--     update public.interview_sessions set expires_at = expires_at + interval '1 hour' where id = v_async;",
        "--     update public.interview_sessions set expires_at = expires_at + interval '1 hour' where kind = 'async';",
      ),
    ],
    [
      "C0 disable",
      sql.replace(
        "--     alter table public.interview_sessions disable trigger interview_sessions_kind_immutable;\n",
        "",
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

test("060 is the only 060, after 058", () => {
  const files = readdirSync(MIGRATIONS);
  assert.deepEqual(
    files.filter((f) => f.startsWith("060_")),
    [FILE],
  );
  assert.ok(files.includes("058_communication_logs_attempt_clock.sql"));
});
