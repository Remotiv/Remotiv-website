/**
 * Overview's numbers, before and after screening_answers left the bulk read.
 *
 *   node --test "src/app/ai-dashboard/(gated)/overview-counts.test.ts"
 *
 * ── What changed ─────────────────────────────────────────────
 *
 * `screenedCount` used to be derived in memory from every application row:
 *
 *   apps.filter((a) => Array.isArray(a.screening_answers) && a.screening_answers.length > 0)
 *
 * which meant the page selected a jsonb column averaging ~1.7 KB per row to
 * answer a yes/no question. It is now a `count: "exact", head: true` query
 * filtered on `screening_answers <> '[]'`, and the column is gone from the
 * bulk select.
 *
 * ── What these tests prove ───────────────────────────────────
 *
 * `oldOverview` below reimplements the PRE-FIX derivations from the seed,
 * including the old in-memory screening predicate. The correctness test then
 * deep-compares the shipped `fetchOverview` against it. So the assertion is
 * not "the code agrees with itself" — it is "the new query path produces the
 * byte-identical object the array derivation produced".
 *
 * The fake database answers the count by applying `JSON.stringify(sa) !== "[]"`
 * — the emulation of the SQL predicate — to the same seed, AFTER honouring
 * whatever company and job filters the code actually sent. So dropping either
 * filter from the count makes it count the wrong rows, and the comparison
 * fails rather than silently agreeing.
 *
 * ── What is real here ────────────────────────────────────────
 *
 * fetchOverview, pageAll and getJobScope all run as shipped; only the session
 * and the database are fakes. The role -> scope -> filter chain under test is
 * the one that ships. Filters are looked up BY COLUMN NAME, so a renamed or
 * removed filter reads as "no filter" and widens the fake's answer, which is
 * what lets these tests fail in the right direction.
 *
 * ── What they do NOT prove ───────────────────────────────────
 *
 * Not that PostgREST translates `.neq("screening_answers", "[]")` into
 * `screening_answers <> '[]'::jsonb`. Nothing reachable from a unit test can
 * prove that; it was established separately against the live endpoint, where
 * both that filter and `screening_answers->0 IS NOT NULL` returned the same
 * 2,060 of 3,747 rows and partitioned the table exactly.
 */
// @ts-nocheck — same reason as recipients-scope.test.ts: Node's `.ts` specifier
// vs this repo's tsconfig, which does not set allowImportingTsExtensions.
// Nothing ships from this file.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../../test-support/node-resolve.mjs", import.meta.url));
// The applicants hook, not the messages one: the same four stubs, plus the
// requireCompanyRole export that jobs/actions.ts imports from company-guards.
register(new URL("../../../test-support/applicants-test-hook.mjs", import.meta.url));

const { call, fakeService } = await import("../../../test-support/fake-postgrest.mjs");
const { fakeListDb } = await import("../../../test-support/fake-list-db.mjs");
const { fetchOverview } = await import("./overview-actions.ts");
const { fetchAnalytics } = await import("./analytics/actions.ts");
const { fetchWeekReport } = await import("./weekly-report/actions.ts");
const { fetchCompanyJobs } = await import("./jobs/actions.ts");

const CO = "c0000000-0000-0000-0000-000000000001";
const OTHER_CO = "c0000000-0000-0000-0000-000000000002";
const JOB_A = "a0000000-0000-0000-0000-00000000000a";
const JOB_B = "b0000000-0000-0000-0000-00000000000b";
const JOB_DRAFT = "d0000000-0000-0000-0000-00000000000d";
const JOB_X = "e0000000-0000-0000-0000-00000000000e";
const MEMBER = "11111111-1111-1111-1111-111111111111";

const WEEK_MS = 7 * 86_400_000;
const NOW = Date.now();
const ago = (ms) => new Date(NOW - ms).toISOString();
const RECENT = ago(86_400_000); // 1 day
const OLDER = ago(30 * 86_400_000); // 30 days

const ANSWERS = [{ id: "q1", question: "Remote?", answer: "yes", matched: true }];

/**
 * Four published-or-draft jobs, one of them in a different company.
 *
 * JOB_DRAFT is the sole on_hold role, so soleDraftId and soleDraftTitle are
 * exercised rather than left null.
 */
const JOBS = [
  {
    id: JOB_A,
    company_id: CO,
    title: "Engineer",
    category: "Eng",
    status: "open",
    created_at: OLDER,
    deleted_at: null,
  },
  {
    id: JOB_B,
    company_id: CO,
    title: "Designer",
    category: "Design",
    status: "open",
    created_at: RECENT,
    deleted_at: null,
  },
  {
    id: JOB_DRAFT,
    company_id: CO,
    title: "Analyst",
    category: "Data",
    status: "on_hold",
    created_at: OLDER,
    deleted_at: null,
  },
  {
    id: JOB_X,
    company_id: OTHER_CO,
    title: "Nope",
    category: "Nope",
    status: "open",
    created_at: RECENT,
    deleted_at: null,
  },
];

