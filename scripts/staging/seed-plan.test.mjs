/**
 * Seed invariants, and the source pins that keep them honest.
 *
 *   node --test "scripts/staging/*.test.mjs"
 *
 * Two kinds of test here, and the second kind is the one that matters.
 *
 * INVARIANTS assert the plan has the shape the brief asked for: all seven
 * message statuses, all five interview chips including cancelled, a
 * skipped-heavy score mix, a job tail that brackets the 1,000-row page.
 *
 * PINS re-read shipped source and fail when a vocabulary here has drifted from
 * it. Without them every invariant above is self-referential — the plan would
 * agree with its own copy of the enum forever, including after someone adds a
 * status the seed then never writes. Each pin asserts its match was FOUND
 * before asserting anything about the content, so a moved constant goes red
 * rather than quietly matching nothing.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  APPLICANT_PAGE_SIZE,
  APPLICATION_TIE_BLOCK,
  APPLICATIONS_WITHOUT_SCORE_ROW,
  apportion,
  buildPlan,
  CHIP_STATUSES,
  enrich,
  FULL_SCALE,
  INTERNAL_PAGE,
  JOB_APPLICANT_COUNTS,
  JOB_REQUIRED,
  JOB_STATUS,
  MESSAGE_CANCELLED,
  MESSAGE_CHANNELS,
  MESSAGE_EVENT_MANUAL,
  MESSAGE_HIDDEN_STATUS,
  MESSAGE_ORPHAN_COLUMN,
  MESSAGE_ORPHANS,
  MESSAGE_STATUSES,
  MESSAGE_TIE_BLOCK,
  MESSAGE_TOTAL,
  MESSAGES_PAGE_SIZE,
  notCovered,
  PIPELINE_STAGES,
  SCORE_STATUSES,
  SESSION_ARCHIVED,
  SESSION_STATUSES,
  SESSION_TOTAL,
  SKIPPED_WITH_ADJUSTMENT,
  scaled,
  TOTAL_APPLICANTS,
} from "./seed-plan.mjs";

// fileURLToPath, not .pathname: this checkout's path contains spaces, which a
// URL percent-encodes and fs does not decode.
const ROOT = new URL("../../", import.meta.url);
const read = (rel) => {
  const p = fileURLToPath(new URL(rel, ROOT));
  assert.ok(existsSync(p), `pin source is missing: ${rel}. Re-point this pin before trusting it.`);
  return readFileSync(p, "utf8");
};

/**
 * The production schema dump, which is the ONLY schema authority (AGENTS.md).
 * schema.sql at the workspace root was proven wrong in both directions and is
 * never read here. The dump lives outside the repo; a missing dump is a RED
 * pin, not a skipped one, because a pin that silently stops reading its
 * source is a pin that agrees with anything.
 */
const DUMP_PATH = process.env.REMOTIV_SCHEMA_DUMP ?? "/tmp/remotiv-prod-schema.sql";
const dump = () => {
  assert.ok(
    existsSync(DUMP_PATH),
    `the production schema dump is not at ${DUMP_PATH}. Take it as README-steps.md step 1 ` +
      `describes, or point REMOTIV_SCHEMA_DUMP at it. schema.sql is never used.`,
  );
  return readFileSync(DUMP_PATH, "utf8");
};

const COMPANY = "00000000-0000-4000-8000-000000000001";
const COMPANY_NAME = "Staging Fixture";
const plan = buildPlan({ companyId: COMPANY, companyName: COMPANY_NAME, applicants: FULL_SCALE });
const SMOKE = 50;
const smoke = buildPlan({ companyId: COMPANY, companyName: COMPANY_NAME, applicants: SMOKE });

/** Asserts a regex matched before anything is concluded from it. */
function pin(src, re, what) {
  const m = src.match(re);
  assert.ok(m, `${what}: pattern did not match. Re-point this pin before trusting it.`);
  return m;
}

/**
 * The column lines of one CREATE TABLE in the dump, as { name, notNull, hasDefault }.
 *
 * Asserts the table was found and has columns before returning, so a renamed
 * table yields a red pin rather than an empty list that every loop passes over.
 */
