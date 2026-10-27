/**
 * Writes the staging fixture, proves the app can see it, then emits the manifest.
 *
 *   node --env-file=.env.staging scripts/staging/seed.mjs --applicants=50
 *   node --env-file=.env.staging scripts/staging/seed.mjs --applicants=10000
 *   node --env-file=.env.staging scripts/staging/seed.mjs --applicants=50 --verify-only
 *
 * The applicant count is required (see applicantsArg). The 50-row smoke run
 * and the 10,000-row full run are the same code path at a different scale;
 * seed-plan.mjs scales every count and records what the scale cannot cover.
 *
 * ── This file does not decide WHAT the data looks like ───────
 *
 * Every distribution lives in seed-plan.mjs, a pure function covered by
 * seed-plan.test.mjs. This file does four things to that plan: it adds the
 * columns the database requires and the plan does not model, it inserts in
 * committed batches, it proves what landed is visible through the application,
 * and it writes the manifest.
 *
 * ── "seed complete" is printed only after the REAL scoped read ─
 *
 * A service-role census proves rows reached the tables. It is NOT a visibility
 * proof, and an earlier version of this file reproduced the dashboard's filter
 * chain by hand and called the agreement a pass: a reimplementation can agree
 * with itself while both are wrong. So the last step here signs in as the
 * job-scoped recruiter and calls the application's own scopedApplicationIds,
 * in the app's runtime, through /api/staging-probe/scoped-application-ids,
 * and compares the ids it returns against the manifest the plan generated.
 * If that route cannot be reached, the seed prints SEED WRITTEN BUT NOT
 * COMPLETE and exits 1. `--verify-only` re-runs that step without writing.
 *
 * ── Two limits, monitored between tables ─────────────────────
 *
 * Free plan: a 500 MB database quota and a separate 2 GB disk that WAL fills
 * independently. Inserts go through PostgREST in 500-row batches, each its own
 * committed transaction, so WAL is checkpointed and recycled during the run
 * rather than held. After every table, staging_guard.usage() is read and the
 * seed aborts at the thresholds in guard-db-checks.mjs.
 *
 * ── The queue must be empty afterwards ───────────────────────
 *
 * The restored schema keeps migration 040's trigger that enqueues a cleanup
 * job when a final-interview bot row is deleted. Three reasons say it cannot
 * fire here; assertQueueEmpty is the measurement that it did not.
 *
 * ── Why it does not go through /api/apply ────────────────────
 *
 * The real intake path enqueues CV scoring and sends a confirmation email.
 * 10,000 synthetic CVs through the real scorer is a bill, not a test. The cost
 * of this choice is that the seed does NOT exercise intake, which is a
 * different test from the one asked for.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  assertAccountFree,
  assertAccountUsable,
  ACCOUNTS as STAGING_ACCOUNTS,
} from "./accounts.mjs";
import { proveAppIdentity } from "./app-identity.mjs";
import { assertSameIdSet } from "./assertions.mjs";
import { enumViolations, parseCheckEnums } from "./constraints.mjs";
import {
  assertQueueEmpty,
  assertScoringDisabled,
  assertUsageWithinLimits,
  loadPin,
  openStaging,
  signInStagingAccount,
} from "./guard.mjs";
import { sessionCookieHeader } from "./probe-session.mjs";
import {
  buildPlan,
  CHIP_STATUSES,
  enrich,
  JOB_REQUIRED,
  JOB_STATUS,
  MESSAGE_EVENT_MANUAL,
  MESSAGE_EVENTS_AUTOMATIC,
  MESSAGE_STATUSES,
  PIPELINE_STAGES,
  SCORE_STATUSES,
  uuidFrom,
} from "./seed-plan.mjs";

const VERIFY_ONLY = process.argv.includes("--verify-only");

/**
 * Remove the fixture and stop. Its first real use follows a partial seed that
 * a mid-table constraint failure left behind; guard check 7 (target table
 * empty) then refuses the next seed, and reseeding over a half-fixture would
 * make every figure meaningless. README-steps.md step 12.
 */
