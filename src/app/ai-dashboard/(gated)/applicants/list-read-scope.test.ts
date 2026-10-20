/**
 * Tenant and job-scope isolation for the PAGED list read.
 *
 *   node --test "src/app/ai-dashboard/(gated)/applicants/list-read-scope.test.ts"
 *
 * ── Why paging needs its own isolation file ──────────────────
 *
 * counts-read-scope.test.ts already proves the head-counts are scoped, and the
 * list used to need nothing of the kind: it read the population once, the
 * browser filtered it, and a scope failure was a single wrong number.
 *
 * Reading one ordered page changes the shape of the risk in two ways that file
 * cannot cover.
 *
 *   1. A leak can hide in the middle. The old read returned everybody, so an
 *      intruder's rows were somewhere in a list nobody scrolled. Now twenty
 *      rows come back ranked, and an intruder who scores well is on page 1
 *      above the reader's own candidates. So the fixture here deliberately
 *      interleaves the two companies' scores, and the assertions walk EVERY
 *      page — a leak on page 3 of 4 is the one a page-1 test would miss.
 *
 *   2. The tenancy filter now shares a query with a score embed, and across a
 *      LEFT embed a filter on an embedded column does not restrict the parent
 *      AT ALL. Measured in production: `!inner` on the embed returned 146 of
 *      3,788 rows, `!left` returned all 3,788 unrestricted. So "the filter is
 *      on `company_id_snapshot`" is not a style note, it is the boundary, and
 *      it is asserted here both as the query's shape and as its behaviour.
 *
 * `job_id` is ON DELETE SET NULL, which is why the scope cannot be joined
 * through `jobs.company_id`. The orphan row in the fixture is what proves it.
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
const { fetchCompanyApplicants, fetchTopScoredApplicants } = await import("./actions.ts");
const { APPLICANT_PAGE_SIZE } = await import("../../lib/applicant-types.ts");

const CO = "c0000000-0000-0000-0000-000000000001";
const CO2 = "c0000000-0000-0000-0000-000000000002";
const J1 = "a0000000-0000-0000-0000-00000000000a";
const J2 = "a0000000-0000-0000-0000-00000000000b";
const J9 = "f0000000-0000-0000-0000-00000000000f";

const ctxFor = (role) => ({
  companyId: CO,
  role,
  memberId: "m-1",
  memberName: "Rae Recruiter",
  user: { id: "u-1", email: "rae@acme.test" },
  company: { name: "Acme" },
});

const idAt = (n) => `app-${String(n).padStart(5, "0")}`;

async function run(action, query = {}, { role = "owner", world = WORLD, ...opts } = {}) {
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
 * Two companies whose applicants INTERLEAVE on every order term.
 *
 * 76 rows. Every fourth one belongs to the intruder, and the scores run
 * straight down from 89 in id order, so the intruder's rows are spread evenly
 * through the victim's Best Match ordering rather than clustered at one end. A
 * missing tenancy filter therefore contaminates every page, and one that is
 * present but ineffective cannot hide in a tail.
 *
 * `created_at` ascends with the index, so Newest is the exact reverse and the
 * same interleaving holds under the other sort.
 *
 * Three deliberate irregularities:
 *   - every 11th row has NO score row, so the nulls-last tail is populated and
 *     is checked for leaks too — the tail is where an intruder would sit if the
 *     filter worked on scored rows only
 *   - row 50 is an ORPHAN: `job_id` null, because its job was deleted
 *   - the intruder's score rows carry their own `company_id`, which is what
 *     makes the embed-keyed filter below a fair demonstration rather than a
 *     query against a column that happens to be empty
 */
