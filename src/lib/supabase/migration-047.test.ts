/**
 * Source pins for migration 047: access-record retention (24 months) on
 * admin_access_logs and signed_url_logs.
 *
 *   node --test src/lib/supabase/migration-047.test.ts
 *
 * WHAT THIS DOES NOT PROVE. Nothing here runs the SQL; the PGlite run that
 * does is reported with the change. These pins cover what PGlite cannot tell
 * apart, chiefly the begin/commit wrap (a multi-statement script runs as one
 * implicit transaction there either way). Each check is a pure function over
 * the SQL text and is also run against a deliberately broken copy.
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

const MIGRATIONS = new URL("migrations/", import.meta.url);
const FILE = "047_access_log_retention.sql";
const sql = readFileSync(new URL(FILE, MIGRATIONS), "utf8");

/** SQL without comments: a comment can neither satisfy nor trip a check. */
const code = (text) => text.replace(/--.*$/gm, "");

/** The body of one function, from its create line to the closing `$$;`. */
function fnBody(text, name) {
  const body = code(text);
  const start = body.indexOf(`create or replace function public.${name}(`);
  if (start < 0) return "";
  const close = body.indexOf("\n$$;", start);
  return close < 0 ? "" : body.slice(start, close);
}

/** Every problem with a copy of the migration; empty when it is right. */
function problems(text) {
  const out = [];
  const body = code(text).trim();
  // All or nothing: the first statement opens the transaction, the last closes it.
  if (!body.startsWith("begin;")) out.push("not opened with begin;");
  if (!body.endsWith("commit;")) out.push("not closed with commit;");
  if (
    (body.match(/^begin;$/gm) ?? []).length !== 1 ||
    (body.match(/^commit;$/gm) ?? []).length !== 1
  )
    out.push("not exactly one begin and one commit");

  const purge = fnBody(text, "purge_expired_access_logs");
  if (
    !/^create or replace function public\.purge_expired_access_logs\(p_limit integer default 1000\)/.test(
      purge,
    )
  )
    out.push("the purge takes something other than a batch size");
  if (!/\nsecurity definer\nset search_path = public, pg_temp\n/.test(purge))
    out.push("purge not SECURITY DEFINER with a pinned search_path");
  if ((purge.match(/< now\(\) - interval '24 months'/g) ?? []).length !== 2)
    out.push("purge age is not now() minus 24 months on both tables");
  if (!/least\(greatest\(coalesce\(p_limit, 1000\), 1\), 5000\)/.test(purge))
    out.push("batch size not clamped");

  const guard = fnBody(text, "access_log_delete_allowed");
  if (!/current_setting\('remotiv\.access_log_purge', true\)/.test(guard))
    out.push("guard ignores the purge flag");
  if (!/current_user = v_owner/.test(guard)) out.push("guard does not require the purge's owner");
  if (!/p_stamped_at < now\(\) - interval '24 months'/.test(guard))
    out.push("guard does not check the row's age");
  if (/security definer/.test(guard)) out.push("guard must run as the deleting role");

  // The only intervals anywhere are 24 months.
  const intervals = [...code(text).matchAll(/interval '([^']+)'/g)].map((m) => m[1]);
  if (intervals.length === 0 || intervals.some((i) => i !== "24 months"))
    out.push(`intervals: ${intervals}`);

  if (
    !code(text).includes(
      "revoke all on function public.purge_expired_access_logs(integer) from public, anon, authenticated;",
    )
  )
    out.push("purge not revoked from public, anon and authenticated");
  if (
    !code(text).includes(
      "grant execute on function public.purge_expired_access_logs(integer) to service_role;",
    )
  )
    out.push("purge not granted to service_role");
  if (
    /grant[^;]*purge_expired_access_logs[^;]*\b(anon|authenticated|public)\b/.test(
      code(text).replace(/revoke[^;]*;/g, ""),
    )
  )
    out.push("purge granted to an API role");

  for (const t of ["no_update", "no_delete", "no_truncate", "stamp"]) {
    if (
      !code(text).includes(`drop trigger if exists signed_url_logs_${t} on public.signed_url_logs;`)
    )
      out.push(`signed_url_logs_${t} not created re-runnably`);
  }
  if (!/new\.granted_at := now\(\);/.test(fnBody(text, "signed_url_logs_stamp")))
    out.push("signed_url_logs not stamped");
  if (!/confrelid = 'auth\.users'::regclass/.test(code(text)))
    out.push("the cascade foreign key is not dropped");
  // The statement that writes the new constraint, not the re-run's comparison.
  if (
    !/string_agg\(quote_literal\(x\), ', '\) from unnest\(v_types \|\| array\['access_log_purge'\]\) as x\)/.test(
      code(text),
    )
  )
    out.push("the twentieth job type is not added");
  // A re-run verifies the exact approved twenty, and never skips silently.
  if (
    !/if 'access_log_purge' = any\(v_have\) then\n[^\n]*\n\s+select array_agg\(x order by x\) into v_want from unnest\(v_types \|\| array\['access_log_purge'\]\) as x;\n\s+if v_have is distinct from v_want then\n\s+raise exception/.test(
      code(text),
    )
  )
    out.push("a re-run does not verify exactly the approved twenty");
  if (/already allows access_log_purge; skipping/.test(code(text)))
    out.push("a re-run skips silently");
  return out;
}

