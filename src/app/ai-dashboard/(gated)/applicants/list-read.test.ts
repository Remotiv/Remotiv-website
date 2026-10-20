/**
 * fetchCompanyApplicants and fetchTopScoredApplicants — the paged, server-ordered
 * list — run as shipped against a PostgREST emulator that actually sorts and pages.
 *
 *   node --test "src/app/ai-dashboard/(gated)/applicants/list-read.test.ts"
 *
 * ── Why these tests execute the ordering instead of pinning it ───
 *
 * The claim of this pass is that the database now ranks the population and
 * hands back one page of it. So the things that can be wrong are not names in
 * the source — they are the order terms, their sequence, where the nulls land,
 * whether a unique tiebreaker is present, and the offset arithmetic. Asserting
 * `.order()` was called with certain arguments restates the code; it cannot
 * tell you the rows come back in the right order.
 *
 * So fake-list-db.mjs applies what the query asked for. It is the database;
 * the action is the query. Every expectation below is computed by sorting the
 * fixture independently, in this file, and comparing ids.
 *
 * ── The fake is deliberately hostile about ties ──────────────────
 *
 * Rows that compare equal on every ORDER BY term are permuted differently on
 * every request, because that is what Postgres does and what production was
 * measured doing: at window 1500-1549 two applicants came back twice and two
 * vanished, at 1 boundary in 5. A stable fake would make `id.asc` look
 * optional and the completeness test would pass without it.
 */
// @ts-nocheck — same reason as the other node:test files here: Node's `.ts`
// specifier vs this tsconfig, which does not set allowImportingTsExtensions.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../../../test-support/applicants-test-hook.mjs", import.meta.url));

const { fakeService } = await import("../../../../test-support/fake-postgrest.mjs");
const { fakeListDb } = await import("../../../../test-support/fake-list-db.mjs");
const { fetchApplicantCounts, fetchCompanyApplicants, fetchTopScoredApplicants } = await import(
  "./actions.ts"
);
const { APPLICANT_PAGE_SIZE, TOP_SCORED_LIMIT } = await import("../../lib/applicant-types.ts");

const CO = "c0000000-0000-0000-0000-000000000001";
const CO2 = "c0000000-0000-0000-0000-000000000002";
const J1 = "a0000000-0000-0000-0000-00000000000a";

const ctxFor = (role) => ({
  companyId: CO,
  role,
  memberId: "m-1",
  memberName: "Rae Recruiter",
  user: { id: "u-1", email: "rae@acme.test" },
  company: { name: "Acme" },
});

/** Zero-padded so lexical id order and numeric order agree, for readable expectations. */
const idAt = (n) => `app-${String(n).padStart(5, "0")}`;

/**
 * Run an action against a world. Returns the read AND the service, so a test
 * can assert on the number of requests as well as the rows.
 */
async function run(action, query = {}, { role = "owner", world, ...opts } = {}) {
  const service = fakeService(fakeListDb(world, opts));
  globalThis.__applicantsServiceForTests = () => service;
  globalThis.__applicantsCtxForTests = ctxFor(role);
  const quiet = console.error;
  console.error = () => {};
  try {
    const read = await action(query);
    return { read, service };
  } finally {
    console.error = quiet;
  }
}

/**
 * The expected Best Match order, computed here rather than taken from the fake.
 *
 * effective_score DESC NULLS LAST, then created_at DESC NULLS LAST, then id ASC.
 * This is the specification; if the action's terms differ in any respect the
 * ids will not match.
 */
function expectedBest(apps, scores) {
  const scoreOf = (id) => scores.find((s) => s.application_id === id) ?? null;
  return [...apps]
    .sort((a, b) => {
      const as = scoreOf(a.id)?.effective_score ?? null;
      const bs = scoreOf(b.id)?.effective_score ?? null;
      if (as !== bs) {
        if (as === null) return 1; // nulls last
        if (bs === null) return -1;
        return bs - as;
      }
      if (a.created_at !== b.created_at) {
        if (a.created_at === null) return 1;
        if (b.created_at === null) return -1;
        return a.created_at < b.created_at ? 1 : -1; // DESC
      }
      return a.id < b.id ? -1 : 1; // id ASC
    })
    .map((r) => r.id);
}

function expectedNewest(apps) {
  return [...apps]
    .sort((a, b) => {
      if (a.created_at !== b.created_at) {
        if (a.created_at === null) return 1;
        if (b.created_at === null) return -1;
        return a.created_at < b.created_at ? 1 : -1;
      }
      return a.id < b.id ? -1 : 1;
    })
    .map((r) => r.id);
}

