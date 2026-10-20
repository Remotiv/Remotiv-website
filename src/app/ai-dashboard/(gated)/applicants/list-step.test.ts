/**
 * Prev/next walking the population rather than the page, executed.
 *
 *   node --test "src/app/ai-dashboard/(gated)/applicants/list-step.test.ts"
 *
 * ── The regression this closes, and why it needs tests ───────
 *
 * The drawer's arrows were an index into an array holding every applicant the
 * member could see, so a walk ran from the first match to the last and the page
 * number was a presentation detail it moved underneath the reader. When the
 * rows became ONE PAGE of twenty, the straight port of that index stopped the
 * arrows at the page edges: a recruiter working a shortlist of sixty hit a dead
 * end every twenty rows and had to close the panel, turn the page and reopen.
 *
 * The fix addresses the population by index and derives the page from it, which
 * splits the operation in two — because the destination row is in a page nobody
 * has read yet. `stepTarget` decides where to go; `stepRow` decides when an
 * arriving page is the one to open from. Both are pure, and the failures worth
 * catching are statements about them:
 *
 *   - ARITHMETIC AT THE BOUNDARY. Off by one at a page edge is the whole bug
 *     class: it skips a candidate, or re-opens the one already on screen, or
 *     walks off the end of the population into an empty panel. So the central
 *     test is not a boundary case but an exhaustive WALK — every index of a
 *     multi-page population, forwards and then backwards, asserting the visit
 *     order is the population order with nothing duplicated and nothing
 *     dropped. That is the same property the server-side `id.asc` tiebreaker
 *     exists for, checked here on the client's side of the boundary.
 *
 *   - OPENING A STRANGER. Between the step and the page landing, a filter can
 *     move, a search can commit, or rows can be deleted. In every one of those
 *     the offset is still a valid array index into rows that answer a different
 *     question, so `stepRow` refusing is the only thing between "next
 *     applicant" and a panel showing somebody the reader never asked for.
 *     Asserted per refusal, because a single combined check would pass on one
 *     of the three guards being present.
 *
 *   - AN UNKNOWN POPULATION. The total is a server count and so can be
 *     unreadable. Null is not zero and it is not "assume there is more": a step
 *     against an unknown total has no answer that can be checked against
 *     anything, so it must refuse and the arrows must go.
 *
 * Tenancy is not this module's concern and nothing here implies it is. These
 * functions compute a page number and an offset; which rows that page contains
 * is `listQuery`'s company and job-scope filter, proven in
 * list-read-scope.test.ts.
 */
// @ts-nocheck — same reason as the other node:test files here: Node's `.ts`
// specifier vs this tsconfig, which does not set allowImportingTsExtensions.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../../../test-support/node-resolve.mjs", import.meta.url));

const { listKey, populationIndex, stepRow, stepTarget } = await import("./list-state.ts");
const { APPLICANT_PAGE_SIZE } = await import("../../lib/applicant-types.ts");

const SIZE = APPLICANT_PAGE_SIZE;
const JOB = "0f6b2a1c-8d4e-4b7a-9c31-5e2f8a0d1b43";

const req = (over = {}) => ({
  jobId: null,
  search: "",
  stage: null,
  flaggedOnly: false,
  sort: "best",
  page: 1,
  ...over,
});

/** A landed page of `n` rows whose ids say which population index they are. */
const pageRows = (page, n = SIZE) =>
  Array.from({ length: n }, (_, i) => ({ id: `row-${(page - 1) * SIZE + i}` }));

const landed = (request, rows) => ({ key: listKey(request), updating: false, rows });

/* ── populationIndex ─────────────────────────────────────────── */

test("the population index counts from page 1, offset 0", () => {
  assert.equal(populationIndex(1, 0), 0);
  assert.equal(populationIndex(1, SIZE - 1), SIZE - 1);
  assert.equal(populationIndex(2, 0), SIZE);
  assert.equal(populationIndex(3, 5), 2 * SIZE + 5);
});

test("a page number that is not one is treated as page 1, not as page zero", () => {
  // Reached when a clamp has not yet run. Treating 0 as a page would make the
  // index NEGATIVE, and a negative index refuses every step — both arrows dead
  // with rows plainly on screen.
  for (const bad of [0, -4, Number.NaN, 0.4]) {
    assert.equal(populationIndex(bad, 3), 3, `page ${bad}`);
  }
});

