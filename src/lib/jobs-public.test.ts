/**
 * F7: what the public is sent about a job is exactly a KEEP-list
 * (PUBLIC_JOB_SUMMARY_FIELDS / PUBLIC_JOB_DETAIL_FIELDS in lib/jobs.ts),
 * whoever asks. Covers GET /api/jobs (list, and `?id=` now a 404), the /jobs
 * page's server data (getInitialJobs, fetchCompanyJobs) and the job page's
 * (getJobBySlug). The database is a small fake that applies the select string
 * the way PostgREST does; its rows carry every column the production jobs row
 * has, plus a made-up future one, and screening questions with their private
 * keys. All job data here is synthetic.
 *
 *   node --test src/lib/jobs-public.test.ts
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../test-support/node-resolve.mjs", import.meta.url));
register(
  `data:text/javascript,${encodeURIComponent(`
const STUBS = {
  "server-only": "",
  "@/lib/supabase/server": "export function createServiceClient() { return globalThis.__jobsService; }",
  "@/app/api/_lib/rate-limit": "export function rateLimit() { return { ok: true }; }",
};
export async function resolve(specifier, context, next) {
  // The real NextResponse, so the response goes through real JSON serialisation.
  if (specifier === "next/server") return next("next/server.js", context);
  if (specifier in STUBS) return { url: "data:text/javascript," + encodeURIComponent(STUBS[specifier]), shortCircuit: true };
  return next(specifier, context);
}`)}`,
);

const { NextRequest } = await import("next/server.js");
const { fakeService } = await import("../test-support/fake-postgrest.mjs");
const jobs = await import("./jobs.ts");
const { GET } = await import("../app/api/jobs/route.ts");
const { fetchCompanyJobs } = await import("../app/jobs/company-filter.ts");
const { getInitialJobs, getJobBySlug, PUBLIC_JOB_SUMMARY_FIELDS, PUBLIC_JOB_DETAIL_FIELDS } = jobs;

for (const m of ["log", "error", "warn"]) console[m] = () => {};

/** Every column of the production jobs row (read by key name on 21 Oct 2026), and one from the future. */
const ALL_COLUMNS = [
  "ai_cv_scoring_enabled",
  "allow_rerecord",
  "archived_at",
  "async_interview_enabled",
  "async_interview_name",
  "autoshortlist_cv_threshold",
  "autoshortlist_interview_threshold",
  "autoshortlist_source",
  "avatar_interview_enabled",
  "avatar_interviewer_name",
  "booking_hours_override",
  "category",
  "city",
  "client_id",
  "company",
  "company_id",
  "company_rating",
  "contract_type",
  "country",
  "created_at",
  "created_by",
  "criteria_version",
  "cv_weight_domain",
  "cv_weight_experience",
  "cv_weight_requirements",
  "cv_weight_responsibilities",
  "deleted_at",
  "description",
  "display_order",
  "experience_level",
  "id",
  "interview_criteria",
  "interview_duration_minutes",
  "language",
  "listed_on_remotiv",
  "location",
  "measure_relevancy",
  "positions",
  "requirements",
  "responsibilities",
  "salary_currency",
  "salary_max",
  "salary_min",
  "scoring_must_haves",
  "screening_questions",
  "send_rejection_email",
  "slug",
  "status",
  "title",
  "work_type",
  "future_internal_column",
];
const CO = "c0c0c0c0-0000-4000-8000-000000000001";
const job = (n, over = {}) => {
  const row = Object.fromEntries(ALL_COLUMNS.map((c) => [c, `${c}-${n}`]));
  return {
    ...row,
    id: `00000000-0000-4000-8000-00000000000${n}`,
    slug: `role-${n}`,
    company_id: CO,
    status: "open",
    archived_at: null,
    deleted_at: null,
    listed_on_remotiv: true,
    display_order: n,
    positions: 1,
    company_rating: 4,
    salary_min: 1000,
    salary_max: 2000,
    interview_criteria: ["Owns outcomes"],
    scoring_must_haves: ["Five years of Go"],
    booking_hours_override: [{ weekday: 1, startMinute: 540, endMinute: 1020 }],
    screening_questions: [
      {
        id: "q1",
        question: "Years of Go?",
        type: "numeric",
        options: [],
        essential: true,
        ideal: "5",
        numeric_mode: "min",
      },
      {
        id: "q2",
        question: "Pick one",
        type: "multiple",
        options: ["a", "b"],
        essential: false,
        ideal: "1",
      },
    ],
    ...over,
  };
};

