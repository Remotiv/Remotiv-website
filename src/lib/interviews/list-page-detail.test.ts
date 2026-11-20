/**
 * #20 part 2: the interview list reads answer counts and scores for the 20
 * visible rows only, after filtering and paging, and a failed score read says
 * "Score unavailable" instead of passing for "Not scored".
 *
 *   node --test src/lib/interviews/list-page-detail.test.ts
 *
 * listInterviewSessions and loadInterviewSession run as shipped against a fake
 * database of up to 10,000 sessions. Every interview_answers and
 * interview_session_scores request is recorded with the ids it asked for.
 * Synthetic data only.
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { mock, test } from "node:test";

register(new URL("../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../test-support/messages-test-hook.mjs", import.meta.url));

const { call, fakeService } = await import("../../test-support/fake-postgrest.mjs");
const { answerSessions } = await import("../../test-support/interview-list-fake.mjs");
const { listInterviewSessions, loadInterviewSession } = await import("./review.ts");

// The reads log their failures; the assertions are on what the page shows.
console.error = () => {};

const NOW = Date.parse("2026-11-03T12:00:00.000Z");
mock.timers.enable({ apis: ["Date"], now: NOW });
const MAX_ROWS = 1000;
const DAY = 86_400_000;
const CO = "c0000000-0000-4000-8000-0000000000b0";
const JOB = "b0000000-0000-4000-8000-0000000000b0";
const ctx = { companyId: CO, role: "owner", memberId: "m-1", user: { id: "u-1" } };
const iso = (ms) => new Date(ms).toISOString();
const pad = (i) => String(i).padStart(12, "0");
const sessionId = (i) => `5e550000-0000-4000-8000-${pad(i)}`;
const appId = (i) => `a0000000-0000-4000-8000-${pad(i)}`;

/**
 * n sessions, newest first. Every third is "started" (not submitted), so the
 * status tabs have something to tell apart. `purged(i)`: answers recorded but
 * their files gone. `expiredWords(i)`: past delete_after. `noSnapshot(i)`:
 * no questions_snapshot, so the total comes from the answer read.
 */
function world(
  n,
  {
    failScores = false,
    failAnswers = false,
    purged = () => false,
    expiredWords = () => false,
    noSnapshot = () => false,
    missingApp = () => false,
  } = {},
) {
  const sessions = Array.from({ length: n }, (_, i) => ({
    id: sessionId(i),
    application_id: appId(i),
    job_id: JOB,
    kind: "async",
    status: i % 3 === 2 ? "started" : "submitted",
    started_at: iso(NOW - 2 * DAY),
    submitted_at: i % 3 === 2 ? null : iso(NOW - DAY),
    expires_at: iso(NOW + DAY),
    delete_after: expiredWords(i) ? iso(NOW - DAY) : iso(NOW + 100 * DAY),
    invited_by_name: null,
    questions_snapshot: noSnapshot(i) ? null : [{ id: "q0" }, { id: "q1" }, { id: "q2" }],
    archived_at: null,
    created_at: iso(NOW - i * 1000),
    previous_attempt_id: null,
  }));
  const withCompany = sessions.map((s) => ({ company_id: CO, ...s }));
  // The search's embed reads these (#41 follow-up); the name read below, the page's.
  const applications = sessions
    .map((_, i) => i)
    .filter((i) => !missingApp(i))
    .map((i) => ({
      id: appId(i),
      company_id_snapshot: CO,
      first_name: `First${i}`,
      last_name: `Last${i}`,
      email: `c${i}@example.invalid`,
    }));
  const index = new Map(sessions.map((s, i) => [s.id, i]));
  const reads = { answers: [], scores: [] };
  globalThis.__messagesServiceForTests = () =>
    fakeService((table, calls) => {
      if (table === "interview_sessions") {
        // Filters, counts and paging applied as PostgREST would (#41 part 2).
        return answerSessions(withCompany, calls, {
          maxRows: MAX_ROWS,
          related: { job_applications: applications },
        });
      }
      if (table === "job_applications") {
        const ids = call(calls, "in")[2];
        return {
          data: ids
            .filter((id) => !missingApp(Number(id.slice(-12))))
            .map((id) => {
              const i = Number(id.slice(-12));
              return {
                id,
                first_name: `First${i}`,
                last_name: `Last${i}`,
                email: `c${i}@example.invalid`,
              };
            }),
          error: null,
        };
      }
      if (table === "interview_answers") {
        const ids = call(calls, "in")[2];
        reads.answers.push(ids);
        if (failAnswers) return { data: null, error: { message: "timeout", code: "57014" } };
        // Two answers per session; a purged session's answers hold no file.
        const rows = ids.flatMap((id) =>
          [0, 1].map((q) => ({
            session_id: id,
            video_path: purged(index.get(id)) ? null : `${id}/q${q}.webm`,
          })),
        );
        const r = call(calls, "range");
        const [from, to] = r ? [r[1], r[2]] : [0, rows.length - 1];
        return { data: rows.slice(from, Math.min(to, from + MAX_ROWS - 1) + 1), error: null };
      }
      if (table === "interview_session_scores") {
        const ids = call(calls, "in")[2];
        reads.scores.push({ ids, company: calls.find((c) => c[0] === "eq")?.slice(1) });
        if (failScores) return { data: null, error: { message: "timeout", code: "57014" } };
        return {
          data: ids
            .filter((id) => index.get(id) % 2 === 0)
            .map((id) => ({
              session_id: id,
              status: "scored",
              overall_score: 60 + (index.get(id) % 30),
              human_adjusted_score: null,
              human_feedback: null,
              adjusted_by_name: null,
              adjusted_at: null,
              verdict: "Solid",
              summary: "A synthetic summary.",
              confidence: "high",
              criteria: [],
              error: null,
              scored_at: iso(NOW - DAY),
            })),
          error: null,
        };
      }
      return { data: [], error: null };
    });
  return { sessions, reads };
}

