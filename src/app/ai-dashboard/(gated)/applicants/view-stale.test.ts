/**
 * #41: rapid job switching through the new view batcher can never let an
 * older answer overwrite the current job's rows, counts, flagged chip or top
 * scored.
 *
 *   node --test "src/app/ai-dashboard/(gated)/applicants/view-stale.test.ts"
 *
 * The batcher (view-batch.ts) gives each read its own promise and does not
 * order answers. The guards are where they were before #41, one per read:
 *   - list:    requestList / settleList (list-state.ts), keyed on the request
 *              and a sequence number; an answer that is not the newest is
 *              dropped;
 *   - counts:  requestCounts / settleCounts (counts-state.ts), the same way;
 *   - flagged: a sequence number (`seq === flaggedSeq.current`);
 *   - top:     the effect's cleanup (`live = false`) when the filter moves.
 * This drives the REAL batcher and the REAL list and counts state machines,
 * wired exactly as _applicants-client.tsx wires them (pinned below), with a
 * server whose answers the test releases in any order. Synthetic data.
 */
// @ts-nocheck - same reason as the other node:test files here: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../../../test-support/node-resolve.mjs", import.meta.url));

const { createViewBatcher } = await import("./view-batch.ts");
const { listKey, listView, requestList, seedList, settleList } = await import("./list-state.ts");
const { countsKey, countsView, requestCounts, seedCounts, settleCounts } = await import(
  "./counts-state.ts"
);

const tick = () => new Promise((r) => setTimeout(r, 0));

/** A server whose answers wait until the test releases them, per call. */
function heldServer() {
  const calls = [];
  const send = (request) =>
    new Promise((resolve, reject) => {
      calls.push({ request, resolve, reject });
    });
  /** The answer for call `i`: every part about that call's job, or a failure. */
  const answer = (i, { fail = false } = {}) => {
    const { request, resolve, reject } = calls[i];
    if (fail) return reject(new TypeError("fetch failed"));
    const job = request.list?.jobId ?? request.counts?.[0]?.jobId ?? "all";
    resolve({
      list: request.list
        ? { threw: false, read: { ok: true, value: { rows: [{ id: `${job}-row` }], total: 1 } } }
        : null,
      top: request.top ? { threw: false, read: { ok: true, value: [{ id: `${job}-top` }] } } : null,
      counts: (request.counts ?? []).map((q) => ({
        threw: false,
        read: { ok: true, value: { total: `${q.jobId ?? "all"}-total`, stages: {} } },
      })),
      flagged: request.flagged
        ? { threw: false, read: { ok: true, value: `${request.flagged.jobId}-flagged` } }
        : null,
    });
  };
  return { calls, answer, send };
}

const request = (jobId) => ({
  jobId,
  search: "",
  stage: null,
  flaggedOnly: false,
  sort: "best",
  page: 1,
});

/**
 * The page's four reads for one job switch, as the client issues them: one
 * commit, so one batch. State and guards as in _applicants-client.tsx.
 */
function page(batch) {
  const s = {
    list: seedList(listKey(request(null)), { rows: [{ id: "seed-row" }], total: 1 }),
    counts: seedCounts(countsKey(null), { total: "seed-total", stages: {} }),
    flagged: "seed-flagged",
    top: [{ id: "seed-top" }],
  };
  let listSeq = 0;
  let countsSeq = 0;
  let flaggedSeq = 0;
  let topLive = () => {};
  const switchTo = (jobId) => {
    const r = request(jobId);
    // list (refreshList)
    const lKey = listKey(r);
    const lSeq = ++listSeq;
    s.list = requestList(s.list, lKey, lSeq);
    batch
      .list({ jobId, page: 1, sort: "best" })
      .then(
        (read) => (read.ok ? read.value : null),
        () => null,
      )
      .then((p) => {
        s.list = settleList(s.list, { key: lKey, seq: lSeq, page: p });
      });
    // counts (readCounts)
    const cKey = countsKey(jobId);
    const cSeq = ++countsSeq;
    s.counts = requestCounts(s.counts, cKey, cSeq);
    batch
      .counts({ jobId })
      .then((read) =>
        settleCounts(s.counts, { key: cKey, seq: cSeq, counts: read.ok ? read.value : null }),
      )
      .catch(() => settleCounts(s.counts, { key: cKey, seq: cSeq, counts: null }))
      .then((next) => {
        s.counts = next;
      });
    // flagged (refreshFlaggedCount)
    const fSeq = ++flaggedSeq;
    batch
      .flagged({ jobId })
      .then((read) => {
        if (fSeq === flaggedSeq) s.flagged = read.ok ? read.value : null;
      })
      .catch(() => {
        if (fSeq === flaggedSeq) s.flagged = null;
      });
    // top (the effect, whose cleanup runs when the filter moves)
    topLive();
    let live = true;
    topLive = () => {
      live = false;
    };
    s.top = null;
    batch
      .top({ jobId, page: 1, sort: "best" })
      .then((read) => {
        if (live) s.top = read.ok ? read.value : null;
      })
      .catch(() => {
        if (live) s.top = null;
      });
  };
  const shown = () => ({
    rows: listView(s.list).rows.map((r) => r.id),
    total: countsView(s.counts).total,
    flagged: s.flagged,
    top: s.top?.map((r) => r.id) ?? null,
  });
  return { switchTo, shown };
}

