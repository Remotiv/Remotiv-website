/**
 * Source pins for migration 053: the live restart decision, the restart and its
 * deadline (F10 C2, applied 31 Oct 2026), and the server module that mirrors
 * its rules (live-restart.ts, F10 C3).
 *
 *   node --test src/lib/supabase/migration-053.test.ts
 *
 * WHAT THIS DOES NOT PROVE. Nothing here runs the SQL; the PGlite run that
 * does was reported with C2, and the production post-check with the apply.
 * Each check is a pure function over the SQL text, and each is also run
 * against a deliberately broken copy, so a check that cannot fail is caught
 * here rather than trusted.
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

const MIGRATIONS = new URL("migrations/", import.meta.url);
const FILE = "053_live_restart_decision.sql";
const sql = readFileSync(new URL(FILE, MIGRATIONS), "utf8");
const restartModule = readFileSync(
  new URL("../interviews/live-restart.ts", import.meta.url),
  "utf8",
);

/** SQL without comments: a comment can neither satisfy nor trip a check. */
const code = (text) => text.replace(/--.*$/gm, "");

/** One constraint's definition, from its add line to the closing `);`. */
function constraint(text, name) {
  const body = code(text);
  const at = body.indexOf(`add constraint ${name}`);
  if (at < 0) return "";
  const rest = body.slice(at);
  return rest.slice(0, rest.indexOf(");\n") + 2);
}

/** One function's body, from its create line to its closing `$$;`. */
function fn(text, name) {
  const body = code(text);
  const at = body.indexOf(`create or replace function public.${name}(`);
  if (at < 0) return "";
  const rest = body.slice(at);
  return rest.slice(0, rest.indexOf("$$;") + 3);
}

const has = (text, snippet) => text.replace(/\s+/g, " ").includes(snippet.replace(/\s+/g, " "));

const RESTART_SIG =
  "public.live_restart_session(uuid, uuid, uuid, text, text, uuid, text, text, uuid, text)";
const EXTEND_SIG = "public.live_restart_extend_deadline(uuid, uuid)";