/* ── stepTarget: the ends ────────────────────────────────────── */

test("there is nowhere before the first row of the population", () => {
  assert.equal(stepTarget(req(), 0, -1, 100), null);
});

test("there is nowhere after the last row of the population", () => {
  const lastPage = 5;
  const lastOffset = SIZE - 1;
  assert.equal(stepTarget(req({ page: lastPage }), lastOffset, 1, lastPage * SIZE), null);
});

test("a population of one steps in neither direction", () => {
  assert.equal(stepTarget(req(), 0, 1, 1), null);
  assert.equal(stepTarget(req(), 0, -1, 1), null);
});

test("an UNKNOWN population refuses both directions", () => {
  // Null is an unreadable count, not zero and not "assume there is more".
  assert.equal(stepTarget(req({ page: 2 }), 5, 1, null), null);
  assert.equal(stepTarget(req({ page: 2 }), 5, -1, null), null);
});

test("a last page that is PARTIAL stops at its real last row", () => {
  // 3 full pages plus 7. Stepping forward from the 7th of those must refuse,
  // and the row before it must not.
  const total = 3 * SIZE + 7;
  assert.equal(stepTarget(req({ page: 4 }), 6, 1, total), null);
  assert.notEqual(stepTarget(req({ page: 4 }), 5, 1, total), null);
});

/* ── stepTarget: within and across the boundary ──────────────── */

test("a step inside the page keeps the page and moves the offset", () => {
  assert.deepEqual(stepTarget(req({ page: 2 }), 5, 1, 100), {
    request: req({ page: 2 }),
    offset: 6,
  });
  assert.deepEqual(stepTarget(req({ page: 2 }), 5, -1, 100), {
    request: req({ page: 2 }),
    offset: 4,
  });
});

test("forward off the end of a page lands on the first row of the next", () => {
  assert.deepEqual(stepTarget(req({ page: 1 }), SIZE - 1, 1, 100), {
    request: req({ page: 2 }),
    offset: 0,
  });
});

test("back off the start of a page lands on the LAST row of the previous", () => {
  // The symmetric case, and the one a naive implementation gets wrong by
  // landing on offset 0 of the previous page — which silently skips nineteen.
  assert.deepEqual(stepTarget(req({ page: 3 }), 0, -1, 100), {
    request: req({ page: 2 }),
    offset: SIZE - 1,
  });
});

test("a cross-page step changes ONLY the page", () => {
  const from = req({
    page: 2,
    jobId: JOB,
    search: "ana",
    stage: "offer",
    flaggedOnly: true,
    sort: "newest",
  });
  const target = stepTarget(from, SIZE - 1, 1, 500);
  assert.deepEqual(target.request, { ...from, page: 3 });
  // Spelled out as well as deep-equalled: the whole point is that the page
  // turn carries the filters, or the reader lands in an unfiltered list.
  assert.equal(target.request.jobId, JOB);
  assert.equal(target.request.search, "ana");
  assert.equal(target.request.stage, "offer");
  assert.equal(target.request.flaggedOnly, true);
  assert.equal(target.request.sort, "newest");
});

test("the request handed in is not mutated", () => {
  const from = req({ page: 2 });
  const snapshot = { ...from };
  stepTarget(from, 0, -1, 100);
  assert.deepEqual(from, snapshot);
});

/* ── the exhaustive walk ─────────────────────────────────────── */

test("walking forward visits every row of a multi-page population exactly once, in order", () => {
  const total = 3 * SIZE + 7;
  let at = { request: req({ page: 1 }), offset: 0 };
  const seen = [populationIndex(1, 0)];

  for (;;) {
    const next = stepTarget(at.request, at.offset, 1, total);
    if (!next) break;
    seen.push(populationIndex(next.request.page, next.offset));
    at = next;
  }

  assert.deepEqual(
    seen,
    Array.from({ length: total }, (_, i) => i),
    "the forward walk is not the population in order with nothing duplicated or dropped",
  );
  // And it ended where the population ends, not one short of it.
  assert.equal(at.request.page, 4);
  assert.equal(at.offset, 6);
});