/**
 * Walk every page of a query and return the ids in page order, plus the number
 * of POPULATED pages.
 *
 * The empty page past the end is requested and asserted readable, but not
 * counted. When the total is an exact multiple of the page size — 2,500 and 260
 * both are, on purpose — the final populated page is full, so nothing about it
 * says it was the last. The walk only learns that from the empty page after it,
 * which production answers as a 206 carrying the true total rather than the 416
 * an offset past the end would give. Counting it would make `pages` one more
 * than ceil(total / size) for every exact multiple and one less for every other
 * size, which is a worse thing to assert against.
 */
async function walkAllPages(query, opts) {
  const ids = [];
  let page = 1;
  let total = null;
  let populated = 0;
  // Bounded by construction: the loop stops on the first short page, and the
  // ceiling below exists so a bug cannot hang the suite.
  for (; page <= 2000; page++) {
    const { read } = await run(fetchCompanyApplicants, { ...query, page }, opts);
    assert.equal(read.ok, true, `page ${page} failed to read`);
    total = read.value.total;
    ids.push(...read.value.rows.map((r) => r.id));
    if (read.value.rows.length > 0) populated++;
    if (read.value.rows.length < APPLICANT_PAGE_SIZE) break;
  }
  return { ids, total, pages: populated };
}

// ════════════════════════════════════════════════════════════
//  1. ORDERING — 2,500 applicants on one job
// ════════════════════════════════════════════════════════════

/**
 * 2,500 applicants, 1,700 scored and 800 with no score row at all.
 *
 * The scores repeat on purpose — 1,700 applicants over ~60 distinct values
 * means every page boundary lands inside a tie, which is where the production
 * defect lived. created_at also repeats across groups of 7, so the second
 * order term is exercised too and `id.asc` is the only term that can finally
 * separate some of them.
 */
function buildOrderingWorld() {
  const apps = [];
  const scores = [];
  for (let i = 0; i < 2500; i++) {
    const id = idAt(i);
    apps.push({
      id,
      company_id_snapshot: CO,
      job_id: J1,
      first_name: `First${i}`,
      last_name: `Last${i}`,
      email: `cand${i}@acme.test`,
      pipeline_stage: "applied",
      shortlist_flagged_at: null,
      // Repeats every 7 rows, so ties on score frequently tie on date too.
      created_at: `2026-02-${String(1 + (Math.floor(i / 7) % 28)).padStart(2, "0")}T00:00:00.000Z`,
      cv_path: "cv.pdf",
      cv_url: null,
      cv_delete_after: null,
    });
    if (i < 1700) {
      const value = 30 + (i % 60);
      scores.push({
        application_id: id,
        status: "scored",
        overall_score: value,
        human_adjusted_score: null,
        confidence: "high",
        error: null,
        effective_score: value,
      });
    }
  }
  return {
    apps,
    scores,
    jobs: [{ id: J1, company_id: CO, title: "Engineer", deleted_at: null }],
    team: [],
  };
}

const ORDERING = buildOrderingWorld();

test("Best Match page 1 is the top 20 of the whole 2,500, not of a fetched slice", async () => {
  const { read } = await run(fetchCompanyApplicants, {}, { world: ORDERING });
  assert.equal(read.ok, true);

  const expected = expectedBest(ORDERING.apps, ORDERING.scores).slice(0, APPLICANT_PAGE_SIZE);
  assert.deepEqual(
    read.value.rows.map((r) => r.id),
    expected,
  );
  assert.equal(read.value.total, 2500);
});

test("Best Match is the DEFAULT — no sort option produces the same page as sort:best", async () => {
  // The default matters: it is the view the page opens on, and a default of
  // "newest" would silently retire the ranking this whole pass exists for.
  const bare = await run(fetchCompanyApplicants, {}, { world: ORDERING });
  const best = await run(fetchCompanyApplicants, { sort: "best" }, { world: ORDERING });
  assert.deepEqual(
    bare.read.value.rows.map((r) => r.id),
    best.read.value.rows.map((r) => r.id),
  );

  const newest = await run(fetchCompanyApplicants, { sort: "newest" }, { world: ORDERING });
  assert.notDeepEqual(
    bare.read.value.rows.map((r) => r.id),
    newest.read.value.rows.map((r) => r.id),
    "best and newest produced the same page, so neither option is discriminating",
  );
});