/**
 * PostgREST, as far as these readers use it: the select string decides the
 * columns ("*" is every one), eq/is/in filter. `honourSelect: false` returns
 * whole rows whatever was asked, to prove the readers' own projection.
 */
function fakeDb({ honourSelect = true } = {}) {
  const tables = {
    jobs: [job(1), job(2), job(3, { status: "closed" })],
    companies: [
      {
        id: CO,
        logo_path: "logo.png",
        is_internal: false,
        name: "Acme",
        slug: "acme",
        status: "active",
      },
    ],
  };
  const selects = [];
  const service = fakeService((table, calls) => {
    const cols = calls.find((c) => c[0] === "select")?.[1] ?? null;
    if (cols !== null) selects.push({ table, cols });
    let rows = (tables[table] ?? []).filter((r) =>
      calls.every((c) => {
        if (c[0] === "eq" || c[0] === "is") return r[c[1]] === c[2];
        if (c[0] === "in") return c[2].includes(r[c[1]]);
        return true;
      }),
    );
    if (honourSelect && cols && cols !== "*") {
      const names = cols.split(",").map((c) => c.trim());
      rows = rows.map((r) =>
        Object.fromEntries(names.filter((c) => c in r).map((c) => [c, structuredClone(r[c])])),
      );
    } else rows = rows.map((r) => structuredClone(r));
    const single = calls.some((c) => c[0] === "maybeSingle");
    return { data: single ? (rows[0] ?? null) : rows, error: null };
  });
  service.storage = {
    from: () => ({ getPublicUrl: (p) => ({ data: { publicUrl: `https://cdn.test/${p}` } }) }),
  };
  globalThis.__jobsService = service;
  return { service, selects };
}

/** Every key path in a value: `a`, `a.b`, `a[].b`. */
function keyPaths(value, prefix = "", out = new Set()) {
  if (Array.isArray(value)) for (const v of value) keyPaths(v, `${prefix}[]`, out);
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      const p = prefix ? `${prefix}.${k}` : k;
      out.add(p);
      keyPaths(v, p, out);
    }
  }
  return [...out].sort();
}
const DERIVED = ["company_is_internal", "company_logo_url"];
const SUMMARY_PATHS = [...PUBLIC_JOB_SUMMARY_FIELDS, ...DERIVED].sort();
const QUESTION_PATHS = ["essential", "id", "options", "question", "type"].map(
  (k) => `screening_questions[].${k}`,
);
const DETAIL_PATHS = [...PUBLIC_JOB_DETAIL_FIELDS, ...DERIVED, ...QUESTION_PATHS].sort();

/** The exact-keys check every test below uses, and the negative controls aim at. */
function assertSummary(row) {
  assert.deepEqual(keyPaths(row), SUMMARY_PATHS);
}
function assertDetail(row) {
  assert.deepEqual(keyPaths(row), DETAIL_PATHS);
}
const NEVER = [
  "future_internal_column",
  "ideal",
  "numeric_mode",
  "created_by",
  "client_id",
  "interview_criteria",
  "scoring_must_haves",
  "booking_hours_override",
  "avatar_interviewer_name",
  "cv_weight_domain",
];
function assertNoInternal(value) {
  const text = JSON.stringify(value);
  for (const key of NEVER) assert.ok(!text.includes(`"${key}"`), `${key} was sent`);
}