const TEARDOWN = process.argv.includes("--teardown");

/**
 * The applicant count is a REQUIRED parameter, not a mode.
 *
 *   --applicants=50      the smoke run: same code path, same plan shape in miniature
 *   --applicants=10000   the full run
 *
 * No default, so a forgotten flag cannot seed 10,000 rows, and a 50-row run
 * cannot be mistaken for the full one: the manifest records the scale and the
 * harness prints everything that scale leaves NOT COVERED.
 */
function applicantsArg(argv) {
  const raw = argv.find((a) => a.startsWith("--applicants="))?.slice("--applicants=".length);
  const n = Number(raw);
  if (raw === undefined || !/^\d+$/.test(raw) || !Number.isInteger(n) || n <= 0) {
    throw new Error(
      "pass --applicants=<positive integer>. There is no default: 50 for the smoke run, " +
        "10000 for the full run (README-steps.md step 9).",
    );
  }
  return n;
}
const APPLICANTS = TEARDOWN ? 0 : applicantsArg(process.argv);

/**
 * The enumerated values the seed WRITES, per `table.column`, each pointing at
 * the single source it is written from — the plan's own constants and the
 * insert-time literals below — so this map cannot drift from what lands in the
 * rows. The enum preflight checks every one against the dump's CHECK
 * constraints before the first insert. Columns with no CHECK (channel,
 * from_stage/to_stage) are free and absent here.
 */
const MEMBER_ROLE_OWNER = "owner";
const MEMBER_ROLE_SCOPED = "recruiter";
const MEMBER_STATUS = "active";
const TEAM_ROLE = "recruiter";
const APPLICATION_STATUS = "new";
const TRANSCRIPT_STATUS = "skipped";

const ENUM_WANTED = {
  "company_members.role": [MEMBER_ROLE_OWNER, MEMBER_ROLE_SCOPED],
  "company_members.status": [MEMBER_STATUS],
  "job_hiring_team.team_role": [TEAM_ROLE],
  "jobs.status": [JOB_STATUS],
  "jobs.category": [JOB_REQUIRED.category],
  "jobs.experience_level": [JOB_REQUIRED.experience_level],
  "job_applications.status": [APPLICATION_STATUS],
  "job_applications.pipeline_stage": PIPELINE_STAGES,
  "application_scores.status": SCORE_STATUSES,
  "communication_logs.event": [MESSAGE_EVENT_MANUAL, ...MESSAGE_EVENTS_AUTOMATIC],
  "communication_logs.status": MESSAGE_STATUSES,
  "interview_sessions.status": CHIP_STATUSES,
  "interview_answers.transcript_status": [TRANSCRIPT_STATUS],
};

/** The schema dump the staging DB was restored from; the enum authority. */
const SCHEMA_DUMP_PATH = process.env.REMOTIV_SCHEMA_DUMP ?? "/tmp/remotiv-prod-schema.sql";

/**
 * Every enumerated value the seed will write, checked against the live CHECK
 * constraints BEFORE the first insert. The column preflight proves the shape;
 * this proves the content. Reads the dump staging was restored from, because
 * PostgREST exposes no pg_catalog; fails closed if it is absent, because an
 * unvalidated enumerated column is exactly what half-wrote communication_logs.
 */
