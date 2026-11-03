/**
 * The interview list's answer counts are never cut by the database's per-response
 * row limit (SCALE-LIST item 2): each chunk of a hundred sessions pages through
 * all its answers, so 100 sessions x 15 answers (1,500 rows) count exactly.
 *
 *   node --test src/lib/interviews/answer-stats-paging.test.ts
 *
 * listInterviewSessions and pageAll run as shipped. The database is a fake that
 * answers each read from the range the code asked for and, like Supabase's
 * max-rows, never returns more than 1,000 rows in one response, so a read that
 * does not page is cut exactly as it would be in production. Set
 * ANSWER_TRACE_OUT to write the small cases' results, for a diff against HEAD.
 * Synthetic data only.
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { register } from "node:module";
import { after, mock, test } from "node:test";

register(new URL("../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../test-support/messages-test-hook.mjs", import.meta.url));

const { call, fakeService } = await import("../../test-support/fake-postgrest.mjs");
const { listInterviewSessions } = await import("./review.ts");

const NOW = Date.parse("2026-11-03T12:00:00.000Z");
mock.timers.enable({ apis: ["Date"], now: NOW });
const MAX_ROWS = 1000;
const CO = "c0000000-0000-4000-8000-0000000000f6";
const JOB = "b0000000-0000-4000-8000-0000000000f6";
const ctx = { companyId: CO, role: "owner", memberId: "m-1", user: { id: "u-1" } };
const iso = (ms) => new Date(ms).toISOString();

const sessionId = (i) => `5e550000-0000-4000-8000-${String(i).padStart(12, "0")}`;
function sessions(n, questions) {
  return Array.from({ length: n }, (_, i) => ({
    id: sessionId(i),
    application_id: null,
    job_id: JOB,
    kind: "async",
    status: "submitted",
    started_at: null,
    submitted_at: iso(NOW - 86_400_000),
    expires_at: iso(NOW + 86_400_000),
    delete_after: null,
    invited_by_name: null,
    questions_snapshot: Array.from({ length: questions }, (_, q) => ({ id: `q${q}` })),
    archived_at: null,
    created_at: iso(NOW - i * 1000),
    previous_attempt_id: null,
  }));
}
/** `perSession(i)` answers for session i; `video(i, q)` whether that answer still has a file. */
function answers(n, perSession, video = () => true) {
  const out = [];
  for (let i = 0; i < n; i++) {
    for (let q = 0; q < perSession(i); q++) {
      out.push({
        id: `a${String(i).padStart(4, "0")}-${String(q).padStart(3, "0")}`,
        session_id: sessionId(i),
        video_path: video(i, q) ? `${sessionId(i)}/q${q}.webm` : null,
      });
    }
  }
  return out;
}

/** Sessions and answers from the requested range, never more than MAX_ROWS in one response. */
function install(sessionRows, answerRows) {
  const reads = { answers: 0 };
  globalThis.__messagesServiceForTests = () =>
    fakeService((table, calls) => {
      const r = call(calls, "range");
      const window = (rows) => {
        const [from, to] = r ? [r[1], r[2]] : [0, rows.length - 1];
        return rows.slice(from, Math.min(to, from + MAX_ROWS - 1) + 1);
      };
      if (table === "interview_sessions") return { data: window(sessionRows), error: null };
      if (table === "interview_answers") {
        reads.answers += 1;
        const ids = new Set(call(calls, "in")[2]);
        const hit = answerRows
          .filter((a) => ids.has(a.session_id))
          .sort((a, b) => a.id.localeCompare(b.id));
        return {
          data: window(hit).map((a) => ({ session_id: a.session_id, video_path: a.video_path })),
          error: null,
        };
      }
      return { data: [], error: null };
    });
  return reads;
}

async function everyRow() {
  const out = [];
  for (let page = 1; ; page++) {
    const r = await listInterviewSessions(ctx, { status: "all", page });
    assert.equal(r.ok, true);
    out.push(...r.value.rows);
    if (page * r.value.pageSize >= r.value.total) return out;
  }
}

test("100 sessions x 15 answers (1,500 rows in one chunk): every count exact", async () => {
  install(
    sessions(100, 15),
    answers(100, () => 15),
  );
  const rows = await everyRow();
  assert.equal(rows.length, 100);
  for (const row of rows) {
    assert.deepEqual(
      [row.progress, row.totalQuestions],
      [{ answered: 15, purged: false }, 15],
      row.id,
    );
  }
});

test("130 sessions x 15 answers over two chunks, with uneven counts and purged media: every count exact", async () => {
  const per = (i) => (i % 3 === 0 ? 15 : i % 3 === 1 ? 9 : 0);
  // Session 7's answers have all lost their files (purged); session 8 has some.
  const video = (i, q) => !(i === 7 || (i === 8 && q % 2 === 0));
  const reads = install(sessions(130, 15), answers(130, per, video));
  const rows = await everyRow();
  assert.equal(rows.length, 130);
  for (const row of rows) {
    const i = Number(row.id.slice(-12));
    assert.deepEqual(row.progress, { answered: per(i), purged: i === 7 && per(i) > 0 }, row.id);
  }
  assert.ok(reads.answers >= 2, "two chunks, and the first paged");
});

const traces = {};
after(() => {
  if (process.env.ANSWER_TRACE_OUT) {
    writeFileSync(process.env.ANSWER_TRACE_OUT, `${JSON.stringify(traces, null, 2)}\n`);
  }
});

test("small cases are as before", async () => {
  const cases = {
    "5 x 3": [sessions(5, 3), answers(5, () => 3)],
    "uneven, some none": [
      sessions(7, 4),
      answers(
        7,
        (i) => i % 4,
        (_i, q) => q !== 1,
      ),
    ],
    "no answers at all": [sessions(3, 5), []],
  };
  for (const [name, [s, a]] of Object.entries(cases)) {
    install(s, a);
    const r = await listInterviewSessions(ctx, { status: "all" });
    assert.equal(r.ok, true, name);
    traces[name] = r.value;
  }
});