const request = (url, headers = {}) => new NextRequest(`http://localhost${url}`, { headers });

/* ── the keep-lists themselves ────────────────────────────────── */

test("the keep-lists are exactly the approved fields", () => {
  assert.deepEqual(
    [...PUBLIC_JOB_SUMMARY_FIELDS],
    [
      "id",
      "title",
      "company",
      "company_rating",
      "location",
      "salary_min",
      "salary_max",
      "salary_currency",
      "contract_type",
      "work_type",
      "category",
      "experience_level",
      "positions",
      "created_at",
      "slug",
      "company_id",
    ],
  );
  assert.deepEqual(
    [...PUBLIC_JOB_DETAIL_FIELDS],
    [
      ...PUBLIC_JOB_SUMMARY_FIELDS,
      "description",
      "requirements",
      "responsibilities",
      "country",
      "city",
      "language",
      "screening_questions",
    ],
  );
  assert.equal(
    jobs.LIST_SELECT,
    PUBLIC_JOB_SUMMARY_FIELDS.join(","),
    "LIST_SELECT is built from the keep-list",
  );
});

/* ── each public reader ───────────────────────────────────────── */

test("GET /api/jobs: every row is the summary keep-list exactly, nothing internal", async () => {
  const { selects } = fakeDb();
  const res = await GET(request("/api/jobs"));
  assert.equal(res.status, 200);
  const rows = await res.json();
  assert.equal(rows.length, 2, "the closed job is not listed");
  for (const row of rows) assertSummary(row);
  assertNoInternal(rows);
  assert.deepEqual(
    selects.filter((s) => s.table === "jobs").map((s) => s.cols),
    [jobs.LIST_SELECT],
  );
});

test("the /jobs page's server data: getInitialJobs and fetchCompanyJobs are the summary keep-list", async () => {
  fakeDb();
  const initial = await getInitialJobs();
  assert.equal(initial.ok, true);
  for (const row of initial.value) assertSummary(row);
  assertNoInternal(initial.value);
  const company = await fetchCompanyJobs(CO);
  assert.equal(company.ok, true);
  assert.equal(company.value.length, 2);
  for (const row of company.value) assertSummary(row);
  assertNoInternal(company.value);
});

test("getJobBySlug: the detail keep-list, questions in their public shape only", async () => {
  const { selects } = fakeDb();
  const read = await getJobBySlug("role-1");
  assert.equal(read.ok, true);
  assertDetail(read.value);
  assertNoInternal(read.value);
  assert.deepEqual(
    read.value.screening_questions.map((q) => q.id),
    ["q1", "q2"],
    "the questions are all there",
  );
  assert.equal(
    selects.find((s) => s.table === "jobs").cols,
    PUBLIC_JOB_DETAIL_FIELDS.join(","),
    "the detail select is the keep-list",
  );
  assert.equal((await getJobBySlug("no-such-role")).value, null);
});

test("the readers project on their own: a row wider than the select still leaks nothing", async () => {
  fakeDb({ honourSelect: false });
  const list = await (await GET(request("/api/jobs"))).json();
  for (const row of list) assertSummary(row);
  for (const row of (await getInitialJobs()).value) assertSummary(row);
  assertDetail((await getJobBySlug("role-2")).value);
  assertNoInternal([list, (await getJobBySlug("role-2")).value]);
});

test('no public reader ever selects "*"', async () => {
  const { selects } = fakeDb();
  await GET(request("/api/jobs"));
  await getInitialJobs();
  await fetchCompanyJobs(CO);
  await getJobBySlug("role-1");
  const jobSelects = selects.filter((s) => s.table === "jobs").map((s) => s.cols);
  assert.equal(jobSelects.length, 4);
  for (const cols of jobSelects) {
    assert.ok(!cols.includes("*"), `select(${cols})`);
    assert.ok([jobs.LIST_SELECT, PUBLIC_JOB_DETAIL_FIELDS.join(",")].includes(cols));
  }
  // And none in the source either.
  for (const file of ["./jobs.ts", "../app/api/jobs/route.ts", "../app/jobs/company-filter.ts"]) {
    assert.doesNotMatch(
      readFileSync(new URL(file, import.meta.url), "utf8"),
      /select\("\*"\)/,
      file,
    );
  }
});

