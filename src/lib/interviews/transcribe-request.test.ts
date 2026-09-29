/**
 * requestTranscription against a queue that models migration 032's compound
 * partial unique index, plus the superseded-job cancel.
 *
 *   node --test src/lib/interviews/transcribe-request.test.ts
 */
// @ts-nocheck — same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cancelSupersededTranscribeJobs,
  requestTranscription,
  TRANSCRIBE_JOB_TYPE,
} from "./transcribe-request.ts";

const G1 = "2026-09-30T10:00:00.123+00:00";
const G2 = "2026-09-30T10:04:30.5+00:00";

function queue(opts = { index: true, delay: 0 }) {
  const jobs = [];
  const enqueue = async (input) => {
    if (opts.delay) await new Promise((r) => setTimeout(r, opts.delay));
    const { answerId, recordedAt } = input.payload ?? {};
    if (opts.index) {
      const live = jobs.some(
        (j) =>
          j.type === input.type &&
          ["queued", "running"].includes(j.status) &&
          j.payload.answerId === answerId &&
          j.payload.recordedAt === recordedAt,
      );
      if (live) {
        return {
          ok: false,
          error:
            'duplicate key value violates unique constraint "background_jobs_transcribe_live_uniq"',
          code: "23505",
        };
      }
    }
    const id = `j${jobs.length}`;
    jobs.push({
      id,
      type: input.type,
      status: "queued",
      payload: { answerId, recordedAt },
      last_error: null,
    });
    return { ok: true, id };
  };
  return {
    jobs,
    enqueue,
    live: () => jobs.filter((j) => j.status === "queued" || j.status === "running"),
  };
}

test("first request queues with both generation fields in the payload", async () => {
  const q = queue();
  const r = await requestTranscription(
    { answerId: "a1", recordedAt: G1, companyId: "co" },
    { enqueue: q.enqueue },
  );
  assert.deepEqual(r, { ok: true, outcome: "queued" });
  assert.deepEqual(q.jobs[0].payload, { answerId: "a1", recordedAt: G1 });
  assert.equal(q.jobs[0].type, TRANSCRIBE_JOB_TYPE);
});

test("a payload without a generation is refused before any insert", async () => {
  const q = queue();
  const r = await requestTranscription(
    { answerId: "a1", recordedAt: "", companyId: "co" },
    { enqueue: q.enqueue },
  );
  assert.equal(r.ok, false);
  assert.match(r.error, /recordedAt missing/);
  assert.equal(q.jobs.length, 0);
});

test("concurrent requests for the same answer AND generation collapse to one job", async () => {
  const q = queue({ index: true, delay: 5 });
  const [a, b] = await Promise.all([
    requestTranscription(
      { answerId: "a1", recordedAt: G1, companyId: "co" },
      { enqueue: q.enqueue },
    ),
    requestTranscription(
      { answerId: "a1", recordedAt: G1, companyId: "co" },
      { enqueue: q.enqueue },
    ),
  ]);
  assert.equal(q.live().length, 1);
  assert.deepEqual([a.outcome, b.outcome].sort(), ["already_queued", "queued"]);
});

test("a NEWER generation of the same answer is never blocked by the older job", async () => {
  const q = queue();
  await requestTranscription(
    { answerId: "a1", recordedAt: G1, companyId: "co" },
    { enqueue: q.enqueue },
  );
  const r = await requestTranscription(
    { answerId: "a1", recordedAt: G2, companyId: "co" },
    { enqueue: q.enqueue },
  );
  assert.deepEqual(r, { ok: true, outcome: "queued" });
  assert.equal(q.live().length, 2);
});

test("a deliberate re-record after the previous job completed or died enqueues normally", async () => {
  const q = queue();
  await requestTranscription(
    { answerId: "a1", recordedAt: G1, companyId: "co" },
    { enqueue: q.enqueue },
  );
  q.jobs[0].status = "succeeded";
  const again = await requestTranscription(
    { answerId: "a1", recordedAt: G1, companyId: "co" },
    { enqueue: q.enqueue },
  );
  assert.equal(again.outcome, "queued");
  q.jobs[1].status = "dead";
  const third = await requestTranscription(
    { answerId: "a1", recordedAt: G2, companyId: "co" },
    { enqueue: q.enqueue },
  );
  assert.equal(third.outcome, "queued");
});

test("other enqueue failures are reported as failures", async () => {
  const r = await requestTranscription(
    { answerId: "a1", recordedAt: G1, companyId: "co" },
    { enqueue: async () => ({ ok: false, error: "connection refused", code: "08006" }) },
  );
  assert.deepEqual(r, { ok: false, error: "connection refused" });
});

test("cancel retires only QUEUED jobs of OLDER generations, never running ones or the current generation", async () => {
  const rows = [
    {
      id: "old-queued",
      type: "transcribe",
      status: "queued",
      payload: { answerId: "a1", recordedAt: G1 },
    },
    {
      id: "old-running",
      type: "transcribe",
      status: "running",
      payload: { answerId: "a1", recordedAt: G1 },
    },
    {
      id: "current",
      type: "transcribe",
      status: "queued",
      payload: { answerId: "a1", recordedAt: G2 },
    },
    {
      id: "other-answer",
      type: "transcribe",
      status: "queued",
      payload: { answerId: "a2", recordedAt: G1 },
    },
    { id: "other-type", type: "ai_scorecard", status: "queued", payload: { sessionId: "s" } },
  ];
  // A fake that applies the same filters PostgREST would.
  const service = {
    from: () => ({
      update: (patch) => {
        const filters = [];
        const chain = {
          eq: (col, v) => {
            filters.push([col, "eq", v]);
            return chain;
          },
          neq: (col, v) => {
            filters.push([col, "neq", v]);
            return chain;
          },
          select: async () => {
            const read = (row, col) =>
              col.startsWith("payload->>") ? row.payload[col.slice(10)] : row[col];
            const hit = rows.filter((row) =>
              filters.every(([col, op, v]) =>
                op === "eq" ? read(row, col) === v : read(row, col) !== v,
              ),
            );
            for (const row of hit) Object.assign(row, patch);
            return { data: hit.map((r) => ({ id: r.id })), error: null };
          },
        };
        return chain;
      },
    }),
  };
  const n = await cancelSupersededTranscribeJobs(service, "a1", G2);
  assert.equal(n, 1);
  assert.equal(rows[0].status, "succeeded");
  assert.match(rows[0].last_error, /^superseded: answer re-recorded at /);
  assert.equal(rows[1].status, "running");
  assert.equal(rows[2].status, "queued");
  assert.equal(rows[3].status, "queued");
  assert.equal(rows[4].status, "queued");
});