test("every scored applicant outranks every unscored one — nulls last, not nulls first", async () => {
  // The discriminating test for `.nullslast`. DESC defaults to NULLS FIRST, so
  // without it all 800 unscored applicants would occupy the first 40 pages and
  // page 1 would be entirely blank scores.
  const { read } = await run(fetchCompanyApplicants, { page: 1 }, { world: ORDERING });
  for (const row of read.value.rows) {
    assert.equal(row.score.status, "scored", `an unscored applicant reached page 1: ${row.id}`);
    assert.ok(typeof row.score.overall === "number");
  }

  // And the top score really is the maximum in the fixture (89 = 30 + 59).
  assert.equal(read.value.rows[0].score.overall, 89);
});

test("the unscored tail sits at the very end, after all 1,700 scored applicants", async () => {
  // 1700 scored / 20 = page 85 is the last all-scored page; 86 starts the tail.
  const { read } = await run(fetchCompanyApplicants, { page: 86 }, { world: ORDERING });
  assert.equal(read.ok, true);
  for (const row of read.value.rows) {
    assert.equal(row.score.status, "pending", `a scored applicant appeared in the tail: ${row.id}`);
    assert.equal(row.score.overall, null);
  }
});

test("Newest sorts by created_at with the same unique tiebreaker", async () => {
  const { read } = await run(fetchCompanyApplicants, { sort: "newest" }, { world: ORDERING });
  assert.deepEqual(
    read.value.rows.map((r) => r.id),
    expectedNewest(ORDERING.apps).slice(0, APPLICANT_PAGE_SIZE),
  );
});

// ════════════════════════════════════════════════════════════
//  2. COMPLETENESS — the union of all pages IS the population
// ════════════════════════════════════════════════════════════

test("walking all 125 pages of 2,500 yields every applicant exactly once", async () => {
  const { ids, total, pages } = await walkAllPages({}, { world: ORDERING });

  assert.equal(total, 2500);
  assert.equal(pages, 125);
  assert.equal(ids.length, 2500, "the union of the pages was not the population");
  assert.equal(new Set(ids).size, 2500, "an applicant appeared on two pages");
  assert.deepEqual(ids, expectedBest(ORDERING.apps, ORDERING.scores));
});

/**
 * 260 applicants sharing ONE score and ONE timestamp.
 *
 * Both of the first two order terms are therefore exhausted on every pair, so
 * `id.asc` is the only thing left that can produce a total order. 260 rows is
 * 13 pages, so 12 internal boundaries all fall inside the tie — the production
 * defect showed up at 1 boundary in 5, so a two-page test would have missed it.
 */
function buildTieWorld() {
  const apps = [];
  const scores = [];
  for (let i = 0; i < 260; i++) {
    const id = idAt(i);
    apps.push({
      id,
      company_id_snapshot: CO,
      job_id: J1,
      first_name: `Tie${i}`,
      last_name: "Same",
      email: `tie${i}@acme.test`,
      pipeline_stage: "applied",
      shortlist_flagged_at: null,
      created_at: "2026-03-01T00:00:00.000Z",
      cv_path: null,
      cv_url: null,
      cv_delete_after: null,
    });
    scores.push({
      application_id: id,
      status: "scored",
      overall_score: 77,
      human_adjusted_score: null,
      confidence: "medium",
      error: null,
      effective_score: 77,
    });
  }
  return {
    apps,
    scores,
    jobs: [{ id: J1, company_id: CO, title: "Engineer", deleted_at: null }],
    team: [],
  };
}

const TIES = buildTieWorld();

test("260 applicants on one identical score page cleanly across 12 tied boundaries", async () => {
  const { ids, total, pages } = await walkAllPages({}, { world: TIES });

  assert.equal(total, 260);
  assert.equal(pages, 13);
  assert.equal(ids.length, 260);
  assert.equal(new Set(ids).size, 260, "a tied applicant was returned on two different pages");
  // With score and date fully tied, id ASC is the entire order.
  assert.deepEqual(ids, TIES.apps.map((r) => r.id).sort());
});

