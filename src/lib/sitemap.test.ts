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
  assert.ok(logged.some((l) => l.includes("[sitemap] failed to fetch profile entries")));
});
