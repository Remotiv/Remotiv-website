/**
 * Source pins for migration 056: the orphan sweep (#72).
 *
 *   node --test src/lib/supabase/migration-056.test.ts
 *
 * Nothing here runs the SQL. Each check is a pure function over the
 * migration text, and each is also run against a deliberately broken copy,
 * so a check that cannot fail is caught here rather than trusted. Two checks
 * reach into TypeScript: the SQL type list must equal
 * SWEEPABLE_NOTIFICATION_TYPES and the SQL placeholder must equal
 * ERASED_ADDRESS, so neither constant can drift from its twin.
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../test-support/fake-service-client-hook.mjs", import.meta.url));

const { SWEEPABLE_NOTIFICATION_TYPES } = await import("../notifications/company.ts");
const { ERASED_ADDRESS } = await import("../email/candidate/types.ts");

const MIGRATIONS = new URL("migrations/", import.meta.url);
const FILE = "056_candidate_erasure_sweep.sql";
const sql = readFileSync(new URL(FILE, MIGRATIONS), "utf8");

const ONE_TIME_OP = "7b2c9b8e-0056-4a6e-9f01-202611060000";
const ONE_TIME_PREDICATE = "orphaned_at is null and created_at < '2026-10-01'";

/** SQL without comments: a comment can neither satisfy nor trip a check. */
const code = (text) => text.replace(/--.*$/gm, "");
const squash = (s) => s.replace(/\s+/g, " ");
const has = (text, snippet) => squash(text).includes(squash(snippet));
const count = (text, snippet) => squash(text).split(squash(snippet)).length - 1;

/** One function's body, from its create line to its closing `$$;`. */
function fn(text, name) {
  const body = code(text);
  const at = body.indexOf(`create or replace function public.${name}(`);
  if (at < 0) return "";
  const rest = body.slice(at);
  return rest.slice(0, rest.indexOf("$$;") + 3);
}

/** The `do $$ ... $$;` block. */
function doBlock(text) {
  const body = code(text);
  const at = body.indexOf("do $$");
  if (at < 0) return "";
  const rest = body.slice(at);
  return rest.slice(0, rest.indexOf("$$;") + 3);
}

/** The string literals of the first `array[...]` in a text. */
function sqlArray(text) {
  const m = squash(text).match(/array\[([^\]]*)\]/);
  if (!m) return null;
  return [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1]);
}