function enumPreflight() {
  console.log(
    "preflight: every enumerated value this seed writes, checked against the schema's CHECK constraints",
  );
  let dumpText;
  try {
    dumpText = readFileSync(SCHEMA_DUMP_PATH, "utf8");
  } catch {
    throw new Error(
      `the schema dump is not at ${SCHEMA_DUMP_PATH}. The enum preflight needs it to learn ` +
        `which values each CHECK constraint permits; PostgREST cannot read pg_catalog, so the ` +
        `running database cannot be asked directly. Set REMOTIV_SCHEMA_DUMP or place the dump ` +
        `(README-steps.md step 1). Refusing to seed values it cannot validate.`,
    );
  }
  const constraints = parseCheckEnums(dumpText);
  const violations = enumViolations(constraints, ENUM_WANTED);
  if (violations.length > 0) {
    const lines = violations.map(
      (v) =>
        `    ${v.column}: the plan writes ${JSON.stringify(v.bad)}, but the constraint allows ` +
        `only ${JSON.stringify(v.allowed)}`,
    );
    throw new Error(
      `the plan writes values the database's CHECK constraints reject:\n${lines.join("\n")}\n` +
        `  Fix the plan to use permitted values. Caught before the first insert, not mid-table.`,
    );
  }
  let checked = 0;
  for (const [col, vals] of Object.entries(ENUM_WANTED)) {
    if (constraints[col]) {
      console.log(
        `  ok  ${col} (${new Set(vals).size} value(s), all within a ${constraints[col].length}-value constraint)`,
      );
      checked += 1;
    } else {
      console.log(`  --  ${col} has no CHECK constraint; free column, not validated`);
    }
  }
  console.log(`  ${checked} enumerated column(s) validated against the dump\n`);
}

/**
 * Delete the fixture company and its applications, then prove nothing of it
 * remains. Applications go first: their link to the company is the
 * `company_id_snapshot` column, which is not a foreign key, so the company
 * delete would SET NULL their `job_id` rather than remove them. The company
 * delete then cascades jobs, members, hiring team, messages, sessions,
 * answers and background jobs. The sentinel, auth users and buckets reference
 * no company, so they are untouched. FK behaviour read from the dump.
 */
async function teardown(service) {
  console.log(`teardown: removing the fixture company ${COMPANY_ID}`);
  const apps = await service
    .from("job_applications")
    .delete({ count: "exact" })
    .eq("company_id_snapshot", COMPANY_ID);
  if (apps.error) throw new Error(`[teardown] job_applications: ${apps.error.message}`);
  const co = await service.from("companies").delete({ count: "exact" }).eq("id", COMPANY_ID);
  if (co.error) throw new Error(`[teardown] companies: ${co.error.message}`);
  console.log(
    `  deleted ${apps.count ?? "?"} job_applications (cascaded scores, stage history) and ` +
      `${co.count ?? "?"} company (cascaded jobs, members, team, messages, sessions, answers)`,
  );

  const left = {};
  for (const [table, col] of [
    ["job_applications", "company_id_snapshot"],
    ["jobs", "company_id"],
    ["communication_logs", "company_id"],
    ["interview_sessions", "company_id"],
    ["company_members", "company_id"],
    ["application_scores", "company_id"],
  ]) {
    const { count, error } = await service
      .from(table)
      .select("id", { count: "exact", head: true })
      .eq(col, COMPANY_ID);
    if (error) throw new Error(`[teardown] recount ${table}: ${error.message}`);
    left[table] = count ?? null;
  }
  const total = Object.values(left).reduce((a, b) => a + (b ?? 0), 0);
  console.log(`  fixture rows remaining: ${JSON.stringify(left)} (total ${total})`);
  if (total !== 0)
    throw new Error(`[teardown] ${total} fixture row(s) remain; teardown incomplete`);
  console.log("teardown complete. staging_guard, the auth users and the buckets were untouched.");
}

const COMPANY_ID = uuidFrom("company");
// A neutral label. The company NAME is not evidence of anything: a row called
// "Staging Fixture" is one anyone could create in production, which is why
// identity is settled by the sentinel in guard-db-checks.mjs instead.
const COMPANY_NAME = `Staging Fixture ${COMPANY_ID.slice(0, 8)}`;
const BATCH = 500;

const SCOPED_ROUTE = "/api/staging-probe/scoped-application-ids";

/** Where the harness reads the expected id sets from. Untracked; see README-steps.md. */
const MANIFEST_PATH = fileURLToPath(new URL("./seed-manifest.json", import.meta.url));

/** A fixed epoch, matching seed-plan's, so enriched timestamps are deterministic too. */
const EPOCH = Date.parse("2026-01-05T09:00:00.000Z");
const at = (i) => new Date(EPOCH + i * 60_000).toISOString();

/** Every seeded session's deadline: far enough out that deriveStatus never expires one. */
const SESSION_DEADLINE = "2099-01-01T00:00:00.000Z";