function dumpColumns(src, table) {
  const m = pin(
    src,
    new RegExp(`CREATE TABLE public\\.${table} \\(\\n([\\s\\S]*?)\\n\\);`),
    `CREATE TABLE ${table}`,
  );
  const cols = m[1]
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("CONSTRAINT"))
    .map((l) => {
      const name = l.match(/^"?([a-z_]+)"?\s/)[1];
      return { name, notNull: /\bNOT NULL\b/.test(l), hasDefault: /\bDEFAULT\b/.test(l) };
    });
  assert.ok(cols.length > 3, `${table}: only ${cols.length} columns parsed`);
  return cols;
}

/** The quoted values of one CHECK (... = ANY (ARRAY[...])) constraint in the dump. */
function dumpCheckValues(src, constraint) {
  const m = pin(
    src,
    new RegExp(`CONSTRAINT ${constraint} CHECK \\(\\([a-z_]+ = ANY \\(ARRAY\\[([^\\]]*)\\]`),
    constraint,
  );
  const values = [...m[1].matchAll(/'([A-Za-z_ -]+)'/g)].map((x) => x[1]);
  assert.ok(values.length > 0, `${constraint}: no values parsed`);
  return values;
}

/* ─────────────────────────── source pins ─────────────────────────── */

test("pin: PIPELINE_STAGES matches applicant-types.ts", () => {
  const src = read("src/app/ai-dashboard/lib/applicant-types.ts");
  const m = pin(src, /export const PIPELINE_STAGES = \[([\s\S]*?)\] as const;/, "PIPELINE_STAGES");
  const shipped = [...m[1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]);
  assert.deepEqual(PIPELINE_STAGES, shipped);
});

test("pin: Messages hides cancelled and excludes orphans", () => {
  const src = read("src/app/ai-dashboard/(gated)/messages/actions.ts");
  const hidden = pin(src, /const HIDDEN_STATUS = "([a-z_]+)"/, "HIDDEN_STATUS");
  const orphan = pin(src, /const ORPHAN_COLUMN = "([a-z_]+)"/, "ORPHAN_COLUMN");
  assert.equal(MESSAGE_HIDDEN_STATUS, hidden[1]);
  assert.equal(MESSAGE_ORPHAN_COLUMN, orphan[1]);
  // The filters must still be applied, not merely declared.
  assert.match(src, /\.neq\("status", HIDDEN_STATUS\)/, "the hidden-status filter is gone");
  assert.match(src, /\.not\(ORPHAN_COLUMN, "is", null\)/, "the orphan filter is gone");
});

test("pin: applyTab splits Written from Automatic on event === manual", () => {
  const src = read("src/app/ai-dashboard/(gated)/messages/actions.ts");
  const m = pin(src, /function applyTab[\s\S]{0,600}?\n}/, "applyTab");
  assert.match(m[0], /tab === "scheduled"\) return q\.eq\("status", "queued"\)/);
  assert.match(
    m[0],
    /tab === "written"\) return q\.eq\("event", "manual"\)\.neq\("status", "queued"\)/,
  );
  assert.match(
    m[0],
    /tab === "automatic"\) return q\.neq\("event", "manual"\)\.neq\("status", "queued"\)/,
  );
  assert.equal(MESSAGE_EVENT_MANUAL, "manual");
});

test("pin: the interview chips hidden at zero are cancelled and archived", () => {
  const src = read("src/app/ai-dashboard/(gated)/interviews/_interviews-client.tsx");
  const m = pin(
    src,
    /const HIDDEN_AT_ZERO: readonly InterviewTab\[\] = \[([^\]]*)\]/,
    "HIDDEN_AT_ZERO",
  );
  const hidden = [...m[1].matchAll(/"([a-z]+)"/g)].map((x) => x[1]);
  assert.deepEqual(hidden, ["cancelled", "archived"]);
  // The reason the seed must write both: a zero count removes the element.
  assert.ok(
    CHIP_STATUSES.includes("cancelled"),
    "cancelled must be a seeded chip status or its chip never renders",
  );
});