/**
 * Seven applications in our company spread across stages, recency and whether
 * they arrived with screening answers, plus one in a different company.
 *
 * `offer` and `rejected` are present deliberately: neither is in FUNNEL_STAGES,
 * so they must count toward totalApplicants and the per-job bars while staying
 * out of all five funnel steps.
 *
 * x1 is the isolation probe. It has answers and is recent, so it would move
 * totalApplicants, newThisWeek, screenedCount and the funnel if any filter were
 * dropped.
 */
const APPS = [
  {
    id: "app-1",
    company_id_snapshot: CO,
    job_id: JOB_A,
    first_name: "Ada",
    last_name: "One",
    email: "ada@example.test",
    job_title_snapshot: "Engineer",
    pipeline_stage: "applied",
    screening_answers: ANSWERS,
    created_at: RECENT,
  },
  {
    id: "app-2",
    company_id_snapshot: CO,
    job_id: JOB_A,
    first_name: "Bo",
    last_name: "Two",
    email: "bo@example.test",
    job_title_snapshot: "Engineer",
    pipeline_stage: "screening",
    screening_answers: [],
    created_at: ago(2 * 86_400_000),
  },
  {
    id: "app-3",
    company_id_snapshot: CO,
    job_id: JOB_A,
    first_name: "Cy",
    last_name: "Three",
    email: "cy@example.test",
    job_title_snapshot: "Engineer",
    pipeline_stage: "shortlisted",
    screening_answers: ANSWERS,
    created_at: OLDER,
  },
  {
    id: "app-4",
    company_id_snapshot: CO,
    job_id: JOB_B,
    first_name: "Di",
    last_name: "Four",
    email: "di@example.test",
    job_title_snapshot: "Designer",
    pipeline_stage: "interview",
    screening_answers: [],
    created_at: ago(31 * 86_400_000),
  },
  {
    id: "app-5",
    company_id_snapshot: CO,
    job_id: JOB_B,
    first_name: "Ed",
    last_name: "Five",
    email: "ed@example.test",
    job_title_snapshot: "Designer",
    pipeline_stage: "hired",
    screening_answers: ANSWERS,
    created_at: ago(32 * 86_400_000),
  },
  {
    id: "app-6",
    company_id_snapshot: CO,
    job_id: JOB_B,
    first_name: "Fay",
    last_name: "Six",
    email: "fay@example.test",
    job_title_snapshot: "Designer",
    pipeline_stage: "offer",
    screening_answers: ANSWERS,
    created_at: ago(3 * 86_400_000),
  },
  {
    id: "app-7",
    company_id_snapshot: CO,
    job_id: JOB_A,
    first_name: "",
    last_name: "",
    email: "gus@example.test",
    job_title_snapshot: "Engineer",
    pipeline_stage: "rejected",
    screening_answers: [],
    created_at: ago(33 * 86_400_000),
  },
  {
    id: "app-x1",
    company_id_snapshot: OTHER_CO,
    job_id: JOB_X,
    first_name: "Nope",
    last_name: "Nobody",
    email: "nope@other.test",
    job_title_snapshot: "Nope",
    pipeline_stage: "applied",
    screening_answers: ANSWERS,
    created_at: RECENT,
  },
];

/**
 * One stage move on a JOB_A application and one on a JOB_B application, so a
 * recruiter scoped to JOB_A must see exactly one of them. That narrowing is
 * what `visibleAppIds` does, and it is the only consumer of the full id set.
 */
const HISTORY = [
  {
    id: "h1",
    company_id: CO,
    application_id: "app-1",
    from_stage: null,
    to_stage: "applied",
    changed_by_name: "Bilal",
    created_at: ago(3600_000),
  },
  {
    id: "h2",
    company_id: CO,
    application_id: "app-5",
    from_stage: "interview",
    to_stage: "hired",
    changed_by_name: null,
    created_at: ago(7200_000),
  },
];

/*
 * #67: invites live in company_invites. Only the first two are pending for
 * this company AND unexpired; every other row differs from them in exactly
 * one respect, so dropping any one filter from the count lets that row in.
 */
const LATER = new Date(NOW + 3 * 86_400_000).toISOString();
const INVITES = [
  { id: "inv-1", company_id: CO, status: "pending", expires_at: LATER },
  { id: "inv-2", company_id: CO, status: "pending", expires_at: LATER },
  { id: "inv-3", company_id: CO, status: "pending", expires_at: ago(86_400_000) },
  { id: "inv-4", company_id: CO, status: "revoked", expires_at: LATER },
  { id: "inv-5", company_id: CO, status: "accepted", expires_at: LATER },
  { id: "inv-6", company_id: CO, status: "expired", expires_at: LATER },
  { id: "inv-7", company_id: OTHER_CO, status: "pending", expires_at: LATER },
];
const PENDING_INVITES = 2;

/** What the old company_members count would claim; never the right answer. */
const MEMBERS_INVITED_DECOY = 99;

// ── The fake database ────────────────────────────────────────

