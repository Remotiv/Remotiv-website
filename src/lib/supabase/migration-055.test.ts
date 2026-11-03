/**
 * Source pins for migration 055: the restart link record
 * (live_restart_link_events) and the database guard that refuses a new live
 * first attempt for an application already restarted or decided (F10-LOG).
 *
 *   node --test src/lib/supabase/migration-055.test.ts
 *
 * WHAT THIS DOES NOT PROVE. Nothing here runs the SQL; the PGlite run that
 * does is reported with the change. Each check is a pure function over the SQL
 * text, and each is also run against a deliberately broken copy, so a check
 * that cannot fail is caught here rather than trusted.
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

const MIGRATIONS = new URL("migrations/", import.meta.url);
const FILE = "055_live_restart_link_events.sql";
const sql = readFileSync(new URL(FILE, MIGRATIONS), "utf8");

/** SQL without comments: a comment can neither satisfy nor trip a check. */
const code = (text) => text.replace(/--.*$/gm, "");
const has = (text, snippet) => text.replace(/\s+/g, " ").includes(snippet.replace(/\s+/g, " "));

/** One function's body, from its create line to its closing `$$;`. */
function fn(text, name) {
  const body = code(text);
  const at = body.indexOf(`create or replace function public.${name}(`);
  if (at < 0) return "";
  const rest = body.slice(at);
  return rest.slice(0, rest.indexOf("$$;") + 3);
}

/** Every problem with a copy of the migration; empty when it is right. */
function problems(text) {
  const out = [];
  const c = code(text);
  if (
    !has(
      c,
      "to_regprocedure( 'public.live_restart_session(uuid, uuid, uuid, text, text, uuid, text, text, uuid, text)' ) is null",
    )
  )
    out.push("it no longer stops when 053 is missing");

  // ── the link record ──
  if (
    !has(c, "session_id uuid not null references public.interview_sessions (id) on delete cascade")
  )
    out.push("link events no longer go with their session");
  if (!has(c, "check (event in ('sent', 'failed', 'reissued'))"))
    out.push("the event codes changed");
  if (!has(c, "check (actor_role in ('owner', 'admin'))"))
    out.push("the actor role is no longer owner or admin");
  const rules = fn(text, "live_restart_link_events_rules");
  if (!has(rules, "if s_kind is distinct from 'live' or s_attempt is distinct from 2 then"))
    out.push("link events are no longer restart-only");
  if (!has(rules, "if new.company_id is distinct from s_company then"))
    out.push("link events no longer check the session's company");
  if (!has(rules, "new.created_at := now();")) out.push("the database no longer stamps the time");
  if (
    !has(
      c,
      "before insert on public.live_restart_link_events for each row execute function public.live_restart_link_events_rules();",
    )
  )
    out.push("the link rules are not attached");
  for (const [op, name] of [
    ["update", "no_update"],
    ["delete", "no_delete"],
    ["truncate", "no_truncate"],
  ]) {
    if (
      !has(
        c,
        `create trigger live_restart_link_events_${name} before ${op} on public.live_restart_link_events`,
      )
    )
      out.push(`append-only: ${op} is no longer refused`);
  }
  if (
    !has(
      fn(text, "live_restart_link_events_append_only"),
      "if exists (select 1 from public.interview_sessions where id = old.session_id) then",
    )
  )
    out.push("a link row can go without its session");
  if (!has(c, "alter table public.live_restart_link_events enable row level security;"))
    out.push("RLS is off");
  if (
    !has(c, "revoke all on table public.live_restart_link_events from public, anon, authenticated;")
  )
    out.push("anon or authenticated keep rights on the table");
  if (/grant\s+[^;]*\bto\s+[^;]*\b(anon|authenticated|public)\b/i.test(c))
    out.push("something is granted to anon, authenticated or public");

  // ── the guard ──
  const guard = fn(text, "interview_sessions_no_first_attempt_after_restart");
  for (const [snippet, why] of [
    [
      "if new.kind = 'live' and new.attempt = 1 and new.previous_attempt_id is null and new.application_id is not null then",
      "the guard no longer targets a new live first attempt",
    ],
    ["and s.attempt = 2", "the guard no longer looks for a restart"],
    ["and a.action = 'decide_restart'", "the guard no longer looks for a decision"],
    ["and a.company_id = new.company_id", "the guard reads another company's decisions"],
    ["using errcode = 'check_violation'", "the guard no longer refuses"],
  ]) {
    if (!has(guard, snippet)) out.push(why);
  }
  // Within the company, in both lookups (the restart, and the decision's session).
  if (guard.replace(/\s+/g, " ").split("and s.company_id = new.company_id").length - 1 !== 2)
    out.push("the guard is no longer within the company in both lookups");
  if (
    !has(
      c,
      "before insert on public.interview_sessions for each row execute function public.interview_sessions_no_first_attempt_after_restart();",
    )
  )
    out.push("the guard is not attached");

  // ── one lock, per application, in both functions ──
  const LOCK = "perform pg_advisory_xact_lock(hashtextextended('live-restart:' ||";
  if (!has(guard, `${LOCK} new.application_id::text, 0));`))
    out.push("the guard no longer takes the per-application lock");
  const decide = fn(text, "live_interview_actions_restart_rules");
  if (!has(decide, `${LOCK} app::text, 0));`))
    out.push("the decision no longer takes the per-application lock");
  const lockAt = decide.indexOf("pg_advisory_xact_lock");
  const rowAt = decide.indexOf("for update");
  if (lockAt < 0 || rowAt < 0 || lockAt > rowAt) {
    out.push("the decision locks the row before the application");
  }
  // The restart (053's, replaced): the same lock, also before its row.
  const restart = fn(text, "live_restart_session");
  if (!has(restart, `${LOCK} app::text, 0));`))
    out.push("the restart no longer takes the per-application lock");
  const rLockAt = restart.indexOf("pg_advisory_xact_lock");
  const rRowAt = restart.indexOf("for update");
  if (rLockAt < 0 || rRowAt < 0 || rLockAt > rRowAt) {
    out.push("the restart locks the row before the application");
  }
  if (!has(restart, "insert into public.live_interview_actions"))
    out.push("the restart no longer records its decision");
  if (
    !has(
      c,
      "grant execute on function public.live_restart_session(uuid, uuid, uuid, text, text, uuid, text, text, uuid, text) to service_role;",
    )
  )
    out.push("the restart is no longer granted to the service role");

  // ── the decision: 053's rules kept, plus no newer first attempt ──
  for (const [snippet, why] of [
    ["if s.kind is distinct from 'live' or s.attempt <> 1 then", "053: a live first attempt only"],
    ["if s.status <> 'started' then", "053: started only"],
    ["if s.live_ended_at is null then", "053: a verified end"],
    ["if s.live_ended_at > now() - interval '1 hour' then", "053: the 1-hour rule"],
    ["elsif coalesce(s.live_outcome ->> 'final', 'false') <> 'true' then", "053: a final outcome"],
    [
      "not in ('ending_unconfirmed', 'technical_failure', 'abandoned') then",
      "053: the restartable outcomes",
    ],
    ["using errcode = 'unique_violation';", "053: decided once"],
    [
      "and n.created_at >= s.created_at and n.status <> 'cancelled'",
      "the newer-first-attempt rule is gone, or no longer fails closed on a tie",
    ],
  ]) {
    if (!has(decide, snippet)) out.push(why);
  }
  if (
    !has(
      c,
      "revoke all on function public.live_interview_actions_restart_rules() from public, anon, authenticated;",
    )
  )
    out.push("the decision function is executable by anon or authenticated");

  // ── what the comments promise ──
  if (!has(text, "sent      the email provider accepted the link's email (not proof that"))
    out.push("'sent' is described as delivery");
  if (!has(text, "NOT check that actor_user_id is a member of the company with that role"))
    out.push("the actor-role caveat is gone");
  return out;
}

