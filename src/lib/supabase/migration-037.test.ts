/**
 * Source pins for migration 037: company plans, plan history, pricing
 * settings, and the allowance functions.
 *
 *   node --test src/lib/supabase/migration-037.test.ts
 *
 * WHAT THIS DOES NOT PROVE. The tests run without a database, so nothing here
 * executes the SQL. In particular, no race is exercised: "concurrent requests
 * cannot overspend the final slot" is pinned as the ORDER of operations inside
 * consume_allowance (the advisory lock is taken before the limit is read and
 * usage is counted, and the insert happens under it). Whether Postgres then
 * serialises two callers is Postgres's guarantee, not something this file
 * observed. The same holds for the history trigger and the append-only guard:
 * they are pinned as present and wired, not run.
 *
 * Every check is a pure function over the SQL text, and each is also run
 * against a deliberately broken copy, so a check that cannot fail is caught
 * here rather than trusted.
 */
// @ts-nocheck — same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const MIGRATION = "migrations/037_company_plans_and_allowances.sql";
const sql = readFileSync(new URL(MIGRATION, import.meta.url), "utf8");

/** The body of one function, from its create line to the closing `$$;`. */
function fnBody(text, name) {
  const start = text.indexOf(`create or replace function public.${name}(`);
  if (start < 0) return "";
  const open = text.indexOf("as $$", start);
  const close = text.indexOf("\n$$;", open);
  return open < 0 || close < 0 ? "" : text.slice(start, close);
}

const LOCK = "pg_advisory_xact_lock(hashtextextended(p_company::text || ':' || p_metric, 0))";
/** How the CHECK assertion pulls every quoted literal out of the definition. */
const LITERAL_PATTERN_SQL = "regexp_matches(v_def, '''((?:[^'']|'''')*)''', 'g')";
const EXPECTED_TYPES = [
  "interview_sent",
  "interview_completed",
  "cv_scored",
  "message_sent",
  "live_minutes",
  "whatsapp_sent",
  "interview_scored",
];
const REFUSAL_CONDITION =
  "if not coalesce(v_internal, false) and v_has_plan and v_limit is not null and v_used >= v_limit then";

/* ── the checks ───────────────────────────────────────────────── */

/** The lock comes before the limit read, the count and the insert. */
function lockOrder(text) {
  const body = fnBody(text, "consume_allowance");
  const lock = body.indexOf(LOCK);
  const plan = body.indexOf("from public.company_plans cp");
  const count = body.indexOf("sum(ue.quantity)");
  const insert = body.indexOf("insert into public.usage_events");
  const problems = [];
  if (lock < 0) problems.push("no advisory lock keyed on company and metric");
  if (!(lock < plan && plan < count && count < insert)) {
    problems.push(
      "lock must precede the limit read, which precedes the count, which precedes the insert",
    );
  }
  return problems;
}

/** The refusal returns before the only insert, so refusing writes nothing. */
function refusalWritesNothing(text) {
  const body = fnBody(text, "consume_allowance");
  const problems = [];
  const condition = body.indexOf(REFUSAL_CONDITION);
  const refuse = body.indexOf("return query select false", condition);
  const bail = body.indexOf("return;", refuse);
  const insert = body.indexOf("insert into public.usage_events");
  if (condition < 0 || refuse < 0 || bail < 0) problems.push("refusal branch not found");
  if (!(insert > bail)) problems.push("the usage row is inserted before the refusal returns");
  if ((body.match(/insert into/g) ?? []).length !== 1) problems.push("expected exactly one insert");
  return problems;
}

/** No plan, or a null limit, or an internal company: never refused. */
function noPlanIsUnlimited(text) {
  const body = fnBody(text, "consume_allowance");
  const problems = [];
  if (!body.includes("v_has_plan := found;"))
    problems.push("plan presence is not taken from FOUND");
  if (!body.includes(REFUSAL_CONDITION))
    problems.push("refusal condition does not require a plan, a limit and a non-internal company");
  for (const reason of [
    "'unlimited_internal'",
    "'unlimited_no_plan'",
    "'unlimited_metric_not_set'",
  ]) {
    if (!body.includes(reason)) problems.push(`missing reason ${reason}`);
  }
  if (!body.includes("select c.is_internal into v_internal"))
    problems.push("internal exemption not read from companies.is_internal");
  return problems;
}