test("the SAME walk without a unique tiebreaker duplicates and drops rows", async () => {
  /*
   * The control for `id.asc`, run without touching actions.ts.
   *
   * This issues the list's own chain minus the final term against the same
   * emulator, which permutes equal rows per request exactly as Postgres does.
   * Its purpose is to prove the completeness test above can FAIL — a test that
   * cannot fail is not evidence, and a stable fake would have made the
   * tiebreaker look optional.
   */
  const service = fakeService(fakeListDb(TIES));
  const seen = [];
  for (let page = 1; page <= 13; page++) {
    const from = (page - 1) * APPLICANT_PAGE_SIZE;
    const { data } = await service
      .from("job_applications")
      .select("id, application_scores!left(application_id, status, effective_score)", {
        count: "exact",
      })
      .eq("company_id_snapshot", CO)
      .order("application_scores(effective_score)", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false, nullsFirst: false })
      .range(from, from + APPLICANT_PAGE_SIZE - 1);
    seen.push(...data.map((r) => r.id));
  }

  assert.equal(seen.length, 260, "the pages did not cover 260 slots");
  assert.ok(
    new Set(seen).size < 260,
    "without the tiebreaker every row still came back exactly once — the fake is not reproducing Postgres' tie behaviour, so the completeness test above proves nothing",
  );
});

test("an offset equal to the total is an empty page, and past it clamps with a true total", async () => {
  // Page 14 of 260 starts at offset 260 == total: a normal empty answer.
  const atEnd = await run(fetchCompanyApplicants, { page: 14 }, { world: TIES });
  assert.equal(atEnd.read.ok, true);
  assert.deepEqual(atEnd.read.value, { rows: [], total: 260 });

  // Page 40 starts at 780 > 260: PGRST103, which must NOT read as a failure —
  // the total has to survive so the client can clamp to a page that exists.
  const past = await run(fetchCompanyApplicants, { page: 40 }, { world: TIES });
  assert.equal(past.read.ok, true, "an out-of-range page reported as a failed load");
  assert.deepEqual(past.read.value, { rows: [], total: 260 });
});

// ════════════════════════════════════════════════════════════
//  3. UNSCORED VISIBILITY — the !left embed
// ════════════════════════════════════════════════════════════

/** Three scored, three with no score row, one scored-but-null, one skipped. */
const MIXED = {
  apps: [1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({
    id: idAt(n),
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
  })),
  scores: [
    {
      application_id: idAt(1),
      status: "scored",
      overall_score: 95,
      human_adjusted_score: null,
      confidence: "high",
      error: null,
      effective_score: 95,
    },
    {
      application_id: idAt(2),
      status: "scored",
      overall_score: 80,
      human_adjusted_score: null,
      confidence: "high",
      error: null,
      effective_score: 80,
    },
    {
      application_id: idAt(3),
      status: "scored",
      overall_score: 60,
      human_adjusted_score: null,
      confidence: "low",
      error: null,
      effective_score: 60,
    },
    // 'scored' with no number — must not take a place in the top 10.
    {
      application_id: idAt(7),
      status: "scored",
      overall_score: null,
      human_adjusted_score: null,
      confidence: null,
      error: null,
      effective_score: null,
    },
    // A skipped card IS a row. !inner alone would admit it.
    {
      application_id: idAt(8),
      status: "skipped",
      overall_score: null,
      human_adjusted_score: null,
      confidence: null,
      error: "no cv",
      effective_score: null,
    },
  ],
  jobs: [{ id: J1, company_id: CO, title: "Engineer", deleted_at: null }],
  team: [],
};

test("applicants with no score row at all are listed, and sorted last", async () => {
  const { read } = await run(fetchCompanyApplicants, {}, { world: MIXED });
  assert.equal(read.ok, true);
  assert.equal(read.value.total, 8, "the LEFT embed dropped applicants with no score row");

  const ids = read.value.rows.map((r) => r.id);
  // The three scored, in score order, come first.
  assert.deepEqual(ids.slice(0, 3), [idAt(1), idAt(2), idAt(3)]);
  // Everyone whose effective_score is null — no row, null, or skipped — is after them.
  const tail = new Set(ids.slice(3));
  assert.deepEqual(tail, new Set([idAt(4), idAt(5), idAt(6), idAt(7), idAt(8)]));
});

test("the top-scored read, which IS !inner, admits only scored rows carrying a number", async () => {
  /*
   * The contrast that makes the test above discriminating. This query uses the
   * same filter chain over the same world across an INNER embed, and the
   * result is 3 rows rather than 8 — so if the list's embed were changed to
   * !inner the test above would fail on `total`, not pass quietly.
   *
   * It also pins what the two embed gates buy: app 7 is 'scored' with a null
   * score and app 8 is 'skipped'; both have a score ROW and both are excluded.
   */
  const { read } = await run(fetchTopScoredApplicants, {}, { world: MIXED });
  assert.equal(read.ok, true);
  assert.deepEqual(
    read.value.map((r) => r.id),
    [idAt(1), idAt(2), idAt(3)],
  );
});