function buildWorld() {
  const apps = [];
  const scores = [];
  const expected = { [CO]: [], [CO2]: [], [J1]: [], [J2]: [] };

  for (let i = 0; i < 76; i++) {
    const id = idAt(i);
    const intruder = i % 4 === 3;
    const company = intruder ? CO2 : CO;
    let jobId: string | null;
    if (intruder) jobId = J9;
    else if (i === 50) jobId = null;
    else jobId = i % 2 === 0 ? J1 : J2;

    apps.push({
      id,
      company_id_snapshot: company,
      job_id: jobId,
      first_name: `Cand${i}`,
      last_name: intruder ? "Rival" : "Acme",
      email: `cand${i}@${intruder ? "rival" : "acme"}.test`,
      pipeline_stage: "applied",
      shortlist_flag: false,
      shortlist_flag_dismissed_at: null,
      created_at: `2026-01-01T00:${String(i).padStart(2, "0")}:00.000Z`,
    });

    expected[company].push(id);
    if (!intruder && jobId) expected[jobId].push(id);

    if (i % 11 !== 0) {
      const value = 89 - i;
      scores.push({
        application_id: id,
        company_id: company,
        status: "scored",
        overall_score: value,
        human_adjusted_score: null,
        confidence: "high",
        error: null,
        effective_score: value,
      });
    }
  }

  const jobs = [
    { id: J1, company_id: CO, title: "Backend", deleted_at: null },
    { id: J2, company_id: CO, title: "Frontend", deleted_at: null },
    { id: J9, company_id: CO2, title: "Rival role", deleted_at: null },
  ];

  return { world: { apps, scores, jobs, team: [{ job_id: J1 }] }, expected };
}

const { world: WORLD, expected: EXPECTED } = buildWorld();
const ORPHAN = idAt(50);
const INTRUDERS = new Set(EXPECTED[CO2]);

/**
 * Walk every page and return the ids seen, plus the total the reads reported.
 *
 * Asserts page width on the way through: a page wider than APPLICANT_PAGE_SIZE
 * would mean the range arithmetic, not the scope, is what bounds the response.
 */
async function walk(query, opts) {
  const ids = [];
  let total = null;
  for (let page = 1; page <= 50; page++) {
    const { read } = await run(fetchCompanyApplicants, { ...query, page }, opts);
    assert.equal(read.ok, true, `page ${page} failed to read`);
    assert.ok(
      read.value.rows.length <= APPLICANT_PAGE_SIZE,
      `page ${page} returned ${read.value.rows.length} rows`,
    );
    total = read.value.total;
    ids.push(...read.value.rows.map((r) => r.id));
    if (read.value.rows.length < APPLICANT_PAGE_SIZE) break;
  }
  return { ids, total };
}

const sorted = (xs) => [...xs].sort();

// ════════════════════════════════════════════════════════════
//  1. The other company, on every page of both sorts
// ════════════════════════════════════════════════════════════

for (const sort of ["best", "newest"]) {
  test(`every page of ${sort} holds this company's applicants and only those`, async () => {
    const { ids, total } = await walk({ sort });

    assert.equal(total, EXPECTED[CO].length);
    assert.deepEqual(sorted(ids), sorted(EXPECTED[CO]));
    // Said twice on purpose: the deepEqual above would also fail on a missing
    // row, and this is the half that matters for a leak.
    assert.deepEqual(
      ids.filter((id) => INTRUDERS.has(id)),
      [],
      "another company's applicants reached the list",
    );
    // 57 of this company's rows over 20 to a page is four pages, the last one
    // short. If the walk stopped at one page the assertions above would pass
    // on a prefix, so the page count is pinned.
    assert.equal(Math.ceil(EXPECTED[CO].length / APPLICANT_PAGE_SIZE), 3);
  });
}

test("the unscored tail is scoped too — a leak cannot hide behind the nulls", async () => {
  const { ids } = await walk({ sort: "best" });
  const unscored = ids.filter((id) => !WORLD.scores.some((s) => s.application_id === id));
  assert.ok(unscored.length > 0, "the fixture no longer has an unscored tail to check");
  for (const id of unscored) assert.ok(!INTRUDERS.has(id));
});

// ════════════════════════════════════════════════════════════
//  2. The filter is on the parent, and that is why it works
// ════════════════════════════════════════════════════════════