const list = (opts) => listInterviewSessions(ctx, { status: "all", ...opts });

// Negative control: read answers and scores for every session again (before
// this change) and the request count becomes 100 + 100 at 10,000 sessions.
test("answer and score reads: one each per page, for exactly the visible rows, at 100 or 10,000 sessions", async () => {
  for (const n of [100, 10_000]) {
    for (const page of [1, 3]) {
      const { reads } = world(n);
      const r = await list({ page });
      assert.equal(r.ok, true);
      assert.equal(r.value.total, n);
      const shown = r.value.rows.map((row) => row.id);
      assert.equal(shown.length, 20);
      assert.equal(reads.answers.length, 1, `${n} sessions, page ${page}: answer requests`);
      assert.equal(reads.scores.length, 1, `${n} sessions, page ${page}: score requests`);
      assert.deepEqual(reads.answers[0], shown);
      assert.deepEqual(reads.scores[0].ids, shown);
    }
  }
});

test("the visible rows carry their counts, totals and scores", async () => {
  world(10_000);
  const r = await list({ page: 2 });
  for (const row of r.value.rows) {
    const i = Number(row.id.slice(-12));
    assert.deepEqual(row.progress, { answered: 2, purged: false }, row.id);
    assert.equal(row.totalQuestions, 3, "from the snapshot");
    assert.equal(row.scoreUnavailable, false);
    if (i % 2 === 0) assert.equal(row.score?.overall, 60 + (i % 30));
    else assert.equal(row.score, null, "really not scored");
  }
});

test("tabs, counts and search are computed over every session, not the page", async () => {
  world(10_000);
  const all = await list({ page: 1 });
  const started = Math.floor((10_000 - 3) / 3) + 1;
  assert.equal(all.value.counts.all, 10_000);
  assert.equal(all.value.counts.started, started);
  assert.equal(all.value.counts.submitted, 10_000 - started);

  const { reads } = world(10_000);
  const tab = await list({ status: "started", page: 4 });
  assert.equal(tab.value.total, started);
  assert.ok(tab.value.rows.every((row) => row.status === "started"));
  assert.deepEqual(
    reads.scores[0].ids,
    tab.value.rows.map((row) => row.id),
  );
  assert.equal(tab.value.counts.all, 10_000, "counts do not move with the tab");

  const found = world(10_000);
  const hit = await list({ query: "first9998" });
  assert.equal(hit.value.total, 1);
  assert.equal(hit.value.rows[0].candidateName, "First9998 Last9998");
  assert.equal(hit.value.rows[0].score?.overall, 60 + (9998 % 30));
  assert.deepEqual(found.reads.answers, [[sessionId(9998)]]);
  assert.deepEqual(
    found.reads.scores.map((s) => s.ids),
    [[sessionId(9998)]],
  );
});