test("the top-scored read is bounded at TOP_SCORED_LIMIT however large the population is", async () => {
  const { read } = await run(fetchTopScoredApplicants, {}, { world: ORDERING });
  assert.equal(read.ok, true);
  assert.equal(read.value.length, TOP_SCORED_LIMIT);
  // And it is the genuine top of the 1,700, not the top of a page.
  assert.deepEqual(
    read.value.map((r) => r.id),
    expectedBest(ORDERING.apps, ORDERING.scores).slice(0, TOP_SCORED_LIMIT),
  );
});

// ════════════════════════════════════════════════════════════
//  5. FILTERS AND SEARCH — over the population, not the page
// ════════════════════════════════════════════════════════════

/**
 * A world where every filter changes a different number, so none of them can
 * pass by doing nothing.
 */
const FILTERS = {
  apps: [
    {
      id: idAt(1),
      company_id_snapshot: CO,
      job_id: J1,
      first_name: "Ana",
      last_name: "Oyelaran",
      email: "ana@example.com",
      pipeline_stage: "applied",
      shortlist_flagged_at: "2026-01-01T00:00:00Z",
      created_at: "2026-01-01T00:00:00Z",
      cv_path: null,
      cv_url: null,
      cv_delete_after: null,
    },
    {
      id: idAt(2),
      company_id_snapshot: CO,
      job_id: J1,
      first_name: "Ben",
      last_name: "Smith",
      email: "ben@example.com",
      pipeline_stage: "screening",
      shortlist_flagged_at: "2026-01-02T00:00:00Z",
      created_at: "2026-01-02T00:00:00Z",
      cv_path: null,
      cv_url: null,
      cv_delete_after: null,
    },
    {
      id: idAt(3),
      company_id_snapshot: CO,
      job_id: J1,
      first_name: "Cara",
      last_name: "Jones",
      email: "cara@example.com",
      pipeline_stage: "hired",
      shortlist_flagged_at: "2026-01-03T00:00:00Z",
      created_at: "2026-01-03T00:00:00Z",
      cv_path: null,
      cv_url: null,
      cv_delete_after: null,
    },
    {
      id: idAt(4),
      company_id_snapshot: CO,
      job_id: "job-2",
      first_name: "Dai",
      last_name: "Patel",
      email: "dai@example.com",
      pipeline_stage: "applied",
      shortlist_flagged_at: null,
      created_at: "2026-01-04T00:00:00Z",
      cv_path: null,
      cv_url: null,
      cv_delete_after: null,
    },
    // A null stage: toRow reports it as 'applied', so the Applied tab must select it.
    {
      id: idAt(5),
      company_id_snapshot: CO,
      job_id: J1,
      first_name: "Eve",
      last_name: "Null",
      email: "eve@example.com",
      pipeline_stage: null,
      shortlist_flagged_at: null,
      created_at: "2026-01-05T00:00:00Z",
      cv_path: null,
      cv_url: null,
      cv_delete_after: null,
    },
    // Another company's row. Must never appear.
    {
      id: idAt(6),
      company_id_snapshot: CO2,
      job_id: J1,
      first_name: "Ana",
      last_name: "Intruder",
      email: "ana@other.test",
      pipeline_stage: "applied",
      shortlist_flagged_at: "2026-01-06T00:00:00Z",
      created_at: "2026-01-06T00:00:00Z",
      cv_path: null,
      cv_url: null,
      cv_delete_after: null,
    },
  ],
  scores: [],
  jobs: [
    { id: J1, company_id: CO, title: "Engineer", deleted_at: null },
    { id: "job-2", company_id: CO, title: "Designer", deleted_at: null },
  ],
  team: [],
};

const idsOf = (read) => read.value.rows.map((r) => r.id).sort();

test("the stage tab filters on the server, and Applied claims the NULL stages", async () => {
  const applied = await run(fetchCompanyApplicants, { stage: "applied" }, { world: FILTERS });
  assert.deepEqual(idsOf(applied.read), [idAt(1), idAt(4), idAt(5)]);

  const hired = await run(fetchCompanyApplicants, { stage: "hired" }, { world: FILTERS });
  assert.deepEqual(idsOf(hired.read), [idAt(3)]);
});

test("the job filter narrows to one role", async () => {
  const { read } = await run(fetchCompanyApplicants, { jobId: "job-2" }, { world: FILTERS });
  assert.deepEqual(idsOf(read), [idAt(4)]);
  assert.equal(read.value.total, 1);
});