/** Filters are looked up by column, so a missing one widens rather than hides. */
function filters(calls) {
  const eqOn = (col) => calls.find((c) => c[0] === "eq" && c[1] === col)?.[2];
  const inOn = (col) => calls.find((c) => c[0] === "in" && c[1] === col)?.[2];
  const neqOn = (col) => calls.find((c) => c[0] === "neq" && c[1] === col)?.[2];
  const gtOn = (col) => calls.find((c) => c[0] === "gt" && c[1] === col)?.[2];
  return { eqOn, inOn, neqOn, gtOn };
}

/**
 * The invite count, answered from INVITES by whatever filters were sent. A
 * missing filter answers widely, so the wrong rows are counted, not hidden.
 */
function inviteCount(calls) {
  const { eqOn, gtOn } = filters(calls);
  let rows = keep(INVITES, eqOn("company_id"), (i) => i.company_id);
  rows = keep(rows, eqOn("status"), (i) => i.status);
  const after = gtOn("expires_at");
  if (after !== undefined) rows = rows.filter((i) => Date.parse(i.expires_at) > Date.parse(after));
  return rows.length;
}

/** True for `.select(cols, { count: "exact", head: true })`. */
function isCountQuery(calls) {
  return call(calls, "select")?.[2]?.head === true;
}

function keep(rows, value, pick) {
  // undefined means the code sent no such filter: answer WIDELY, so the test
  // sees the leak instead of being protected from it by the fake.
  return value === undefined ? rows : rows.filter((r) => pick(r) === value);
}

// The role reaches the code under test through install()'s ctx, not through the
// database: all the responder needs is which jobs the member is on the team of.
function world({ teamJobs = [], inviteError = false } = {}) {
  return fakeService((table, calls) => {
    const { eqOn, inOn, neqOn } = filters(calls);

    if (table === "job_hiring_team") {
      const okCompany = eqOn("company_id") === CO;
      const okMember = eqOn("member_id") === MEMBER;
      return {
        data: okCompany && okMember ? teamJobs.map((job_id) => ({ job_id })) : [],
        error: null,
      };
    }

    if (table === "jobs") {
      let rows = keep(JOBS, eqOn("company_id"), (j) => j.company_id);
      const ids = inOn("id");
      if (ids) rows = rows.filter((j) => ids.includes(j.id));
      rows = [...rows].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
      return { data: rows, error: null };
    }

    if (table === "job_applications") {
      let rows = keep(APPS, eqOn("company_id_snapshot"), (a) => a.company_id_snapshot);
      const jobIds = inOn("job_id");
      if (jobIds) rows = rows.filter((a) => jobIds.includes(a.job_id));

      if (isCountQuery(calls)) {
        // The emulation of `screening_answers <> '[]'::jsonb`. Applied only if
        // the code actually sent the filter — omitting it must over-count.
        if (neqOn("screening_answers") !== undefined) {
          const literal = neqOn("screening_answers");
          rows = rows.filter((a) => JSON.stringify(a.screening_answers) !== literal);
        }
        return { count: rows.length, error: null };
      }

      rows = [...rows].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
      return { data: rows, error: null };
    }

    if (table === "application_stage_history") {
      const rows = keep(HISTORY, eqOn("company_id"), (h) => h.company_id);
      return { data: rows, error: null };
    }

    if (table === "company_invites") {
      if (inviteError) return { count: null, error: { message: "boom", code: "57014" } };
      return { count: inviteCount(calls), error: null };
    }

    // The pre-#67 source. Answered rather than thrown, so a regression shows
    // as a wrong number in an assertion, not as a crash.
    if (table === "company_members") {
      return { count: MEMBERS_INVITED_DECOY, error: null };
    }

    throw new Error(`test: unexpected table ${table}`);
  });
}

function install(service, role) {
  globalThis.__applicantsServiceForTests = () => service;
  globalThis.__applicantsCtxForTests = {
    companyId: CO,
    memberId: MEMBER,
    role,
    memberName: "Waleed",
    company: { id: CO, name: "Acme" },
  };
}

// ── The pre-fix implementation, reimplemented from the seed ──

const FUNNEL_STAGES = ["applied", "screening", "shortlisted", "interview", "hired"];
const PIPELINE_STAGES = [
  "applied",
  "screening",
  "shortlisted",
  "interview",
  "offer",
  "hired",
  "rejected",
];

/**
 * What fetchOverview returned BEFORE the fix, computed independently here.
 *
 * `screenedCount` uses the ORIGINAL in-memory predicate on purpose: that is
 * the baseline the database count has to reproduce.
 */