/**
 * Insert in batches, loudly.
 *
 * `.insert()` of 10,000 rows in one request is a request-size failure, and
 * PostgREST's error for it is not obviously about size. Batched at 500, and
 * every batch's error aborts the run rather than being counted and skipped: a
 * seed that half-wrote is worse than one that did not run, because the harness
 * cannot tell the difference from the outside.
 */
async function insertAll(service, table, rows, label = table) {
  if (rows.length === 0) {
    throw new Error(`[seed] refusing to "insert" 0 rows into ${table}; the plan produced none`);
  }
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const { error } = await service.from(table).insert(chunk);
    if (error) {
      throw new Error(
        `[seed] ${label} failed at rows ${i}-${i + chunk.length - 1} of ${rows.length}: ` +
          `${error.message}`,
      );
    }
    if (i % 2000 === 0 || i + BATCH >= rows.length) {
      process.stdout.write(`\r  ${label}: ${Math.min(i + BATCH, rows.length)}/${rows.length}   `);
    }
  }
  process.stdout.write("\n");
}

/** Both limits, read from the database, printed, and enforced. */
async function usage(service, label) {
  const u = await assertUsageWithinLimits(service, process.env);
  console.log(
    `  usage after ${label}: db ${u.dbMb} MB, wal ${u.walMb ?? "unreadable (dashboard)"} MB, ` +
      `slot ${u.slotMb ?? "n/a"} MB`,
  );
}

/**
 * Prove every column this seed writes actually exists, before writing any.
 *
 * schema.sql has been caught missing real production columns three times, so
 * the column list below cannot be trusted from the repo, and this asks the
 * DATABASE. `.select(cols).limit(0)` returns no rows and errors if any name is
 * unknown. It cannot see NOT NULL or CHECK; seed-plan.test.mjs pins those
 * against the dump instead.
 */
async function preflight(service, plan) {
  console.log("preflight: every column this seed writes, checked against the database");
  const missing = [];
  for (const [table, cols] of Object.entries(plan)) {
    const { error } = await service.from(table).select(cols.join(", ")).limit(0);
    if (error) missing.push(`${table}: ${error.message}`);
    else console.log(`  ok  ${table} (${cols.length} columns)`);
  }
  if (missing.length > 0) {
    throw new Error(
      `the staging database does not have the shape this seed writes:\n    ` +
        missing.join("\n    ") +
        `\n  This is the expected failure if staging was built from schema.sql or ` +
        `from the migrations rather than from a production dump. See ` +
        `README-steps.md step 4.`,
    );
  }
  console.log();
}

const COLUMN_PLAN = {
  companies: ["id", "name", "contact_email", "must_change_password"],
  company_members: ["id", "company_id", "user_id", "role", "status", "name", "email"],
  job_hiring_team: ["id", "job_id", "company_id", "member_id", "team_role"],
  jobs: [
    "id",
    "company_id",
    "company",
    "title",
    "location",
    "category",
    "experience_level",
    "status",
    "ai_cv_scoring_enabled",
    "created_at",
  ],
  job_applications: [
    "id",
    "job_id",
    "first_name",
    "last_name",
    "email",
    "status",
    "pipeline_stage",
    "company_id_snapshot",
    "job_title_snapshot",
    "created_at",
    "shortlist_flagged_at",
  ],
  application_scores: [
    "id",
    "application_id",
    "company_id",
    "job_id",
    "overall_score",
    "human_adjusted_score",
    "adjusted_at",
    "status",
    "ai_model",
    "prompt_version",
    "scored_at",
    "created_at",
  ],
  application_stage_history: [
    "id",
    "application_id",
    "company_id",
    "from_stage",
    "to_stage",
    "created_at",
  ],
  communication_logs: [
    "id",
    "company_id",
    "application_id",
    "event",
    "channel",
    "to_address",
    "subject",
    "status",
    "created_at",
  ],
  interview_sessions: [
    "id",
    "company_id",
    "application_id",
    "job_id",
    "token_hash",
    "status",
    "archived_at",
    "expires_at",
    "questions_snapshot",
    "created_at",
  ],
  interview_answers: [
    "id",
    "session_id",
    "question_text",
    "position",
    "transcript_status",
    "created_at",
  ],
  background_jobs: ["id", "status"],
};