/** Every problem with a copy of the migration; empty when it is right. */
function problems(text) {
  const out = [];
  const action = constraint(text, "live_interview_actions_action");
  if (!action.includes("'decide_restart'")) out.push("the action constraint lost decide_restart");
  for (const kept of [
    "retry_transcription",
    "resolve_wording_check",
    "resolve_failed_transcription",
  ])
    if (!action.includes(`'${kept}'`)) out.push(`the action constraint lost ${kept}`);
  if (
    !has(
      constraint(text, "live_interview_actions_decision"),
      "or (action = 'decide_restart' and decision in ('restart', 'no_restart'))",
    )
  )
    out.push("the decision constraint lost decide_restart's restart / no_restart");
  if (
    !has(
      constraint(text, "live_interview_actions_target"),
      "when action = 'decide_restart' then question_position is null and turn_id is null and turn_sequence is null",
    )
  )
    out.push("the target constraint lost decide_restart's session-only target");

  if (
    !has(
      code(text),
      "create unique index if not exists live_interview_actions_one_restart_decision on public.live_interview_actions (session_id) where action = 'decide_restart';",
    )
  )
    out.push("the decided-once unique index is gone");

  const rules = fn(text, "live_interview_actions_restart_rules");
  if (!has(rules, "if s.kind is distinct from 'live' or s.attempt <> 1 then"))
    out.push("the decision no longer needs a live first attempt");
  if (!has(rules, "if s.status <> 'started' then"))
    out.push("the decision no longer needs started");
  if (!has(rules, "if s.live_ended_at is null then"))
    out.push("the decision no longer needs a verified end");
  if (!has(rules, "if s.live_ended_at > now() - interval '1 hour' then"))
    out.push("the 1-hour rule for no export is gone");
  if (!has(rules, "elsif coalesce(s.live_outcome ->> 'final', 'false') <> 'true' then"))
    out.push("the decision no longer needs a final outcome");
  if (!has(rules, "not in ('ending_unconfirmed', 'technical_failure', 'abandoned') then"))
    out.push("the restartable outcomes changed");
  if (
    !has(
      code(text),
      "before insert on public.live_interview_actions for each row when (new.action = 'decide_restart') execute function public.live_interview_actions_restart_rules();",
    )
  )
    out.push("the decision trigger is not attached");

  const attempt = fn(text, "interview_sessions_attempt_rules");
  if (
    !has(
      attempt,
      "if old.status = 'abandoned' and new.live_outcome is distinct from old.live_outcome then",
    )
  )
    out.push("an abandoned attempt's live_outcome can change");
  if (
    !has(
      attempt,
      "where a.session_id = old.id and a.action = 'decide_restart' and a.decision = 'restart'",
    )
  )
    out.push("abandoned no longer needs a restart decision");
  if (!has(attempt, "or new.scoring_snapshot is distinct from prev.scoring_snapshot"))
    out.push("a restart no longer copies scoring_snapshot");
  if (!has(attempt, "or new.questions_snapshot is distinct from prev.questions_snapshot"))
    out.push("a restart no longer copies questions_snapshot");
  if (!has(attempt, "if new.status is distinct from 'invited' then"))
    out.push("a restart no longer starts invited");

  const restart = fn(text, "live_restart_session");
  if (!has(restart, "deadline := greatest(prev.expires_at, now() + interval '72 hours');"))
    out.push("the restart's 72-hour greatest() is gone");
  if (!has(restart, "prev.questions_snapshot, prev.scoring_snapshot,"))
    out.push("the restart does not insert the frozen snapshots");
  if (!has(restart, "if prev.delete_after is not null and deadline >= prev.delete_after then"))
    out.push("the restart can end past retention");
  const extend = fn(text, "live_restart_extend_deadline");
  if (!has(extend, "deadline := greatest(s.expires_at, now() + interval '72 hours');"))
    out.push("the extension's 72-hour greatest() is gone");
  if (!has(extend, "if s.status <> 'invited' then"))
    out.push("the extension no longer needs invited");

  for (const sig of [RESTART_SIG, EXTEND_SIG]) {
    if (!has(code(text), `revoke all on function ${sig} from public, anon, authenticated;`))
      out.push(`${sig} is not revoked from public, anon and authenticated`);
    if (!has(code(text), `grant execute on function ${sig} to service_role;`))
      out.push(`${sig} is not granted to service_role`);
  }
  if (/grant\s+[^;]*\bto\s+[^;]*\b(anon|authenticated)\b/i.test(code(text)))
    out.push("something is granted to anon or authenticated");
  return out;
}

test("053 still holds every restart guard: the decision, decided once, the 1-hour and 72-hour rules, the frozen copy, the outcome freeze, service role only", () => {
  assert.deepEqual(problems(sql), []);
});

