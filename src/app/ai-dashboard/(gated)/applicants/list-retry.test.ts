/**
 * A failed page read: one silent retry, then the error state with Try again.
 *
 *   node --test "src/app/ai-dashboard/(gated)/applicants/list-retry.test.ts"
 *
 * The 500-page staging sweep stopped once on a page whose list read never
 * came back with rows; the page then sat in its error state with no way on
 * but a reload. Now the newest read is asked once more before the error shows
 * (the read is read-only), and the error state offers Try again, which re-runs
 * the same request. Flag off and on: both render this list state. The copy
 * says "search" only when a search term is set. Synthetic data only.
 */
// @ts-nocheck - same reason as stage-tabs.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { describe, test } from "node:test";

register(new URL("../../../../test-support/node-resolve.mjs", import.meta.url));

const { readWithOneRetry, requestList, seedList, settleList, listView } = await import(
  "./list-state.ts"
);

const client = readFileSync(new URL("./_applicants-client.tsx", import.meta.url), "utf8");
const PAGE = { rows: [{ id: "a" }], total: 1 };

function attempts(results) {
  let calls = 0;
  const fn = async () => {
    const r = results[calls];
    calls += 1;
    return r;
  };
  return { fn, calls: () => calls };
}

describe("readWithOneRetry", () => {
  test("a good first read is not asked again", async () => {
    const a = attempts([PAGE]);
    assert.equal(await readWithOneRetry(a.fn, () => true), PAGE);
    assert.equal(a.calls(), 1);
  });
  test("one failure, then the retry's page", async () => {
    const a = attempts([null, PAGE]);
    assert.equal(await readWithOneRetry(a.fn, () => true), PAGE);
    assert.equal(a.calls(), 2);
  });
  test("two failures: null, after exactly two attempts (never a third)", async () => {
    const a = attempts([null, null, PAGE]);
    assert.equal(await readWithOneRetry(a.fn, () => true), null);
    assert.equal(a.calls(), 2);
  });
  test("a superseded request is not retried", async () => {
    const a = attempts([null, PAGE]);
    assert.equal(await readWithOneRetry(a.fn, () => false), null);
    assert.equal(a.calls(), 1);
  });
});

describe("the list state around a retry", () => {
  test("the retry's answer settles the newest request; the failure path still clears the rows", () => {
    const shown = seedList("k1", PAGE);
    const pending = requestList(shown, "k2", 1);
    assert.equal(listView(pending).updating, true, "loading across both attempts");
    assert.equal(listView(pending).rows, PAGE.rows, "the old rows stay, dimmed, while it retries");
    const ok = settleList(pending, { key: "k2", seq: 1, page: { rows: [{ id: "b" }], total: 1 } });
    assert.equal(listView(ok).failed, false);
    const failed = settleList(pending, { key: "k2", seq: 1, page: null });
    assert.equal(listView(failed).failed, true);
    assert.equal(listView(failed).rows.length, 0, "rows are cleared on the final failure");
  });
  test("a late retry for an older request cannot overwrite the newest", () => {
    const s = requestList(requestList(seedList("k1", PAGE), "k2", 1), "k3", 2);
    assert.equal(settleList(s, { key: "k2", seq: 1, page: null }), s);
  });
});

describe("wiring in the client", () => {
  const body = client.slice(
    client.indexOf("const refreshList = useCallback("),
    client.indexOf("const listPrimed = useRef(false);"),
  );
  test("refreshList retries once, only while the request is the newest, and maps both failures to null", () => {
    assert.match(body, /readWithOneRetry\(/);
    assert.match(body, /\(\) => listSeq\.current === seq,/);
    assert.match(body, /\(read\) => \(read\.ok \? read\.value : null\),\s*\(\) => null,/);
    assert.match(body, /settleList\(prev, \{ key, seq, page \}\)/);
    assert.doesNotMatch(body, /\.catch\(/, "a rejection must not settle before the retry");
  });
  test("Try again re-runs the same request and keeps the error copy up while it reads", () => {
    assert.match(
      body,
      /const tryAgain = useCallback\(\(\) => \{\s*refreshList\(request\);\s*setRetrySeq\(listSeq\.current\);/,
    );
    assert.match(
      body,
      /const retrying = retrySeq !== null && list\.expected === retrySeq && list\.pending;/,
    );
    const empty = client.slice(
      client.indexOf("const emptyState = ("),
      client.indexOf("const splitProps"),
    );
    assert.match(empty, /\(pageView\.failed \|\| retrying\) && \(\s*<button/);
    assert.match(empty, /onClick=\{tryAgain\}/);
    assert.match(empty, /\{retrying \? "Trying again…" : "Try again"\}/);
  });
  test("the copy says search only when a search term is set; hyphens only", () => {
    const copy = client.slice(
      client.indexOf("const emptyCopy = (() => {"),
      client.indexOf("const emptyState = ("),
    );
    const failed = copy.slice(
      copy.indexOf("if (pageView.failed || retrying) {"),
      copy.indexOf("if (urlSearch) {"),
    );
    assert.match(failed, /return urlSearch\s*\?\s*\{\s*title: "We couldn't run that search",/);
    assert.match(failed, /title: "We couldn't load applicants\.",/);
    assert.match(
      failed,
      /text: "This is on our side, not a filter you set\. Try again, or reload the page if it keeps happening\.",/,
    );
    const strings = [...failed.matchAll(/"([^"]*)"/g)].map((m) => m[1]).join(" ");
    assert.doesNotMatch(strings, /[–—]/);
  });
});