/**
 * A service-role census of what landed. NOT a visibility proof.
 *
 * Every count here is read with the service key, which bypasses RLS and the
 * dashboard's filter chain entirely. Agreement establishes exactly one thing:
 * the rows the plan describes are in the tables. Still worth running, because
 * a half-written seed and a correctly-written one are indistinguishable from
 * the outside, and the harness would attribute the gap to a pagination defect.
 */
async function census(service, plan) {
  console.log("census (service role, RLS bypassed): did the rows land?");
  console.log("  this is NOT a visibility check; the self-check below goes through the app");

  const expected = {
    jobs: plan.jobs.length,
    job_applications: plan.applications.length,
    application_scores: plan.scores.length,
    communication_logs: plan.messages.length,
    interview_sessions: plan.sessions.length,
  };

  const shortfalls = [];
  for (const [table, want] of Object.entries(expected)) {
    const { count, error } = await service
      .from(table)
      .select("id", { count: "exact", head: true })
      .eq(table === "job_applications" ? "company_id_snapshot" : "company_id", COMPANY_ID);
    if (error) throw new Error(`[seed] census of ${table} failed: ${error.message}`);
    if (typeof count !== "number") {
      // `null > 0` and `null !== want` would both mislead: the first reads as
      // empty, the second as a shortfall of unknown size.
      throw new Error(`[seed] census of ${table} returned ${JSON.stringify(count)}, not a number`);
    }
    if (count !== want) shortfalls.push(`${table}: ${count} rows present, plan wrote ${want}`);
    else console.log(`  ok  ${table}: ${count.toLocaleString("en-US")}`);
  }

  if (shortfalls.length > 0) {
    throw new Error(
      `THE SEED DID NOT WRITE WHAT THE MANIFEST CLAIMS: do not run the harness:\n    ` +
        shortfalls.join("\n    ") +
        `\n  The harness would read these gaps as dropped pages.`,
    );
  }
}

/**
 * The visibility proof: the application's REAL scoped read, in the app's own
 * runtime, as the job-scoped recruiter, compared against what the plan wrote.
 *
 * Not a reimplementation of the filter. Not a second read of the same query.
 * The route calls scopedApplicationIds(ctx, scope) exactly as the Messages
 * page does, and the expected set comes from the manifest the plan generated,
 * so a read that deterministically drops the same fifty rows is caught.
 */
async function proveVisibility(scoped, manifest) {
  const base = process.env.STAGING_BASE_URL;
  if (!base)
    throw new Error("STAGING_BASE_URL is not set; the visibility self-check needs the running app");
  const cookie = sessionCookieHeader(scoped.session, process.env.STAGING_APP_SUPABASE_URL);

  let res;
  try {
    res = await fetch(`${base}${SCOPED_ROUTE}`, { headers: { cookie }, redirect: "manual" });
  } catch {
    throw new Error(`could not reach the app at STAGING_BASE_URL${SCOPED_ROUTE}`);
  }
  if (res.status === 404) {
    throw new Error(
      `${SCOPED_ROUTE} answered 404. Either the app is not pointed at the staging project ` +
        `(the route reads staging_guard.sentinel first and 404s without it), the session was ` +
        `not accepted, or the probe route is not deployed. Visibility is UNPROVEN.`,
    );
  }
  if (res.status !== 200) throw new Error(`${SCOPED_ROUTE} answered ${res.status}`);

  const body = await res.json();
  if (body.scoped !== true) {
    throw new Error(
      `${SCOPED_ROUTE} says the account in STAGING_SCOPED_EMAIL is not job-scoped. The ` +
        `allow-list is only computed for recruiters and hiring managers; check its role.`,
    );
  }
  if (!Array.isArray(body.ids)) throw new Error(`${SCOPED_ROUTE} returned no ids array`);
  assertSameIdSet(body.ids, manifest.scopedApplicationIds, "seed self-check: real scoped read");
  console.log(
    `  visibility: the app's scopedApplicationIds returned all ` +
      `${body.ids.length.toLocaleString("en-US")} expected ids across ${body.jobCount} jobs`,
  );
}