function oldOverview({ scopedJobIds }) {
  const inScope = (r) => (scopedJobIds ? scopedJobIds.includes(r.job_id) : true);
  const apps = APPS.filter((a) => a.company_id_snapshot === CO && inScope(a))
    .slice()
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  const jobs = JOBS.filter(
    (j) => j.company_id === CO && (!scopedJobIds || scopedJobIds.includes(j.id)),
  )
    .slice()
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));

  const stageOf = (r) =>
    PIPELINE_STAGES.includes(r.pipeline_stage ?? "") ? r.pipeline_stage : "applied";
  const isRecent = (iso) => !!iso && NOW - Date.parse(iso) <= WEEK_MS;
  const fullName = (r) =>
    `${r.first_name ?? ""} ${r.last_name ?? ""}`.trim() || r.email?.split("@")[0] || "Someone";

  const total = apps.length;
  const screenedCount = apps.filter(
    (a) => Array.isArray(a.screening_answers) && a.screening_answers.length > 0,
  ).length;

  const published = jobs.filter((j) => j.status === "open");
  const drafts = jobs.filter((j) => j.status === "on_hold");

  const byJob = new Map();
  for (const a of apps) {
    if (!a.job_id) continue;
    const e = byJob.get(a.job_id) ?? { total: 0, recent: 0 };
    e.total += 1;
    if (isRecent(a.created_at)) e.recent += 1;
    byJob.set(a.job_id, e);
  }

  const liveRoles = published
    .map((j) => ({
      id: j.id,
      title: j.title?.trim() || "Untitled role",
      category: j.category?.trim() || "",
      applicants: byJob.get(j.id)?.total ?? 0,
      newThisWeek: byJob.get(j.id)?.recent ?? 0,
      createdAt: j.created_at ?? "",
    }))
    .sort((a, b) => {
      if (b.applicants !== a.applicants) return b.applicants - a.applicants;
      const byDate = Date.parse(b.createdAt) - Date.parse(a.createdAt);
      return byDate !== 0 ? byDate : a.id.localeCompare(b.id);
    })
    .slice(0, 4)
    .map(({ createdAt: _c, ...role }) => role);

  const visibleAppIds = new Set(apps.map((a) => a.id));
  const scopedHistory = scopedJobIds
    ? HISTORY.filter(
        (h) =>
          h.company_id === CO && h.application_id !== null && visibleAppIds.has(h.application_id),
      )
    : HISTORY.filter((h) => h.company_id === CO);

  const appById = new Map(apps.map((a) => [a.id, a]));
  const stageItems = scopedHistory
    .filter((h) => h.to_stage && h.created_at)
    .map((h) => {
      const app = h.application_id ? appById.get(h.application_id) : undefined;
      return {
        id: `stage-${h.id}`,
        kind: "stage",
        subject: app ? fullName(app) : "An applicant",
        predicate: h.from_stage
          ? `was moved to ${h.to_stage}`
          : `entered the pipeline as ${h.to_stage}`,
        actor: h.changed_by_name?.trim() || null,
        createdAt: h.created_at,
      };
    });
  const applyItems = apps.slice(0, 6).map((a) => ({
    id: `apply-${a.id}`,
    kind: "applied",
    subject: fullName(a),
    predicate: `applied for ${jobs.find((j) => j.id === a.job_id)?.title?.trim() || a.job_title_snapshot?.trim() || "a role"}`,
    actor: null,
    createdAt: a.created_at ?? "",
  }));
  const jobItems = published.slice(0, 4).map((j) => ({
    id: `job-${j.id}`,
    kind: "published",
    subject: j.title?.trim() || "A role",
    predicate: "was published",
    actor: null,
    createdAt: j.created_at ?? "",
  }));

  return {
    totalApplicants: total,
    newThisWeek: apps.filter((a) => isRecent(a.created_at)).length,
    screenedCount,
    funnel: FUNNEL_STAGES.map((stage) => {
      const count = apps.filter((a) => stageOf(a) === stage).length;
      return { stage, count, pct: total > 0 ? Math.round((count / total) * 100) : 0 };
    }),
    publishedJobs: published.length,
    draftJobs: drafts.length,
    soleDraftId: drafts.length === 1 ? drafts[0].id : null,
    soleDraftTitle: drafts.length === 1 ? (drafts[0].title?.trim() ?? null) : null,
    awaitingReview: apps.filter((a) => stageOf(a) === "applied").length,
    pendingInvites: { ok: true, value: PENDING_INVITES },
    liveRoles,
    recentApplicants: apps.slice(0, 5).map((a) => ({
      id: a.id,
      name: fullName(a),
      jobTitle:
        jobs.find((j) => j.id === a.job_id)?.title?.trim() || a.job_title_snapshot?.trim() || "—",
      stage: stageOf(a),
      createdAt: a.created_at ?? "",
    })),
    activity: {
      ok: true,
      value: [...stageItems, ...applyItems, ...jobItems]
        .filter((i) => i.createdAt)
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
        .slice(0, 6),
    },
  };
}

// ── Correctness ──────────────────────────────────────────────

/*
 * Owner and admin are the two unscoped roles; recruiter and hiring_manager are
 * the two that carry a job scope. All four run the same assertion so neither
 * pair can drift from the other.
 */
for (const role of ["owner", "admin"]) {
  test(`${role}: every Overview number matches the pre-fix array derivation`, async () => {
    const svc = world();
    install(svc, role);
    assert.deepEqual(await fetchOverview(), oldOverview({ scopedJobIds: null }));
  });
}

for (const role of ["recruiter", "hiring_manager"]) {
  test(`${role}: every Overview number matches the pre-fix derivation, within job scope`, async () => {
    const svc = world({ teamJobs: [JOB_A] });
    install(svc, role);
    assert.deepEqual(await fetchOverview(), oldOverview({ scopedJobIds: [JOB_A] }));
  });
}

