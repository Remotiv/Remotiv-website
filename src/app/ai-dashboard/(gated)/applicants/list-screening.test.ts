/**
 * The list's verdict line and "Screening X/Y met" counts (Applicants Split,
 * commit 2).
 *
 *   node --test "src/app/ai-dashboard/(gated)/applicants/list-screening.test.ts"
 *
 * Runs the shipped fetchCompanyApplicants and fetchTopScoredApplicants against
 * fake-list-db.mjs, which applies the filters the code sends. Synthetic data.
 *
 * What is proved: the counting rule (tested questions only; untested ones are
 * neither met nor counted; nothing tested is null); the counts are one
 * company-scoped read of exactly the page's ids; no answer text reaches a list
 * row; a failed counts read leaves the list intact with no counts; the verdict
 * rides on the row only when the model itself produced it.
 */
// @ts-nocheck - same reason as list-read.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../../../test-support/applicants-test-hook.mjs", import.meta.url));

const { fakeService } = await import("../../../../test-support/fake-postgrest.mjs");
const { fakeListDb } = await import("../../../../test-support/fake-list-db.mjs");
// APPLICANTS_ACTIONS_UNDER_TEST points the suite at another copy (the negative control).
const { pathToFileURL } = await import("node:url");
const { fetchCompanyApplicants, fetchTopScoredApplicants } = await import(
  process.env.APPLICANTS_ACTIONS_UNDER_TEST
    ? pathToFileURL(process.env.APPLICANTS_ACTIONS_UNDER_TEST).href
    : "./actions.ts"
);
const { screeningCounts } = await import("../../lib/applicant-types.ts");

const CO = "c0000000-0000-0000-0000-000000000001";
const J1 = "a0000000-0000-0000-0000-00000000000a";
const SECRET = "Answer text that must never reach the list";

const q = (matched, extra = {}) => ({
  question_id: "q",
  question: "Q?",
  type: "yesno",
  essential: false,
  ideal: "yes",
  answer: SECRET,
  matched,
  ...extra,
});

const app = (n, screening_answers) => ({
  id: `app-0000${n}`,
  company_id_snapshot: CO,
  job_id: J1,
  first_name: `Cand${n}`,
  last_name: "X",
  email: `c${n}@acme.test`,
  pipeline_stage: "applied",
  shortlist_flagged_at: null,
  created_at: `2026-01-0${n}T00:00:00.000Z`,
  cv_path: null,
  cv_url: null,
  cv_delete_after: null,
  screening_answers,
});

const score = (n, fields) => ({
  application_id: `app-0000${n}`,
  status: "scored",
  overall_score: 90 - n,
  human_adjusted_score: null,
  confidence: "high",
  error: null,
  verdict: null,
  effective_score: 90 - n,
  ...fields,
});

const WORLD = {
  apps: [
    app(1, [q(true), q(false), q(true, { scored: false })]), // 1 of 2 tested
    app(2, [q(true), q(true)]), // 2 of 2, no scored key (legacy snapshot)
    app(3, [q(false, { scored: false })]), // nothing tested
    app(4, []), // the job asked nothing
    app(5, "not an array"),
  ],
  scores: [
    score(1, { verdict: "  Strong React lead; notice period is the only gap  " }),
    score(2, { status: "failed", verdict: "A leftover line from an earlier attempt" }),
    score(3, { status: "skipped", human_adjusted_score: 70, verdict: "Never shown" }),
    score(4, { verdict: "   " }),
  ],
  jobs: [{ id: J1, title: "Engineer", company_id: CO }],
};

const ctx = {
  companyId: CO,
  role: "owner",
  memberId: "m-1",
  memberName: "Rae",
  user: { id: "u-1", email: "rae@acme.test" },
  company: { name: "Acme" },
};

const isCounts = (q) => q.calls.find((c) => c[0] === "select")?.[1] === "id, screening_answers";

/**
 * The counts read runs only with the Split flag on, so every case here turns
 * it on, except the one that proves the flag-off path, and restores it after.
 */
async function run(action, { failCounts = false, split = true } = {}) {
  const saved = process.env.APPLICANTS_SPLIT_ENABLED;
  if (split) process.env.APPLICANTS_SPLIT_ENABLED = "1";
  else delete process.env.APPLICANTS_SPLIT_ENABLED;
  const respond = fakeListDb(WORLD);
  const service = fakeService((table, calls) => {
    if (failCounts && table === "job_applications" && isCounts({ calls })) {
      return { data: null, error: { code: "57014", message: "timeout on job_applications" } };
    }
    return respond(table, calls);
  });
  globalThis.__applicantsServiceForTests = () => service;
  globalThis.__applicantsCtxForTests = ctx;
  const logged = [];
  const quiet = console.error;
  console.error = (...a) => logged.push(a.map(String).join(" "));
  try {
    return { read: await action({}), service, logged };
  } finally {
    console.error = quiet;
    if (saved === undefined) delete process.env.APPLICANTS_SPLIT_ENABLED;
    else process.env.APPLICANTS_SPLIT_ENABLED = saved;
  }
}

