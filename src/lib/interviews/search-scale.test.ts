/**
 * #41 follow-up: a multi-word Interviews search at 10,000 sessions. Thousands
 * of rows hold the longest word, few hold the whole query; the totals and the
 * pages must be exact, and no read may grow with the company.
 *
 *   node --test src/lib/interviews/search-scale.test.ts
 *
 * listInterviewSessions runs as shipped against the fake database that
 * applies every filter it sends, the search's embeds included
 * (interview-list-fake.mjs). Every interview_sessions and job_applications
 * request is recorded with its size. Synthetic data only.
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { register } from "node:module";
import { mock, test } from "node:test";

register(new URL("../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../test-support/messages-test-hook.mjs", import.meta.url));

const { call, fakeService } = await import("../../test-support/fake-postgrest.mjs");
const { answerSessions } = await import("../../test-support/interview-list-fake.mjs");
const { listInterviewSessions } = await import("./review.ts");

console.error = () => {};
const NOW = Date.parse("2026-11-03T12:00:00.000Z");
mock.timers.enable({ apis: ["Date"], now: NOW });
const N = 10_000;
const CO = "c0000000-0000-4000-8000-0000000000a9";
const JOB = "b0000000-0000-4000-8000-0000000000a9";
const ctx = { companyId: CO, role: "owner", memberId: "m-1", user: { id: "u-1" } };
const iso = (ms) => new Date(ms).toISOString();
const pad = (i) => String(i).padStart(12, "0");
const appId = (i) => `a0000000-0000-4000-8000-${pad(i)}`;

/** Session i: "First<i> Johnson" for even i, "First<i> Smith" for odd, c<i>@example.invalid. */
const last = (i) => (i % 2 === 0 ? "Johnson" : "Smith");
const SESSIONS = Array.from({ length: N }, (_, i) => ({
  id: `5e550000-0000-4000-8000-${pad(i)}`,
  company_id: CO,
  application_id: appId(i),
  job_id: JOB,
  kind: "async",
  status: "submitted",
  started_at: null,
  submitted_at: null,
  expires_at: iso(NOW + 86_400_000),
  delete_after: iso(NOW + 100 * 86_400_000),
  invited_by_name: null,
  questions_snapshot: [{ id: "q0" }],
  archived_at: null,
  created_at: iso(NOW - i * 1000),
  previous_attempt_id: null,
}));
const APPS = SESSIONS.map((_, i) => ({
  id: appId(i),
  company_id_snapshot: CO,
  first_name: `First${i}`,
  last_name: last(i),
  email: `c${i}@example.invalid`,
}));
const JOBS = [{ id: JOB, company_id: CO, title: "Engineer" }];
const appById = new Map(APPS.map((a) => [a.id, a]));

const reads = { sessions: [], names: [] };
globalThis.__messagesServiceForTests = () =>
  fakeService((table, calls) => {
    if (table === "interview_sessions") {
      const out = answerSessions(SESSIONS, calls, {
        related: { job_applications: APPS, jobs: JOBS },
      });
      reads.sessions.push(Array.isArray(out.data) ? out.data.length : 0);
      return out;
    }
    if (table === "job_applications") {
      const ids = call(calls, "in")?.[2] ?? [];
      reads.names.push(ids.length);
      return { data: ids.map((id) => appById.get(id)).filter(Boolean), error: null };
    }
    if (table === "jobs") {
      const ids = call(calls, "in")?.[2] ?? [];
      return { data: JOBS.filter((j) => ids.includes(j.id)), error: null };
    }
    if (table === "interview_answers") return { data: [], count: 0, error: null };
    if (call(calls, "maybeSingle")) return { data: null, error: null };
    return { data: [], error: null };
  });

/** What the list has always matched: the query inside "name email title", newest first. */
const expected = (query) => {
  const q = query.trim().toLowerCase();
  return SESSIONS.map((s, i) => ({ s, i }))
    .filter(({ i }) =>
      `First${i} ${last(i)} c${i}@example.invalid Engineer`.toLowerCase().includes(q),
    )
    .map(({ s }) => s.id);
};
const holding = (word) =>
  SESSIONS.filter((_, i) =>
    `First${i} ${last(i)} c${i}@example.invalid Engineer`.toLowerCase().includes(word),
  ).length;

/** Every page of a search, with the reads each made. */
async function allPages(query) {
  const ids = [];
  const perPage = [];
  let total = null;
  for (let page = 1; page < 100; page += 1) {
    reads.sessions.length = 0;
    reads.names.length = 0;
    const r = await listInterviewSessions(ctx, { status: "all", query, page });
    assert.equal(r.ok, true, `${query} p${page}`);
    total ??= r.value.total;
    assert.equal(r.value.total, total, "the total does not move with the page");
    assert.equal(r.value.counts.all, N, "the counts are the whole list's");
    ids.push(...r.value.rows.map((x) => x.id));
    perPage.push({ sessions: [...reads.sessions], names: [...reads.names] });
    if (page * 20 >= total) break;
  }
  return { ids, total, perPage };
}

test("M1. thousands hold the longest word, hundreds the query (555): exact total, every page, in order", async () => {
  assert.equal(holding("johnson"), 5_000, "the narrowing word alone matches half the company");
  const want = expected("johnson c1");
  assert.equal(want.length, 555, "even i starting with 1: 5 + 50 + 500");
  const got = await allPages("johnson c1");
  assert.equal(got.total, want.length);
  assert.deepEqual(got.ids, want, "every page, in order, nothing twice, nothing missing");
  assert.equal(new Set(got.ids).size, got.ids.length);
});

test("M2. reads are bounded by the rows holding BOTH words, never by the company", async () => {
  const { perPage, total } = await allPages("johnson c1");
  for (const [p, r] of perPage.entries()) {
    // No session read returns more than the rows holding both words (555),
    // and none comes near the 5,000 holding the longest word alone.
    assert.ok(Math.max(...r.sessions) <= total, `page ${p + 1}: ${Math.max(...r.sessions)} rows`);
    // The candidates' names (555, a hundred per request) and the page's: 7 at most.
    assert.ok(r.names.length <= 7, `page ${p + 1}: ${r.names.length} name requests`);
    assert.ok(Math.max(...r.names) <= 100);
  }
});

test("M3. candidates the exact test drops: few match, none in the wrong order", async () => {
  // Both words held by 56 rows (even i starting with 12); as one run, by one.
  const one = await allPages("first12 johnson");
  assert.deepEqual(one.ids, expected("first12 johnson"));
  assert.equal(one.total, 1);
  const none = await allPages("c12 johnson");
  assert.equal(none.total, 0, "both words present, never in this order");
  assert.deepEqual(none.ids, []);
});

test("M4. a page past the end: no rows, the true total", async () => {
  const r = await listInterviewSessions(ctx, { status: "all", query: "johnson c1", page: 40 });
  assert.equal(r.ok, true);
  assert.equal(r.value.total, 555);
  assert.deepEqual(r.value.rows, []);
});

test("M5. one word at 10,000: decided in SQL, one page read, one name read", async () => {
  reads.sessions.length = 0;
  reads.names.length = 0;
  const r = await listInterviewSessions(ctx, { status: "all", query: "johnson", page: 7 });
  assert.equal(r.value.total, 5_000);
  assert.deepEqual(
    r.value.rows.map((x) => x.id),
    expected("johnson").slice(120, 140),
  );
  assert.ok(Math.max(...reads.sessions) <= 20);
  assert.deepEqual(reads.names, [20]);
});
