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
register(new URL("../../../test-support/messages-test-hook.mjs", import.meta.url));

const { call, fakeService } = await import("../../../test-support/fake-postgrest.mjs");
const { fetchOverview } = await import("./overview-actions.ts");

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

const PENDING_INVITES = 2;

// ── The fake database ────────────────────────────────────────

/** Filters are looked up by column, so a missing one widens rather than hides. */
function filters(calls) {
  const eqOn = (col) => calls.find((c) => c[0] === "eq" && c[1] === col)?.[2];
  const inOn = (col) => calls.find((c) => c[0] === "in" && c[1] === col)?.[2];
  const neqOn = (col) => calls.find((c) => c[0] === "neq" && c[1] === col)?.[2];
  return { eqOn, inOn, neqOn };
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
function world({ teamJobs = [] } = {}) {
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

    if (table === "company_members") {
      const mine = eqOn("company_id") === CO && eqOn("status") === "invited";
      return { count: mine ? PENDING_INVITES : 0, error: null };
    }

    throw new Error(`test: unexpected table ${table}`);
  });
}

function install(service, role) {
  globalThis.__messagesServiceForTests = () => service;
  globalThis.__messagesCtxForTests = {
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
    if (table === "company_members") return { count: PENDING_INVITES, error: null };
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