test("each check fails on a broken copy", () => {
  const broken = [
    [
      "action",
      sql.replace(
        "        'resolve_failed_transcription',\n        'decide_restart'\n",
        "        'resolve_failed_transcription'\n",
      ),
    ],
    ["decision", sql.replace("decision in ('restart', 'no_restart')", "decision in ('restart')")],
    [
      "target",
      sql.replace(
        "then question_position is null and turn_id is null and turn_sequence is null",
        "then true",
      ),
    ],
    [
      "index",
      sql.replace(
        "create unique index if not exists live_interview_actions_one_restart_decision",
        "create index if not exists live_interview_actions_one_restart_decision",
      ),
    ],
    [
      "first attempt",
      sql.replace(
        "if s.kind is distinct from 'live' or s.attempt <> 1 then",
        "if s.kind is distinct from 'live' then",
      ),
    ],
    ["started", sql.replace("  if s.status <> 'started' then\n", "  if false then\n")],
    ["ended", sql.replace("  if s.live_ended_at is null then\n", "  if false then\n")],
    ["1 hour", sql.replace("interval '1 hour'", "interval '1 minute'")],
    ["final", sql.replace("coalesce(s.live_outcome ->> 'final', 'false') <> 'true'", "false")],
    [
      "partial allowed",
      sql.replace(
        "not in ('ending_unconfirmed', 'technical_failure', 'abandoned')",
        "not in ('ending_unconfirmed', 'technical_failure', 'abandoned', 'partial')",
      ),
    ],
    [
      "trigger",
      sql.replace(
        "when (new.action = 'decide_restart')\n  execute",
        "when (new.action = 'decide_restart' and false)\n  execute",
      ),
    ],
    [
      "outcome freeze",
      sql.replace(
        "if old.status = 'abandoned' and new.live_outcome is distinct from old.live_outcome then",
        "if false then",
      ),
    ],
    [
      "abandon needs decision",
      sql.replace(
        "where a.session_id = old.id and a.action = 'decide_restart' and a.decision = 'restart'",
        "where a.session_id = old.id",
      ),
    ],
    [
      "scoring copy",
      sql.replace("     or new.scoring_snapshot is distinct from prev.scoring_snapshot\n", ""),
    ],
    [
      "questions copy",
      sql.replace("     or new.questions_snapshot is distinct from prev.questions_snapshot\n", ""),
    ],
    [
      "starts invited",
      sql.replace("if new.status is distinct from 'invited' then", "if false then"),
    ],
    [
      "72h restart",
      sql.replace("greatest(prev.expires_at, now() + interval '72 hours')", "prev.expires_at"),
    ],
    [
      "snapshots inserted",
      sql.replace(
        "prev.questions_snapshot, prev.scoring_snapshot,",
        "prev.questions_snapshot, null,",
      ),
    ],
    [
      "retention",
      sql.replace(
        "if prev.delete_after is not null and deadline >= prev.delete_after then",
        "if false then",
      ),
    ],
    [
      "72h extend",
      sql.replace(
        "greatest(s.expires_at, now() + interval '72 hours')",
        "s.expires_at + interval '72 hours'",
      ),
    ],
    ["extend invited", sql.replace("  if s.status <> 'invited' then\n", "  if false then\n")],
    [
      "revoke restart",
      sql.replace(
        `revoke all on function ${RESTART_SIG}\n  from public, anon, authenticated;`,
        `revoke all on function ${RESTART_SIG}\n  from public;`,
      ),
    ],
    [
      "revoke extend",
      sql.replace(
        `revoke all on function ${EXTEND_SIG}\n  from public, anon, authenticated;`,
        `revoke all on function ${EXTEND_SIG}\n  from public, anon;`,
      ),
    ],
    [
      "granted to authenticated",
      sql.replace(
        `grant execute on function ${EXTEND_SIG}\n  to service_role;`,
        `grant execute on function ${EXTEND_SIG}\n  to service_role, authenticated;`,
      ),
    ],
    [
      "only in a comment",
      sql.replace(
        "create unique index if not exists live_interview_actions_one_restart_decision",
        "-- create unique index if not exists live_interview_actions_one_restart_decision",
      ),
    ],
  ];
  for (const [name, copy] of broken) {
    assert.notEqual(copy, sql, `${name}: the broken copy changed nothing`);
    assert.ok(problems(copy).length > 0, `${name}: not caught`);
  }
});

test("053 is the only 053, after 052", () => {
  const files = readdirSync(MIGRATIONS);
  assert.deepEqual(
    files.filter((f) => f.startsWith("053_")),
    [FILE],
  );
  assert.ok(files.includes("052_usage_events_keep_company_id.sql"));
});

test("live-restart.ts mirrors 053: the same restartable outcomes, the hour, the 72 hours and the note's length", () => {
  const listed = restartModule.match(/const RESTARTABLE_OUTCOMES = \[([^\]]*)\]/)?.[1] ?? "";
  assert.deepEqual(
    [...listed.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]),
    ["ending_unconfirmed", "technical_failure", "abandoned"],
  );
  assert.match(restartModule, /const HOUR_MS = 60 \* 60 \* 1000;/);
  assert.match(restartModule, /const RESTART_DEADLINE_MS = 72 \* HOUR_MS;/);
  assert.match(restartModule, /const NOTE_MAX = 2000;/);
  assert.match(restartModule, /service\.rpc\("live_restart_session"/);
  assert.match(restartModule, /service\.rpc\("live_restart_extend_deadline"/);
});