test("055 records restart links (restart-only, company-checked, append-only, server-only) and refuses a new first attempt after a restart or decision", () => {
  assert.deepEqual(problems(sql), []);
});

test("each check fails on a broken copy", () => {
  const broken = [
    [
      "053 check",
      sql.replace(
        "to_regprocedure(\n       'public.live_restart_session",
        "to_regprocedure(\n       'public.nothing_here",
      ),
    ],
    [
      "cascade",
      sql.replace(
        "references public.interview_sessions (id) on delete cascade",
        "references public.interview_sessions (id)",
      ),
    ],
    [
      "event codes",
      sql.replace(
        "check (event in ('sent', 'failed', 'reissued'))",
        "check (event in ('sent', 'failed', 'reissued', 'opened'))",
      ),
    ],
    [
      "actor role",
      sql.replace("check (actor_role in ('owner', 'admin'))", "check (actor_role is not null)"),
    ],
    ["restart only", sql.replace("or s_attempt is distinct from 2 then", "then")],
    [
      "company check",
      sql.replace("  if new.company_id is distinct from s_company then", "  if false then"),
    ],
    ["stamped time", sql.replace("  new.created_at := now();\n", "")],
    [
      "rules attached",
      sql.replace(
        "before insert on public.live_restart_link_events\n  for each row",
        "before update on public.live_restart_link_events\n  for each row",
      ),
    ],
    [
      "no update",
      sql.replace(
        "create trigger live_restart_link_events_no_update\n  before update",
        "create trigger live_restart_link_events_no_update\n  after update",
      ),
    ],
    [
      "no delete",
      sql.replace(
        "create trigger live_restart_link_events_no_delete\n  before delete",
        "create trigger live_restart_link_events_no_delete\n  after delete",
      ),
    ],
    [
      "no truncate",
      sql.replace(
        "create trigger live_restart_link_events_no_truncate\n  before truncate",
        "create trigger live_restart_link_events_no_truncate\n  after truncate",
      ),
    ],
    [
      "goes with session",
      sql.replace(
        "  if exists (select 1 from public.interview_sessions where id = old.session_id) then",
        "  if false then",
      ),
    ],
    [
      "rls",
      sql.replace("alter table public.live_restart_link_events enable row level security;", ""),
    ],
    [
      "revoke",
      sql.replace(
        "revoke all on table public.live_restart_link_events from public, anon, authenticated;",
        "revoke all on table public.live_restart_link_events from public;",
      ),
    ],
    [
      "grant to authenticated",
      sql.replace(
        "grant select, insert on table public.live_restart_link_events to service_role;",
        "grant select, insert on table public.live_restart_link_events to service_role, authenticated;",
      ),
    ],
    ["guard target", sql.replace("     and new.attempt = 1\n", "")],
    ["guard restart", sql.replace("         and s.attempt = 2\n", "")],
    ["guard decision", sql.replace("         and a.action = 'decide_restart'\n", "")],
    [
      "guard company",
      sql.replace(
        "       where s.application_id = new.application_id\n         and s.company_id = new.company_id\n         and s.kind = 'live'\n         and s.attempt = 2",
        "       where s.application_id = new.application_id\n         and s.kind = 'live'\n         and s.attempt = 2",
      ),
    ],
    [
      "guard refuses",
      sql.replace(
        "        new.application_id\n        using errcode = 'check_violation';",
        "        new.application_id;",
      ),
    ],
    [
      "guard attached",
      sql.replace(
        "  before insert on public.interview_sessions\n  for each row execute function public.interview_sessions_no_first_attempt_after_restart();",
        "  before update on public.interview_sessions\n  for each row execute function public.interview_sessions_no_first_attempt_after_restart();",
      ),
    ],
    [
      "guard lock",
      sql.replace(
        "    perform pg_advisory_xact_lock(hashtextextended('live-restart:' || new.application_id::text, 0));\n",
        "",
      ),
    ],
    [
      "decision lock",
      sql.replace(
        "    perform pg_advisory_xact_lock(hashtextextended('live-restart:' || app::text, 0));\n",
        "",
      ),
    ],
    [
      "another key",
      sql.replace(
        "hashtextextended('live-restart:' || app::text, 0)",
        "hashtextextended('restart:' || app::text, 0)",
      ),
    ],
    [
      "row before lock",
      sql
        .replace(
          "  select * into s from public.interview_sessions where id = new.session_id for update;\n",
          "",
        )
        .replace(
          "  -- Serialized with the guard above, per application: the lock before the row.\n",
          "  select * into s from public.interview_sessions where id = new.session_id for update;\n",
        ),
    ],
    [
      "053 rule",
      sql.replace("  if s.live_ended_at > now() - interval '1 hour' then", "  if false then"),
    ],
    ["newer attempt", sql.replace("       and n.status <> 'cancelled'\n", "")],
    [
      "strict newer",
      sql.replace(
        "       and n.created_at >= s.created_at\n",
        "       and n.created_at > s.created_at\n",
      ),
    ],
    [
      "restart lock",
      sql.replace(
        "  -- The application lock before the row, as in every path (see the header).\n  select application_id into app\n    from public.interview_sessions\n   where id = p_session_id and company_id = p_company_id;\n  if app is not null then\n    perform pg_advisory_xact_lock(hashtextextended('live-restart:' || app::text, 0));\n  end if;\n",
        "",
      ),
    ],
    [
      "restart row before lock",
      sql
        .replace(
          "   where id = p_session_id and company_id = p_company_id\n   for update;\n  if not found then\n    raise exception 'live_restart_session",
          "   where id = p_session_id and company_id = p_company_id;\n  if not found then\n    raise exception 'live_restart_session",
        )
        .replace(
          "  -- The application lock before the row, as in every path (see the header).\n  select application_id into app\n    from public.interview_sessions\n   where id = p_session_id and company_id = p_company_id;",
          "  select application_id into app\n    from public.interview_sessions\n   where id = p_session_id and company_id = p_company_id\n   for update;",
        ),
    ],
    [
      "restart grant",
      sql.replace(
        "grant execute on function public.live_restart_session(uuid, uuid, uuid, text, text, uuid, text, text, uuid, text)\n  to service_role;",
        "",
      ),
    ],
    [
      "decision revoke",
      sql.replace(
        "revoke all on function public.live_interview_actions_restart_rules() from public, anon, authenticated;",
        "",
      ),
    ],
    [
      "sent wording",
      sql.replace(
        "the email provider accepted the link's email (not proof that",
        "the link's email was delivered (proof that",
      ),
    ],
    [
      "actor caveat",
      sql.replace(
        "NOT check that actor_user_id is a member of the company with that role",
        "check the actor",
      ),
    ],
    [
      "only in a comment",
      sql.replace(
        "alter table public.live_restart_link_events enable row level security;",
        "-- alter table public.live_restart_link_events enable row level security;",
      ),
    ],
  ];
  for (const [name, copy] of broken) {
    assert.notEqual(copy, sql, `${name}: the broken copy changed nothing`);
    assert.ok(problems(copy).length > 0, `${name}: not caught`);
  }
});

test("055 is the only 055, after 054", () => {
  const files = readdirSync(MIGRATIONS);
  assert.deepEqual(
    files.filter((f) => f.startsWith("055_")),
    [FILE],
  );
  assert.ok(files.includes("054_interview_words_retention_guard.sql"));
});