test("047 is one transaction; the purge takes only a batch size; age is only now() minus 24 months", () => {
  assert.deepEqual(problems(sql), []);
});

test("each check fails on a broken copy", () => {
  const broken = [
    ["no begin", sql.replace("\nbegin;\n", "\n")],
    ["no commit", sql.replace("\ncommit;\n", "\n")],
    [
      "a cutoff parameter",
      sql.replace(
        "purge_expired_access_logs(p_limit integer default 1000)",
        "purge_expired_access_logs(p_limit integer default 1000, p_cutoff timestamptz default now())",
      ),
    ],
    [
      "not security definer",
      sql.replace(
        "\nsecurity definer\nset search_path = public, pg_temp\n",
        "\nset search_path = public, pg_temp\n",
      ),
    ],
    ["24 days", sql.split("interval '24 months'").join("interval '24 days'")],
    ["no flag check", sql.replace("current_setting('remotiv.access_log_purge', true)", "'on'")],
    ["no owner check", sql.replace("     and current_user = v_owner\n", "\n")],
    [
      "no age check in the guard",
      sql.replace("     and p_stamped_at < now() - interval '24 months';", "     ;"),
    ],
    [
      "granted to authenticated",
      sql.replace(
        "to service_role;\nrevoke all on function public.access_log_delete_allowed",
        "to service_role, authenticated;\nrevoke all on function public.access_log_delete_allowed",
      ),
    ],
    [
      "anon not revoked",
      sql.replace(
        "(integer) from public, anon, authenticated;",
        "(integer) from public, authenticated;",
      ),
    ],
    [
      "a trigger not re-runnable",
      sql.replace(
        "drop trigger if exists signed_url_logs_no_truncate on public.signed_url_logs;\n",
        "",
      ),
    ],
    ["no stamp", sql.replace("  new.granted_at := now();\n", "")],
    [
      "no twentieth type",
      sql.replace(
        "string_agg(quote_literal(x), ', ') from unnest(v_types || array['access_log_purge']) as x)",
        "string_agg(quote_literal(x), ', ') from unnest(v_types) as x)",
      ),
    ],
    [
      "re-run checks only for missing types",
      sql.replace(
        "    if v_have is distinct from v_want then",
        "    if not (v_want <@ v_have) then",
      ),
    ],
    [
      "re-run skips silently",
      sql.replace(
        "    raise notice '047: background_jobs_type_check is exactly the approved twenty; nothing to change.';",
        "    raise notice '047: background_jobs_type_check already allows access_log_purge; skipping.';",
      ),
    ],
  ];
  for (const [label, copy] of broken) {
    assert.notEqual(copy, sql, `${label}: the copy differs`);
    assert.ok(problems(copy).length > 0, label);
  }
});

test("numbered 047, between 046 and 048, alone", () => {
  const files = readdirSync(MIGRATIONS);
  assert.deepEqual(
    files.filter((f) => f.startsWith("047_")),
    [FILE],
  );
  assert.ok(
    files.includes("046_admin_access_logs.sql") && files.includes("048_live_repeat_check.sql"),
  );
});
