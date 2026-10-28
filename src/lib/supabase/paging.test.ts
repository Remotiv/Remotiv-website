/**
 * The shared pager's contract.
 *
 * Run with Node's built-in runner — no test framework, no new dependency:
 *
 *   node --test src/lib/supabase/paging.test.ts
 *
 * ── Why these exist ──────────────────────────────────────────
 *
 * This function replaced three hand-written copies whose only real difference
 * was how they failed, and the consolidation is only safe if the surviving one
 * behaves exactly as each of them did. So these are equivalence tests, not
 * feature tests: each asserts something one of the three copies did, and the
 * two cases that are genuinely new — the clamped cap and the cap warning —
 * assert the boundary where a naive merge would have got it wrong.
 *
 * The module imports nothing, which is what makes this testable at all. The
 * copies could not be tested: they lived in "use server" files, where exporting
 * them to a test would have published a database reader as a POST endpoint.
 */

// @ts-nocheck — the `./paging.ts` specifier Node requires is rejected by this
// repo's tsconfig, which does not set `allowImportingTsExtensions`. Suppressed
// HERE, in the one file that needs it; `node --test` still type-strips and runs
// every assertion below.
import assert from "node:assert/strict";
import { test } from "node:test";
import { FakeTable, fakeClient, hexRows } from "./fake-table.ts";
import { pageAll, pageAllByKey } from "./paging.ts";

/** A source of `total` rows, recording the ranges it was asked for. */
function rows(total: number, failAt?: number) {
  const asked: Array<[number, number]> = [];
  const build = (from: number, to: number) => {
    asked.push([from, to]);
    if (failAt !== undefined && from === failAt) {
      return Promise.resolve({ data: null, error: { message: "connection reset" } });
    }
    const size = to - from + 1;
    const slice = Array.from({ length: Math.max(0, Math.min(size, total - from)) }, (_, i) => ({
      id: from + i,
    }));
    return Promise.resolve({ data: slice, error: null });
  };
  return { build, asked };
}

const OPTS = { scope: "overview", label: "applications" };

test("pages at 1000 and stops when the data runs out", async () => {
  const { build, asked } = rows(2500);
  const out = await pageAll(build, OPTS);
  assert.equal(out.length, 2500);
  assert.deepEqual(asked, [
    [0, 999],
    [1000, 1999],
    [2000, 2999],
  ]);
});

test("an exact multiple still terminates, without an extra empty read", async () => {
  // 2000 rows means page 2 comes back full, so it must ask for page 3 to learn
  // the data ended. Three requests is correct; four would be a bug.
  const { build, asked } = rows(2000);
  const out = await pageAll(build, OPTS);
  assert.equal(out.length, 2000);
  assert.equal(asked.length, 3);
});

test("a failed page THROWS rather than returning what it had", async () => {
  // The whole point of the consolidation. Copy A returned partial rows here,
  // copy B returned them silently.
  const { build } = rows(5000, 2000);
  await assert.rejects(
    () => pageAll(build, OPTS),
    (err) => {
      assert.match(err.message, /^\[overview\] applications failed at rows 2000-2999$/);
      assert.equal(err.cause.message, "connection reset");
      return true;
    },
  );
});

test("the scope prefixes the message, so three callers stay distinguishable", async () => {
  for (const [scope, label] of [
    ["overview", "jobs"],
    ["weekly-report", "stage history"],
    ["platform-analytics", "companies"],
  ]) {
    const { build } = rows(10, 0);
    await assert.rejects(
      () => pageAll(build, { scope, label }),
      (err) => {
        assert.equal(err.message, `[${scope}] ${label} failed at rows 0-999`);
        return true;
      },
    );
  }
});

test("no cap means no warning, ever", async () => {
  const warnings = captureWarnings();
  try {
    await pageAll(rows(2500).build, OPTS);
  } finally {
    warnings.restore();
  }
  assert.deepEqual(warnings.seen, [], "an uncapped read has nothing to disclose");
});

test("a cap that stops a full run WARNS", async () => {
  // 5000 rows available, capped at 2000: every page up to the cap is full, so
  // the cap is what ended it and the figures downstream are truncated.
  const warnings = captureWarnings();
  let out: unknown[] = [];
  try {
    out = await pageAll(rows(5000).build, { ...OPTS, cap: 2000 });
  } finally {
    warnings.restore();
  }
  assert.equal(out.length, 2000);
  assert.equal(warnings.seen.length, 1);
  assert.match(warnings.seen[0], /hit the 2,000-row cap/);
});

