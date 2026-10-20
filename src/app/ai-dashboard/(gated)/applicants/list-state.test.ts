/**
 * The ways a fetched PAGE can state something the list cannot support,
 * executed rather than pinned.
 *
 *   node --test "src/app/ai-dashboard/(gated)/applicants/list-state.test.ts"
 *
 * ── Why this module exists at all ────────────────────────────
 *
 * counts-state.test.ts opens with the three new failure modes a count
 * inherits when it stops being `array.length` and becomes a response. The
 * rows inherit every one of them and that reasoning is not repeated here.
 *
 * Two of them bite harder on rows than on numbers, and one is new:
 *
 *   - A stale COUNT is a wrong number beside a label. Stale ROWS are a list
 *     the reader will CLICK. So `updating` is not decoration, and the test
 *     for it asserts the rows survive the filter change — blanking the table
 *     on every keystroke is worse — while the flag says they are not yours.
 *
 *   - A failed count draws an em dash. A failed page has no em dash
 *     available: zero rows and "no one matches that search" are the same
 *     picture. So `failed` is carried separately from an empty page, and the
 *     discriminating test is the PAIR — an empty answered page and a failed
 *     read, which must differ in exactly one field and agree in the rest.
 *
 *   - The page number is now an INPUT to the read, so it can be out of range
 *     in a way an in-memory slice never was. `.slice()` past the end answers
 *     `[]`; a `.range()` past the end is an error. The clamp therefore cannot
 *     run before the request, because the total that defines the range is
 *     what the response carries — so `clampPage` is tested against a total
 *     it did not have when the page was asked for.
 *
 * There is no DOM test runner in this repo, so a rendering assertion is not
 * available and a source pin would prove nothing about behaviour. Every
 * decision that can be wrong is therefore a pure function, and this file runs
 * them.
 */
// @ts-nocheck — same reason as the other node:test files here: Node's `.ts`
// specifier vs this tsconfig, which does not set allowImportingTsExtensions.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../../../test-support/node-resolve.mjs", import.meta.url));

const {
  SEARCH_DEBOUNCE_MS,
  clampPage,
  dropRow,
  filterKey,
  listKey,
  listQueryFor,
  listView,
  rangeStart,
  requestList,
  seedList,
  settleList,
} = await import("./list-state.ts");
const { APPLICANT_PAGE_SIZE } = await import("../../lib/applicant-types.ts");

const JOB_A = "a0000000-0000-0000-0000-00000000000a";
const JOB_B = "b0000000-0000-0000-0000-00000000000b";
const JOB_C = "c0000000-0000-0000-0000-00000000000c";

/** The default request — what the server pass answers for. */
const req = (over = {}) => ({
  jobId: null,
  search: "",
  stage: null,
  flaggedOnly: false,
  sort: "best",
  page: 1,
  ...over,
});

const row = (id) => ({ id, first_name: "A", last_name: id, email: `${id}@t.test` });

/** A page of `n` rows numbered from `from`, over a population of `total`. */
const pageOf = (from, n, total) => ({
  rows: Array.from({ length: n }, (_, i) => row(`app-${from + i}`)),
  total,
});

const ids = (view) => view.rows.map((r) => r.id);

// ── 1. The out-of-order response ────────────────────────────

test("A -> B -> A: the older A page cannot overwrite the newer one", () => {
  // The whole reason a sequence number exists alongside the key. Both A
  // requests carry key A, so a key-only guard lets the first response — the
  // stale one — land on top of the second. Identical in shape to the counts
  // test, and it has to be proved separately: these are different reducers,
  // and here the consequence is twenty clickable rows rather than a figure.
  const kA = listKey(req({ jobId: JOB_A }));
  const kB = listKey(req({ jobId: JOB_B }));

  let s = seedList(listKey(req()), pageOf(1, 20, 100));

  s = requestList(s, kA, 1);
  s = requestList(s, kB, 2);
  s = requestList(s, kA, 3);

  // The NEWEST A response arrives first.
  s = settleList(s, { key: kA, seq: 3, page: pageOf(500, 2, 2) });
  assert.deepEqual(ids(listView(s)), ["app-500", "app-501"]);
  assert.equal(listView(s).updating, false);

  // Now the FIRST A request answers, late, with different rows. Its key
  // matches what is displayed. It must still be discarded.
  s = settleList(s, { key: kA, seq: 1, page: pageOf(900, 2, 2) });
  assert.deepEqual(
    ids(listView(s)),
    ["app-500", "app-501"],
    "the stale A page overwrote the newer one",
  );

  // And the B response, for a filter nobody is looking at.
  s = settleList(s, { key: kB, seq: 2, page: pageOf(700, 2, 2) });
  assert.deepEqual(ids(listView(s)), ["app-500", "app-501"]);
});