/** Every problem with a copy of the migration; empty when it is right. */
function problems(text) {
  const out = [];
  const c = code(text);

  // ── the two constants, one home each, equal to their TypeScript twins ──
  const types = sqlArray(fn(text, "sweepable_notification_types"));
  if (!types) out.push("no SQL type list");
  else if (JSON.stringify(types) !== JSON.stringify([...SWEEPABLE_NOTIFICATION_TYPES]))
    out.push("the SQL type list differs from SWEEPABLE_NOTIFICATION_TYPES");
  if (count(c, "array['score_ready'") !== 1) out.push("the type list does not appear exactly once");
  if (c.includes("'applicant_deleted'")) out.push("applicant_deleted is in the SQL");
  if (!has(fn(text, "erased_address"), `select '${ERASED_ADDRESS}'`))
    out.push("the SQL placeholder differs from ERASED_ADDRESS");
  if (count(c, `'${ERASED_ADDRESS}'`) !== 1)
    out.push("the placeholder literal does not appear exactly once");
  for (const name of ["preview_orphaned_message_rows", "erase_orphaned_message_rows"]) {
    const body = fn(text, name);
    if (!has(body, "public.erased_address()")) out.push(`${name} does not use erased_address()`);
    if (!has(body, "public.sweepable_notification_types()"))
      out.push(`${name} does not use sweepable_notification_types()`);
  }
  const once = doBlock(text);
  if (!has(once, "public.erased_address()") || !has(once, "public.sweepable_notification_types()"))
    out.push("the one-time block does not use the constants");

  // ── the preview writes nothing ──
  if (/\b(insert|update|delete)\b/i.test(fn(text, "preview_orphaned_message_rows")))
    out.push("the preview writes");

  // ── the sweep: window refused, operation id first, real counts ──
  const sweep = fn(text, "erase_orphaned_message_rows");
  const windowAt = sweep.indexOf("interval '30 days'");
  const lookupAt = sweep.indexOf("where operation_id = p_operation_id");
  const workAt = sweep.indexOf("update public.communication_logs");
  if (windowAt < 0 || !has(sweep.slice(windowAt, windowAt + 400), "raise exception"))
    out.push("the sweep does not refuse a cutoff inside the window");
  if (!(windowAt >= 0 && lookupAt > windowAt && workAt > lookupAt))
    out.push("the sweep does not check the window, then the operation id, then work");
  if (!has(sweep, "if found then return done; end if;"))
    out.push("a committed operation is not answered from its record");
  if (
    !has(sweep, "get diagnostics n_logs = row_count") ||
    !has(sweep, "get diagnostics n_bells = row_count")
  )
    out.push("the sweep's counts do not come from the statements");
  if (
    !has(
      sweep,
      "values (p_operation_id, p_performed_by, 'sweep', done, public.sweep_not_covered())",
    )
  )
    out.push("the sweep's audit row does not carry the real counts");
  if (count(sweep, "orphaned_at is not null and orphaned_at < p_orphaned_before") !== 2)
    out.push("the sweep does not key both statements on orphaned_at");
  if (
    count(
      fn(text, "preview_orphaned_message_rows"),
      "orphaned_at is not null and orphaned_at < p_orphaned_before",
    ) !== 2
  )
    out.push("the preview does not key both counts on orphaned_at");
  if (/'communication_logs',\s*86|'notifications_company',\s*29/.test(c))
    out.push("an audit row carries the expected counts instead of the real ones");

  // ── the record ──
  if (!has(c, "operation_id uuid not null unique")) out.push("operation_id is not unique");
  if (!has(c, "alter table public.candidate_erasures enable row level security;"))
    out.push("RLS is off");
  if (!has(c, "revoke all on table public.candidate_erasures from public, anon, authenticated;"))
    out.push("anon or authenticated keep rights on the record");
  if (/grant\s+[^;]*\bto\s+[^;]*\b(anon|authenticated|public)\b/i.test(c))
    out.push("something is granted to anon, authenticated or public");

  // ── orphaned_at: stamped by the FK's update, on both tables, BEFORE the one-time block ──
  if (
    !has(
      fn(text, "stamp_orphaned_at"),
      "if old.application_id is not null and new.application_id is null then",
    )
  )
    out.push("the stamp fires on the wrong change");
  for (const table of ["communication_logs", "notifications_company"]) {
    if (!has(c, `before update of application_id on public.${table}`))
      out.push(`${table} has no orphaned_at trigger`);
  }
  if (!(c.indexOf("create trigger communication_logs_orphaned_at") < c.indexOf("do $$")))
    out.push("the one-time block runs before the trigger exists");

  // ── the one-time block ──
  if (count(c, ONE_TIME_PREDICATE) !== 2)
    out.push("the one-time predicate is not on exactly both statements");
  if (!has(once, `'${ONE_TIME_OP}'`)) out.push("the one-time operation id is not a fixed literal");
  if (!has(once, "if exists (select 1 from public.candidate_erasures where operation_id = op)"))
    out.push("a second run is not refused up front");
  if (!has(once, "if performed_by = '00000000-0000-0000-0000-000000000000' then"))
    out.push("the sentinel performed_by is accepted");
  if (!has(once, "if n_logs <> 86 or n_bells <> 29 then"))
    out.push("the expected counts are not enforced");
  if (
    !has(once, "jsonb_build_object('communication_logs', n_logs, 'notifications_company', n_bells)")
  )
    out.push("the one-time audit row does not carry the real counts");
  if (
    !has(once, "get diagnostics n_logs = row_count") ||
    !has(once, "get diagnostics n_bells = row_count")
  )
    out.push("the one-time counts do not come from the statements");

  // ── what the comments promise ──
  if (!text.includes("ONE DATE SERVES BOTH TABLES"))
    out.push("the shared date is no longer explained");
  if (!text.includes("expected 86") || !text.includes("expected 29"))
    out.push("the measured expectations are gone");
  return out;
}

test("056 stamps orphans, previews read-only, sweeps inside a refused window by operation id, and clears the measured backlog once", () => {
  assert.deepEqual(problems(sql), []);
});