/** release deletes exactly the reserved row, of a capped metric only, and the count reads that table. */
function releaseReturnsSlot(text) {
  const release = fnBody(text, "release_allowance");
  const consume = fnBody(text, "consume_allowance");
  const problems = [];
  if (!release.includes("delete from public.usage_events ue"))
    problems.push("release does not delete from usage_events");
  if (!release.includes("where ue.id = p_usage_id"))
    problems.push("release is not keyed on the returned id");
  if (!release.includes("and ue.type in ('cv_scored', 'interview_sent')"))
    problems.push("release is not restricted to the capped metrics");
  if (!release.includes("return v_deleted > 0;"))
    problems.push("release does not report whether it removed a row");
  // The slot comes back because the count is over the same table the row left.
  if (
    !consume.includes("from public.usage_events ue") ||
    !consume.includes("and ue.type = p_metric")
  ) {
    problems.push("consume does not count the table release deletes from");
  }
  return problems;
}

/** Every insert, update and delete of a plan writes history; history cannot be rewritten. */
function historyIsAutomaticAndAppendOnly(text) {
  const log = fnBody(text, "log_company_plan_change");
  const problems = [];
  if (
    !/after insert or update or delete on public\.company_plans\s+for each row execute function public\.log_company_plan_change\(\)/.test(
      text,
    )
  ) {
    problems.push("no history trigger on every insert, update and delete of company_plans");
  }
  if (!log.includes("insert into public.company_plan_history") || !log.includes("to_jsonb(new)")) {
    problems.push("the trigger does not append the full snapshot");
  }
  if (!log.includes("new.updated_by")) problems.push("the trigger does not record who");
  if (!/before update or delete on public\.company_plan_history/.test(text))
    problems.push("history rows can be updated or deleted");
  if (!/before truncate on public\.company_plan_history/.test(text))
    problems.push("history can be truncated");
  if (!fnBody(text, "company_plan_history_append_only").includes("raise exception"))
    problems.push("the append-only guard does not raise");
  if (
    !text.includes(
      "revoke insert, update, delete, truncate on table public.company_plan_history from service_role;",
    )
  ) {
    problems.push("the service role can write history directly");
  }
  return problems;
}

/** The live CHECK is asserted before anything is created, inside one transaction. */
function constraintAsserted(text) {
  const problems = [];
  const begin = text.indexOf("\nbegin;");
  const assertAt = text.indexOf("v_name     text := 'usage_events_type_check'");
  const firstCreate = text.indexOf("create table");
  const commit = text.lastIndexOf("\ncommit;");
  if (!(begin >= 0 && begin < assertAt && assertAt < firstCreate && firstCreate < commit)) {
    problems.push("the assertion must run inside the transaction, before the first create");
  }
  for (const v of [
    "interview_sent",
    "interview_completed",
    "cv_scored",
    "message_sent",
    "live_minutes",
    "whatsapp_sent",
    "interview_scored",
  ]) {
    if (!text.includes(`'${v}'`)) problems.push(`expected value ${v} not asserted`);
  }
  // A set comparison in both directions, over literals extracted by pattern.
  if (!text.includes(LITERAL_PATTERN_SQL))
    problems.push("literals are not extracted by the shared pattern");
  if (!/where e <> all \(coalesce\(v_found, '\{\}'::text\[\]\)\)/.test(text))
    problems.push("no missing-value set check");
  if (!/where f <> all \(v_expected\)/.test(text)) problems.push("no unexpected-value set check");
  if (!text.includes("constraint is missing %")) problems.push("a missing value does not raise");
  if (!text.includes("constraint allows unexpected %"))
    problems.push("an unexpected value does not raise");
  // Nothing may depend on how Postgres prints the CHECK.
  if (/'::text'\)|quote_literal\(v_val\) \|\| '::text'|length\('::text'\)/.test(text)) {
    problems.push("the assertion still depends on the ::text formatting");
  }
  return problems;
}