test("a cap the data never reaches does NOT warn", async () => {
  /*
   * The case a naive merge gets wrong. Copy C returned early on a short page,
   * skipping its warning; rewriting that as `break` plus a post-loop warn would
   * fire on every ordinary call. A false "your data is truncated" on every load
   * is worse than the silence it replaced.
   */
  const warnings = captureWarnings();
  let out: unknown[] = [];
  try {
    out = await pageAll(rows(1500).build, { ...OPTS, cap: 50_000 });
  } finally {
    warnings.restore();
  }
  assert.equal(out.length, 1500);
  assert.deepEqual(warnings.seen, [], "the data ran out, the cap did not stop it");
});

test("a cap that is not a page multiple is CLAMPED, not rounded up", async () => {
  // Latent in every copy: cap 1500 with PAGE 1000 would ask for 0-999 then
  // 1000-1999 and return 2000 rows — more than asked for. None of the copies
  // could hit it because the only cap in use divides exactly.
  const { build, asked } = rows(9000);
  const out = await pageAll(build, { ...OPTS, cap: 1500 });
  assert.equal(out.length, 1500, "exactly the cap, not the next page boundary");
  assert.deepEqual(asked, [
    [0, 999],
    [1000, 1499],
  ]);
});

test("the cap is a bound, not an error — it returns rows", async () => {
  const warnings = captureWarnings();
  let out: unknown[] = [];
  try {
    out = await pageAll(rows(50_000).build, { ...OPTS, cap: 3000 });
  } finally {
    warnings.restore();
  }
  assert.equal(out.length, 3000, "a deliberate bound still yields its rows");
  assert.equal(warnings.seen.length, 1, "and says so");
});

/* ──────────── #56 / #57: offset drift, reproduced by ID SET ──────────── */

/**
 * The staging reproduction, made deterministic. 2,500 rows; between page 1
 * and page 2 a row whose id sorts BEFORE the cursor is inserted, and between
 * page 2 and 3 it is deleted again. Offset paging shifts under both; keyset
 * does not. Every assertion is on the SET of ids: the live run's counts
 * cancelled (one repeat, one miss, 2,500 of 2,500), so a count proves nothing.
 */
function driftTable() {
  const table = new FakeTable(hexRows(2500));
  const expected = new Set(table.rows.map((r) => r.id as string));
  const synthetic = "0000000-before-the-cursor";
  table.between = (queryNo) => {
    if (queryNo === 1) table.insert({ id: synthetic });
    if (queryNo === 2) table.remove(synthetic);
  };
  return { table, expected, synthetic };
}
function setReport(ids: string[], expected: Set<string>) {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) repeated.add(id);
    seen.add(id);
  }
  const missing = [...expected].filter((id) => !seen.has(id));
  return { seen, repeated, missing };
}
const rangeBuild = (table: FakeTable) => (from: number, to: number) =>
  fakeClient({ t: table }).from("t").select("id").order("id").range(from, to);
const keyBuild = (table: FakeTable) => () => fakeClient({ t: table }).from("t").select("id");

test("#56: pageAll (order by id + range) loses a row to an insert before the cursor, and the COUNT hides it", async () => {
  const { table, expected } = driftTable();
  const out = await pageAll<{ id: string }>(rangeBuild(table), OPTS);
  const ids = out.map((r) => r.id);
  const { seen, repeated, missing } = setReport(ids, expected);
  assert.equal(ids.length, 2500, "the count equals the truth, which is the trap");
  assert.equal(repeated.size, 1, "one row read twice");
  assert.equal(missing.length, 1, "one row never read");
  assert.notEqual(seen.size, expected.size, "the SET is wrong");
});

test("#56: pageAll loses a row to a delete before the cursor too", async () => {
  const table = new FakeTable(hexRows(2500));
  const expected = new Set(table.rows.map((r) => r.id as string));
  table.between = (queryNo) => {
    if (queryNo === 1) table.remove("00000005");
  };
  const out = await pageAll<{ id: string }>(rangeBuild(table), OPTS);
  const { missing } = setReport(
    out.map((r) => r.id),
    expected,
  );
  // The deleted row was already read on page 1, so it is not what goes
  // missing. The rows after it shift up by one, page 2 starts one row late,
  // and the row that sat first on the old page 2 is never read: an innocent
  // neighbour of the boundary, not the row anyone deleted.
  assert.deepEqual(missing, ["000003e8"], "exactly one row, and not the deleted one");
});

