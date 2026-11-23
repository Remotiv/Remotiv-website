/**
 * The sitemap advertises every public profile and nothing else: read through
 * the shared visibility predicate, paged past PostgREST's 1,000-row cap.
 *
 *   node --test src/lib/sitemap.test.ts
 *
 * Runs the real sitemap() against a fake database (fake-service-client-hook).
 * The fake behaves like PostgREST where it matters: a request with no range
 * gets at most 1,000 rows, so a version that reads in one request silently
 * drops the rest, exactly as the old sitemap did.
 */
// @ts-nocheck — same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
import { call, fakeService } from "../test-support/fake-postgrest.mjs";

register(new URL("../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../test-support/fake-service-client-hook.mjs", import.meta.url));

const { default: sitemap } = await import("../app/sitemap.ts");

const POSTGREST_CAP = 1000;
const TALENT = Array.from({ length: 1500 }, (_, i) => ({
  id: `t-${String(i).padStart(4, "0")}`,
  claimed_at: null,
  approved_at: "2026-09-01T00:00:00Z",
}));
const REMOTE = Array.from({ length: 38 }, (_, i) => ({
  id: `r-${String(i).padStart(2, "0")}`,
  claimed_at: null,
  approved_at: "2026-09-01T00:00:00Z",
}));

/** Serve a table the way PostgREST would: a range if asked, else the first 1,000. */
function serve(rows, calls) {
  const range = call(calls, "range");
  const slice = range ? rows.slice(range[1], range[2] + 1) : rows.slice(0, POSTGREST_CAP);
  return { data: slice, error: null };
}

function world({ failing = null } = {}) {
  return fakeService((table, calls) => {
    if (table === failing) return { data: null, error: { message: "connection reset" } };
    if (table === "talent_profiles") return serve(TALENT, calls);
    if (table === "hire_remote_profiles") return serve(REMOTE, calls);
    if (table === "jobs")
      return {
        data: [{ id: "j1", slug: "engineer", created_at: "2026-09-01T00:00:00Z" }],
        error: null,
      };
    throw new Error(`unexpected table ${table}`);
  });
}

async function run(service) {
  globalThis.__fakeServiceClientForTests = () => service;
  const errors = console.error;
  const logged = [];
  console.error = (...a) => logged.push(a.map(String).join(" "));
  try {
    return { entries: await sitemap(), logged };
  } finally {
    console.error = errors;
    delete globalThis.__fakeServiceClientForTests;
  }
}

const profileUrls = (entries) => entries.map((e) => e.url).filter((u) => u.includes("/talent/"));

test("every public profile is advertised, past the 1,000-row cap", async () => {
  const { entries } = await run(world());
  const urls = profileUrls(entries);
  assert.equal(
    urls.length,
    TALENT.length + REMOTE.length,
    "profiles beyond the first 1,000 were dropped",
  );
  assert.equal(new Set(urls).size, urls.length, "a profile was listed twice");
  assert.ok(
    urls.includes("https://remotiv.work/talent/t-1499"),
    "the last talent profile is missing",
  );
  assert.ok(urls.includes("https://remotiv.work/talent/r-37"));
});

test("both tables are read only through the public-visibility predicate, in a stable order", async () => {
  const service = world();
  await run(service);
  const talent = service.queries.filter((q) => q.table === "talent_profiles");
  const remote = service.queries.filter((q) => q.table === "hire_remote_profiles");
  assert.ok(talent.length >= 2, "talent was not paged");
  for (const q of talent) {
    const filters = q.calls.filter((c) => ["not", "eq"].includes(c[0])).map((c) => c.slice(0, 3));
    assert.deepEqual(filters, [
      ["not", "approved_at", "is"],
      ["eq", "is_paused", false],
      ["eq", "is_archived", false],
    ]);
    assert.deepEqual(call(q.calls, "order"), ["order", "id"]);
  }
  for (const q of remote) {
    assert.deepEqual(call(q.calls, "not").slice(0, 3), ["not", "approved_at", "is"]);
    assert.deepEqual(call(q.calls, "in"), ["in", "status", ["approved", "shortlisted", "placed"]]);
  }
});