/** A plan can be removed on purpose: actor required, delete recorded, history kept. */
function removalIsAudited(text) {
  const remove = fnBody(text, "remove_company_plan");
  const log = fnBody(text, "log_company_plan_change");
  const problems = [];
  if (!remove) return ["no remove_company_plan function"];
  if (!remove.includes("if p_actor is null then"))
    problems.push("removal does not require the acting user");
  if (!remove.includes("from auth.users u where u.id = p_actor"))
    problems.push("removal does not check the actor exists");
  const actor = remove.indexOf("set_config('remotiv.plan_actor', p_actor::text, true)");
  const del = remove.indexOf(
    "delete from public.company_plans cp where cp.company_id = p_company;",
  );
  if (!(actor > 0 && del > actor)) problems.push("the actor must be set before the delete");
  if (/company_plan_history/.test(remove)) problems.push("removal touches history directly");
  // The delete is recorded by the trigger, with the actor this call set.
  if (
    !/if tg_op = 'DELETE' then[\s\S]*to_jsonb\(old\)[\s\S]*current_setting\('remotiv\.plan_actor', true\)/.test(
      log,
    )
  ) {
    problems.push("a delete is not recorded with its snapshot and actor");
  }
  if (
    !/revoke all on function public\.remove_company_plan\(uuid, uuid\)\s+from public, anon, authenticated;/.test(
      text,
    )
  ) {
    problems.push("removal is callable beyond the service role");
  }
  return problems;
}

/**
 * The history writer can write although the service role cannot: it runs as
 * the table owner, and it fires on every path that changes a plan.
 */
function historyWriterRunsAsOwner(text) {
  const problems = [];
  const start = text.indexOf("create or replace function public.log_company_plan_change()");
  const header = start < 0 ? "" : text.slice(start, text.indexOf("as $$", start));
  if (!/\nsecurity definer\n/.test(header))
    problems.push("the history writer does not run as its owner");
  if (!/\nset search_path = public\n/.test(header))
    problems.push("the history writer has no fixed search_path");
  // Insert and update (set_company_plan's upsert), delete (remove_company_plan).
  if (
    !/after insert or update or delete on public\.company_plans\s+for each row execute function public\.log_company_plan_change\(\)/.test(
      text,
    )
  ) {
    problems.push("the trigger does not cover insert, update and delete");
  }
  // A company deletion cascades into company_plans, which fires the delete branch.
  if (
    !/company_id\s+uuid primary key references public\.companies\(id\) on delete cascade,/.test(
      text,
    )
  ) {
    problems.push("a company deletion does not cascade to its plan");
  }
  if (
    !/if tg_op = 'DELETE' then\s+insert into public\.company_plan_history/.test(
      fnBody(text, "log_company_plan_change"),
    )
  ) {
    problems.push("the delete branch does not write history");
  }
  // And the service role still cannot write history itself.
  if (
    !/revoke insert, update, delete, truncate on table public\.company_plan_history from service_role;/.test(
      text,
    )
  ) {
    problems.push("the service role can write history directly");
  }
  return problems;
}

const CHECKS = {
  lockOrder,
  refusalWritesNothing,
  noPlanIsUnlimited,
  releaseReturnsSlot,
  historyIsAutomaticAndAppendOnly,
  constraintAsserted,
  removalIsAudited,
  historyWriterRunsAsOwner,
};

/* ── each check can fail ──────────────────────────────────────── */

