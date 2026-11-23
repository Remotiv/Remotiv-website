/**
 * #74: the Admin Talent page and Admin Search read named columns, never "*".
 * The Talent page used to pull every profile's cv_text and search_vector on
 * every render; neither is shown.
 *
 *   node --test src/app/admin/admin-reads-columns.test.ts
 *
 * Runs the shipped fetchTalentProfiles and searchCandidates against a fake
 * database that serves only the columns asked for, the way PostgREST does,
 * and refuses a column the table does not have. The same calls against a fake
 * that ignores the column list (what "*" returned) must give an identical
 * answer: that is what proves nothing on screen went blank. Synthetic data.
 */
// @ts-nocheck - same reason as the other node:test files.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
import { call, fakeService } from "../../test-support/fake-postgrest.mjs";

register(new URL("../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../test-support/fake-service-client-hook.mjs", import.meta.url));
register(new URL("../../test-support/admin-actions-test-hook.mjs", import.meta.url));

const { fetchTalentProfiles } = await import("./talent/actions.ts");
const { searchCandidates } = await import("./search/actions.ts");

globalThis.__adminCtxForTests = { userId: "admin-1", role: "admin" };

/** talent_profiles as production has it (scripts/staging/.schema dump, 16 Nov). */
const TALENT_COLUMNS = new Set(
  (
    "id first_name last_name email phone city country linkedin_url github_url job_title " +
    "role_category years_experience industry degree institution skills summary availability " +
    "work_type notice_period work_location salary_min salary_max avatar_url cv_url cv_text " +
    "status notes created_at approved_at experience cv_path search_vector user_id claimed_at " +
    "claim_method email_verified_at photo_path is_shortlisted is_placed is_paused is_archived " +
    "last_active_at retention_warned_at"
  ).split(" "),
);

/** Every column filled, so a column left out of a select cannot go unnoticed. */
const TALENT_ROW = {
  id: "t0000000-0000-0000-0000-00000000a001",
  first_name: "Synthetic",
  last_name: "Person",
  email: "synthetic@example.invalid",
  phone: "+920000000000",
  city: "Lahore",
  country: "Pakistan",
  linkedin_url: "https://linkedin.example.invalid/in/x",
  github_url: "https://github.example.invalid/x",
  job_title: "Android Engineer",
  role_category: "Engineering",
  years_experience: 6,
  industry: "Software",
  degree: "BSc",
  institution: "Example University",
  skills: ["Kotlin", "Jetpack Compose"],
  summary: "Builds mobile apps.",
  availability: "immediate",
  work_type: "full_time",
  notice_period: "2 weeks",
  work_location: "remote",
  salary_min: 1000,
  salary_max: 2000,
  avatar_url: "https://avatars.example.invalid/a.png",
  cv_url: "https://cv.example.invalid/a.pdf",
  cv_text: "x".repeat(20_000),
  status: "approved",
  notes: "An admin note.",
  created_at: "2026-10-01T00:00:00Z",
  approved_at: "2026-10-02T00:00:00Z",
  experience: [{ title: "Engineer", company: "Acme", dates: "2020-2026" }],
  cv_path: "talent/a.pdf",
  search_vector: "'android':1 'engineer':2",
  user_id: "u0000000-0000-0000-0000-000000000001",
  claimed_at: "2026-10-03T00:00:00Z",
  claim_method: "self_service",
  email_verified_at: "2026-10-03T00:00:00Z",
  photo_path: "photos/a.jpg",
  is_shortlisted: true,
  is_placed: true,
  is_paused: true,
  is_archived: true,
  last_active_at: "2026-11-01T00:00:00Z",
  retention_warned_at: null,
};

const APP_ROWS = [
  {
    id: "a0000000-0000-0000-0000-0000000aa001",
    first_name: "Cvonly",
    last_name: "Match",
    email: "cvonly@example.invalid",
    phone: "+920000000001",
    status: "new",
    created_at: "2026-11-01T00:00:00Z",
    // The only place the keyword appears: matched in the database, and
    // re-counted in memory, so cv_text has to come back for this hit to show.
    cv_text: "Experienced with zephyrine pipelines.",
    notes: null,
    jobs: { title: "Data Engineer" },
    cv_path: "apps/a.pdf",
    answers: { q1: "a" },
    company_id_snapshot: null,
  },
  {
    id: "a0000000-0000-0000-0000-0000000aa002",
    first_name: "Kotlin",
    last_name: "Applicant",
    email: "kotlin@example.invalid",
    phone: null,
    status: "shortlisted",
    created_at: "2026-11-02T00:00:00Z",
    cv_text: "Mobile.",
    notes: "Strong Lahore candidate.",
    jobs: { title: "Android Engineer" },
    cv_path: "apps/b.pdf",
    answers: {},
    company_id_snapshot: null,
  },
];
const APP_COLUMNS = new Set(Object.keys(APP_ROWS[0]));