const B_SHOWN = { rows: ["B-row"], total: "B-total", flagged: "B-flagged", top: ["B-top"] };

test("S1. switch to A, then to B; A's answer arrives LAST: the screen stays on B", async () => {
  const server = heldServer();
  const p = page(createViewBatcher(server.send));
  p.switchTo("A");
  await tick();
  p.switchTo("B");
  await tick();
  assert.equal(server.calls.length, 2, "one call per switch");
  server.answer(1);
  await tick();
  assert.deepEqual(p.shown(), B_SHOWN);
  server.answer(0); // A, late
  await tick();
  assert.deepEqual(p.shown(), B_SHOWN, "the older answer changed nothing");
});

test("S2. the answers in order: B still wins", async () => {
  const server = heldServer();
  const p = page(createViewBatcher(server.send));
  p.switchTo("A");
  await tick();
  p.switchTo("B");
  await tick();
  server.answer(0);
  await tick();
  server.answer(1);
  await tick();
  assert.deepEqual(p.shown(), B_SHOWN);
});

test("S3. A, B, then back to A: the FIRST A answer arriving last is not the current one either", async () => {
  const server = heldServer();
  const p = page(createViewBatcher(server.send));
  for (const job of ["A", "B", "A"]) {
    p.switchTo(job);
    await tick();
  }
  server.answer(2); // the current A
  await tick();
  const current = p.shown();
  assert.deepEqual(current, {
    rows: ["A-row"],
    total: "A-total",
    flagged: "A-flagged",
    top: ["A-top"],
  });
  server.answer(1); // B, stale
  server.answer(0); // the first A, stale (same job, older request)
  await tick();
  assert.deepEqual(p.shown(), current);
});

test("S4. the current job's call FAILS and an older one then succeeds: the old rows never come back", async () => {
  const server = heldServer();
  const p = page(createViewBatcher(server.send));
  p.switchTo("A");
  await tick();
  p.switchTo("B");
  await tick();
  server.answer(1, { fail: true });
  await tick();
  const failed = p.shown();
  assert.deepEqual(failed, { rows: [], total: null, flagged: null, top: null });
  server.answer(0); // A succeeds, late
  await tick();
  assert.deepEqual(p.shown(), failed, "A's rows, counts, chip and top stay off B's screen");
});

test("S5. the simulation is the client: every guard above is the one _applicants-client.tsx uses", () => {
  const src = readFileSync(new URL("./_applicants-client.tsx", import.meta.url), "utf8");
  const between = (from, to) => src.slice(src.indexOf(from), src.indexOf(to, src.indexOf(from)));
  const list = between("const refreshList = useCallback(", "}, []);");
  assert.match(list, /const seq = \+\+listSeq\.current;/);
  assert.match(list, /setList\(\(prev\) => requestList\(prev, key, seq\)\);/);
  assert.match(list, /viewBatch\.list\(listQueryFor\(r\)\)/);
  assert.match(list, /setList\(\(prev\) => settleList\(prev, \{ key, seq, page \}\)\);/);
  const counts = between("const readCounts = useCallback(", "}, []);");
  assert.match(counts, /const seq = \+\+countsSeq\.current;/);
  assert.match(counts, /setCounts\(\(prev\) => requestCounts\(prev, key, seq\)\);/);
  assert.match(counts, /\.counts\(jobId \? \{ jobId \} : \{\}\)/);
  assert.equal((counts.match(/settleCounts\(prev, \{ key, seq, counts:/g) ?? []).length, 2);
  const flagged = between("const refreshFlaggedCount = useCallback(", "}, []);");
  assert.match(flagged, /const seq = \+\+flaggedSeq\.current;/);
  assert.equal(
    (flagged.match(/if \(seq === flaggedSeq\.current\) setFlaggedCount\(/g) ?? []).length,
    2,
  );
  const top = between("let live = true;\n    setTopScored(null);", "}, [topKey]);");
  assert.match(top, /\.top\(listQueryFor\(request\)\)/);
  assert.equal((top.match(/if \(live\) setTopScored\(/g) ?? []).length, 2);
  assert.match(top, /return \(\) => \{\s*live = false;\s*\};/);
  // And the settle functions really drop what is not the newest.
  const l = requestList(seedList("k0", null), "k1", 5);
  assert.equal(settleList(l, { key: "k1", seq: 4, page: { rows: [], total: 0 } }), l);
  const c = requestCounts(seedCounts("all", null), "B", 3);
  assert.equal(settleCounts(c, { key: "A", seq: 3, counts: { total: 1 } }), c);
});
