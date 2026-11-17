/**
 * Weekly report, #31: a failed score read makes Top matches say unavailable,
 * instead of ranking whatever scores did arrive as if they were the week.
 *
 *   node --test "src/app/ai-dashboard/(gated)/weekly-report/top-matches.test.ts"
 *
 * Drives the real fetchWeekReport. Only the session (applicants-test-hook) and
 * the database are fakes; the database applies eq, in, is(null), gte, lt, the
 * order terms and range, so pageAll drains it as it would PostgREST.
 */
// @ts-nocheck - same reason as overview-counts.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../../../test-support/applicants-test-hook.mjs", import.meta.url));

const { fakeService } = await import("../../../../test-support/fake-postgrest.mjs");
const { fetchWeekReport } = await import("./actions.ts");

const CO = "c0000000-0000-4000-8000-000000000001";
const JOB = "j0000001-0000-4000-8000-000000000000";
const DAY = 86_400_000;
const pad = (n) => String(n).padStart(5, "0");

/** The last complete Monday-to-Monday week, the one fetchWeekReport(0) reports. */
function lastWeek() {
  const now = new Date();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const monday = today - ((new Date(today).getUTCDay() + 6) % 7) * DAY;
  return { start: monday - 7 * DAY, end: monday };
}

function filterOf([method, col, a]) {
  if (method === "eq") return (r) => r[col] === a;
  if (method === "in") {
    const set = new Set(a);
    return (r) => set.has(r[col]);
  }
  if (method === "is" && a === null) return (r) => r[col] === null || r[col] === undefined;
  if (method === "gte") return (r) => r[col] !== null && String(r[col]) >= String(a);
  if (method === "lt") return (r) => r[col] !== null && String(r[col]) < String(a);
  return null;
}

function answer(rows, calls) {
  const filters = calls.map(filterOf).filter(Boolean);
  let out = rows.filter((r) => filters.every((f) => f(r)));
  const orders = calls.filter((c) => c[0] === "order");
  if (orders.length) {
    out = [...out].sort((x, y) => {
      for (const [, col, opts] of orders) {
        const asc = opts?.ascending !== false;
        const a = String(x[col] ?? "");
        const b = String(y[col] ?? "");
        if (a !== b) return (a < b ? -1 : 1) * (asc ? 1 : -1);
      }
      return 0;
    });
  }
  const range = calls.find((c) => c[0] === "range");
  const limit = calls.find((c) => c[0] === "limit");
  const from = range ? range[1] : 0;
  const to = range ? range[2] : Math.min((limit?.[1] ?? 1000) - 1, 999);
  return { data: out.slice(from, to + 1), count: null, error: null };
}

/** 450 applicants last week, every one scored: three score chunks of 200. */
function seed() {
  const { start } = lastWeek();
  const apps = Array.from({ length: 450 }, (_, i) => ({
    id: `a${pad(i)}-0000-4000-8000-000000000000`,
    company_id_snapshot: CO,
    job_id: JOB,
    first_name: "Cand",
    last_name: String(i),
    job_title_snapshot: null,
    jobs: { title: "Engineer" },
    pipeline_stage: "applied",
    created_at: new Date(start + DAY + i * 1000).toISOString(),
  }));
  const scores = apps.map((a, i) => ({
    application_id: a.id,
    overall_score: 50 + (i % 40),
    human_adjusted_score: null,
  }));
  return { job_applications: apps, application_scores: scores };
}

/** `failScoreChunk` is the 1-based score request that answers with an error. */
async function report({ failScoreChunk = null } = {}) {
  const tables = seed();
  let scoreRequests = 0;
  const service = fakeService((table, calls) => {
    if (table === "application_scores") {
      scoreRequests += 1;
      if (scoreRequests === failScoreChunk) return { data: null, error: { code: "57014" } };
    }
    return answer(tables[table] ?? [], calls);
  });
  globalThis.__applicantsServiceForTests = () => service;
  globalThis.__applicantsCtxForTests = {
    companyId: CO,
    memberId: "m-1",
    role: "owner",
    memberName: "Owner",
    company: { id: CO, name: "Acme" },
  };
  const quiet = console.error;
  console.error = () => {};
  try {
    return await fetchWeekReport(0);
  } finally {
    console.error = quiet;
  }
}

test("every score chunk read: the card ranks the whole week", async () => {
  const week = await report();
  assert.equal(week.applied, 450);
  assert.equal(week.topUnavailable, false);
  assert.equal(week.topTotal, 450, "every applicant's score was counted");
  assert.equal(week.top.length, 4);
  assert.ok(
    week.top.every((m) => m.score === 89),
    "the four highest of the whole week",
  );
});

// Negative control: ignore the chunk's error and topTotal comes back 250, ranked as the week.
test("a failed score chunk makes Top matches unavailable, never a partial ranking", async () => {
  for (const n of [1, 2, 3]) {
    const week = await report({ failScoreChunk: n });
    assert.equal(week.topUnavailable, true, `chunk ${n} failed and the card still ranked`);
    assert.deepEqual(week.top, []);
    assert.equal(week.topTotal, 0);
    assert.equal(week.applied, 450, "the rest of the report is unaffected");
  }
});

// Negative control: drop the unavailable branch and the empty state ("Nobody applied") shows.
test("the card renders the unavailable state before the empty one, and the copy has no em dash", () => {
  const client = readFileSync(new URL("./_weekly-client.tsx", import.meta.url), "utf8");
  const unavailable = client.indexOf("{week.topUnavailable ? (");
  const empty = client.indexOf("Nobody applied this week");
  assert.ok(unavailable > 0, "the card checks topUnavailable");
  assert.ok(unavailable < empty, "and before it can say nobody applied");
  const branch = client.slice(unavailable, empty);
  assert.match(branch, /Top matches are unavailable/);
  assert.match(branch, /We couldn't load this week's scores\. Try again in a moment\./);
  assert.ok(!/—/.test(branch), "no em dash in the new copy");
  assert.match(client, /week\.topUnavailable\s*\?\s*"Scores unavailable for this period"/);
});
