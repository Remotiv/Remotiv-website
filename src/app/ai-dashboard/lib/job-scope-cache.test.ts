/**
 * readJobScope is cache()d, and this file is the proof that it memoises.
 *
 *   node --test "src/app/ai-dashboard/lib/job-scope-cache.test.ts"
 *
 * ── Why this needs proving at all ────────────────────────────
 *
 * One Applicants render asks the same permission question four times — the page
 * itself, the list, the counts batch, the assignable-jobs read. Four reads of
 * one fact are four independent chances to fail, and they can disagree: the
 * counts batch answering an empty scope while the page's own read fails (or the
 * reverse) puts population figures above a table stating the reader is assigned
 * to no roles. A page contradicting itself about who you are is worse than
 * either honest outcome, and it is purely an artefact of asking twice.
 *
 * cache() collapses that to one read and one answer per request. But cache()
 * only memoises under two conditions, and BOTH are silent when unmet:
 *
 *   1. A dispatcher must be installed — i.e. a real request scope. Without one
 *      React's server build does `if (!dispatcher) return fn.apply(...)` and the
 *      wrapper is a no-op.
 *   2. Object arguments are keyed in a WeakMap by REFERENCE. Two ctx objects
 *      with identical contents are two different cache entries.
 *
 * Neither failure throws, logs, or shows up in a type. The wrapper would just
 * quietly do nothing — which is exactly the shape of a claim that is asserted
 * rather than tested, so it is tested here.
 *
 * ── What a "request scope" is, in this file ──────────────────
 *
 * Next installs the dispatcher per render pass; there is no Next here. The
 * dispatcher's whole contract for cache() is one method:
 *
 *     var fnMap = dispatcher.getCacheForType(createCacheRoot);
 *
 * — a per-request store, keyed by the constructor React hands in. `withRequestScope`
 * below supplies exactly that and nothing else, so what is exercised is React's
 * own memo logic rather than a reimplementation of it. A fresh store per call is
 * what makes the scopes independent, which is the property that stops this from
 * being a process-level cache across tenants.
 *
 * react-server-hook.mjs is why `cache` is the real implementation at all: bare
 * Node resolves React's DEFAULT build, whose cache is an unconditional
 * pass-through.
 */
// @ts-nocheck — same reason as the other node:test files here: Node's `.ts`
// specifier vs this tsconfig, which does not set allowImportingTsExtensions.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../../test-support/applicants-test-hook.mjs", import.meta.url));
// Last, so it sees the bare "react".
register(new URL("../../../test-support/react-server-hook.mjs", import.meta.url));

const React = await import("react");
const { fakeService } = await import("../../../test-support/fake-postgrest.mjs");
const { getJobScope, readJobScope } = await import("./job-scope.ts");

// If this is the pass-through build the rest of the file would pass vacuously.
assert.ok(
  React.__SERVER_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE,
  "test: the client React build was loaded; cache() there is a no-op and every assertion below would be meaningless",
);

const INTERNALS = React.__SERVER_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;

/** One render pass: its own cache store, torn down afterwards. */
async function withRequestScope(body) {
  const store = new Map();
  const previous = INTERNALS.A;
  INTERNALS.A = {
    getCacheForType(ctor) {
      if (!store.has(ctor)) store.set(ctor, ctor());
      return store.get(ctor);
    },
    cacheSignal: () => null,
  };
  try {
    return await body();
  } finally {
    INTERNALS.A = previous;
  }
}

const CO = "c0000000-0000-0000-0000-000000000001";
const J1 = "a0000000-0000-0000-0000-00000000000a";

/** A recruiter — a job-scoped role, so the hiring-team read actually happens. */
const ctxFor = (over = {}) => ({
  companyId: CO,
  role: "recruiter",
  memberId: "m-1",
  memberName: "Rae Recruiter",
  user: { id: "u-1", email: "rae@acme.test" },
  company: { name: "Acme" },
  ...over,
});

/** Counts hiring-team reads. `fail` makes every one of them fail. */
function install({ fail = false, jobs = [J1] } = {}) {
  const service = fakeService((table) => {
    if (table !== "job_hiring_team") throw new Error(`test: unexpected table ${table}`);
    if (fail) return { data: null, error: { message: "boom", code: "57014" } };
    return { data: jobs.map((job_id) => ({ job_id })), error: null };
  });
  globalThis.__applicantsServiceForTests = () => service;
  return service;
}

const reads = (service) => service.queries.filter((q) => q.table === "job_hiring_team").length;

// ── The memoisation itself ──────────────────────────────────

test("four calls with the same ctx issue ONE hiring-team read", async () => {
  const service = install();
  const ctx = ctxFor();

  await withRequestScope(async () => {
    const all = await Promise.all([
      readJobScope(ctx),
      readJobScope(ctx),
      readJobScope(ctx),
      readJobScope(ctx),
    ]);
    for (const read of all) {
      assert.deepEqual(read, { ok: true, value: { scoped: true, jobIds: [J1] } });
    }
  });

  assert.equal(reads(service), 1, "the scope was read more than once in one request");
});

test("concurrent callers share one in-flight read, not one read each", async () => {
  // React memoises the returned PROMISE, so the memo is populated before the
  // first read resolves. A cache that stored the resolved value instead would
  // let four simultaneous callers all miss and all query.
  const service = install();
  const ctx = ctxFor();

  await withRequestScope(async () => {
    const a = readJobScope(ctx);
    const b = readJobScope(ctx);
    assert.equal(reads(service), 1, "a second read was issued before the first resolved");
    assert.equal(await a, await b, "the two callers did not get the identical Read");
  });
});