async function main() {
  const { service } = await openStaging({
    intent: TEARDOWN || VERIFY_ONLY ? "harness" : "seed",
  });

  if (TEARDOWN) {
    await teardown(service);
    return;
  }

  // Both accounts must exist in the STAGING project's auth users, created by
  // hand. The seed makes them members of the fixture company below.
  const owner = await signInStagingAccount({
    emailVar: "STAGING_TEST_EMAIL",
    passwordVar: "STAGING_TEST_PASSWORD",
  });
  const scoped = await signInStagingAccount({
    emailVar: "STAGING_SCOPED_EMAIL",
    passwordVar: "STAGING_SCOPED_PASSWORD",
  });
  console.log("  signed in both staging accounts (owner, job-scoped recruiter)");

  // Before any write: both accounts are FREE (no active membership anywhere),
  // because the dashboard resolves the FIRST active row and the seed is about
  // to write the one that must be it. Skipped only when deliberately
  // reseeding over this script's own rows, where the fixture membership exists.
  // After the writes, assertAccountUsable re-reads them the dashboard's way.
  const signedIn = { STAGING_TEST_EMAIL: owner, STAGING_SCOPED_EMAIL: scoped };
  if (!VERIFY_ONLY && process.env.STAGING_RESEED_OVER_EXISTING !== "yes") {
    for (const a of STAGING_ACCOUNTS) {
      await assertAccountFree(service, {
        userId: signedIn[a.emailVar].userId,
        emailVar: a.emailVar,
      });
    }
    console.log("  both accounts are free: no active company membership yet (the seed writes it)");
  }

  const plan = buildPlan({
    companyId: COMPANY_ID,
    companyName: COMPANY_NAME,
    applicants: APPLICANTS,
  });
  console.log(`plan: ${APPLICANTS.toLocaleString("en-US")} applicants`);
  if (plan.manifest.notCovered.length > 0) {
    console.log("  NOT COVERED at this scale (never PASS; the harness prints these again):");
    for (const n of plan.manifest.notCovered) console.log(`    - ${n}`);
  }
  console.log();

  if (!VERIFY_ONLY) {
    await preflight(service, COLUMN_PLAN);
    enumPreflight();
    await usage(service, "nothing (baseline)");

    // must_change_password DEFAULTS TO TRUE in this table (no migration defines
    // the column; the first 50-row run proved it). Left to the default, the
    // gated layout sends every member to /ai-dashboard/change-password?forced=true
    // and no browser login ever reaches /ai-dashboard. assertAccountUsable
    // repeats the dashboard's gate after the write.
    const { error: coErr } = await service.from("companies").insert([
      {
        id: COMPANY_ID,
        name: COMPANY_NAME,
        contact_email: "staging-fixture@example.invalid",
        must_change_password: false,
      },
    ]);
    if (coErr) throw new Error(`[seed] companies: ${coErr.message}`);

    // Membership is what resolves a user to a company (company-access.ts). The
    // owner sees everything; the recruiter sees only the jobs on their hiring
    // team, which is the allow-list #25 measures.
    const ownerMemberId = uuidFrom("member:owner");
    const scopedMemberId = uuidFrom("member:scoped");
    await insertAll(
      service,
      "company_members",
      [
        {
          id: ownerMemberId,
          company_id: COMPANY_ID,
          user_id: owner.userId,
          role: MEMBER_ROLE_OWNER,
          status: MEMBER_STATUS,
          name: "Staging Owner",
          email: owner.email,
        },
        {
          id: scopedMemberId,
          company_id: COMPANY_ID,
          user_id: scoped.userId,
          role: MEMBER_ROLE_SCOPED,
          status: MEMBER_STATUS,
          name: "Staging Recruiter",
          email: scoped.email,
        },
      ],
      "company_members",
    );

    // applicantCount is plan metadata, not a column. Dropped here rather than in
    // the plan, because the manifest's job spread is derived from it.
    const jobRows = plan.jobs.map(({ applicantCount: _ignored, ...j }, i) =>
      enrich(j, { status: JOB_STATUS, created_at: at(i) }),
    );
    assertScoringDisabled(jobRows);
    await insertAll(service, "jobs", jobRows);

    await insertAll(
      service,
      "job_hiring_team",
      plan.manifest.scopedJobIds.map((jobId) => ({
        id: uuidFrom(`team:${jobId}`),
        job_id: jobId,
        company_id: COMPANY_ID,
        member_id: scopedMemberId,
        team_role: TEAM_ROLE,
      })),
      "job_hiring_team",
    );

    const applicationRows = plan.applications.map((a, i) =>
      enrich(a, {
        email: `staging+${i}@example.invalid`,
        status: APPLICATION_STATUS,
        // On a subset only, and the flaggedOnly filter ANDs this with
        // WORTH_A_LOOK_STAGES, so a flag on a rejected row is deliberately inert.
        shortlist_flagged_at: i % 17 === 0 ? at(i) : null,
      }),
    );
    await insertAll(service, "job_applications", applicationRows, "job_applications");
    await usage(service, "job_applications");

    const scoreRows = plan.scores.map((s, i) =>
      enrich(s, {
        // Without adjusted_at, buildAgreement short-circuits and the AI-vs-human
        // agreement panel has nothing to compute over.
        adjusted_at: s.human_adjusted_score === null ? null : at(i),
        scored_at: s.status === "scored" ? at(i) : null,
        created_at: at(i),
      }),
    );
    await insertAll(service, "application_scores", scoreRows, "application_scores");
    await usage(service, "application_scores");

    // Up to three transitions per applicant. This is the table the Analytics
    // funnel and the weekly report drain unbounded, so its size is the point.
    // Identical timestamps for the same application at different stages:
    // analytics/actions.ts:359 orders by (application_id, created_at) and calls
    // that unique. It is not, and this is the fixture that shows it.
    const history = [];
    for (const [i, app] of plan.applications.entries()) {
      for (let s = 0; s <= i % 3; s += 1) {
        history.push({
          id: uuidFrom(`hist:${app.id}:${s}`),
          application_id: app.id,
          company_id: COMPANY_ID,
          from_stage: s === 0 ? null : PIPELINE_STAGES[s - 1],
          to_stage: PIPELINE_STAGES[s],
          created_at: at(i),
        });
      }
    }
    await insertAll(service, "application_stage_history", history, "application_stage_history");
    await usage(service, "application_stage_history");

    await insertAll(service, "communication_logs", plan.messages, "communication_logs");
    await usage(service, "communication_logs");

    const sessionRows = plan.sessions.map((s, i) =>
      enrich(s, {
        // A synthetic digest, not a real token. Nothing can redeem this.
        token_hash: createHash("sha256").update(`staging-not-a-token:${s.id}`).digest("hex"),
        // In the FUTURE, by a wide margin. review.ts deriveStatus returns
        // "expired" for any live session whose deadline has passed before it
        // looks at the stored status, so a past deadline turned every seeded
        // "started" and "invited" row into an expired one and the Interviews
        // chips disagreed with the manifest (first 50-row run, 2026-10-27).
        // at(i + 100_000) was 2026-03-15. A fixed far date, so the seed does
        // not silently start expiring again on some later calendar day.
        expires_at: SESSION_DEADLINE,
        // Session 0 carries 52 questions: past the silent, UNORDERED .limit(50)
        // at review.ts:554.
        questions_snapshot: Array.from({ length: i === 0 ? 52 : 4 }, (_, q) => ({ id: `q${q}` })),
      }),
    );
    // `kind` is not set, so every session is the default 'async'. Live sessions
    // are NOT seeded; the harness records that as a stated limitation.
    await insertAll(service, "interview_sessions", sessionRows, "interview_sessions");

    // Session 0 carries 60 answers: past the silent .limit(50) at review.ts:477,
    // which renders 50 of them with no count and no flag.
    const answers = [];
    for (const [i, s] of plan.sessions.entries()) {
      for (let q = 0; q < (i === 0 ? 60 : 3); q += 1) {
        answers.push({
          id: uuidFrom(`answer:${s.id}:${q}`),
          session_id: s.id,
          question_text: `Staging question ${q}`,
          position: q,
          transcript_status: TRANSCRIPT_STATUS,
          created_at: at(i),
        });
      }
    }
    await insertAll(service, "interview_answers", answers, "interview_answers");
    await usage(service, "interview_answers (final)");

    await census(service, plan);
    console.log(
      `  queue: background_jobs holds ${await assertQueueEmpty(service)} rows (must be 0)\n`,
    );
  }

  // The RUNNING app proves its identity, isolation and browser connections,
  // as the OWNER, now that the owner has a company membership.
  //
  // Why here and not before the writes: the identity route is gated by
  // getCompanyContext(), which resolves the signed-in user to a company and
  // refuses (code `no-company`) anyone with no active membership. Before the
  // seed writes company_members the owner is FREE, so a pre-write call 404s
  // for that reason — not the sentinel, not the cookie. The writes are safe to
  // run first regardless: openStaging's service-side sentinel (check 6) already
  // proved this is staging before the first insert, and the seed writes through
  // its own service client, which the app's createServiceClient guard does not
  // gate. The app-side browser path is only USED by the harness, later. In
  // --verify-only there were no writes, but the membership from a prior seed
  // already exists, so this resolves the same way.
  const identity = await proveAppIdentity({
    baseUrl: process.env.STAGING_BASE_URL,
    cookie: sessionCookieHeader(owner.session, process.env.STAGING_APP_SUPABASE_URL),
    pin: loadPin(),
    appUrl: process.env.STAGING_APP_SUPABASE_URL,
  });
  console.log(
    `  the running app agrees with the pin and is isolated (${identity.checked} variables confirmed absent)`,
  );

  // The real read, through the app, as the scoped recruiter. If this throws,
  // the data is written and the seed is NOT complete; main().catch says so.
  // Both accounts resolve the way company-access.ts resolves them: first
  // active membership in the fixture company, with the planned role, company
  // active. This is the dashboard's own answer to "can this account sign in
  // and see the fixture", asked before the browser ever tries.
  for (const a of STAGING_ACCOUNTS) {
    await assertAccountUsable(service, {
      userId: signedIn[a.emailVar].userId,
      emailVar: a.emailVar,
      fixtureCompanyId: COMPANY_ID,
      role: a.role,
    });
  }
  console.log(
    "  both accounts are usable: each resolves to the fixture company with its planned role",
  );

  await proveVisibility(scoped, plan.manifest);

  // The manifest is the independently generated expected answer. It is derived
  // from what the plan WROTE, never from a read of the queries under test.
  writeFileSync(MANIFEST_PATH, `${JSON.stringify(plan.manifest, null, 2)}\n`, "utf8");

  console.log(`\nseed complete at ${APPLICANTS.toLocaleString("en-US")} applicants.`);
  console.log(`  manifest: ${MANIFEST_PATH}`);
  console.log(
    `  ${plan.manifest.applicationIdsAll.length.toLocaleString("en-US")} application ids`,
  );
  console.log(
    `  ${plan.manifest.scopedApplicationIds.length.toLocaleString("en-US")} scoped ids (#25)`,
  );
  console.log("\nThe manifest is untracked and must stay that way; it is regenerable from the");
  console.log("plan at any time. Run the harness next; it re-proves identity from the app side.");
}

main().catch((err) => {
  console.error(`\n${err.message}`);
  if (!VERIFY_ONLY) {
    console.error(
      "\nSEED WRITTEN BUT NOT COMPLETE if the failure is above the self-check; visibility is " +
        "unproven and no manifest was written. Fix the cause, then re-run with --verify-only.",
    );
  }
  process.exit(1);
});