test("a late FAILURE is discarded too, so it cannot empty a list that read fine", () => {
  // Without the sequence check this is the worst of the set: the newest read
  // succeeded, so the reader is looking at correct rows, and a failure for a
  // request they have already left replaces them with the "couldn't load"
  // empty state. Nothing on screen would say the rows were ever there.
  const kA = listKey(req({ jobId: JOB_A }));
  let s = seedList(listKey(req()), pageOf(1, 20, 100));
  s = requestList(s, kA, 1);
  s = requestList(s, kA, 2);

  s = settleList(s, { key: kA, seq: 2, page: pageOf(300, 3, 3) });
  s = settleList(s, { key: kA, seq: 1, page: null });

  const v = listView(s);
  assert.deepEqual(ids(v), ["app-300", "app-301", "app-302"], "a stale failure emptied the list");
  assert.equal(v.failed, false);
  assert.equal(v.total, 3);
});

test("a matching sequence from a RESET counter is still refused on the key", () => {
  /*
   * The other half of the guard, and the only scenario that distinguishes it.
   *
   * `settleList` checks the key AND the sequence, and the sequence alone
   * decides every case above — delete the key check and they all still pass.
   * What it buys is this: the counter is minted by the component, not the
   * reducer, so a remount, a second caller, or a reset starts it over, and two
   * live requests for DIFFERENT filters then carry the same number. The
   * sequence says "newest"; only the key says "for this question". Without it
   * job A's twenty rows land under job B's filter, settled, with the sequence
   * check waving them through.
   */
  const kA = listKey(req({ jobId: JOB_A }));
  const kB = listKey(req({ jobId: JOB_B }));

  let s = seedList(listKey(req()), pageOf(1, 20, 100));
  s = requestList(s, kA, 1);
  // The counter restarts, so job B's request reuses the number job A has out.
  s = requestList(s, kB, 1);

  s = settleList(s, { key: kA, seq: 1, page: pageOf(900, 2, 2) });
  const v = listView(s);
  assert.notDeepEqual(ids(v), ["app-900", "app-901"], "job A's page settled under job B");
  assert.equal(v.updating, true, "job B's request was marked answered by job A's response");
});

// ── 2. Stale rows must not pass as current ──────────────────

test("the previous filter's rows stay on screen, but marked updating", () => {
  let s = seedList(listKey(req()), pageOf(1, 20, 100));
  assert.equal(listView(s).updating, false);

  s = requestList(s, listKey(req({ jobId: JOB_A })), 1);
  const mid = listView(s);

  // Deliberately NOT blanked. A table that collapses to empty on every
  // keystroke is worse than one that admits it is behind. `updating` is the
  // whole of what makes that honest, so it is asserted, not assumed.
  assert.equal(mid.rows.length, 20, "the table was blanked instead of marked stale");
  assert.equal(mid.updating, true, "the old filter's rows were presented as the new filter's");

  s = settleList(s, { key: listKey(req({ jobId: JOB_A })), seq: 1, page: pageOf(50, 2, 2) });
  assert.deepEqual(
    { n: listView(s).rows.length, updating: listView(s).updating },
    {
      n: 2,
      updating: false,
    },
  );
});