test("every check refuses a copy broken in the way it guards against", () => {
  const broken = {
    lockOrder: [
      ["lock removed", sql.replace(`perform ${LOCK};`, "")],
      [
        "lock after the count",
        sql
          .replace(`perform ${LOCK};`, "")
          .replace("  -- The only refusal.", `  perform ${LOCK};\n  -- The only refusal.`),
      ],
    ],
    refusalWritesNothing: [
      [
        "insert before the refusal",
        sql.replace(
          `  -- The only refusal.`,
          "  insert into public.usage_events (company_id, type) values (p_company, p_metric);\n  -- The only refusal.",
        ),
      ],
    ],
    noPlanIsUnlimited: [
      ["no plan refused", sql.replace(REFUSAL_CONDITION, "if v_used >= coalesce(v_limit, 0) then")],
      [
        "exemption by UUID",
        sql.replace(
          "select c.is_internal into v_internal",
          "select (c.id = p_company) into v_internal",
        ),
      ],
    ],
    releaseReturnsSlot: [
      [
        "release of any type",
        sql.replace("     and ue.type in ('cv_scored', 'interview_sent');", ";"),
      ],
      [
        "release by company",
        sql.replace("where ue.id = p_usage_id", "where ue.company_id = p_usage_id"),
      ],
    ],
    historyIsAutomaticAndAppendOnly: [
      [
        "history on update only",
        sql.replace(
          "after insert or update or delete on public.company_plans",
          "after update on public.company_plans",
        ),
      ],
      [
        "no append-only guard",
        sql.replace(
          "before update or delete on public.company_plan_history",
          "after insert on public.company_plan_history",
        ),
      ],
    ],
    constraintAsserted: [
      [
        "assertion after the tables",
        `${sql.replace("v_name     text := 'usage_events_type_check'", "v_name     text := 'x'")}\nv_name     text := 'usage_events_type_check'`,
      ],
      ["one value dropped", sql.replace("'interview_completed',", "")],
      ["missing-value check removed", sql.replace("constraint is missing %", "constraint is fine")],
      ["unexpected-value check removed", sql.replace("where f <> all (v_expected)", "where false")],
      [
        "formatting-dependent again",
        sql.replace(
          "  if v_missing is not null then",
          "  v_x := length('::text');\n  if v_missing is not null then",
        ),
      ],
    ],
    removalIsAudited: [
      [
        "actor not required",
        sql.replace(
          "  if p_actor is null then\n    raise exception 'remove_company_plan:",
          "  if false then\n    raise exception 'remove_company_plan:",
        ),
      ],
      [
        "actor set after the delete",
        sql.replace(
          "  perform set_config('remotiv.plan_actor', p_actor::text, true);\n\n  delete from public.company_plans cp",
          "  delete from public.company_plans cp",
        ),
      ],
      [
        "deletes history too",
        sql
          .split(
            "  get diagnostics v_deleted = row_count;\n  return v_deleted > 0;\nend;\n$$;\n\n\n-- ── 6.",
          )
          .join(
            "  delete from public.company_plan_history h where h.company_id = p_company;\n  get diagnostics v_deleted = row_count;\n  return v_deleted > 0;\nend;\n$$;\n\n\n-- ── 6.",
          ),
      ],
      ["delete not logged", sql.replace("if tg_op = 'DELETE' then", "if false then")],
    ],
    historyWriterRunsAsOwner: [
      [
        "runs as the caller",
        sql.replace(
          "create or replace function public.log_company_plan_change()\nreturns trigger\nlanguage plpgsql\nsecurity definer\n",
          "create or replace function public.log_company_plan_change()\nreturns trigger\nlanguage plpgsql\n",
        ),
      ],
      [
        "no fixed search_path",
        // split/join, not replace: in a replacement string "$$" means "$".
        sql
          .split(
            "language plpgsql\nsecurity definer\nset search_path = public\nas $$\nbegin\n  if tg_op = 'DELETE' then",
          )
          .join("language plpgsql\nsecurity definer\nas $$\nbegin\n  if tg_op = 'DELETE' then"),
      ],
      [
        "no cascade from companies",
        sql.replace(
          "references public.companies(id) on delete cascade,",
          "references public.companies(id),",
        ),
      ],
      [
        "service role may insert history",
        sql.replace(
          "revoke insert, update, delete, truncate on table public.company_plan_history from service_role;",
          "revoke update, delete, truncate on table public.company_plan_history from service_role;",
        ),
      ],
    ],
  };
  for (const [name, check] of Object.entries(CHECKS)) {
    assert.deepEqual(check(sql), [], `${name} fails on the real migration`);
    for (const [label, text] of broken[name]) {
      // A broken copy whose edit did not apply would test the real file and
      // pass for the wrong reason, which is exactly how this was once missed.
      assert.notEqual(text, sql, `${name}: the broken copy "${label}" is unchanged`);
      assert.ok(check(text).length > 0, `${name} did not catch: ${label}`);
    }
  }
});