test("pin: migration 020 widened session status to six, and abandoned has no chip", () => {
  const src = read("src/lib/supabase/migrations/020_interview_session_restart.sql");
  const m = pin(src, /check \(status in \(([^)]*)\)\)/, "interview_sessions_status_check");
  const allowed = [...m[1].matchAll(/'([a-z]+)'/g)].map((x) => x[1]);
  assert.deepEqual(SESSION_STATUSES, allowed, "the seed's status list must match the constraint");
  assert.equal(allowed.length, 6, "schema.sql says five; the migration says six");
  // abandoned is legal in the database and has no chip, so the five-chip
  // exhaustiveness invariant holds only while nothing writes it.
  const unchipped = allowed.filter((s) => !CHIP_STATUSES.includes(s));
  assert.deepEqual(unchipped, ["abandoned"]);
  assert.equal(
    plan.sessions.filter((s) => s.status === "abandoned").length,
    0,
    "seeding abandoned would break the all = sum-of-five-chips invariant",
  );
});

test("pin: the internal page size is still 1,000 at both paged reads", () => {
  const scope = read("src/app/ai-dashboard/lib/job-scope.ts");
  const applicants = read("src/app/ai-dashboard/(gated)/applicants/actions.ts");
  pin(scope, /const PAGE = 1000;/, "job-scope PAGE");
  pin(applicants, /const PAGE = 1000;/, "rescoreJob PAGE");
  assert.equal(INTERNAL_PAGE, 1000);
});