test("settled rows under a key that is no longer current are updating — the defensive half", () => {
  /*
   * This state is built BY HAND, and the reason is the finding.
   *
   * `listView`'s `updating` is `pending || shownKey !== key`. The first run of
   * this file asserted the second disjunct by settling a response — and passed
   * with that disjunct deleted, because no sequence of this reducer's own calls
   * can produce `pending === false` alongside `shownKey !== key`. Every path to
   * a key change goes through `requestList`, which sets `pending`; every path
   * that clears `pending` goes through `settleList`, which only accepts a
   * response whose key IS the current one and writes `shownKey` from it.
   *
   * So the disjunct is unreachable through the public API today. It is kept —
   * `pending` alone would make the flag depend on a caller never forgetting to
   * announce a request, and `settleList`'s key guard is the only thing standing
   * between that and a silent lie — and this test states what it does if a
   * future caller ever reaches it, rather than pretending a reachable path to
   * it exists. The previous version of this test proved nothing.
   */
  const stale = {
    key: listKey(req({ jobId: JOB_B })),
    expected: 2,
    pending: false,
    shown: pageOf(50, 2, 2),
    shownKey: listKey(req({ jobId: JOB_A })),
    failed: false,
  };

  const v = listView(stale);
  assert.equal(v.updating, true, "a page read for job A was presented as job B's, settled");
  assert.deepEqual(ids(v), ["app-50", "app-51"], "the stale rows were dropped rather than marked");
});

test("a page turn is updating too — page 1's rows are not page 2's", () => {
  // The page number is in the key precisely so this is true. Without it the
  // reader clicks Next and the previous twenty rows sit there looking settled.
  let s = seedList(listKey(req()), pageOf(1, 20, 100));
  s = requestList(s, listKey(req({ page: 2 })), 1);
  assert.equal(listView(s).updating, true);
});

// ── 3. A failed read is not an empty result ─────────────────

test("the discriminating pair: an empty answered page and a failed read", () => {
  // These are the two states that render the same picture — no rows — and
  // need opposite copy. "No one matches that search" over a read that did not
  // happen is the lie `failed` exists to prevent. They must differ in exactly
  // that field.
  const k = listKey(req({ search: "zzz" }));

  let answered = seedList(listKey(req()), pageOf(1, 20, 100));
  answered = requestList(answered, k, 1);
  answered = settleList(answered, { key: k, seq: 1, page: { rows: [], total: 0 } });

  let failed = seedList(listKey(req()), pageOf(1, 20, 100));
  failed = requestList(failed, k, 1);
  failed = settleList(failed, { key: k, seq: 1, page: null });

  const a = listView(answered);
  const f = listView(failed);

  assert.deepEqual(a.rows, [], "an answered empty page should have no rows");
  assert.deepEqual(f.rows, [], "a failed read should have no rows");

  // The one field that separates them, and the one the copy branches on.
  assert.equal(a.failed, false);
  assert.equal(f.failed, true);

  // And the total: a real 0 is a fact, an unreadable total is not a 0.
  assert.equal(a.total, 0, "a genuine empty result lost its true total of 0");
  assert.equal(f.total, null, "a failed read reported a population of 0");
  assert.equal(a.pageCount, 1);
  assert.equal(f.pageCount, null, "a failed read claimed to know how many pages there are");
});