/* ── ?id= is gone ─────────────────────────────────────────────── */

test("GET /api/jobs?id= is a 404 for any value, and never falls through to the list", async () => {
  const { selects } = fakeDb();
  for (const url of [
    "/api/jobs?id=00000000-0000-4000-8000-000000000001",
    "/api/jobs?id=",
    "/api/jobs?id=not-a-uuid",
    "/api/jobs?category=x&id=00000000-0000-4000-8000-000000000001",
  ]) {
    const res = await GET(request(url));
    assert.equal(res.status, 404, url);
    assert.deepEqual(await res.json(), { error: "Not found." });
  }
  assert.equal(selects.length, 0, "no query was made");
});

/* ── the same answer whoever asks ─────────────────────────────── */

test("signed in or signed out: identical responses", async () => {
  fakeDb();
  const out = await (await GET(request("/api/jobs"))).text();
  fakeDb();
  const signedIn = await (
    await GET(
      request("/api/jobs", {
        cookie: "sb-access-token=test-session; sb-refresh-token=test-refresh; remotiv-admin=1",
        authorization: "Bearer test-session",
      }),
    )
  ).text();
  assert.equal(signedIn, out);
  // None of these readers can see a session: no cookies, headers or auth client.
  for (const file of ["./jobs.ts", "../app/api/jobs/route.ts", "../app/jobs/company-filter.ts"]) {
    const src = readFileSync(new URL(file, import.meta.url), "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    assert.doesNotMatch(
      code,
      /next\/headers|cookies\(|getUser|createClient\(|requireAdmin|getCompanyContext/,
      file,
    );
  }
});

/* ── negative controls: the old code fails these checks ───────── */

const OLD_LIST_SELECT =
  "id,title,company,company_rating,location,country,city,salary_min,salary_max,salary_currency,contract_type,work_type,category,experience_level,language,positions,status,created_at,slug,display_order,client_id,created_by,company_id,listed_on_remotiv";

/** The single-job projection as it shipped before F7, verbatim. */
function oldToPublicDetailJob(job) {
  const { client_id, created_by, company_id, screening_questions, ...rest } = job;
  return {
    ...rest,
    screening_questions: (screening_questions ?? []).map((q) => ({
      id: q.id,
      question: q.question,
      type: q.type,
      options: q.options,
      essential: q.essential,
    })),
  };
}

test("negative control: the old LIST_SELECT fails the summary check", async () => {
  const { service } = fakeDb();
  const { data } = await service.from("jobs").select(OLD_LIST_SELECT).eq("status", "open");
  assert.throws(() =>
    assertSummary({ ...data[0], company_logo_url: null, company_is_internal: false }),
  );
  assert.throws(() => assertNoInternal(data));
});

test('negative control: the old toPublicDetailJob over select("*") fails the detail check', async () => {
  const { service } = fakeDb();
  const { data } = await service.from("jobs").select("*").eq("slug", "role-1").maybeSingle();
  const old = oldToPublicDetailJob({ ...data, company_logo_url: null, company_is_internal: false });
  assert.throws(() => assertDetail(old));
  assert.throws(
    () => assertNoInternal(old),
    "future_internal_column and the scoring fields went out",
  );
});

test('negative control: select("*") through the new projection is still caught by the select check', async () => {
  const { service, selects } = fakeDb();
  await service.from("jobs").select("*").eq("slug", "role-1").maybeSingle();
  const cols = selects.at(-1).cols;
  assert.throws(() =>
    assert.ok([jobs.LIST_SELECT, PUBLIC_JOB_DETAIL_FIELDS.join(",")].includes(cols)),
  );
});