test("pin: the message status vocabulary matches the live CHECK constraint", () => {
  const src = dump();
  const m = pin(
    src,
    /communication_logs_status_check CHECK \(\(status = ANY \(ARRAY\[([^\]]*)\]/,
    "status check",
  );
  const allowed = [...m[1].matchAll(/'([a-z]+)'/g)].map((x) => x[1]);
  assert.deepEqual(MESSAGE_STATUSES, allowed);
  assert.equal(allowed.length, 7, "the brief asks for all seven");
});

test("pin: the score status vocabulary matches the live CHECK constraint", () => {
  const src = dump();
  const m = pin(
    src,
    /application_scores_status_check CHECK \(\(status = ANY \(ARRAY\[([^\]]*)\]/,
    "score check",
  );
  const allowed = [...m[1].matchAll(/'([a-z]+)'/g)].map((x) => x[1]);
  assert.deepEqual(SCORE_STATUSES, allowed);
});

/*
 * ── Pins against the dump's NOT NULL and CHECK constraints ───────
 *
 * A column-existence preflight (seed.mjs) cannot see NOT NULL or CHECK, and
 * the first version of this plan would have failed at the jobs insert on four
 * NOT NULL columns and a status outside the CHECK. These pins read the dump's
 * CREATE TABLE and refuse a plan the database would refuse. The dump is the
 * real production dump at DUMP_PATH, taken 2026-10-26; the stale schema.sql is
 * never read (see dump() above and AGENTS.md).
 */

/** What seed.mjs adds at insert time, per table; the plan must not set these. */
const ADDED_AT_INSERT = {
  companies: ["contact_email"],
  jobs: ["status", "created_at"],
  job_applications: ["email", "status", "shortlist_flagged_at"],
  application_scores: ["adjusted_at", "scored_at", "created_at"],
  interview_sessions: ["token_hash", "expires_at", "questions_snapshot"],
};

test("pin: every NOT NULL jobs column without a default is set by the plan or at insert", () => {
  const src = dump();
  const required = dumpColumns(src, "jobs")
    .filter((c) => c.notNull && !c.hasDefault)
    .map((c) => c.name);
  assert.ok(required.length >= 4, `jobs has only ${required.length} required columns parsed`);
  const planned = new Set([...Object.keys(plan.jobs[0]), ...ADDED_AT_INSERT.jobs]);
  for (const col of required) {
    assert.ok(planned.has(col), `jobs.${col} is NOT NULL with no default and nothing sets it`);
  }
});

test("pin: the jobs CHECK lists accept every value the plan writes", () => {
  const src = dump();
  assert.ok(dumpCheckValues(src, "jobs_status_check").includes(JOB_STATUS), JOB_STATUS);
  assert.ok(dumpCheckValues(src, "jobs_category_check").includes(JOB_REQUIRED.category));
  assert.ok(
    dumpCheckValues(src, "jobs_experience_level_check").includes(JOB_REQUIRED.experience_level),
  );
  for (const j of plan.jobs) {
    assert.equal(j.category, JOB_REQUIRED.category);
    assert.equal(j.experience_level, JOB_REQUIRED.experience_level);
    assert.equal(j.company, COMPANY_NAME, "jobs.company is NOT NULL free text");
  }
});

test("pin: pipeline_stage is NOT NULL in the dump, so no planned stage is NULL", () => {
  const src = dump();
  const col = dumpColumns(src, "job_applications").find((c) => c.name === "pipeline_stage");
  assert.ok(col, "pipeline_stage column not found");
  assert.equal(
    col.notNull,
    true,
    "pipeline_stage is nullable now: seed the NULL case so the Applied tab's or() is exercised",
  );
  const nulls = plan.applications.filter((a) => a.pipeline_stage === null).length;
  assert.equal(nulls, 0, `${nulls} planned rows carry a NULL stage the column refuses`);
  for (const s of PIPELINE_STAGES) {
    assert.ok(
      plan.applications.some((a) => a.pipeline_stage === s),
      `no applicant in stage ${s}; its chip would render at zero`,
    );
  }
});

test("pin: every NOT NULL companies column without a default is set at insert", () => {
  const src = dump();
  const required = dumpColumns(src, "companies")
    .filter((c) => c.notNull && !c.hasDefault)
    .map((c) => c.name);
  assert.deepEqual(required, ["name", "contact_email"], "companies' required columns moved");
  for (const col of required) {
    assert.ok(
      col === "name" || ADDED_AT_INSERT.companies.includes(col),
      `companies.${col} is NOT NULL with no default and seed.mjs does not add it`,
    );
  }
});

/* ─────────────────────────── invariants ─────────────────────────── */

test("the job tail brackets the internal page boundary and is not uniform", () => {
  for (const n of [INTERNAL_PAGE - 1, INTERNAL_PAGE, INTERNAL_PAGE + 1]) {
    assert.ok(JOB_APPLICANT_COUNTS.includes(n), `no job has exactly ${n} applicants`);
  }
  assert.equal(Math.min(...JOB_APPLICANT_COUNTS), 1, "no single-applicant job");
  assert.equal(Math.max(...JOB_APPLICANT_COUNTS), 2500);
  const small = JOB_APPLICANT_COUNTS.filter((n) => n < 20).length;
  assert.ok(small >= 4, `only ${small} jobs are smaller than one UI page; the tail is too short`);
  assert.equal(TOTAL_APPLICANTS, 10_000);
  assert.equal(plan.applications.length, TOTAL_APPLICANTS);
});

/* ─────────────────────────── scale ─────────────────────────── */

test("pin: the UI page sizes the NOT COVERED list is computed against", () => {
  const applicants = read("src/app/ai-dashboard/lib/applicant-types.ts");
  const messages = read("src/app/ai-dashboard/(gated)/messages/types.ts");
  const a = pin(applicants, /export const APPLICANT_PAGE_SIZE = (\d+);/, "APPLICANT_PAGE_SIZE");
  const m = pin(messages, /export const MESSAGES_PAGE_SIZE = (\d+);/, "MESSAGES_PAGE_SIZE");
  assert.equal(APPLICANT_PAGE_SIZE, Number(a[1]));
  assert.equal(MESSAGES_PAGE_SIZE, Number(m[1]));
});

test("at FULL_SCALE every scaled count IS the constant: the full run is the fixed point, not a mode", () => {
  const s = scaled(FULL_SCALE);
  assert.deepEqual(s.jobCounts, JOB_APPLICANT_COUNTS);
  assert.deepEqual(
    { ...s, jobCounts: undefined },
    {
      applicants: FULL_SCALE,
      jobCounts: undefined,
      withoutScoreRow: APPLICATIONS_WITHOUT_SCORE_ROW,
      skippedWithAdjustment: SKIPPED_WITH_ADJUSTMENT,
      messages: MESSAGE_TOTAL,
      messageOrphans: MESSAGE_ORPHANS,
      messageCancelled: MESSAGE_CANCELLED,
      sessions: SESSION_TOTAL,
      sessionArchived: SESSION_ARCHIVED,
      applicationTie: APPLICATION_TIE_BLOCK,
      messageTie: MESSAGE_TIE_BLOCK,
    },
  );
  assert.deepEqual(plan.manifest.notCovered, [], "the full run must cover everything");
  assert.deepEqual(notCovered(plan.manifest), []);
});

test("apportion keeps the total exactly and reproduces integer shares", () => {
  assert.deepEqual(apportion([2500, 7500], 10000), [2500, 7500]);
  const fifty = apportion(JOB_APPLICANT_COUNTS, 50);
  assert.equal(
    fifty.reduce((a, b) => a + b, 0),
    50,
  );
  assert.equal(fifty.length, JOB_APPLICANT_COUNTS.length, "every job keeps a slot, even at zero");
  assert.ok(fifty[0] > fifty[1], "the largest job stays the largest");
});

test("at 50 applicants every count is scaled, every surface still has rows, same code path", () => {
  const s = smoke.manifest.scale;
  assert.equal(s.applicants, SMOKE);
  assert.equal(smoke.applications.length, SMOKE);
  assert.ok(s.messages < MESSAGE_TOTAL / 10, `messages were not scaled: ${s.messages}`);
  assert.ok(s.sessions < SESSION_TOTAL / 10, `sessions were not scaled: ${s.sessions}`);
  assert.ok(smoke.scores.length < SMOKE, "some applicants must still have no score row");
  // Every vocabulary is still fully exercised at this scale.
  assert.equal(
    new Set(smoke.applications.map((a) => a.pipeline_stage)).size,
    PIPELINE_STAGES.length,
  );
  assert.deepEqual(
    [...new Set(smoke.messages.map((m) => m.status))].sort(),
    [...MESSAGE_STATUSES].sort(),
  );
  for (const c of CHIP_STATUSES) {
    assert.ok(smoke.manifest.interviews.byStatus[c] > 0, `interview chip ${c} has no rows at 50`);
  }
  assert.ok(smoke.manifest.interviews.expectedArchived > 0);
  for (const st of SCORE_STATUSES)
    assert.ok(
      smoke.scores.some((r) => r.status === st),
      st,
    );
  const mx = smoke.manifest.messages;
  assert.ok(mx.expectedScheduled > 0 && mx.expectedWritten > 0 && mx.expectedAutomatic > 0);
  assert.equal(mx.expectedScheduled + mx.expectedWritten + mx.expectedAutomatic, mx.expectedAll);
  assert.ok(mx.seededCancelled > 0 && mx.seededOrphans > 0);
  // The scoped set is still a real subset.
  const sc = smoke.manifest.scopedApplicationIds;
  assert.ok(sc.length > 0 && sc.length < SMOKE);
});

test("a 50-applicant plan reports the internal page boundary as NOT COVERED, never silently", () => {
  const nc = smoke.manifest.notCovered;
  assert.ok(nc.length > 0, "a small run that claims full coverage is a false green");
  assert.ok(
    nc.some((n) => n.includes("internal page boundary")),
    `the 1,000-row boundary is not reachable at 50 and must be listed:\n${nc.join("\n")}`,
  );
  assert.ok(
    nc.some((n) => n.includes("#23")),
    "#23's tie-block boundary must be listed",
  );
  assert.ok(
    nc.some((n) => n.includes("#25")),
    "#25's chunking must be listed",
  );
  assert.ok(
    nc.some((n) => n.includes("2,500-applicant")),
    "the 2,500 job must be listed",
  );
  for (const n of nc) assert.match(n, /\d/, `each entry names the number that falls short: ${n}`);
});

test("buildPlan refuses a missing, zero, negative or fractional applicant count", () => {
  for (const bad of [undefined, 0, -5, 12.5, "50", Number.NaN]) {
    assert.throws(
      () => buildPlan({ companyId: COMPANY, companyName: COMPANY_NAME, applicants: bad }),
      /positive integer applicant count/,
      `accepted ${String(bad)}`,
    );
  }
});

test("every application id is unique, and the plan is byte-identical across runs", () => {
  const ids = plan.applications.map((a) => a.id);
  assert.equal(new Set(ids).size, ids.length, "the seed would insert a duplicate id");
  const again = buildPlan({
    companyId: COMPANY,
    companyName: COMPANY_NAME,
    applicants: FULL_SCALE,
  });
  assert.deepEqual(again.manifest.applicationIdsAll, plan.manifest.applicationIdsAll);
  assert.deepEqual(again.manifest.messages, plan.manifest.messages);
});

test("every job sets ai_cv_scoring_enabled explicitly false, never null", () => {
  for (const j of plan.jobs) {
    assert.equal(j.ai_cv_scoring_enabled, false, `job ${j.title} would be scoring-enabled`);
  }
});

test("messages cover all seven statuses and both channels", () => {
  const seen = new Set(plan.messages.map((m) => m.status));
  assert.deepEqual([...seen].sort(), [...MESSAGE_STATUSES].sort());
  const channels = new Set(plan.messages.map((m) => m.channel));
  assert.deepEqual([...channels].sort(), [...MESSAGE_CHANNELS].sort());
  for (const c of MESSAGE_CHANNELS) {
    assert.ok(
      plan.messages.filter((m) => m.channel === c).length > 100,
      `channel ${c} has too few rows to page`,
    );
  }
});

test("the hidden status and the orphans are seeded, and both are excluded from the expectation", () => {
  const { messages: mx } = plan.manifest;
  assert.ok(mx.seededCancelled > 0, "nothing tests the hidden-status filter");
  assert.ok(mx.seededOrphans > 0, "nothing tests the orphan filter");
  assert.equal(mx.expectedAll, plan.messages.length - mx.seededCancelled - mx.seededOrphans);
  // Orphans must span statuses, so the two filters are independent.
  const orphanStatuses = new Set(
    plan.messages.filter((m) => m.application_id === null).map((m) => m.status),
  );
  assert.ok(orphanStatuses.size >= 5, "orphans do not span enough statuses to isolate the filter");
});

test("the three message tabs are each non-empty and exhaustive over the visible rows", () => {
  const { messages: mx } = plan.manifest;
  for (const [k, v] of Object.entries({
    scheduled: mx.expectedScheduled,
    written: mx.expectedWritten,
    automatic: mx.expectedAutomatic,
  })) {
    assert.ok(v > 0, `the ${k} tab would be empty, so its filter is untested`);
  }
  assert.equal(
    mx.expectedScheduled + mx.expectedWritten + mx.expectedAutomatic,
    mx.expectedAll,
    "the tabs are not exhaustive over All, so the reconciliation cannot be asserted",
  );
});

test("interviews cover all five chip statuses, with archived rows as a separate dimension", () => {
  const { interviews } = plan.manifest;
  for (const s of CHIP_STATUSES) {
    assert.ok(interviews.byStatus[s] > 0, `chip ${s} has no live rows, so it renders at zero`);
  }
  assert.ok(interviews.expectedArchived > 0, "the archived chip would be hidden at zero");
  assert.equal(
    Object.values(interviews.byStatus).reduce((a, b) => a + b, 0),
    interviews.expectedLiveTotal,
    "the five chips are not exhaustive over the live rows",
  );
});

test("the score mix is skipped-heavy, so NULLS LAST is actually exercised", () => {
  const skipped = plan.scores.filter((s) => s.status === "skipped").length;
  const share = skipped / plan.scores.length;
  assert.ok(share > 0.6, `only ${(share * 100).toFixed(1)}% skipped; production is ~67.6%`);
  const nullShare = plan.manifest.bestMatch.effectiveNull / plan.applications.length;
  assert.ok(
    nullShare > 0.7,
    `only ${(nullShare * 100).toFixed(1)}% of rows sort through the NULL branch`,
  );
  for (const s of SCORE_STATUSES) {
    assert.ok(
      plan.scores.some((r) => r.status === s),
      `no ${s} score rows`,
    );
  }
});

test("some rows have no score row at all, and some skipped rows carry a human adjustment", () => {
  assert.equal(plan.applications.length - plan.scores.length, APPLICATIONS_WITHOUT_SCORE_ROW);
  const adjustedSkipped = plan.scores.filter(
    (s) => s.status === "skipped" && s.human_adjusted_score !== null,
  );
  assert.equal(adjustedSkipped.length, SKIPPED_WITH_ADJUSTMENT);
  // These are the rows whose effective_score is non-NULL despite not being
  // "scored" — the branch a pure-skipped seed would never produce.
  assert.ok(adjustedSkipped.every((s) => s.overall_score === null));
});

test("Best Match has large tie groups to break", () => {
  const groups = Object.values(plan.manifest.bestMatch.tiedGroups);
  assert.ok(groups.length >= 5, "too few distinct tied values");
  for (const n of groups) assert.ok(n > 100, `a tie group of ${n} is too small to order through`);
});

test("created_at collides on purpose, in both tables", () => {
  const appTimes = plan.applications.map((a) => a.created_at);
  const biggest = Math.max(...Object.values(appTimes.reduce(tally, {})));
  assert.ok(biggest >= 500, `largest created_at tie is ${biggest} rows; need a real block`);
  assert.equal(APPLICATION_TIE_BLOCK, 500);
  const msgTimes = plan.messages.map((m) => m.created_at);
  assert.ok(Math.max(...Object.values(msgTimes.reduce(tally, {}))) >= 300);
  assert.equal(MESSAGE_TIE_BLOCK, 300);
});

test("the scoped expectation crosses the internal page boundary and is a real subset", () => {
  const { scopedApplicationIds, applicationIdsAll, scopedJobIds } = plan.manifest;
  assert.ok(scopedJobIds.length >= 2, "a single-job scope would not chunk");
  assert.ok(
    scopedApplicationIds.length > INTERNAL_PAGE,
    `the scoped set is ${scopedApplicationIds.length} rows, which never crosses the ` +
      `${INTERNAL_PAGE}-row page where the defect lives`,
  );
  assert.ok(
    scopedApplicationIds.length < applicationIdsAll.length,
    "a scope covering everything proves nothing about scoping",
  );
  const all = new Set(applicationIdsAll);
  assert.ok(scopedApplicationIds.every((id) => all.has(id)));
  assert.equal(new Set(scopedApplicationIds).size, scopedApplicationIds.length);
});

/* ──────────────────────────── enrich ──────────────────────────── */

test("enrich adds the columns the plan does not model", () => {
  assert.deepEqual(enrich({ id: "a", status: "sent" }, { email: "x@example.invalid" }), {
    id: "a",
    status: "sent",
    email: "x@example.invalid",
  });
});

test("enrich REFUSES to overwrite a field the manifest counts", () => {
  // The false-green this guard exists for: silently winning here would leave
  // the manifest claiming 600 cancelled messages while the table held none,
  // and the harness would then measure a real read against a fiction.
  for (const key of ["status", "created_at", "archived_at", "event", "id"]) {
    let caught;
    try {
      enrich({ [key]: "planned" }, { [key]: "overwritten" });
    } catch (e) {
      caught = e;
    }
    assert.ok(caught, `DID NOT THROW on \`${key}\``);
    assert.match(caught.message, new RegExp(`\`${key}\``), "the message must name the key");
  }
});

test("enrich refuses a NULL the plan deliberately set", () => {
  // `key in row` rather than a truthiness test: archived_at is null on 1,250 of
  // the 1,400 sessions, and `row.archived_at || extra` would overwrite every one
  // of them while the guard reported nothing.
  assert.throws(() => enrich({ archived_at: null }, { archived_at: "2026-01-01" }), /archived_at/);
});

test("enrich does not mutate the planned row", () => {
  const row = { id: "a" };
  enrich(row, { email: "x@example.invalid" });
  assert.deepEqual(row, { id: "a" }, "the plan's rows are read twice: to insert and to count");
});

test("every column seed.mjs adds is absent from the planned row it widens", () => {
  // The same invariant from the other side. If the plan ever starts setting one
  // of these, seed.mjs's enrich call throws mid-run against the real database;
  // this fails first, offline, and names the field.
  const added = {
    jobs: ADDED_AT_INSERT.jobs,
    applications: ADDED_AT_INSERT.job_applications,
    scores: ADDED_AT_INSERT.application_scores,
    sessions: ADDED_AT_INSERT.interview_sessions,
  };
  for (const [collection, keys] of Object.entries(added)) {
    const rows = plan[collection];
    assert.ok(rows.length > 0, `plan.${collection} is empty, so this checks nothing`);
    for (const key of keys) {
      assert.ok(
        !(key in rows[0]),
        `plan.${collection} now sets \`${key}\`, which seed.mjs also adds - one must stop`,
      );
    }
  }
});

function tally(acc, v) {
  acc[v] = (acc[v] ?? 0) + 1;
  return acc;
}