const rowsOf = (read) => (Array.isArray(read.value) ? read.value : read.value.rows);
const byId = (read) => Object.fromEntries(rowsOf(read).map((r) => [r.id, r]));

test("the counting rule: tested questions only, matched counted, nothing tested is null", () => {
  assert.deepEqual(screeningCounts([q(true), q(false), q(true, { scored: false })]), {
    met: 1,
    scored: 2,
  });
  assert.deepEqual(screeningCounts([q(true), q(true)]), { met: 2, scored: 2 });
  assert.equal(screeningCounts([q(true, { scored: false })]), null);
  assert.equal(screeningCounts([]), null);
  assert.equal(screeningCounts(null), null);
  assert.equal(screeningCounts("x"), null);
  assert.deepEqual(screeningCounts([null, q(false)]), { met: 0, scored: 1 });
});

test("list rows carry the counts, and the counts read is one company-scoped read of the page's ids", async () => {
  const { read, service } = await run(fetchCompanyApplicants);
  assert.equal(read.ok, true);
  const rows = byId(read);
  assert.deepEqual(rows["app-00001"].screening, { met: 1, scored: 2 });
  assert.deepEqual(rows["app-00002"].screening, { met: 2, scored: 2 });
  assert.equal(rows["app-00003"].screening, null);
  assert.equal(rows["app-00004"].screening, null);
  assert.equal(rows["app-00005"].screening, null);

  const counts = service.queries.filter((x) => x.table === "job_applications" && isCounts(x));
  assert.equal(counts.length, 1);
  const eq = (c) => counts[0].calls.find((x) => x[0] === "eq" && x[1] === c)?.[2];
  assert.equal(eq("company_id_snapshot"), CO);
  const ids = counts[0].calls.find((x) => x[0] === "in" && x[1] === "id")?.[2];
  assert.deepEqual([...ids].sort(), Object.keys(rows).sort(), "exactly the page's ids");
  assert.ok(
    counts[0].calls.some((x) => x[0] === "limit" && x[1] === ids.length),
    "bounded",
  );
});

test("no answer text reaches a list row", async () => {
  const { read } = await run(fetchCompanyApplicants);
  const text = JSON.stringify(rowsOf(read));
  assert.ok(!text.includes(SECRET), "answer text in the list");
  for (const r of rowsOf(read))
    assert.ok(!("screening_answers" in r), "screening_answers on a row");
});

test("a failed counts read keeps the list, with no counts, and logs a code only", async () => {
  const { read, logged } = await run(fetchCompanyApplicants, { failCounts: true });
  assert.equal(read.ok, true, "the list failed because the counts did");
  assert.equal(rowsOf(read).length, WORLD.apps.length);
  for (const r of rowsOf(read)) assert.equal(r.screening, null);
  assert.deepEqual(logged, ["[applicants] screening counts read failed: 57014"]);
});

test("Review top 10 rows carry the counts too", async () => {
  const { read } = await run(fetchTopScoredApplicants);
  assert.equal(read.ok, true);
  const rows = byId(read);
  assert.deepEqual(rows["app-00001"].screening, { met: 1, scored: 2 });
});

test("the verdict rides on the row only when the model itself produced it", async () => {
  const { read } = await run(fetchCompanyApplicants);
  const rows = byId(read);
  assert.equal(rows["app-00001"].score.verdict, "Strong React lead; notice period is the only gap");
  assert.equal(rows["app-00002"].score.verdict, null, "a failed attempt's leftover line");
  assert.equal(rows["app-00003"].score.verdict, null, "a reviewer's number on an unread CV");
  assert.equal(rows["app-00004"].score.verdict, null, "blank is no verdict");
  assert.equal(rows["app-00005"].score.verdict, null, "no score row");
});

test("flag off: no counts read runs, every row has screening null, the live page is unchanged", async () => {
  for (const action of [fetchCompanyApplicants, fetchTopScoredApplicants]) {
    const { read, service, logged } = await run(action, { split: false });
    assert.equal(read.ok, true);
    assert.equal(
      service.queries.filter((x) => x.table === "job_applications" && isCounts(x)).length,
      0,
      "a counts read ran with the flag off",
    );
    for (const r of rowsOf(read)) assert.equal(r.screening, null);
    assert.deepEqual(logged, []);
  }
});
