/**
 * #20: the interview list reads applicant names for the page it shows, not for
 * every interview the company has ever sent, and a failed name read says so.
 *
 *   node --test src/lib/interviews/list-names-scale.test.ts
 *
 * listInterviewSessions runs as shipped against a fake database holding up to
 * 10,000 sessions, each with its own application. Every job_applications
 * request is counted. Synthetic data only.
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

// The read logs its failures; the assertions are on what the page shows.
console.error = () => {};

const NOW = Date.parse("2026-11-03T12:00:00.000Z");
mock.timers.enable({ apis: ["Date"], now: NOW });
const MAX_ROWS = 1000;
const CO = "c0000000-0000-4000-8000-0000000000a0";
const JOB = "b0000000-0000-4000-8000-0000000000a0";
const ctx = { companyId: CO, role: "owner", memberId: "m-1", user: { id: "u-1" } };
const iso = (ms) => new Date(ms).toISOString();
const pad = (i) => String(i).padStart(12, "0");
const sessionId = (i) => `5e550000-0000-4000-8000-${pad(i)}`;
const appId = (i) => `a0000000-0000-4000-8000-${pad(i)}`;

function world(n, { failNames = false, missing = new Set(), delayMs = 0, flight = null } = {}) {
  const sessions = Array.from({ length: n }, (_, i) => ({
    id: sessionId(i),
    application_id: appId(i),
    job_id: JOB,
    kind: "async",
    status: "submitted",
    started_at: null,
    submitted_at: iso(NOW - 86_400_000),
    expires_at: iso(NOW + 86_400_000),
    delete_after: null,
    invited_by_name: null,
    questions_snapshot: [{ id: "q0" }],
    archived_at: null,
    created_at: iso(NOW - i * 1000),
    previous_attempt_id: null,
  }));
  const withCompany = sessions.map((s) => ({ company_id: CO, ...s }));
  const apps = new Map(
    sessions
      .map((_, i) => i)
      .filter((i) => !missing.has(i))
      .map((i) => [
        appId(i),
        {
          id: appId(i),
          first_name: `First${i}`,
          last_name: `Last${i}`,
          email: `c${i}@example.invalid`,
        },
      ]),
  );
  const nameReads = [];
  globalThis.__messagesServiceForTests = () =>
    fakeService((table, calls) => {
      if (table === "interview_sessions") {
        // Filters, counts and paging applied as PostgREST would (#41 part 2).
        return answerSessions(withCompany, calls, { maxRows: MAX_ROWS });
      }
      if (table === "job_applications") {
        const ids = call(calls, "in")[2];
        nameReads.push(ids.length);
        const answer = failNames
          ? { data: null, error: { message: "timeout", code: "57014" } }
          : { data: ids.map((id) => apps.get(id)).filter(Boolean), error: null };
        if (!delayMs) return answer;
        // Answered after a delay, so requests overlap exactly as far as the
        // code lets them. `flight` records how many are open at once.
        flight.now += 1;
        flight.max = Math.max(flight.max, flight.now);
        return new Promise((resolve) =>
          setTimeout(() => {
            flight.now -= 1;
            resolve(answer);
          }, delayMs),
        );
      }
      return { data: [], error: null };
    });
  return nameReads;
}

const list = (opts) => listInterviewSessions(ctx, { status: "all", ...opts });

// Negative control: read names for every session again (the old shape) and
// the request count becomes 100 at 10,000 sessions instead of 1.
test("no search: one name request per page, whether the company has 100 or 10,000 interviews", async () => {
  for (const n of [100, 10_000]) {
    for (const page of [1, 3]) {
      const reads = world(n);
      const r = await list({ page });
      assert.equal(r.ok, true);
      assert.equal(r.value.total, n);
      assert.equal(r.value.rows.length, 20);
      assert.deepEqual(reads, [20], `${n} sessions, page ${page}`);
      const first = (page - 1) * 20;
      assert.equal(r.value.rows[0].candidateName, `First${first} Last${first}`);
      assert.equal(r.value.rows[19].candidateEmail, `c${first + 19}@example.invalid`);
    }
  }
});

// Negative control: drop the `error` check in fetchApplications and every row
// reads "Applicant deleted", the bug this replaces.
test("a failed name read shows 'Name unavailable', never a blank and never 'Applicant deleted'", async () => {
  world(10_000, { failNames: true });
  const r = await list({ page: 1 });
  assert.equal(r.ok, true, "the rest of the list still stands");
  assert.equal(r.value.rows.length, 20);
  for (const row of r.value.rows) {
    assert.equal(row.candidateName, "Name unavailable");
    assert.equal(row.candidateLink, "unavailable");
    assert.equal(row.candidateEmail, "");
  }
});

test("an application that is really gone still reads 'Applicant deleted'", async () => {
  world(100, { missing: new Set([0]) });
  const r = await list({ page: 1 });
  assert.equal(r.value.rows[0].candidateName, "Applicant deleted");
  assert.equal(r.value.rows[0].candidateLink, "deleted");
  assert.equal(r.value.rows[1].candidateLink, "linked");
});

test("search still matches names across every page (it needs them all)", async () => {
  const reads = world(10_000);
  const r = await list({ query: "first9999 " });
  assert.equal(r.ok, true);
  assert.equal(r.value.total, 1);
  assert.equal(r.value.rows[0].candidateName, "First9999 Last9999");
  assert.equal(reads.length, 100, "100 ids per request, every session");
  assert.ok(
    reads.every((len) => len === 100),
    "no extra page read when the search already has the names",
  );
});

test("search with a failed name read: the list says unavailable, not 'no matches'", async () => {
  world(10_000, { failNames: true });
  const r = await list({ query: "first1" });
  assert.equal(r.ok, false);
});

// Negative controls: the old sequential loop gives max 1; Promise.all over every
// chunk (this item's first version) gives max 100.
test("search reads names in parallel, at most NAME_READ_CONCURRENCY requests at once", async () => {
  const flight = { now: 0, max: 0 };
  const reads = world(10_000, { delayMs: 5, flight });
  const r = await list({ query: "first9999" });
  assert.equal(r.ok, true);
  assert.equal(r.value.rows[0].candidateName, "First9999 Last9999");
  assert.equal(reads.length, 100, "every chunk read once");
  assert.ok(flight.max > 1, `parallel: ${flight.max} in flight at most`);
  assert.ok(flight.max <= 5, `bounded: ${flight.max} in flight at most`);
  assert.equal(flight.now, 0, "nothing left open");
});