test("each check fails on a broken copy", () => {
  const broken = [
    ["type list", sql.replace("'interview_expired']", "'interview_expired', 'message_failed']")],
    [
      "list twice",
      sql.replace(
        "select array['whatsapp_inbound'",
        "select array['score_ready']; select array['whatsapp_inbound'",
      ),
    ],
    [
      "applicant_deleted",
      sql.replace("'interview_expired']", "'interview_expired', 'applicant_deleted']"),
    ],
    ["placeholder", sql.replace("select '[erased]'", "select '[removed]'")],
    [
      "placeholder twice",
      sql.replace(
        "to_address <> public.erased_address();\n  get diagnostics n_logs",
        "to_address <> '[erased]';\n  get diagnostics n_logs",
      ),
    ],
    [
      "preview constant",
      sql.replace("and to_address <> public.erased_address()),", "and to_address <> '[gone]'),"),
    ],
    [
      "preview writes",
      sql.replace(
        "stable\nset search_path = public\nas $$\n  select jsonb_build_object(",
        "stable\nset search_path = public\nas $$\n  delete from public.communication_logs; select jsonb_build_object(",
      ),
    ],
    [
      "window",
      sql.replace(
        "  if p_orphaned_before > now() - interval '30 days' then\n    raise exception",
        "  if false then\n    raise exception",
      ),
    ],
    [
      "order",
      sql.replace(
        "  select cleared into done from public.candidate_erasures where operation_id = p_operation_id;\n  if found then\n    return done;\n  end if;\n\n  update public.communication_logs",
        "  update public.communication_logs",
      ),
    ],
    [
      "real counts",
      sql.replace(
        "values (p_operation_id, p_performed_by, 'sweep', done, public.sweep_not_covered());",
        "values (p_operation_id, p_performed_by, 'sweep', jsonb_build_object('communication_logs', 86, 'notifications_company', 29), public.sweep_not_covered());",
      ),
    ],
    [
      "orphaned_at key",
      sql.replace(
        "     and orphaned_at is not null and orphaned_at < p_orphaned_before\n     and to_address",
        "     and created_at < p_orphaned_before\n     and to_address",
      ),
    ],
    ["unique", sql.replace("operation_id  uuid not null unique,", "operation_id  uuid not null,")],
    ["rls", sql.replace("alter table public.candidate_erasures enable row level security;", "")],
    [
      "grant",
      sql.replace(
        "grant select, insert on table public.candidate_erasures to service_role;",
        "grant select, insert on table public.candidate_erasures to service_role, authenticated;",
      ),
    ],
    [
      "stamp",
      sql.replace(
        "if old.application_id is not null and new.application_id is null then",
        "if new.application_id is null then",
      ),
    ],
    [
      "one trigger",
      sql.replace(
        "create trigger notifications_company_orphaned_at\n  before update of application_id",
        "create trigger notifications_company_orphaned_at\n  after update of application_id",
      ),
    ],
    [
      "trigger after block",
      sql
        .replace(
          "create trigger communication_logs_orphaned_at\n  before update of application_id on public.communication_logs\n  for each row execute function public.stamp_orphaned_at();\n",
          "",
        )
        .replace(
          "commit;\n\n-- ── After running",
          "create trigger communication_logs_orphaned_at\n  before update of application_id on public.communication_logs\n  for each row execute function public.stamp_orphaned_at();\ncommit;\n\n-- ── After running",
        ),
    ],
    [
      "one-time predicate",
      sql.replace(
        "     and orphaned_at is null and created_at < '2026-10-01'\n     and to_address",
        "     and created_at < '2026-10-01'\n     and to_address",
      ),
    ],
    [
      "fixed op",
      sql.replace(
        `op           constant uuid := '${ONE_TIME_OP}';`,
        "op           constant uuid := gen_random_uuid();",
      ),
    ],
    [
      "refused up front",
      sql.replace(
        "  if exists (select 1 from public.candidate_erasures where operation_id = op) then",
        "  if false then",
      ),
    ],
    [
      "sentinel",
      sql.replace(
        "  if performed_by = '00000000-0000-0000-0000-000000000000' then",
        "  if false then",
      ),
    ],
    ["expected", sql.replace("  if n_logs <> 86 or n_bells <> 29 then", "  if false then")],
    [
      "one-time real counts",
      sql.replace(
        "          jsonb_build_object('communication_logs', n_logs, 'notifications_company', n_bells),",
        "          jsonb_build_object('communication_logs', 86, 'notifications_company', 29),",
      ),
    ],
  ];
  for (const [name, copy] of broken) {
    assert.notEqual(copy, sql, `${name}: the broken copy changed nothing`);
    assert.ok(problems(copy).length > 0, `${name}: not caught`);
  }
});

test("056 is the only 056, after 055", () => {
  const files = readdirSync(MIGRATIONS);
  assert.deepEqual(
    files.filter((f) => f.startsWith("056_")),
    [FILE],
  );
  assert.ok(files.includes("055_live_restart_link_events.sql"));
});