/* ── the five requirements ────────────────────────────────────── */

test("1. concurrent requests cannot overspend: the lock precedes the read, the count and the insert (source pin, no race run)", () => {
  assert.deepEqual(lockOrder(sql), []);
  // Transaction-scoped, so it is released at commit or rollback, never leaked.
  assert.match(fnBody(sql, "consume_allowance"), /pg_advisory_xact_lock\(/);
  assert.doesNotMatch(fnBody(sql, "consume_allowance"), /pg_advisory_lock\(/);
});

test("2. release_allowance returns the slot", () => {
  assert.deepEqual(releaseReturnsSlot(sql), []);
});

test("3. no plan, a null limit, or an internal company means unlimited", () => {
  assert.deepEqual(noPlanIsUnlimited(sql), []);
});

test("4. a refusal creates no usage row", () => {
  assert.deepEqual(refusalWritesNothing(sql), []);
});

test("5. plan changes create history automatically, and history is append-only", () => {
  assert.deepEqual(historyIsAutomaticAndAppendOnly(sql), []);
  // The one write path requires the actor; direct writes are revoked.
  const setPlan = fnBody(sql, "set_company_plan");
  assert.match(setPlan, /if p_actor is null then/);
  assert.match(setPlan, /set_config\('remotiv\.plan_actor', p_actor::text, true\)/);
  assert.match(
    sql,
    /revoke insert, update, delete, truncate on table public\.company_plans\s+from service_role;/,
  );
  // Who comes from this transaction's setting, never from a value left on the row.
  assert.match(
    fnBody(sql, "company_plans_stamp"),
    /new\.updated_by := nullif\(current_setting\('remotiv\.plan_actor', true\), ''\)::uuid;/,
  );
});

/* ── the rest of the brief ────────────────────────────────────── */

test("the live usage_events CHECK is asserted before anything is created, in one transaction", () => {
  assert.deepEqual(constraintAsserted(sql), []);
});

/*
 * The assertion's set logic, run here in JavaScript with the SAME pattern the
 * migration uses: the pattern is read out of the SQL file and unescaped, not
 * retyped, so editing the migration's pattern changes what this exercises.
 * This proves the extraction and the two-way comparison behave as intended on
 * each shape. It does not run Postgres; the regex syntax used (a character
 * class, a non-capturing group, a global flag) means the same in both.
 */
function assertionVerdict(definition) {
  const at = sql.indexOf("regexp_matches(v_def, ") + "regexp_matches(v_def, ".length;
  const quoted = sql.slice(at, sql.indexOf(", 'g')", at));
  const pattern = new RegExp(quoted.slice(1, -1).replace(/''/g, "'"), "g");
  const found = new Set([...definition.matchAll(pattern)].map((m) => m[1].replace(/''/g, "'")));
  return {
    missing: EXPECTED_TYPES.filter((e) => !found.has(e)),
    unexpected: [...found].filter((f) => !EXPECTED_TYPES.includes(f)),
  };
}

test("the CHECK assertion compares the set of values, however Postgres prints them", () => {
  const list = (values, cast) => values.map((v) => `'${v}'${cast}`).join(", ");
  const reordered = [...EXPECTED_TYPES].reverse();
  const passes = {
    "029 as printed, ::text": `CHECK ((type = ANY (ARRAY[${list(EXPECTED_TYPES, "::text")}])))`,
    "varchar casts, reordered": `CHECK (((type)::text = ANY ((ARRAY[${list(reordered, "::character varying")}])::text[])))`,
    "IN list, no casts, no spaces": `CHECK (type IN (${reordered.map((v) => `'${v}'`).join(",")}))`,
    "a value repeated": `CHECK ((type = ANY (ARRAY[${list([...EXPECTED_TYPES, "cv_scored"], "::text")}])))`,
  };
  for (const [name, def] of Object.entries(passes)) {
    assert.deepEqual(assertionVerdict(def), { missing: [], unexpected: [] }, name);
  }

  const withoutOne = EXPECTED_TYPES.filter((v) => v !== "interview_sent");
  assert.deepEqual(
    assertionVerdict(`CHECK ((type = ANY (ARRAY[${list(withoutOne, "::text")}])))`),
    {
      missing: ["interview_sent"],
      unexpected: [],
    },
  );
  assert.deepEqual(
    assertionVerdict(
      `CHECK ((type = ANY (ARRAY[${list([...EXPECTED_TYPES, "live_interview"], "::text")}])))`,
    ),
    { missing: [], unexpected: ["live_interview"] },
  );
  // A doubled quote is unescaped, so an odd value is named, not mis-split.
  assert.deepEqual(
    assertionVerdict(`CHECK (type IN (${list(EXPECTED_TYPES, "")}, 'it''s'))`).unexpected,
    ["it's"],
  );
  // A definition with no literals at all fails on every value.
  assert.equal(
    assertionVerdict("CHECK ((type IS NOT NULL))").missing.length,
    EXPECTED_TYPES.length,
  );
});

test("history is written as the table owner on every plan change, and the service role still cannot write it", () => {
  assert.deepEqual(historyWriterRunsAsOwner(sql), []);
  // Source pin only: that Postgres runs a SECURITY DEFINER trigger function as
  // its owner, and fires row triggers on a cascaded delete, is Postgres's
  // behaviour, not something this file executed.
});

test("a plan can be removed on purpose: actor required, recorded as a history DELETE, history kept", () => {
  assert.deepEqual(removalIsAudited(sql), []);
  // History has no foreign key to plans, so removing a plan cannot cascade into it.
  const history = sql.slice(
    sql.indexOf("create table if not exists public.company_plan_history ("),
    sql.indexOf("create index if not exists company_plan_history_company_changed_idx"),
  );
  assert.match(history, /company_id\s+uuid not null,/);
  assert.doesNotMatch(history, /references/);
});

test("only cv_scored and interview_sent are capped; the month is Karachi's calendar month", () => {
  assert.match(
    fnBody(sql, "consume_allowance"),
    /p_metric not in \('cv_scored', 'interview_sent'\)/,
  );
  assert.match(
    sql,
    /date_trunc\('month', now\(\) at time zone 'Asia\/Karachi'\)\s+at time zone 'Asia\/Karachi'/,
  );
  // WhatsApp is tracked, not capped: no limit column that nothing enforces.
  // Checked against the table definition, since the header names the absence.
  const plans = sql.slice(
    sql.indexOf("create table if not exists public.company_plans ("),
    sql.indexOf("alter table public.company_plans enable row level security;"),
  );
  assert.match(plans, /cv_scoring_limit\s+integer/, "slice found the table");
  assert.doesNotMatch(plans, /whatsapp/);
});

test("no company UUID is hard-coded", () => {
  assert.doesNotMatch(sql, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
});

test("plans default to USD; pricing is USD with a PKR rate and a fixed-cost split", () => {
  assert.match(
    sql,
    /currency\s+text not null default 'USD' check \(currency in \('USD', 'PKR'\)\)/,
  );
  assert.match(sql, /currency\s+text not null default 'USD' check \(currency = 'USD'\)/);
  assert.match(sql, /pkr_per_usd\s+numeric\(12,4\) check \(pkr_per_usd > 0\)/);
  assert.match(
    sql,
    /clients_sharing_fixed_cost integer not null default 1 check \(clients_sharing_fixed_cost >= 1\)/,
  );
});

test("the functions are callable by the service role only", () => {
  const esc = (s) => s.replace(/[()]/g, "\\$&");
  for (const sig of [
    "consume_allowance(uuid, text, uuid)",
    "release_allowance(uuid)",
    "remove_company_plan(uuid, uuid)",
    "set_company_plan(uuid, uuid, text, integer, integer, integer, numeric, text, text)",
  ]) {
    assert.match(
      sql,
      new RegExp(
        `revoke all on function public\\.${esc(sig)}\\s+from public, anon, authenticated;`,
      ),
      sig,
    );
    assert.match(
      sql,
      new RegExp(`grant execute on function public\\.${esc(sig)}\\s+to service_role;`),
      sig,
    );
  }
  for (const t of ["company_plans", "company_plan_history", "pricing_settings"]) {
    assert.match(sql, new RegExp(`alter table public\\.${t} enable row level security;`));
    assert.match(sql, new RegExp(`revoke all on table public\\.${t}\\s+from anon, authenticated;`));
  }
});

/* ── deploying it changes no behaviour ────────────────────────── */

/*
 * Step 1 pinned that nothing touched any of this. Step 2 added the read-only
 * Usage tab. Step 3 added plan editing. Step 4 enforces the CV-scoring cap and
 * Step 5 the async interview cap, so the pin now states the shape that keeps
 * enforcement in two known places and every plan change audited: the
 * allowance functions are called from exactly two modules, one per metric;
 * the two plan functions from exactly one other;
 * only those two and the Usage reader name the new tables; none writes the
 * plan tables directly, and the Usage reader and the allowance module write
 * nothing but through their functions.
 */
test("allowance functions have one caller; plan writes have one caller; no direct plan-table writes", () => {
  const src = fileURLToPath(new URL("../../", import.meta.url));
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = join(dir, e.name);
      if (e.isDirectory()) return walk(p);
      return /\.(ts|tsx|mjs)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
    });
  // Code only: doc comments may name a function to say it is not called.
  const code = (f) =>
    readFileSync(f, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
  // Application code only: test-support fixtures name these tables as fake data.
  const files = walk(src).filter((f) => !relative(src, f).startsWith("test-support/"));
  const rel = (list) => list.map((f) => relative(src, f));

  assert.deepEqual(rel(files.filter((f) => /consume_allowance|release_allowance/.test(code(f)))), [
    "lib/cv-allowance.ts",
    "lib/interview-allowance.ts",
  ]);
  assert.deepEqual(rel(files.filter((f) => /set_company_plan|remove_company_plan/.test(code(f)))), [
    "lib/plans-admin.ts",
  ]);
  const tableUsers = files.filter((f) =>
    /company_plans|company_plan_history|pricing_settings/.test(code(f)),
  );
  // Step 6 added the company's own read-only view (lib/company-usage.ts).
  assert.deepEqual(rel(tableUsers), [
    "lib/company-usage.ts",
    "lib/cv-allowance.ts",
    "lib/plans-admin.ts",
    "lib/plans-usage.ts",
  ]);
  for (const f of tableUsers) {
    assert.doesNotMatch(
      code(f),
      /from\(\s*["'](company_plans|company_plan_history)["']\s*\)\s*\.(insert|update|upsert|delete)\(/,
      relative(src, f),
    );
  }
  for (const reader of ["lib/plans-usage.ts", "lib/company-usage.ts"]) {
    const f = tableUsers.find((x) => relative(src, x) === reader);
    assert.doesNotMatch(code(f), /\.(insert|update|upsert|delete|rpc)\(/, reader);
  }
  const allowance = tableUsers.find((f) => f.endsWith("cv-allowance.ts"));
  assert.doesNotMatch(code(allowance), /\.(insert|update|upsert|delete)\(/);
  assert.deepEqual(
    [...code(allowance).matchAll(/\.rpc\("([a-z_]+)"/g)].map((m) => m[1]),
    ["consume_allowance", "release_allowance"],
  );
  // The interview module writes nothing directly and consumes only its own metric.
  const interview = files.find((f) => f.endsWith("lib/interview-allowance.ts"));
  assert.doesNotMatch(code(interview), /\.(from|insert|update|upsert|delete)\(/);
  assert.deepEqual(
    [...code(interview).matchAll(/\.rpc\("([a-z_]+)"/g)].map((m) => m[1]),
    ["consume_allowance", "release_allowance"],
  );
  assert.match(code(interview), /INTERVIEW_SENT_METRIC = "interview_sent";/);
  assert.match(code(interview), /p_metric: INTERVIEW_SENT_METRIC,/);
  assert.doesNotMatch(code(interview), /cv_scored/);
  assert.doesNotMatch(code(allowance), /interview_sent/);
});