test("#57: pageAllByKey returns the complete set under the same insert and delete", async () => {
  const { table, expected, synthetic } = driftTable();
  const out = await pageAllByKey<{ id: string }>(keyBuild(table), OPTS);
  const { seen, repeated, missing } = setReport(
    out.map((r) => r.id),
    expected,
  );
  assert.equal(repeated.size, 0);
  assert.deepEqual(missing, []);
  assert.equal(seen.size, expected.size);
  assert.ok(
    !seen.has(synthetic),
    "a row inserted below the cursor is not part of the set the read began on",
  );
});

test("#57: pageAllByKey is unmoved by an UPDATE that relocates a tuple (heap order), where an unordered read is not", async () => {
  // The live B case: an indexed-column update to a page-1 row between pages.
  const table = new FakeTable(hexRows(2500));
  const expected = new Set(table.rows.map((r) => r.id as string));
  table.between = (queryNo, returned) => {
    if (queryNo === 1) table.touch(returned[10].id as string);
  };
  const unordered = await pageAll<{ id: string }>(
    (from, to) => fakeClient({ t: table }).from("t").select("id").range(from, to),
    OPTS,
  );
  const u = setReport(
    unordered.map((r) => r.id),
    expected,
  );
  assert.equal(u.repeated.size, 1, "as shipped: the moved row is read again");
  assert.equal(u.missing.length, 1, "and one row is skipped");
  table.queries = 0;
  const keyed = await pageAllByKey<{ id: string }>(keyBuild(table), OPTS);
  const k = setReport(
    keyed.map((r) => r.id),
    expected,
  );
  assert.equal(k.repeated.size, 0);
  assert.deepEqual(k.missing, []);
});

test("pageAllByKey: pages by id > last with limit, stops on a short page, no extra read on an exact multiple", async () => {
  const table = new FakeTable(hexRows(2000));
  const out = await pageAllByKey<{ id: string }>(keyBuild(table), OPTS);
  assert.equal(out.length, 2000);
  assert.equal(table.queries, 3, "two full pages and one empty read to learn the data ended");
});

test("pageAllByKey: a failed page THROWS with the scope, label and cursor, nothing partial", async () => {
  const table = new FakeTable(hexRows(2500));
  await assert.rejects(
    () =>
      pageAllByKey(() => fakeClient({ t: table }, { failOnQuery: 2 }).from("t").select("id"), OPTS),
    (err) => {
      assert.equal(err.message, "[overview] applications failed after id 000003e7");
      assert.equal(err.cause.message, "connection reset");
      return true;
    },
  );
});

test("pageAllByKey: a full page that does not advance the cursor throws instead of looping", async () => {
  // A select without id: the fake projects columns, so id never comes back,
  // every page is 'full' and the cursor cannot move.
  const table = new FakeTable(hexRows(1500).map(({ id }) => ({ id, other: id })));
  const noId = () => fakeClient({ t: table }).from("t").select("other");
  await assert.rejects(() => pageAllByKey(noId, OPTS), /did not advance the id cursor/);
});

test("pageAllByKey: a cap is clamped and warns only when it stopped a full run", async () => {
  const warnings = captureWarnings();
  let out: unknown[] = [];
  try {
    out = await pageAllByKey(keyBuild(new FakeTable(hexRows(9000))), { ...OPTS, cap: 1500 });
  } finally {
    warnings.restore();
  }
  assert.equal(out.length, 1500);
  assert.equal(warnings.seen.length, 1);
  const quiet = captureWarnings();
  try {
    out = await pageAllByKey(keyBuild(new FakeTable(hexRows(1200))), { ...OPTS, cap: 50_000 });
  } finally {
    quiet.restore();
  }
  assert.equal(out.length, 1200);
  assert.deepEqual(quiet.seen, []);
});

function captureWarnings() {
  const original = console.warn;
  const seen: string[] = [];
  console.warn = (...args: unknown[]) => {
    seen.push(args.map(String).join(" "));
  };
  return {
    seen,
    restore: () => {
      console.warn = original;
    },
  };
}