test("the screening count is the figure the old predicate produced, not a restatement of it", async () => {
  const svc = world();
  install(svc, "owner");
  const data = await fetchOverview();

  // Independently: app-1, app-3, app-5 and app-6 carry answers; app-2, app-4
  // and app-7 carry `[]`; app-x1 belongs to another company.
  assert.equal(data.screenedCount, 4);
  assert.equal(data.totalApplicants, 7);
  // The probe never lands, by any route.
  assert.doesNotMatch(JSON.stringify(data), /Nope|Nobody|nope@other\.test/);
});

test("a recruiter's screening count is scoped to the jobs they are on", async () => {
  const svc = world({ teamJobs: [JOB_A] });
  install(svc, "recruiter");
  const data = await fetchOverview();

  // JOB_A holds app-1 (answers), app-2 ([]), app-3 (answers), app-7 ([]).
  assert.equal(data.screenedCount, 2);
  assert.equal(data.totalApplicants, 4);
  // app-5 is on JOB_B, so its stage move must not reach this feed.
  assert.doesNotMatch(JSON.stringify(data.activity), /was moved to hired/);
});

test("a company with nothing in it reports zero, and still carries the invite count", async () => {
  const svc = fakeService((table, calls) => {
    const { eqOn } = filters(calls);
    if (table === "job_hiring_team") return { data: [], error: null };
    if (table === "company_invites") return { count: inviteCount(calls), error: null };
    if (table === "company_members") return { count: MEMBERS_INVITED_DECOY, error: null };
    if (isCountQuery(calls)) return { count: 0, error: null };
    assert.equal(eqOn("company_id") ?? eqOn("company_id_snapshot"), CO);
    return { data: [], error: null };
  });
  install(svc, "owner");
  const data = await fetchOverview();

  assert.equal(data.totalApplicants, 0);
  assert.equal(data.screenedCount, 0);
  assert.equal(data.publishedJobs, 0);
  assert.deepEqual(data.pendingInvites, { ok: true, value: PENDING_INVITES });
  assert.deepEqual(
    data.funnel.map((f) => [f.count, f.pct]),
    [
      [0, 0],
      [0, 0],
      [0, 0],
      [0, 0],
      [0, 0],
    ],
  );
});

// ── Scale ────────────────────────────────────────────────────

const SOURCE = readFileSync(new URL("./overview-actions.ts", import.meta.url), "utf8");

test("the bulk applications read does not transfer screening_answers", async () => {
  const svc = world();
  install(svc, "owner");
  await fetchOverview();

  const reads = svc.queries.filter((q) => q.table === "job_applications" && !isCountQuery(q.calls));
  assert.equal(reads.length, 1, "one paged row read");

  const cols = call(reads[0].calls, "select")[1];
  assert.doesNotMatch(
    cols,
    /screening_answers/,
    "the heavy jsonb column is back in the bulk select — it averages ~1.7 KB per row and Overview only needs a yes/no",
  );
  // The columns that are still load-bearing, so this test cannot be satisfied
  // by narrowing the select into uselessness.
  for (const col of [
    "id",
    "first_name",
    "last_name",
    "email",
    "job_id",
    "pipeline_stage",
    "created_at",
  ]) {
    assert.match(cols, new RegExp(`\\b${col}\\b`), col);
  }
});

test("the screening count transfers zero rows and carries both scopes", async () => {
  const svc = world({ teamJobs: [JOB_A] });
  install(svc, "recruiter");
  await fetchOverview();

  const counts = svc.queries.filter((q) => q.table === "job_applications" && isCountQuery(q.calls));
  assert.equal(counts.length, 1, "one count query");

  const { calls } = counts[0];
  assert.deepEqual(
    call(calls, "select")[2],
    { count: "exact", head: true },
    "head: true, so no rows come back",
  );
  const { eqOn, inOn, neqOn } = filters(calls);
  assert.equal(eqOn("company_id_snapshot"), CO, "the count must be company-scoped");
  assert.deepEqual(inOn("job_id"), [JOB_A], "and job-scoped for a scoped role");
  assert.equal(neqOn("screening_answers"), "[]", "the existence test belongs in the database");
});