/** Top-level names of a PostgREST select string: "a, b, jobs(title)" -> a, b, jobs. */
const selected = (select) =>
  select
    .split(/,(?![^(]*\))/)
    .map((s) => s.trim())
    .map((s) => s.replace(/\(.*\)$/, ""));

/** projecting: serve only the columns asked for (PostgREST); otherwise everything ("*"). */
function world({ projecting }) {
  return fakeService((table, calls) => {
    if (table === "companies") return { data: [], error: null };
    const rows = table === "talent_profiles" ? [TALENT_ROW] : APP_ROWS;
    const known = table === "talent_profiles" ? TALENT_COLUMNS : APP_COLUMNS;
    const select = call(calls, "select")[1];
    if (!projecting) return { data: rows, error: null };
    const cols = selected(select);
    for (const c of cols) {
      if (c !== "*" && !known.has(c)) {
        return { data: null, error: { code: "42703", message: `column ${c} does not exist` } };
      }
    }
    if (cols.includes("*")) return { data: rows, error: null };
    return {
      data: rows.map((r) => Object.fromEntries(cols.map((c) => [c, r[c]]))),
      error: null,
    };
  });
}

async function selectsOf(run) {
  const service = world({ projecting: true });
  globalThis.__fakeServiceClientForTests = () => service;
  await run();
  return service.queries
    .filter((q) => q.table !== "companies")
    .map((q) => ({ table: q.table, select: call(q.calls, "select")[1] }));
}

async function answer(run, projecting) {
  globalThis.__fakeServiceClientForTests = () => world({ projecting });
  return run();
}

const SEARCH = () => searchCandidates("kotlin zephyrine lahore");

test("(a) Admin Talent: the select is named columns, never *, cv_text or search_vector", async () => {
  const reads = await selectsOf(fetchTalentProfiles);
  assert.equal(reads.length, 1);
  assert.equal(reads[0].table, "talent_profiles");
  const cols = selected(reads[0].select);
  assert.ok(!cols.includes("*"), `select was ${reads[0].select}`);
  assert.ok(!cols.includes("cv_text"));
  assert.ok(!cols.includes("search_vector"));
});

test("(a) Admin Search: neither query selects *; talent never selects cv_text or search_vector", async () => {
  const reads = await selectsOf(SEARCH);
  assert.deepEqual(reads.map((r) => r.table).sort(), ["job_applications", "talent_profiles"]);
  for (const r of reads) {
    const cols = selected(r.select);
    assert.ok(!cols.includes("*"), `${r.table} select was ${r.select}`);
    assert.ok(!cols.includes("search_vector"), r.table);
  }
  const talent = selected(reads.find((r) => r.table === "talent_profiles").select);
  assert.ok(!talent.includes("cv_text"), "talent search does not match on cv_text");
  // The one large column kept, on purpose: applications are re-counted over it.
  const apps = selected(reads.find((r) => r.table === "job_applications").select);
  assert.ok(apps.includes("cv_text"));
});

test("(b) Admin Talent: every field the dashboard gets is identical to what * returned (nothing blank)", async () => {
  const named = await answer(fetchTalentProfiles, true);
  const star = await answer(fetchTalentProfiles, false);
  assert.equal(named.length, 1);
  assert.deepEqual(named, star);
  // Discriminating: every field is filled in the source row, so a column left
  // out would read as "", null, [] or false here and differ from *.
  for (const [k, v] of Object.entries(named[0])) {
    assert.ok(v !== null && v !== "" && v !== false, `${k} came back blank`);
    if (Array.isArray(v)) assert.ok(v.length > 0, `${k} came back empty`);
  }
});

test("(b) Admin Search: results are identical to what * returned, including a hit found only in cv_text", async () => {
  const named = await answer(SEARCH, true);
  const star = await answer(SEARCH, false);
  assert.deepEqual(named, star);
  assert.deepEqual(named.applications.map((h) => h.id.slice(-6)).sort(), ["0aa001", "0aa002"]);
  const cvOnly = named.applications.find((h) => h.id.endsWith("aa001"));
  assert.deepEqual(cvOnly.matchedKeywords, ["zephyrine"]);
  assert.equal(named.talent.length, 1);
  assert.equal(named.talent[0].headline, TALENT_ROW.summary);
  assert.equal(named.talent[0].job_role, TALENT_ROW.job_title);
});