test("walking back from the last row retraces the same sequence", () => {
  const total = 2 * SIZE + 3;
  let at = { request: req({ page: 3 }), offset: 2 };
  const seen = [populationIndex(3, 2)];

  for (;;) {
    const prev = stepTarget(at.request, at.offset, -1, total);
    if (!prev) break;
    seen.push(populationIndex(prev.request.page, prev.offset));
    at = prev;
  }

  assert.deepEqual(
    seen,
    Array.from({ length: total }, (_, i) => total - 1 - i),
    "the backward walk is not the forward walk reversed",
  );
});

test("a population that fits on one page never leaves it", () => {
  const total = SIZE;
  for (let offset = 0; offset < total; offset++) {
    for (const delta of [1, -1]) {
      const target = stepTarget(req(), offset, delta, total);
      if (target) assert.equal(target.request.page, 1);
    }
  }
});

/* ── stepRow: when an arriving page is the one to open from ──── */

test("no pending step opens nobody", () => {
  assert.equal(stepRow(null, landed(req({ page: 2 }), pageRows(2))), null);
});

test("the landed page opens the row at the target offset", () => {
  const target = { request: req({ page: 3 }), offset: 4 };
  const row = stepRow(target, landed(target.request, pageRows(3)));
  assert.equal(row.id, `row-${2 * SIZE + 4}`);
});

test("rows still in flight open nobody", () => {
  // `updating` means what is on screen is the page the reader stepped OFF.
  // Reading offset 4 out of it opens whoever sits at index 4 of the wrong page.
  const target = { request: req({ page: 3 }), offset: 4 };
  assert.equal(
    stepRow(target, { key: listKey(target.request), updating: true, rows: pageRows(3) }),
    null,
  );
});

test("a page read for a DIFFERENT request opens nobody, though the page number matches", () => {
  // Page 2 of one filter and page 2 of another are the same number and
  // different people, so a page-number comparison cannot catch this.
  const target = { request: req({ page: 2, stage: "offer" }), offset: 3 };
  const otherFilter = req({ page: 2, stage: "hired" });
  assert.equal(stepRow(target, landed(otherFilter, pageRows(2))), null);
  // Control: the same rows under the right key DO open.
  assert.notEqual(stepRow(target, landed(target.request, pageRows(2))), null);
});

test("a sort change in flight opens nobody, even at the same page and offset", () => {
  const target = { request: req({ page: 2 }), offset: 3 };
  assert.equal(stepRow(target, landed(req({ page: 2, sort: "newest" }), pageRows(2))), null);
});

test("a page that came back SHORT opens its last row rather than nothing", () => {
  // Rows deleted between the step and the read. "Forward" has no exact answer
  // any more; the nearest honest one is the end of what did arrive, and
  // refusing would leave the arrow dead with rows on screen.
  const target = { request: req({ page: 4 }), offset: 11 };
  const row = stepRow(target, landed(target.request, pageRows(4, 3)));
  assert.equal(row.id, `row-${3 * SIZE + 2}`);
});

test("a page that came back EMPTY opens nobody", () => {
  const target = { request: req({ page: 4 }), offset: 0 };
  assert.equal(stepRow(target, landed(target.request, [])), null);
});

test("a page not read yet at all opens nobody", () => {
  const target = { request: req({ page: 2 }), offset: 0 };
  assert.equal(stepRow(target, { key: null, updating: false, rows: [] }), null);
});

/* ── the two halves composed ─────────────────────────────────── */

test("stepTarget then stepRow walks a three-page population end to end", () => {
  /*
   * The composition is what the component does, and it is tested as one
   * sequence because the halves agree on an offset convention that a unit test
   * of either alone would not pin: `stepTarget` emits an index modulo the page
   * size, and `stepRow` indexes the arriving rows with it directly.
   */
  const total = 2 * SIZE + 5;
  const opened = [];
  let at = { request: req({ page: 1 }), offset: 0 };
  opened.push(stepRow(at, landed(at.request, pageRows(1))).id);

  for (;;) {
    const next = stepTarget(at.request, at.offset, 1, total);
    if (!next) break;
    const rows = pageRows(next.request.page, next.request.page === 3 ? 5 : SIZE);
    const row = stepRow(next, landed(next.request, rows));
    assert.notEqual(row, null, `page ${next.request.page} offset ${next.offset} opened nobody`);
    opened.push(row.id);
    at = next;
  }

  assert.deepEqual(
    opened,
    Array.from({ length: total }, (_, i) => `row-${i}`),
    "the composed walk did not open every applicant once, in population order",
  );
});