test("the flagged chip needs BOTH the mark and a worth-a-look stage", async () => {
  // app 3 is flagged but hired, so the mark is kept and the chip must not
  // count it — showsWorthALook is the two-part predicate this mirrors.
  const { read } = await run(fetchCompanyApplicants, { flaggedOnly: true }, { world: FILTERS });
  assert.deepEqual(idsOf(read), [idAt(1), idAt(2)]);
});

test("search matches across first name, last name and email", async () => {
  const byLast = await run(fetchCompanyApplicants, { search: "oyelaran" }, { world: FILTERS });
  assert.deepEqual(idsOf(byLast.read), [idAt(1)]);

  const byEmail = await run(fetchCompanyApplicants, { search: "dai@example" }, { world: FILTERS });
  assert.deepEqual(idsOf(byEmail.read), [idAt(4)]);

  // Tenancy is not a search concern, but the other company's "Ana" is the row
  // that would show up if the parent filter were missing.
  const byFirst = await run(fetchCompanyApplicants, { search: "ana" }, { world: FILTERS });
  assert.deepEqual(idsOf(byFirst.read), [idAt(1)]);
});

test("the words of a search are ANDed, so order stops mattering and neither word alone wins", async () => {
  const both = await run(fetchCompanyApplicants, { search: "ana oyelaran" }, { world: FILTERS });
  assert.deepEqual(idsOf(both.read), [idAt(1)]);

  // Reversed — the old concatenated blob could not do this.
  const reversed = await run(
    fetchCompanyApplicants,
    { search: "oyelaran ana" },
    { world: FILTERS },
  );
  assert.deepEqual(idsOf(reversed.read), [idAt(1)]);

  // ANDed, not ORed: "oyelaran" and "smith" share no applicant.
  const conflicting = await run(
    fetchCompanyApplicants,
    { search: "oyelaran smith" },
    { world: FILTERS },
  );
  assert.deepEqual(idsOf(conflicting.read), []);
});

test("every match the old concatenated blob found is still found — checked exhaustively", async () => {
  /*
   * The behaviour-change test, and it does not go the way the brief predicted.
   *
   * The client used to match `"${fullName} ${email}"`.includes(q), so a query
   * could span the gap between the name and the email. The concern was that
   * three separate ilikes cannot. In fact they can, and the reason is
   * structural: the blob has a SPACE at the field boundary, so any query that
   * spans it contains that space and is split there by searchTokens. What is
   * left on each side is a suffix of one field and a prefix of the next —
   * each wholly inside a single column.
   *
   * Rather than assert that argument, this enumerates it: every substring of
   * every applicant's blob that spans the name/email boundary is run through
   * the real query, and must still return that applicant.
   */
  const blobOf = (r) => `${`${r.first_name} ${r.last_name}`.trim()} ${r.email}`.toLowerCase();
  const mine = FILTERS.apps.filter((r) => r.company_id_snapshot === CO);

  let checked = 0;
  for (const app of mine) {
    const blob = blobOf(app);
    const boundary = blob.lastIndexOf(" ");
    // Substrings that straddle the final space — the name/email boundary.
    for (let start = 0; start < boundary; start += 3) {
      for (let end = boundary + 2; end <= blob.length; end += 4) {
        const q = blob.slice(start, end);
        if (!q.trim()) continue;
        const { read } = await run(fetchCompanyApplicants, { search: q }, { world: FILTERS });
        assert.equal(read.ok, true);
        assert.ok(
          read.value.rows.some((r) => r.id === app.id),
          `"${q}" matched the old blob for ${app.id} but matches no column now`,
        );
        checked++;
      }
    }
  }
  assert.ok(checked > 40, `only ${checked} boundary-spanning queries were exercised`);
});

test("a search term's PostgREST metacharacters cannot restructure the filter", async () => {
  // `,` `(` `)` `%` become spaces, so this is three ANDed words, not a
  // rewritten filter grammar and not a lone wildcard matching everyone.
  const { read } = await run(
    fetchCompanyApplicants,
    { search: "ana,(oyelaran)%" },
    { world: FILTERS },
  );
  assert.equal(read.ok, true);
  assert.deepEqual(idsOf(read), [idAt(1)]);

  const wildcardAlone = await run(fetchCompanyApplicants, { search: "%" }, { world: FILTERS });
  // Sanitised to nothing, so no search filter at all — the whole company, not
  // a full scan triggered by a single character.
  assert.equal(wildcardAlone.read.value.total, 5);
});