// Negative control: drop the `error` check in fetchSessionScores and every row
// shows "Not scored" again.
test("a failed score read: every visible row says unavailable, and the rest of the list stands", async () => {
  world(10_000, { failScores: true });
  const r = await list({ page: 1 });
  assert.equal(r.ok, true);
  assert.equal(r.value.counts.all, 10_000);
  for (const row of r.value.rows) {
    assert.equal(row.scoreUnavailable, true, row.id);
    assert.equal(row.score, null);
    assert.deepEqual(row.progress, { answered: 2, purged: false }, "answers still read");
  }
});

test("a failed answer read: progress unknown for every row; totals still come from snapshots", async () => {
  world(100, { failAnswers: true, noSnapshot: (i) => i === 1 });
  const r = await list({ page: 1 });
  assert.equal(r.ok, true);
  for (const row of r.value.rows) {
    assert.equal(row.progress, null, row.id);
    assert.equal(row.scoreUnavailable, false, "scores still read");
  }
  assert.equal(r.value.rows[0].totalQuestions, 3);
  assert.equal(r.value.rows[1].totalQuestions, null, "no snapshot and no answer read: unknown");
});

test("purged, past-retention and deleted-applicant rows keep their labels", async () => {
  world(100, {
    purged: (i) => i === 0,
    expiredWords: (i) => i === 2,
    noSnapshot: (i) => i === 4,
    missingApp: (i) => i === 6,
  });
  const r = await list({ page: 1 });
  const row = (i) => r.value.rows.find((x) => x.id === sessionId(i));
  assert.deepEqual(row(0).progress, { answered: 2, purged: true }, "Recording purged");
  assert.deepEqual(row(1).progress, { answered: 2, purged: false });
  assert.equal(row(2).score?.overall, 62, "the number stays");
  assert.equal(row(2).score?.summary, null, "past delete_after: the words are not sent");
  assert.equal(row(0).score?.summary, "A synthetic summary.");
  assert.equal(row(4).totalQuestions, 2, "no snapshot: the answer read is the denominator");
  assert.equal(row(6).candidateName, "Applicant deleted");
  assert.equal(row(6).score?.overall, 66, "a deleted applicant's interview keeps its score");
});

test("score reads stay inside the company", async () => {
  const { reads } = world(10_000);
  await list({ page: 7 });
  assert.deepEqual(reads.scores[0].company, ["company_id", CO]);
});

// Negative control: read the score with the old `const { data }` and a failed
// read comes back as "no score", which offers "Score interview".
test("the review page: a failed score read is an error, never 'not scored'", async () => {
  const s = sessionId(0);
  globalThis.__messagesServiceForTests = () =>
    fakeService((table) => {
      if (table === "interview_sessions") {
        return {
          data: {
            id: s,
            application_id: null,
            job_id: JOB,
            kind: "async",
            status: "submitted",
            started_at: iso(NOW - 2 * DAY),
            submitted_at: iso(NOW - DAY),
            expires_at: null,
            delete_after: iso(NOW + 100 * DAY),
            invited_by_name: null,
            questions_snapshot: [],
            scoring_snapshot: null,
            archived_at: null,
            created_at: iso(NOW - 3 * DAY),
          },
          error: null,
        };
      }
      if (table === "interview_answers") return { data: [], count: 0, error: null };
      if (table === "interview_session_scores") {
        return { data: null, error: { message: "timeout", code: "57014" } };
      }
      return { data: [], error: null };
    });
  await assert.rejects(loadInterviewSession(ctx, s), /session score read failed/);
});

test("the list renders 'Score unavailable' from scoreUnavailable", () => {
  const src = readFileSync(
    new URL("../../app/ai-dashboard/(gated)/interviews/_interviews-client.tsx", import.meta.url),
    "utf8",
  );
  assert.match(src, /<ScorePill score=\{row\.score\} unavailable=\{row\.scoreUnavailable\} \/>/);
  assert.match(src, /if \(unavailable\) \{\s*return \(\s*<span[^>]*>Score unavailable<\/span>/);
});