test("a failed read DROPS the last-known rows rather than leaving them under new filters", () => {
  // The one place this reducer deliberately throws data away. A table still
  // showing job A's applicants after a failed read for job B is asserting
  // they match job B, and nothing on screen could correct that. Contrast the
  // test above, where the rows survive a filter change that is still in
  // flight — there the flag says so; here the claim would be unqualified.
  const kB = listKey(req({ jobId: JOB_B }));
  const kC = listKey(req({ jobId: JOB_C }));
  let s = seedList(listKey(req({ jobId: JOB_A })), pageOf(1, 20, 100));
  s = requestList(s, kB, 1);
  s = settleList(s, { key: kB, seq: 1, page: null });

  const v = listView(s);
  assert.deepEqual(v.rows, [], "job A's rows were left on screen under job B's filter");
  assert.equal(v.failed, true);

  /*
   * And the assertion that actually discriminates.
   *
   * Everything above is also true if `settleList` leaves `shown` in place on a
   * failure, because `listView` already answers no rows while `failed` is set
   * — so the two assertions pass against a reducer that keeps the data. What
   * they cannot see is the NEXT request: `requestList` clears `failed`,
   * deliberately, because a previous failure says nothing about a new read. If
   * the rows were still in the state they would come straight back, now under
   * job C, with nothing marking them as job A's. The drop in `settleList` is
   * what makes the clear in `requestList` safe, and only this sequence proves
   * it.
   */
  s = requestList(s, kC, 2);
  const retry = listView(s);
  assert.equal(retry.failed, false);
  assert.deepEqual(retry.rows, [], "job A's rows returned under job C after a failed read for B");
  assert.equal(retry.total, null, "job A's total outlived the rows it counted");
});

test("seeding from a failed server pass is failed, not an empty slate", () => {
  // page.tsx hands null when its read did not work. Read as "there is
  // nobody" the page would sit in something indistinguishable from loading,
  // and a company with applicants would be told it has none.
  const v = listView(seedList(listKey(req()), null));
  assert.equal(v.failed, true, "a failed server read seeded as an empty pipeline");
  assert.equal(v.total, null);
  assert.deepEqual(v.rows, []);
});

test("a new request clears a previous failure, because it is not evidence about this one", () => {
  let s = seedList(listKey(req()), null);
  assert.equal(listView(s).failed, true);
  s = requestList(s, listKey(req({ jobId: JOB_A })), 1);
  assert.equal(listView(s).failed, false, "a stale failure outlived the request that produced it");
});

// ── 4. The clamp, which can only run after the read ─────────

test("a page in range is returned unchanged", () => {
  const total = APPLICANT_PAGE_SIZE * 7 + 1; // 8 pages
  assert.equal(clampPage(1, total), 1);
  assert.equal(clampPage(7, total), 7);
  assert.equal(clampPage(8, total), 8);
});

test("a page past the end clamps to the last POPULATED page", () => {
  // A stale ?page=12 is the case. It must not render as a failure: the read
  // answers an out-of-range offset with no rows and a true total precisely so
  // there is something to clamp against.
  const total = APPLICANT_PAGE_SIZE * 7 + 1;
  assert.equal(clampPage(12, total), 8);
  assert.equal(clampPage(1_000_000, total), 8);
});

test("an exact multiple of the page size does not invent a trailing empty page", () => {
  // ceil(140/20) is 7, not 8. Off by one here would send a reader to a page
  // that exists only in the arithmetic.
  assert.equal(clampPage(9, APPLICANT_PAGE_SIZE * 7), 7);
});

test("an empty population still has a page 1", () => {
  // Not page 0. The pager and `rangeStart` both read this, and a 0 would put
  // the list on a page the clamp would then keep correcting.
  assert.equal(clampPage(1, 0), 1);
  assert.equal(clampPage(5, 0), 1);
});

test("an UNREADABLE total leaves the page alone — it is no evidence the page is wrong", () => {
  // The discriminating case against clamping to 1 on a null. A failed count
  // would otherwise move the reader off page 7 and then, on the next
  // successful read, they are somewhere they did not ask to be.
  assert.equal(clampPage(7, null), 7);
  assert.equal(clampPage(1, null), 1);
});

test("a junk page number resolves to 1 rather than propagating into a range", () => {
  // These reach the state from the URL, so they are not hypothetical. A NaN
  // offset is what turns a clamp into a 400 from PostgREST.
  for (const bad of [0, -3, Number.NaN, 1.7, "x"]) {
    assert.ok(clampPage(bad, 100) >= 1, `clampPage(${String(bad)}) went below 1`);
  }
  assert.equal(clampPage(Number.NaN, 100), 1);
  assert.equal(clampPage(0, 100), 1);
  assert.equal(clampPage(-3, 100), 1);
  assert.equal(clampPage(1.7, 100), 1, "a fractional page was not truncated");
});