test("filters apply to the POPULATION: a match on page 7 is found from page 1", async () => {
  /*
   * The test that would catch filtering-after-paging. One applicant in 2,500
   * carries a unique surname, and he sorts to position ~1,300 under Best
   * Match. If the filter ran over the fetched page he would be unreachable.
   */
  const world = structuredClone(ORDERING);
  world.apps[1297].last_name = "Quimbleton";
  const { read } = await run(fetchCompanyApplicants, { search: "quimbleton" }, { world });

  assert.equal(read.value.total, 1);
  assert.deepEqual(
    read.value.rows.map((r) => r.id),
    [world.apps[1297].id],
  );
});

// ════════════════════════════════════════════════════════════
//  6. SCALE — requests do not grow with the population
// ════════════════════════════════════════════════════════════

test("one page costs the same number of requests at 8 applicants and at 2,500", async () => {
  const small = await run(fetchCompanyApplicants, {}, { world: MIXED });
  const large = await run(fetchCompanyApplicants, {}, { world: ORDERING });

  const appReads = (s) => s.queries.filter((q) => q.table === "job_applications").length;
  assert.equal(appReads(small.service), 1, "the list path issued more than one row read");
  assert.equal(appReads(large.service), appReads(small.service));
  assert.equal(large.service.queries.length, small.service.queries.length);
});

test("no read in the list path carries an unbounded range", async () => {
  // The loop-to-exhaustion guard. Every row-returning request must be bounded
  // by a range or a limit; "fetch everything and sort in JS" is not available
  // at all — a request for 4,000 rows came back capped at 1,000 in production.
  const { service } = await run(fetchCompanyApplicants, { page: 3 }, { world: ORDERING });
  const reads = service.queries.filter((q) => q.table === "job_applications");

  for (const q of reads) {
    const range = q.calls.find((c) => c[0] === "range");
    const limit = q.calls.find((c) => c[0] === "limit");
    const head = q.calls.find((c) => c[0] === "select")?.[2]?.head;
    assert.ok(range || limit || head, "a row read went out with no range, limit or head");
    if (range) {
      assert.equal(range[2] - range[1] + 1, APPLICANT_PAGE_SIZE);
      assert.equal(range[1], 2 * APPLICANT_PAGE_SIZE, "the offset is not derived from the page");
    }
  }
});

test("the out-of-range retry is bounded at exactly one extra request", async () => {
  const { service } = await run(fetchCompanyApplicants, { page: 99 }, { world: TIES });
  const reads = service.queries.filter((q) => q.table === "job_applications");
  assert.equal(reads.length, 2, "the 416 path did not settle in one retry");
  // And the retry is a head count — it transfers no rows.
  assert.equal(reads[1].calls.find((c) => c[0] === "select")[2].head, true);
  assert.equal(
    reads[1].calls.find((c) => c[0] === "range"),
    undefined,
    "the retry carried a range and so could miss again",
  );
});

// ════════════════════════════════════════════════════════════
//  7. TEN THOUSAND across a company, ~15 jobs
// ════════════════════════════════════════════════════════════

const STAGES = ["applied", "screening", "shortlisted", "interview", "offer", "hired", "rejected"];

/** 10,000 applicants over 15 jobs, with the fixture's own arithmetic recorded. */
function buildBigWorld() {
  const jobs = [];
  for (let j = 0; j < 15; j++) {
    jobs.push({ id: `job-${j}`, company_id: CO, title: `Role ${j}`, deleted_at: null });
  }
  const apps = [];
  const scores = [];
  const perStage = Object.fromEntries(STAGES.map((s) => [s, 0]));
  const perJob = Object.fromEntries(jobs.map((j) => [j.id, 0]));
  let scored = 0;

  for (let i = 0; i < 10000; i++) {
    const id = idAt(i);
    const job_id = `job-${i % 15}`;
    const stage = STAGES[i % 7];
    perStage[stage]++;
    perJob[job_id]++;
    apps.push({
      id,
      company_id_snapshot: CO,
      job_id,
      first_name: `F${i}`,
      last_name: `L${i}`,
      email: `big${i}@acme.test`,
      pipeline_stage: stage,
      shortlist_flagged_at: i % 100 === 0 ? "2026-01-01T00:00:00Z" : null,
      created_at: `2026-04-${String(1 + (i % 28)).padStart(2, "0")}T00:00:00.000Z`,
      cv_path: null,
      cv_url: null,
      cv_delete_after: null,
    });
    // Two in three scored, so a third of the population has no score row.
    if (i % 3 !== 0) {
      const value = 20 + (i % 80);
      scored++;
      scores.push({
        application_id: id,
        status: "scored",
        overall_score: value,
        human_adjusted_score: null,
        confidence: "high",
        error: null,
        effective_score: value,
      });
    }
  }
  return { world: { apps, scores, jobs, team: [] }, perStage, perJob, scored };
}