test("a failed page drops the profile block, never a partial list, and the rest still ships", async () => {
  const { entries, logged } = await run(world({ failing: "talent_profiles" }));
  assert.equal(profileUrls(entries).length, 0, "a partial profile list was advertised");
  assert.ok(
    entries.some((e) => e.url === "https://remotiv.work/"),
    "static pages must still ship",
  );
  assert.ok(
    entries.some((e) => e.url.endsWith("/jobs/engineer")),
    "jobs must still ship",
  );
  // #73: one line, our own words: the database's text never reaches the log.
  assert.deepEqual(logged, [
    "[sitemap] profiles left out: [sitemap] public talent profiles failed at rows 0-999",
  ]);
  assert.ok(!logged.join(" ").includes("connection reset"));
});

/* ── #73: a slow or hung database never holds the build ────────── */

const NEVER = () => new Promise(() => {});
const STATIC = [
  "https://remotiv.work/",
  "https://remotiv.work/jobs",
  "https://remotiv.work/pricing",
];
const flush = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};

/** hang: the table whose read never answers. Every other table answers. */
function hanging(table) {
  return fakeService((t, calls) => (t === table ? NEVER() : serveFor(t, calls)));
}
function serveFor(table, calls) {
  if (table === "talent_profiles") return serve(TALENT, calls);
  if (table === "hire_remote_profiles") return serve(REMOTE, calls);
  return {
    data: [{ id: "j1", slug: "engineer", created_at: "2026-09-01T00:00:00Z" }],
    error: null,
  };
}

/** Starts sitemap() without awaiting it, so a test can see whether it has settled yet. */
function start(service) {
  globalThis.__fakeServiceClientForTests = () => service;
  const logged = [];
  const errors = console.error;
  console.error = (...a) => logged.push(a.map(String).join(" "));
  const state = { settled: false, entries: undefined };
  const done = sitemap()
    .then((entries) => {
      state.settled = true;
      state.entries = entries;
    })
    .finally(() => {
      console.error = errors;
      delete globalThis.__fakeServiceClientForTests;
    });
  return { state, logged, done };
}

test("#73 a hanging profile read: settles at the 10 s deadline, not before, with static pages and jobs and no profiles", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { state, logged, done } = start(hanging("talent_profiles"));
  await flush();
  t.mock.timers.tick(9_999);
  await flush();
  assert.equal(state.settled, false, "still waiting just before the deadline");
  t.mock.timers.tick(1);
  await flush();
  assert.equal(state.settled, true, "the deadline ended the read: the build is not held");
  await done;
  const urls = state.entries.map((e) => e.url);
  for (const u of STATIC) assert.ok(urls.includes(u), u);
  assert.ok(
    urls.some((u) => u.endsWith("/jobs/engineer")),
    "jobs still ship",
  );
  assert.equal(profileUrls(state.entries).length, 0, "no profiles, not a partial list");
  assert.deepEqual(logged, ["[sitemap] profiles left out: profile reads timed out after 10000 ms"]);
});

test("#73 an error read returns at once (no wait for the deadline), with static pages and jobs", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { state, done } = start(world({ failing: "hire_remote_profiles" }));
  await flush();
  assert.equal(state.settled, true, "settled with no timer advanced");
  await done;
  assert.equal(profileUrls(state.entries).length, 0);
  assert.ok(state.entries.some((e) => e.url.endsWith("/jobs/engineer")));
});

test("#73 a hanging jobs read is cut at the same deadline: static pages and profiles still ship", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { state, logged, done } = start(hanging("jobs"));
  await flush();
  assert.equal(state.settled, false);
  t.mock.timers.tick(10_000);
  await flush();
  assert.equal(state.settled, true);
  await done;
  assert.equal(profileUrls(state.entries).length, TALENT.length + REMOTE.length);
  assert.ok(!state.entries.some((e) => e.url.startsWith("https://remotiv.work/jobs/")));
  assert.deepEqual(logged, ["[sitemap] jobs left out: job reads timed out after 10000 ms"]);
});

test("#73 every read carries the abort signal, so a timed-out request is cancelled, not left running", async () => {
  const service = world();
  await run(service);
  assert.ok(service.queries.length >= 4);
  for (const q of service.queries) {
    const sig = call(q.calls, "abortSignal");
    assert.ok(sig, `${q.table}: no abortSignal`);
    assert.ok(sig[1] instanceof AbortSignal, q.table);
  }
});
