/**
 * What the Interviews page is allowed to show after a read that failed.
 *
 *   node --test "src/app/ai-dashboard/(gated)/interviews/load-state.test.ts"
 *
 * ── Why these are functions and not component state ──────────
 *
 * There is no DOM test runner in this repo, so a decision left inside
 * _interviews-client.tsx can only be checked by matching source text, which
 * proves nothing about what it does. The rules below are each one line of code
 * and very easy to get backwards in a hurry, so they live in load-state.ts
 * where this file can execute them. Same split, and the same reason, as
 * applicants/counts-state.ts.
 *
 * ── TEST 1 IS LOAD-BEARING. DO NOT DELETE IT ─────────────────
 *
 * Every other test here asserts something about a FAILURE, and all of them
 * pass against an `applyLoad` that does nothing but `return state`. A function
 * that has stopped applying results entirely satisfies "a failure must not
 * clear the view" perfectly, because it never changes the view at all — which
 * is the exact shape of the vacuous guard this project has now caught five
 * times.
 *
 * Test 1 is what makes the rest mean anything: a successful load provably
 * REPLACES what is shown. Any change that passes the failure tests by giving
 * up early fails test 1. If you are deleting a test here because it looks
 * trivial, it is not this one.
 */
// @ts-nocheck — same reason as the other node:test files here: Node's `.ts`
// specifier vs this tsconfig, which does not set allowImportingTsExtensions.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../../../test-support/node-resolve.mjs", import.meta.url));

const { applyLoad, seedList } = await import("./load-state.ts");

const JOB = "a0000000-0000-0000-0000-00000000000a";

/** A readable list result. `over` replaces whichever fields a test cares about. */
const result = (over = {}) => ({
  applied: { status: "all", jobId: null, query: "" },
  rows: [],
  total: 12,
  page: 1,
  pageSize: 25,
  counts: {
    all: 12,
    invited: 3,
    in_progress: 1,
    submitted: 7,
    expired: 1,
    cancelled: 0,
    archived: 0,
  },
  jobs: [],
  sentThisWeek: 4,
  openRoles: 2,
  ...over,
});

const params = (over = {}) => ({ status: "all", jobId: null, query: "", page: 1, ...over });

const ok = (value) => ({ ok: true, value });
const failed = { ok: false };

// ── 1 — THE LOAD-BEARING ONE. See the docblock. ──
test("a successful load replaces what is shown, and clears the failure with it", () => {
  const first = seedList(ok(result({ total: 12 })), params());
  const next = applyLoad(
    first,
    ok(result({ total: 99, counts: { ...result().counts, all: 99 } })),
    { ...params(), page: 2 },
  );

  assert.equal(next.shown.total, 99, "the newest answer is the one on screen");
  assert.equal(next.shown.counts.all, 99);
  assert.equal(next.failed, false, "nothing failed, so nothing may be labelled stale");
  assert.equal(next.retry, null, "there is nothing to retry");
});

// ── 2 ──
test("a failed refresh keeps the numbers that did load, and says they are old", () => {
  const loaded = seedList(ok(result({ total: 12 })), params());
  const after = applyLoad(loaded, failed, params({ status: "submitted" }));

  assert.equal(
    after.shown.total,
    12,
    "the reader keeps the view they were working through. Blanking the page on a failed " +
      "refresh replaces it with LESS information than they already had",
  );
  assert.equal(
    after.failed,
    true,
    "and the surface has to say so. Keeping the numbers silently states them as current, " +
      "which is the whole bug",
  );
});

// ── 3 ──
test("a failed server render is not the day-one empty state", () => {
  const broken = seedList(failed, params());
  const emptyCompany = seedList(
    ok(result({ total: 0, counts: { ...result().counts, all: 0 } })),
    params(),
  );

  assert.equal(broken.shown, null, "nothing has ever loaded, so there is nothing to show");
  assert.equal(broken.failed, true);

  assert.equal(emptyCompany.failed, false, "an empty company is an ANSWER, not a failure");
  assert.equal(emptyCompany.shown.counts.all, 0, "a true zero stays a zero");
  assert.notDeepEqual(
    broken,
    emptyCompany,
    "these must not be the same state. While they were, a company whose interviews we " +
      "simply could not read was shown the day-one pitch for a product it already uses",
  );
});

// ── 4 ──
test("retry holds the question that failed, not whatever the filters say later", () => {
  const loaded = seedList(ok(result()), params());
  const after = applyLoad(
    loaded,
    failed,
    params({ status: "expired", jobId: JOB, query: "ahmed", page: 3 }),
  );

  assert.deepEqual(
    after.retry,
    { status: "expired", jobId: JOB, query: "ahmed", page: 3 },
    "Retry re-asks the read that broke. Re-reading the CURRENT filters would quietly " +
      "answer a different question and clear the banner for a read nobody checked",
  );
});

// ── 5 ──
test("a second failed retry does not degrade the view further", () => {
  const loaded = seedList(ok(result({ total: 12 })), params());
  const once = applyLoad(loaded, failed, params({ page: 2 }));
  const twice = applyLoad(once, failed, params({ page: 2 }));

  assert.equal(
    twice.shown.total,
    12,
    "a reader who clicks Try again twice must not end up with less than they started with",
  );
  assert.deepEqual(twice, once, "a failed retry changes nothing but the params held");
});

// ── 6 ──
test("a success after a failure recovers completely", () => {
  const broken = seedList(failed, params());
  const recovered = applyLoad(broken, ok(result({ total: 5 })), params());

  assert.equal(recovered.shown.total, 5);
  assert.equal(recovered.failed, false, "the banner must go away, or it outlives its failure");
  assert.equal(recovered.retry, null);
});

// ── 7 ──
test("the chip strip is labelled from the response, not from the click", () => {
  /*
   * A source-text pin, not a render, and it makes no layout claim — the strip
   * is inline JSX inside a client module that pulls in server actions, so the
   * same constraint as chip-strips.test.ts applies.
   *
   * What it holds: the highlight and the badge read `data.applied.status`, the
   * filter the SERVER resolved, rather than `tab`, the reader's unconfirmed
   * intent. With `tab` the click painted the chip and its count before the
   * read returned, so the strip named one filter above another filter's rows —
   * and under the stale banner it put the new filter's name on old numbers.
   *
   * `tab` is still in the file and legitimately so: it drives the next request
   * and the two inputs. This pin is scoped to the strip for that reason.
   */
  const SRC = readFileSync(new URL("./_interviews-client.tsx", import.meta.url), "utf8");

  const strip = SRC.match(/\{TABS\.filter\(\(t\)[\s\S]*?\)\)\}/);
  assert.ok(strip, "the chip strip no longer matches — re-point this pin before trusting it");

  const [body] = strip;
  const applied = body.match(/data\.applied\.status === t\.key/g) ?? [];
  assert.equal(
    applied.length,
    2,
    "both the chip highlight and its badge are labelled from the resolved filter",
  );
  assert.equal(
    body.includes("tab === t.key"),
    false,
    "a chip must not be painted from the click. That is the mislabelling this fixes",
  );
});