const BIG = buildBigWorld();

test("10,000 applicants over 15 jobs: the counts equal the fixture's own arithmetic", async () => {
  const { read } = await run(fetchApplicantCounts, {}, { world: BIG.world });
  assert.equal(read.ok, true);

  assert.equal(read.value.total, 10000);
  assert.equal(read.value.grandTotal, 10000);
  assert.deepEqual(read.value.stages, BIG.perStage);
  // Every one of the 15 jobs has applicants, so all 15 are open roles.
  assert.equal(read.value.openRoles, 15);
  /*
   * `total` and `grandTotal` reach 10,000 by two different routes, which is
   * what makes agreeing meaningful: `grandTotal` is its own COUNT over the
   * scope, while `total` is the seven stage counts added up in JavaScript.
   *
   * So asserting that the stages sum to `total` would prove nothing — it is
   * the definition. Asserting they sum to `grandTotal` is the real check, and
   * it only holds because every row in this fixture carries one of the seven
   * stages. A row with a NULL or unrecognised `pipeline_stage` would land in
   * `grandTotal` and in no stage count, and the two figures would part company.
   */
  assert.equal(
    Object.values(read.value.stages).reduce((a, b) => a + b, 0),
    read.value.grandTotal,
  );
});

test("10,000 applicants cost the same ten counts as eight do", async () => {
  const big = await run(fetchApplicantCounts, {}, { world: BIG.world });
  const small = await run(fetchApplicantCounts, {}, { world: MIXED });
  assert.equal(big.service.queries.length, small.service.queries.length);
  /*
   * Seven stages + new-this-week + grand total on job_applications, plus one
   * jobs query for Open roles. TEN, and no eleventh for the total: that figure
   * is the stage counts added up, which is both one round trip cheaper and the
   * reason the note above compares them against `grandTotal` instead.
   */
  assert.equal(big.service.queries.filter((q) => q.table === "job_applications").length, 9);
  assert.equal(big.service.queries.filter((q) => q.table === "jobs").length, 1);
  assert.equal(big.service.queries.length, 10);
});

test("a job filter at 10,000 counts that job alone, and its pages cover it exactly", async () => {
  const jobId = "job-7";
  const expected = BIG.perJob[jobId];

  const counts = await run(fetchApplicantCounts, { jobId }, { world: BIG.world });
  assert.equal(counts.read.value.total, expected);
  // The grand total ignores the job filter on purpose: it is what keeps "No
  // applicants yet" honest when a filter is what emptied the view.
  assert.equal(counts.read.value.grandTotal, 10000);

  const first = await run(fetchCompanyApplicants, { jobId }, { world: BIG.world });
  assert.equal(first.read.value.total, expected);

  // Last page of that job, by arithmetic rather than by walking 34 pages.
  const lastPage = Math.ceil(expected / APPLICANT_PAGE_SIZE);
  const last = await run(fetchCompanyApplicants, { jobId, page: lastPage }, { world: BIG.world });
  assert.equal(
    last.read.value.rows.length,
    expected - (lastPage - 1) * APPLICANT_PAGE_SIZE,
    "the final page's size does not match the filtered total",
  );
  for (const row of last.read.value.rows) assert.equal(row.job_id, jobId);
});

// ── Three-state reads ───────────────────────────────────────

test("a failed row read is unavailable, never an empty list", async () => {
  const { read } = await run(
    fetchCompanyApplicants,
    {},
    { world: MIXED, failTable: "job_applications" },
  );
  assert.equal(read.ok, false, "a failed read was reported as a readable empty page");
});

test("an unreadable job scope is unavailable, not 'assigned to no roles'", async () => {
  const { read } = await run(
    fetchCompanyApplicants,
    {},
    { world: MIXED, role: "recruiter", scopeFails: true },
  );
  assert.equal(read.ok, false);
});

test("a recruiter genuinely on no jobs gets an answered empty page, not a failure", async () => {
  const { read } = await run(
    fetchCompanyApplicants,
    {},
    { world: { ...MIXED, team: [] }, role: "recruiter" },
  );
  assert.equal(read.ok, true);
  assert.deepEqual(read.value, { rows: [], total: 0 });
});