test("no .select() in the source names screening_answers", () => {
  // Every column list the file passes to PostgREST, whatever the formatter did
  // with the line breaks around it.
  const selects = [...SOURCE.matchAll(/\.select\(\s*"([^"]*)"/g)].map((m) => m[1]);
  assert.ok(selects.length >= 4, `expected the four reads' column lists, found ${selects.length}`);
  for (const cols of selects) {
    assert.doesNotMatch(cols, /screening_answers/, `select("${cols}")`);
  }
  // It must still be here as a filter, or the count is not being scoped at all.
  assert.match(SOURCE, /\.neq\("screening_answers", "\[\]"\)/);
});

// ── #67: pending invites ─────────────────────────────────────

test("a: the invite count is this company's pending, unexpired invites only", async () => {
  const svc = world();
  install(svc, "owner");
  const data = await fetchOverview();
  // inv-1 and inv-2. Not the expired, revoked, accepted, 'expired'-status or
  // other-company rows, and not the company_members decoy.
  assert.deepEqual(data.pendingInvites, { ok: true, value: 2 });
});

test("b: the invite query filters company, status = pending, and expires_at after now", async () => {
  const svc = world();
  install(svc, "owner");
  const before = Date.now();
  await fetchOverview();
  const after = Date.now();
  const q = svc.queries.find((x) => x.table === "company_invites");
  assert.ok(q, `company_invites was not queried: ${svc.queries.map((x) => x.table).join(",")}`);
  const { eqOn, gtOn } = filters(q.calls);
  assert.equal(eqOn("company_id"), CO);
  assert.equal(eqOn("status"), "pending");
  const cut = Date.parse(gtOn("expires_at"));
  assert.ok(!Number.isNaN(cut), "expires_at is compared against a timestamp");
  assert.ok(cut >= before - 1000 && cut <= after + 1000, "and that timestamp is now");
  assert.ok(isCountQuery(q.calls), "a head count, not a row read");
});

test("c: company_members is never queried for the invite count", async () => {
  for (const role of ["owner", "admin", "recruiter"]) {
    const svc = world({ teamJobs: [JOB_A] });
    install(svc, role);
    await fetchOverview();
    const members = svc.queries.filter((x) => x.table === "company_members");
    assert.equal(members.length, 0, `${role}: company_members was queried`);
  }
});

test("d: a failed invite read stays unknown, not zero", async () => {
  const saved = console.error;
  console.error = () => {};
  try {
    const svc = world({ inviteError: true });
    install(svc, "owner");
    const data = await fetchOverview();
    assert.deepEqual(data.pendingInvites, { ok: false });
  } finally {
    console.error = saved;
  }
});

/* ── #54: a created_at tie cannot straddle a page boundary ────── */

/*
 * The three job_applications drains that order on created_at (#54): the
 * Analytics page, the Overview page and the Weekly report. Each runs AS
 * SHIPPED against fake-list-db.mjs, which applies every .order() term the
 * action sends, pages by .range(), and permutes rows that tie on every order
 * term differently on every request, as Postgres may. The seed is 1,200
 * rows, more than one 1,000-row page, with 40 rows sharing one created_at
 * placed so the block straddles the boundary between page 1 and page 2.
 * Without a unique final order term the two pages are two independent sorts
 * of that block: a row comes back twice and another never comes back. The
 * assertion is by ID SET over the whole drain, because the counts cancel.
 *
 * This proves the tiebreaker and only that. A row inserted or deleted
 * between two pages still shifts the offset; nothing here claims otherwise.
 *
 * The fake answers job_applications and job_hiring_team; every other table
 * these actions read answers empty: a company with no history, scores,
 * jobs or invites. It applies eq/in/gte but not .lt(), so the Weekly
 * report's created_at upper bound is not enforced here; the seed sits inside
 * last week's window regardless, so every row qualifies for the real filter.
 */

const DRAIN_ROWS = 1200;
const TIE_ROWS = 40;
/** The 1,000-row page both pageAll and analytics' own loop use. */
const DRAIN_PAGE = 1000;

const padId = (n) => `app-${String(n).padStart(5, "0")}`;

/** Monday 00:00 UTC of the last complete week: the window fetchWeekReport(0) reads. */
function lastWeekWindow() {
  const now = new Date();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const monday = today - ((new Date(today).getUTCDay() + 6) % 7) * 86_400_000;
  return { start: monday - WEEK_MS, end: monday };
}

/**
 * 1,200 applications in this company. Rows 0..979 have distinct created_at
 * values, newest first; rows 980..1019 share ONE created_at; rows 1020..1199
 * are older still. Under created_at DESC the tie block therefore occupies
 * positions 980..1019 of the sorted population, so page 1 (0..999) takes its
 * first 20 rows and page 2 the other 20. `newest` is the latest timestamp;
 * every row lies within 25 minutes before it.
 */
function tieSeed(newest) {
  const at = (i) => {
    if (i >= 980 && i < 980 + TIE_ROWS) return new Date(newest - 1000 * 1000).toISOString();
    return new Date(newest - (i < 980 ? i : i + 100) * 1000).toISOString();
  };
  return Array.from({ length: DRAIN_ROWS }, (_, i) => ({
    id: padId(i),
    company_id_snapshot: CO,
    job_id: JOB_A,
    first_name: "Row",
    last_name: String(i),
    email: `row${i}@example.test`,
    job_title_snapshot: "Engineer",
    source_detail: null,
    pipeline_stage: "applied",
    screening_answers: [],
    created_at: at(i),
  }));
}

/**
 * The database for one drain: job_applications and job_hiring_team through
 * fake-list-db (ORDER BY, RANGE, hostile ties), everything else empty.
 * `drained` collects every row a non-head job_applications read returned, in
 * the order the action received them: the drain the action then aggregates.
 */
function tieWorld(apps) {
  const listDb = fakeListDb({ apps, scores: [], jobs: [], team: [] });
  const drained = [];
  const service = fakeService((table, calls) => {
    if (table === "job_applications" || table === "job_hiring_team") {
      const answer = listDb(table, calls);
      if (table === "job_applications" && Array.isArray(answer.data)) {
        drained.push(...answer.data.map((r) => r.id));
      }
      return answer;
    }
    return { data: [], count: 0, error: null };
  });
  return { service, drained };
}

/** Every seeded id exactly once across the drain, which crossed a page boundary. */
function assertDrainComplete(drained, seed, service, site, table = "job_applications") {
  const pages = service.queries.filter((q) => q.table === table && call(q.calls, "range")).length;
  assert.equal(
    pages,
    Math.ceil(seed.length / DRAIN_PAGE),
    `${site}: the drain did not cross a page boundary`,
  );
  const seen = new Map();
  for (const id of drained) seen.set(id, (seen.get(id) ?? 0) + 1);
  const repeated = [...seen].filter(([, n]) => n > 1).map(([id]) => id);
  const missing = seed.map((r) => r.id).filter((id) => !seen.has(id));
  assert.deepEqual(
    { repeated, missing },
    { repeated: [], missing: [] },
    `${site}: rows repeated or lost across the page boundary`,
  );
  assert.equal(drained.length, seed.length, `${site}: the drained total`);
}

test("#54 analytics: a created_at tie across the page boundary is drained once each, and the funnel counts the whole seed", async () => {
  const seed = tieSeed(NOW - 3600_000);
  const { service, drained } = tieWorld(seed);
  install(service, "owner");
  const result = await fetchAnalytics("90d");
  assertDrainComplete(drained, seed, service, "analytics");
  const applied = result.funnel.find((f) => f.stage === "applied");
  assert.equal(applied?.count, DRAIN_ROWS, "the funnel's Applied count is every seeded row");
});

test("#54 overview: a created_at tie across the page boundary is drained once each, and totalApplicants is the whole seed", async () => {
  const seed = tieSeed(NOW - 3600_000);
  const { service, drained } = tieWorld(seed);
  install(service, "owner");
  const result = await fetchOverview();
  assertDrainComplete(drained, seed, service, "overview");
  assert.equal(result.totalApplicants, DRAIN_ROWS, "totalApplicants is every seeded row");
});

test("#54 weekly report: a created_at tie across the page boundary is drained once each, and applied is the whole seed", async () => {
  const { end } = lastWeekWindow();
  const seed = tieSeed(end - 3600_000);
  const { service, drained } = tieWorld(seed);
  install(service, "owner");
  const result = await fetchWeekReport(0);
  assertDrainComplete(drained, seed, service, "weekly report");
  assert.equal(result.applied, DRAIN_ROWS, "applied is every seeded row");
});

/* ── #54, group 2: the jobs, stage-history and score drains ────── */

/*
 * The five remaining in-reach paged reads (#54): the jobs drains on Overview
 * and the Jobs page, the stage-history drains on the Weekly report and on
 * Analytics, and the Analytics score-agreement drain, which had no ORDER BY
 * at all. Same harness as the three tests above. fake-list-db's evaluator is
 * reached for each table by answering that table's reads through its
 * job_applications branch, which is generic over the parts that matter:
 * eq/in/gte filters, every .order() term in sequence, .range(), and ties
 * rotated differently on every request. Each fixture is 1,200 rows with a
 * 40-row block tying on every order term, placed to straddle the 1,000-row
 * page boundary. For the formerly unordered scores read every row is one
 * tie, so without an order the two pages are two unrelated permutations.
 * Preventive: production holds 7 stage-history rows today, so none of these
 * can page yet.
 *
 * Not applied by the fake: .is() and .lt(). Every fixture satisfies them
 * anyway (deleted_at null, created_at before the week's end).
 */

/** DRAIN_ROWS rows built by `build(i, tie)`; `tie` is true for rows 980..1019. */
function tieBlockSeed(build) {
  return Array.from({ length: DRAIN_ROWS }, (_, i) => build(i, i >= 980 && i < 980 + TIE_ROWS));
}

/** created_at for row i under a DESC order: newest first, the tie block on one value. */
function tieStampDesc(newest, i, tie) {
  if (tie) return new Date(newest - 1000 * 1000).toISOString();
  return new Date(newest - (i < 980 ? i : i + 100) * 1000).toISOString();
}

const jobId = (n) => `job-${String(n).padStart(5, "0")}`;
const moveId = (n) => `move-${String(n).padStart(5, "0")}`;
const scoreId = (n) => `score-${String(n).padStart(5, "0")}`;

/** 1,200 open jobs in this company; rows 980..1019 share one created_at. */
function jobSeed(newest) {
  return tieBlockSeed((i, tie) => ({
    id: jobId(i),
    company_id: CO,
    title: `Role ${i}`,
    location: "Remote",
    category: "Eng",
    experience_level: "mid",
    contract_type: "full_time",
    work_type: "remote",
    status: "open",
    slug: `role-${i}`,
    salary_min: null,
    salary_max: null,
    salary_currency: null,
    positions: 1,
    created_at: tieStampDesc(newest, i, tie),
    archived_at: null,
    deleted_at: null,
  }));
}

/**
 * A database where each table in `tables` answers through the evaluator and
 * every other table answers empty. `drained[table]` collects every row a
 * .range() read on that table returned, in the order the action received
 * them: the drain the action then aggregates.
 */
function tableWorld(tables) {
  const evaluators = Object.fromEntries(
    Object.entries(tables).map(([table, rows]) => [
      table,
      fakeListDb({ apps: rows, scores: [], jobs: [], team: [] }),
    ]),
  );
  const drained = Object.fromEntries(Object.keys(tables).map((table) => [table, []]));
  const service = fakeService((table, calls) => {
    const evaluate = evaluators[table];
    if (!evaluate) return { data: [], count: 0, error: null };
    const answer = evaluate("job_applications", calls);
    if (call(calls, "range") && Array.isArray(answer.data)) {
      drained[table].push(...answer.data.map((r) => r.id));
    }
    return answer;
  });
  return { service, drained };
}

/** Three applications, so Analytics' head count is non-zero and the page is built. */
function fewApps() {
  return [0, 1, 2].map((i) => ({
    id: padId(i),
    company_id_snapshot: CO,
    job_id: JOB_A,
    source_detail: null,
    pipeline_stage: "applied",
    created_at: new Date(NOW - 7200_000).toISOString(),
  }));
}

test("#54 overview jobs: a created_at tie across the page boundary is drained once each, and publishedJobs is the whole seed", async () => {
  const jobs = jobSeed(NOW - 3600_000);
  const { service, drained } = tableWorld({ jobs });
  install(service, "owner");
  const result = await fetchOverview();
  assertDrainComplete(drained.jobs, jobs, service, "overview jobs", "jobs");
  assert.equal(result.publishedJobs, DRAIN_ROWS, "publishedJobs is every seeded open role");
});

test("#54 jobs page: a created_at tie across the page boundary is drained once each, and the list carries every role once", async () => {
  const jobs = jobSeed(NOW - 3600_000);
  const { service, drained } = tableWorld({ jobs });
  install(service, "owner");
  const result = await fetchCompanyJobs();
  assert.ok(result.ok, "the read answered");
  assertDrainComplete(drained.jobs, jobs, service, "jobs page", "jobs");
  const listed = result.value.map((j) => j.id);
  assert.deepEqual(
    [...listed].sort(),
    jobs.map((j) => j.id).sort(),
    "the returned list is exactly the seeded roles, once each",
  );
});

test("#54 weekly report history: a created_at tie across the page boundary is drained once each, and forward counts every move", async () => {
  const { end } = lastWeekWindow();
  const history = tieBlockSeed((i, tie) => ({
    id: moveId(i),
    company_id: CO,
    application_id: padId(i),
    from_stage: "applied",
    to_stage: "screening",
    created_at: tieStampDesc(end - 3600_000, i, tie),
  }));
  const { service, drained } = tableWorld({ application_stage_history: history });
  install(service, "owner");
  const result = await fetchWeekReport(0);
  assertDrainComplete(
    drained.application_stage_history,
    history,
    service,
    "weekly report history",
    "application_stage_history",
  );
  assert.equal(result.forward, DRAIN_ROWS, "forward counts every distinct application moved");
});

test("#54 analytics history: a tie on application_id and created_at across the page boundary is drained once each", async () => {
  // ASC on application_id then created_at: rows 980..1019 share both, so
  // under that order they sit at positions 980..1019 of the population.
  const base = NOW - 7200_000;
  const history = tieBlockSeed((i, tie) => ({
    id: moveId(i),
    company_id: CO,
    application_id: tie ? padId(980) : padId(i),
    from_stage: "applied",
    to_stage: "screening",
    created_at: new Date(base + (tie ? 980 : i) * 1000).toISOString(),
  }));
  const { service, drained } = tableWorld({
    job_applications: fewApps(),
    application_stage_history: history,
  });
  install(service, "owner");
  const result = await fetchAnalytics("90d");
  assertDrainComplete(
    drained.application_stage_history,
    history,
    service,
    "analytics history",
    "application_stage_history",
  );
  const screening = result.funnel.find((f) => f.stage === "screening");
  assert.equal(screening?.count, 3, "the three applications with a move reached screening");
});

test("#54 analytics agreement: the scores drain, which had no order, reads every scored row once and counts them all", async () => {
  const scores = tieBlockSeed((i) => ({
    id: scoreId(i),
    application_id: padId(i),
    company_id: CO,
    job_id: JOB_A,
    status: "scored",
    overall_score: 50,
    human_adjusted_score: null,
    adjusted_at: null,
  }));
  const { service, drained } = tableWorld({
    job_applications: fewApps(),
    application_scores: scores,
  });
  install(service, "owner");
  const result = await fetchAnalytics("90d");
  assertDrainComplete(
    drained.application_scores,
    scores,
    service,
    "analytics agreement",
    "application_scores",
  );
  assert.equal(result.agreement?.scored, DRAIN_ROWS, "scored is every seeded row");
});
