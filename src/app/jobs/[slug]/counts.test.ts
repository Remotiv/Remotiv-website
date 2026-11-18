/**
 * The public job page's applicant counts (#82): cached per job for five
 * minutes, and a count that cannot be read is hidden rather than shown as 0.
 *
 *   node --test "src/app/jobs/[slug]/counts.test.ts"
 *
 * `next/cache` is replaced by a stand-in with unstable_cache's documented
 * contract: the key is the key parts plus the call's arguments, and only a
 * resolved value is stored. It records the options it was given, so the
 * revalidate window and the key are asserted, not assumed. Next's own cache is
 * not exercised here. The database is fake-postgrest.mjs; no network.
 */
// @ts-nocheck - same reason as the other node:test files: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../../test-support/fake-service-client-hook.mjs", import.meta.url));
register(
  `data:text/javascript,${encodeURIComponent(`
const STUB = [
  "export function unstable_cache(fn, keyParts = [], options = {}) {",
  "  const store = new Map();",
  "  (globalThis.__cacheCalls ??= []).push({ keyParts, options });",
  "  globalThis.__cacheStores = [...(globalThis.__cacheStores ?? []), store];",
  "  return async (...args) => {",
  "    const key = JSON.stringify([keyParts, args]);",
  "    if (store.has(key)) return store.get(key);",
  "    const value = await fn(...args);",
  "    store.set(key, value);",
  "    return value;",
  "  };",
  "}",
].join("\\n");
export async function resolve(specifier, context, next) {
  if (specifier === "next/cache") return { url: "data:text/javascript," + encodeURIComponent(STUB), shortCircuit: true };
  return next(specifier, context);
}`)}`,
);

const { fakeService } = await import("../../../test-support/fake-postgrest.mjs");
const { fetchPublicJobCounts, PUBLIC_COUNTS_REVALIDATE_SECONDS } = await import("./_counts.ts");

const counts = { "job-a": [7, 2], "job-b": [3, 0] };
let fail = null;
const service = fakeService((table, calls) => {
  assert.equal(table, "job_applications");
  const job = calls.find((c) => c[0] === "eq" && c[1] === "job_id")?.[2];
  const thisWeek = calls.some((c) => c[0] === "gte" && c[1] === "created_at");
  if (fail === "error") return { count: null, error: { code: "57014", message: "timeout" } };
  if (fail === "no count") return { count: null, error: null };
  return { count: counts[job][thisWeek ? 1 : 0], error: null };
});
globalThis.__fakeServiceClientForTests = () => service;

const quiet = async (fn) => {
  const saved = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = saved;
  }
};
const readsFor = (job) =>
  service.queries.filter((q) => q.calls.some((c) => c[0] === "eq" && c[2] === job)).length;
const clearCache = () => {
  for (const store of globalThis.__cacheStores) store.clear();
};

// Negative control: drop unstable_cache (call readCounts directly) and the second view reads again.
test("the counts are cached per job for 300 seconds: a second view of the same job reads nothing", async () => {
  clearCache();
  assert.deepEqual(await fetchPublicJobCounts("job-a"), { total: 7, thisWeek: 2 });
  assert.equal(readsFor("job-a"), 2, "two head counts on the first view");
  assert.deepEqual(await fetchPublicJobCounts("job-a"), { total: 7, thisWeek: 2 });
  assert.equal(readsFor("job-a"), 2, "the second view is served from the cache");

  assert.deepEqual(await fetchPublicJobCounts("job-b"), { total: 3, thisWeek: 0 });
  assert.equal(readsFor("job-b"), 2, "another job is its own cache entry");

  assert.equal(PUBLIC_COUNTS_REVALIDATE_SECONDS, 300);
  const [{ keyParts, options }] = globalThis.__cacheCalls;
  assert.deepEqual(options, { revalidate: 300 });
  assert.deepEqual(keyParts, ["public-job-counts"]);
});

// Negative control: return { total: 0, thisWeek: 0 } on failure inside the cached function and both halves fail.
for (const kind of ["error", "no count"]) {
  test(`a count that cannot be read (${kind}) is unknown, never 0, and is not cached`, async () => {
    clearCache();
    fail = kind;
    try {
      assert.deepEqual(await quiet(() => fetchPublicJobCounts("job-a")), {
        total: null,
        thisWeek: null,
      });
    } finally {
      fail = null;
    }
    // The next view asks again and gets the real figures: nothing wrong was kept.
    assert.deepEqual(await fetchPublicJobCounts("job-a"), { total: 7, thisWeek: 2 });
  });
}

/*
 * The two views hide an unknown figure and keep every string as it was.
 * Source pins: rendering them here would mean stubbing the navbar, the
 * white-label shell and two stylesheets. Negative control: put back
 * `value: \`${total} so far\`` unguarded and the first assertion fails.
 */
test("an unknown count hides its line on both views; a real 0 still shows; copy unchanged", () => {
  const remotiv = readFileSync(new URL("./_remotiv-detail.tsx", import.meta.url), "utf8");
  const company = readFileSync(new URL("./_company-detail.tsx", import.meta.url), "utf8");
  const page = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");

  assert.match(
    remotiv,
    /\.\.\.\(total === null \? \[\] : \[\{ Icon: IconUsers, label: "Applicants", value: `\$\{total\} so far` \}\]\)/,
  );
  assert.match(remotiv, /\{thisWeek !== null && thisWeek > 0 && \(/);
  assert.match(remotiv, /\{thisWeek === 1 \? "person" : "people"\} applied this week/);
  assert.match(
    company,
    /\{total !== null && total > 0 && ` · \$\{total\} applicant\$\{total === 1 \? "" : "s"\}`\}/,
  );
  assert.match(page, /await fetchPublicJobCounts\(job\.id\)/);
  assert.doesNotMatch(page, /fetchCounts|count \?\? 0/, "no uncached or zero-on-failure path left");
});