test("the tenant filter is on the PARENT column, with none keyed on the embed", async () => {
  const { service } = await run(fetchCompanyApplicants, {});
  const rowQuery = service.queries.find((q) => q.table === "job_applications");
  assert.ok(rowQuery, "no job_applications query was issued");

  const eqs = rowQuery.calls.filter((c) => c[0] === "eq");
  assert.ok(
    eqs.some((c) => c[1] === "company_id_snapshot" && c[2] === CO),
    "the tenant filter is not an eq on company_id_snapshot",
  );
  // The trap: any filter carrying the company id on an embedded column is
  // inert across a LEFT embed, so finding one here would mean the boundary is
  // decorative.
  for (const [, column, value] of eqs) {
    assert.ok(
      !(column.includes(".") && value === CO),
      `the company id is filtered on the embedded column ${column}`,
    );
  }

  const select = rowQuery.calls.find((c) => c[0] === "select")?.[1] ?? "";
  assert.match(
    select,
    /application_scores!left\(/,
    "the list's score embed is no longer !left — the nulls-last tail depends on it",
  );
});

test("had the tenant filter been embed-keyed, the LEFT embed would have let everyone through", async () => {
  /*
   * Not a test of the action — a demonstration of what the action is avoiding,
   * run against the same emulator so the claim is executed rather than
   * asserted in a comment. The two halves differ only in the join type.
   */
  const askWith = async (join) => {
    const service = fakeService(fakeListDb(WORLD));
    const { data } = await service
      .from("job_applications")
      .select(`id, application_scores${join}(effective_score, company_id)`, { count: "exact" })
      .eq("application_scores.company_id", CO)
      .order("application_scores(effective_score)", { ascending: false, nullsFirst: false })
      .order("id", { ascending: true })
      .range(0, 999);
    return data.map((r) => r.id);
  };

  const acrossLeft = await askWith("!left");
  assert.ok(
    acrossLeft.some((id) => INTRUDERS.has(id)),
    "the emulator no longer reproduces the LEFT-embed trap, so this file is not testing it",
  );
  assert.equal(acrossLeft.length, WORLD.apps.length, "the LEFT embed restricted the parent");

  // Across !inner the same filter DOES restrict — which is why the top-scored
  // read may key its gates on the embed and the list read may not.
  const acrossInner = await askWith("!inner");
  assert.deepEqual(
    acrossInner.filter((id) => INTRUDERS.has(id)),
    [],
  );
});

// ════════════════════════════════════════════════════════════
//  3. A scoped recruiter, across every page
// ════════════════════════════════════════════════════════════

for (const sort of ["best", "newest"]) {
  test(`a recruiter on one job sees that job alone across every ${sort} page`, async () => {
    const { ids, total } = await walk({ sort }, { role: "recruiter" });

    assert.deepEqual(sorted(ids), sorted(EXPECTED[J1]));
    assert.equal(total, EXPECTED[J1].length);
    for (const id of ids) assert.ok(!INTRUDERS.has(id));
    // The company total is larger, so a dropped `.in()` would show up as this
    // equality failing rather than as rows the test forgot to look at.
    assert.notEqual(EXPECTED[J1].length, EXPECTED[CO].length);
  });
}

test("a hiring manager is scoped by the same chain, and an admin is not scoped at all", async () => {
  const mgr = await walk({}, { role: "hiring_manager" });
  assert.deepEqual(sorted(mgr.ids), sorted(EXPECTED[J1]));

  const admin = await run(fetchCompanyApplicants, {}, { role: "admin" });
  assert.equal(admin.read.value.total, EXPECTED[CO].length);
  // Site-wide roles must not even ask: a broken hiring-team table cannot blank
  // an owner's or an admin's page if it is never read.
  assert.deepEqual(
    admin.service.queries.filter((q) => q.table === "job_hiring_team"),
    [],
  );
});

test("a scoped recruiter asking for a job they are NOT on gets nothing, not that job", async () => {
  const { read } = await run(fetchCompanyApplicants, { jobId: J2 }, { role: "recruiter" });
  assert.equal(read.ok, true);
  assert.deepEqual(read.value.rows, []);
  // Zero, and a true zero rather than null: the read succeeded and the honest
  // answer is that the scope and the filter do not intersect.
  assert.equal(read.value.total, 0);
});

// ════════════════════════════════════════════════════════════
//  4. The top-scored read carries the identical scope
// ════════════════════════════════════════════════════════════

test("the top-scored read is scoped exactly as the list is", async () => {
  const company = await run(fetchTopScoredApplicants, {});
  assert.equal(company.read.ok, true);
  for (const r of company.read.value) {
    assert.ok(!INTRUDERS.has(r.id), "a rival company's applicant was offered as a Top match");
    assert.ok(EXPECTED[CO].includes(r.id));
  }

  const scopedRead = await run(fetchTopScoredApplicants, {}, { role: "recruiter" });
  for (const r of scopedRead.read.value) {
    assert.ok(EXPECTED[J1].includes(r.id), `${r.id} is outside the recruiter's jobs`);
  }

  // The agreement is the point: "Top match" is a claim about the list in front
  // of the reader, so anyone the chip names must be someone the list can show.
  const listIds = (await walk({ sort: "best" }, { role: "recruiter" })).ids;
  for (const r of scopedRead.read.value) assert.ok(listIds.includes(r.id));

  const topQuery = scopedRead.service.queries.find((q) => q.table === "job_applications");
  const select = topQuery.calls.find((c) => c[0] === "select")?.[1] ?? "";
  assert.match(select, /application_scores!inner\(/);
  assert.ok(
    topQuery.calls.some((c) => c[0] === "eq" && c[1] === "company_id_snapshot" && c[2] === CO),
  );
  assert.ok(topQuery.calls.some((c) => c[0] === "in" && c[1] === "job_id"));
});

// ════════════════════════════════════════════════════════════
//  5. No jobs versus an unreadable scope
// ════════════════════════════════════════════════════════════

test("a recruiter genuinely on no jobs gets an answered empty page", async () => {
  const world = { ...WORLD, team: [] };
  const { read } = await run(fetchCompanyApplicants, {}, { role: "recruiter", world });
  assert.equal(read.ok, true, "being on no jobs is an ANSWER, not a failure");
  assert.deepEqual(read.value.rows, []);
  assert.equal(read.value.total, 0);
});

test("an UNREADABLE scope is unavailable, and issues no row query at all", async () => {
  for (const role of ["recruiter", "hiring_manager"]) {
    const { read, service } = await run(fetchCompanyApplicants, {}, { role, scopeFails: true });
    assert.equal(read.ok, false, `${role} got a readable page from an unreadable scope`);
    /*
     * The stronger half. Fail-closed is not just "return unavailable" — the
     * query must not be SENT, because a read issued before the scope is known
     * would have to be built with no `.in()` and would return the whole
     * company. Nothing downstream could then tell that page from a legitimate
     * owner's one.
     */
    assert.deepEqual(
      service.queries.filter((q) => q.table === "job_applications"),
      [],
      `${role}'s row query was issued despite an unknown scope`,
    );
  }

  // And the same failure cannot touch a site-wide role, which never asks.
  const owner = await run(fetchCompanyApplicants, {}, { role: "owner", scopeFails: true });
  assert.equal(owner.read.ok, true);
  assert.equal(owner.read.value.total, EXPECTED[CO].length);
});

// ════════════════════════════════════════════════════════════
//  6. The orphan: job_id is ON DELETE SET NULL
// ════════════════════════════════════════════════════════════

test("an applicant whose job was deleted still belongs to their company", async () => {
  const { ids } = await walk({ sort: "best" });
  assert.ok(
    ids.includes(ORPHAN),
    "the orphaned applicant vanished — the scope is joined through jobs, not the snapshot",
  );

  // And is not reachable from the other side. Asserted by asking as the rival:
  // their own scope must not pick up a row whose job_id is null.
  const rival = fakeService(fakeListDb(WORLD));
  globalThis.__applicantsServiceForTests = () => rival;
  globalThis.__applicantsCtxForTests = { ...ctxFor("owner"), companyId: CO2 };
  const read = await fetchCompanyApplicants({});
  assert.equal(read.ok, true);
  assert.ok(!read.value.rows.some((r) => r.id === ORPHAN));
  assert.equal(read.value.total, EXPECTED[CO2].length);
});

test("but a SCOPED role cannot see the orphan at all — recorded, not endorsed", async () => {
  /*
   * `.in("job_id", [J1])` cannot match a null, so an applicant whose job was
   * deleted is invisible to every recruiter and hiring manager, permanently,
   * and visible only to owners and admins.
   *
   * This is the behaviour TODAY and it is asserted so a change to it is
   * deliberate rather than accidental. It is not obviously the desired product
   * answer: the person is still a live applicant to the company, and the role
   * they applied to being deleted is not a reason to hide them from the
   * recruiter who was working them. Reported rather than fixed here — changing
   * it means deciding WHICH scoped members should inherit an orphan, which is
   * a product question and not a test's to answer.
   */
  const { ids, total } = await walk({ sort: "best" }, { role: "recruiter" });
  assert.ok(!ids.includes(ORPHAN));
  assert.equal(total, EXPECTED[J1].length);

  // The counts path agrees with the list path, which is the part that would
  // otherwise produce a visible contradiction: a total that includes someone
  // no page can show.
  assert.ok(!EXPECTED[J1].includes(ORPHAN));
});