// ── 5. The row range the surface states ─────────────────────

test("rangeStart is the 1-based index of the page's first row", () => {
  // The pager prints "21–40 of 128" off this, and the row numbers in the
  // table are drawn from the same figure — so an off-by-one here is visible
  // in two places at once and in the same direction.
  assert.equal(rangeStart(1, 20), 1);
  assert.equal(rangeStart(2, 20), APPLICANT_PAGE_SIZE + 1);
  assert.equal(rangeStart(7, 8), APPLICANT_PAGE_SIZE * 6 + 1);
});

test("rangeStart is 0 on an empty page, so the surface can omit the range", () => {
  // Rather than claiming to show row 1 of nothing.
  assert.equal(rangeStart(1, 0), 0);
  assert.equal(rangeStart(9, 0), 0);
});

// ── 6. Deleting a row without a round trip ──────────────────

test("dropRow removes the row and brings the total down with it", () => {
  // The total is decremented rather than recomputed because the true figure
  // needs a round trip, and a count that stays put for the length of one is a
  // count the reader can see is wrong.
  let s = seedList(listKey(req()), pageOf(1, 20, 128));
  s = dropRow(s, "app-7");
  const v = listView(s);
  assert.equal(v.rows.length, 19, "the row did not leave the page");
  assert.ok(!v.rows.some((r) => r.id === "app-7"));
  assert.equal(v.total, 127, "the pager kept counting someone who is gone");
});

test("dropRow does NOT backfill — the refetch owns that", () => {
  // Pulling row 21 up would need a read anyway, and the refetch that follows
  // a delete is already doing it. Nineteen rows is the honest intermediate.
  let s = seedList(listKey(req()), pageOf(1, 20, 128));
  s = dropRow(s, "app-1");
  assert.equal(listView(s).rows.length, 19);
  assert.equal(listView(s).rows[0].id, "app-2");
});

test("dropRow on an id that is not on the page changes nothing", () => {
  // The drawer can delete an applicant reached by deep link who is on page 9.
  // Decrementing the total for a row this page never held would make the
  // pager wrong in the other direction.
  const s0 = seedList(listKey(req()), pageOf(1, 20, 128));
  const s1 = dropRow(s0, "app-9999");
  assert.equal(s1, s0, "an absent id produced a new state");
  assert.equal(listView(s1).total, 128);
});

test("dropRow cannot drive a total below zero, and leaves an unreadable one unreadable", () => {
  let s = seedList(listKey(req()), { rows: [row("app-1")], total: 0 });
  s = dropRow(s, "app-1");
  assert.equal(listView(s).total, 0, "the total went negative");

  let u = seedList(listKey(req()), { rows: [row("app-1")], total: null });
  u = dropRow(u, "app-1");
  assert.equal(listView(u).total, null, "an unreadable total became a number by arithmetic");
});

test("dropRow on a failed state is a no-op rather than a crash", () => {
  const s = seedList(listKey(req()), null);
  assert.equal(dropRow(s, "app-1"), s);
});

// ── 7. The keys: what invalidates a read, and what does not ─

test("every field that reaches the server is in the list key", () => {
  // If one is missing, two different requests become interchangeable and the
  // guard in settleList will accept the wrong answer. Each is varied alone.
  const base = listKey(req());
  const variants = {
    jobId: req({ jobId: JOB_A }),
    search: req({ search: "ana" }),
    stage: req({ stage: "interview" }),
    flaggedOnly: req({ flaggedOnly: true }),
    sort: req({ sort: "newest" }),
    page: req({ page: 2 }),
  };
  for (const [field, r] of Object.entries(variants)) {
    assert.notEqual(listKey(r), base, `${field} does not change the list key`);
  }
});