test("the two entry points share the read: getJobScope does not add one", async () => {
  // getJobScope delegates to readJobScope, so a page mixing the two — which the
  // Applicants render does — still reads once.
  const service = install();
  const ctx = ctxFor();

  await withRequestScope(async () => {
    await Promise.all([readJobScope(ctx), getJobScope(ctx), readJobScope(ctx), getJobScope(ctx)]);
  });

  assert.equal(reads(service), 1);
});

test("the four callers cannot disagree, because there is one answer", async () => {
  // The contradiction this exists to prevent: a failing read for one caller and
  // a succeeding read for another, in the same render. With one read there is
  // one outcome, and every caller sees it.
  const service = install({ fail: true });
  const ctx = ctxFor();
  const quiet = console.error;
  console.error = () => {};

  await withRequestScope(async () => {
    const [page, list, counts] = await Promise.all([
      readJobScope(ctx),
      readJobScope(ctx),
      readJobScope(ctx),
    ]);
    assert.equal(page.ok, false);
    assert.equal(list.ok, false);
    assert.equal(counts.ok, false);
    // And the fail-closed entry point agrees with them rather than contradicting:
    // it reports the empty scope, which is the same answer narrowed.
    assert.deepEqual(await getJobScope(ctx), { scoped: true, jobIds: [] });
  }).finally(() => {
    console.error = quiet;
  });

  assert.equal(reads(service), 1, "a failure was retried, which is how callers end up disagreeing");
});

// ── The scope is per request, which is the tenancy property ──

test("a second request reads again — this is NOT a process-level cache", async () => {
  // The failure a cross-request cache would cause is not a stale page. It is
  // serving one company's scope to another company's user.
  const service = install();
  const ctx = ctxFor();

  await withRequestScope(() => readJobScope(ctx));
  await withRequestScope(() => readJobScope(ctx));

  assert.equal(reads(service), 2, "the memo outlived its request");
});

test("two viewers in one scope are two entries, not one answer shared", async () => {
  const service = install();
  await withRequestScope(async () => {
    const rae = ctxFor({ memberId: "m-1" });
    const sam = ctxFor({ memberId: "m-2" });
    await Promise.all([readJobScope(rae), readJobScope(sam), readJobScope(rae)]);
  });
  assert.equal(reads(service), 2, "two different viewers collapsed into one scope");
});

// ── The premise the memo rests on ───────────────────────────

test("keying is by REFERENCE: an equal-but-new ctx object reads again", async () => {
  /*
   * React puts object arguments in a WeakMap, so identity is the key and deep
   * equality buys nothing. This is the premise the whole fix depends on, and it
   * holds here because getCompanyContext is itself cache()d with ZERO arguments
   * — within one render every `await getCompanyContext()` yields the identical
   * object, which the next test shows.
   *
   * Asserted explicitly rather than left implied: if it were ever broken, the
   * symptom is this wrapper silently doing nothing.
   */
  const service = install();
  await withRequestScope(async () => {
    await readJobScope(ctxFor());
    await readJobScope(ctxFor());
  });
  assert.equal(reads(service), 2);
});

test("a zero-argument cache()d resolver yields the identical object every time", async () => {
  // The getCompanyContext shape, reduced to what matters: no arguments, so no
  // key to differ on, so one object for the whole request. That is what makes
  // readJobScope(ctx) a cache HIT at all four of its call sites.
  let calls = 0;
  const resolve = React.cache(async () => {
    calls++;
    return { companyId: CO };
  });

  await withRequestScope(async () => {
    const [a, b, c] = await Promise.all([resolve(), resolve(), resolve()]);
    assert.equal(calls, 1);
    assert.equal(a, b);
    assert.equal(b, c, "two callers held different context objects");
  });
});

// ── Outside a request scope ─────────────────────────────────

test("with no dispatcher cache() is a pass-through: every call reads", async () => {
  /*
   * Not a defect — it is why wrapping readJobScope changed no existing test.
   * The other scope suites assert things like "the scope is resolved ONCE per
   * batch" by counting queries, and they still mean what they meant because
   * outside a render React calls straight through.
   *
   * It is also the safe-failure property: if the memo ever stops applying, the
   * behaviour is today's four reads. Slower, never wider.
   */
  const service = install();
  const ctx = ctxFor();
  assert.equal(INTERNALS.A, null, "test: a dispatcher leaked out of a previous scope");

  await readJobScope(ctx);
  await readJobScope(ctx);
  await readJobScope(ctx);

  assert.equal(reads(service), 3);
});

test("a site-wide role still issues no read, cached or not", async () => {
  // cache() must not change WHAT is resolved. An owner never had a hiring-team
  // read and must not acquire one.
  const service = install();
  const owner = ctxFor({ role: "owner" });

  await withRequestScope(async () => {
    assert.deepEqual(await readJobScope(owner), { ok: true, value: { scoped: false } });
    assert.deepEqual(await readJobScope(owner), { ok: true, value: { scoped: false } });
  });

  assert.equal(reads(service), 0);
});

test("a scoped role with no member row is still an answered empty scope", async () => {
  const service = install();
  const noMember = ctxFor({ memberId: null });

  await withRequestScope(async () => {
    assert.deepEqual(await readJobScope(noMember), {
      ok: true,
      value: { scoped: true, jobIds: [] },
    });
  });

  assert.equal(reads(service), 0);
});