test("the filter key omits the sort and the page, and nothing else", () => {
  // The top-scored read is ordered by score by definition and limited to ten,
  // so neither the display sort nor the page number changes its answer — but
  // every filter does. Keying it on the whole request would re-read the top
  // ten on every page turn and the chips would flicker for no reason.
  const base = filterKey(req());
  assert.equal(filterKey(req({ page: 9 })), base, "a page turn re-reads the top ten");
  assert.equal(filterKey(req({ sort: "newest" })), base, "the display sort re-reads the top ten");

  for (const r of [
    req({ jobId: JOB_A }),
    req({ search: "ana" }),
    req({ stage: "interview" }),
    req({ flaggedOnly: true }),
  ]) {
    assert.notEqual(filterKey(r), base, "a filter failed to invalidate the top ten");
  }
});

test("the keys are JSON, so a value containing a delimiter cannot collide two requests", () => {
  // The reason for JSON.stringify rather than a join. A search term or a job
  // id holding the delimiter would otherwise produce one key for two
  // different reads, and settleList would accept either answer for either.
  const a = listKey(req({ jobId: "x", search: "y" }));
  const b = listKey(req({ jobId: "x|y", search: "" }));
  assert.notEqual(a, b, "two different requests produced the same key");

  const c = listKey(req({ search: 'a","b' }));
  const d = listKey(req({ search: "a", stage: null }));
  assert.notEqual(c, d);
});

test("search is TRIMMED into the key but not lowercased", () => {
  // Trim is the normalisation the server applies too, so " ana " and "ana"
  // genuinely are the same read. Case is NOT folded: the server match is
  // already case-insensitive, so folding would be harmless for the result but
  // would hide a trailing-space change that does alter the tokens.
  assert.equal(listKey(req({ search: " ana " })), listKey(req({ search: "ana" })));
  assert.notEqual(listKey(req({ search: "Ana" })), listKey(req({ search: "ana" })));
});

// ── 8. The query handed to the server ───────────────────────

test("listQueryFor omits every absent filter rather than sending a null", () => {
  // An explicit `jobId: null` or `search: ""` in the query object is a filter
  // the action would have to special-case. Absence is unambiguous.
  assert.deepEqual(listQueryFor(req()), { sort: "best", page: 1 });
});

test("listQueryFor carries each filter that is set, and trims the search", () => {
  assert.deepEqual(
    listQueryFor(
      req({ jobId: JOB_A, search: "  ana  ", stage: "offer", flaggedOnly: true, page: 3 }),
    ),
    { sort: "best", page: 3, jobId: JOB_A, search: "ana", stage: "offer", flaggedOnly: true },
  );
});

test("a whitespace-only search is no search at all", () => {
  // Otherwise the server receives a term that matches everything, and the
  // empty copy would name a query the reader never typed.
  assert.deepEqual(listQueryFor(req({ search: "   " })), { sort: "best", page: 1 });
});

test("flaggedOnly false is omitted, not sent as false", () => {
  const q = listQueryFor(req({ flaggedOnly: false }));
  assert.equal("flaggedOnly" in q, false);
});

// ── 9. The debounce is a request-count measure, not a guard ─

test("the debounce exists and is short enough to feel immediate", () => {
  // Pinned only to record that it is a request-count measure: correctness is
  // the sequence guard above, which would be needed if every keystroke fired.
  // The bound is what stops it becoming a perceptible delay on the one
  // control a recruiter uses most.
  assert.ok(SEARCH_DEBOUNCE_MS > 0, "no debounce: one request per character");
  assert.ok(SEARCH_DEBOUNCE_MS <= 400, "the search box would feel laggy");
});

// ── 10. pageCount, which the pager reads ────────────────────

test("pageCount is derived from the total, and is null when the total is unknown", () => {
  const s = seedList(listKey(req()), pageOf(1, 20, APPLICANT_PAGE_SIZE * 6 + 3));
  assert.equal(listView(s).pageCount, 7);

  const exact = seedList(listKey(req()), pageOf(1, 20, APPLICANT_PAGE_SIZE * 6));
  assert.equal(listView(exact).pageCount, 6, "an exact multiple gained a trailing empty page");

  const empty = seedList(listKey(req()), { rows: [], total: 0 });
  assert.equal(listView(empty).pageCount, 1, "an empty list had no page at all");
});
