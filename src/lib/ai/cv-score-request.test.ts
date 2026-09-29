/**
 * requestCvScore against a queue that models migration 030's partial unique
 * index, and one that does not.
 *
 *   node --test src/lib/ai/cv-score-request.test.ts
 */
// @ts-nocheck — same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CV_SCORE_JOB_TYPE, requestCvScore } from "./cv-score-request.ts";

function queue(opts: { index: boolean; delay?: number }) {
  const jobs = [];
  const enqueue = async (input) => {
    if (opts.delay) await new Promise((r) => setTimeout(r, opts.delay));
    const applicationId = input.payload?.applicationId;
    if (opts.index) {
      const live = jobs.some(
        (j) =>
          j.type === input.type &&
          ["queued", "running"].includes(j.status) &&
          j.payload.applicationId === applicationId,
      );
      if (live) {
        return {
          ok: false,
          error:
            'duplicate key value violates unique constraint "background_jobs_ai_cv_score_live_uniq"',
          code: "23505",
        };
      }
    }
    const id = `j${jobs.length}`;
    jobs.push({ id, type: input.type, status: "queued", payload: { applicationId } });
    return { ok: true, id };
  };
  return { jobs, enqueue, live: () => jobs.filter((j) => j.status === "queued").length };
}

test("first request queues; the job type and payload key match the index", async () => {
  const q = queue({ index: true });
  const r = await requestCvScore("app-1", "co-1", { enqueue: q.enqueue });
  assert.deepEqual(r, { ok: true, outcome: "queued" });
  assert.deepEqual(q.jobs[0], {
    id: "j0",
    type: CV_SCORE_JOB_TYPE,
    status: "queued",
    payload: { applicationId: "app-1" },
  });
});

test("two requests at once: with the index exactly one job, the loser is told already_queued", async () => {
  const q = queue({ index: true, delay: 5 });
  const [a, b] = await Promise.all([
    requestCvScore("app-1", "co-1", { enqueue: q.enqueue }),
    requestCvScore("app-1", "co-1", { enqueue: q.enqueue }),
  ]);
  assert.equal(q.live(), 1);
  assert.deepEqual([a, b].map((r) => r.outcome).sort(), ["already_queued", "queued"]);
});

test("the same overlap WITHOUT the index queues twice - why 030 runs before deploy", async () => {
  const q = queue({ index: false, delay: 5 });
  await Promise.all([
    requestCvScore("app-1", "co-1", { enqueue: q.enqueue }),
    requestCvScore("app-1", "co-1", { enqueue: q.enqueue }),
  ]);
  assert.equal(q.live(), 2);
});

test("different applications never collide", async () => {
  const q = queue({ index: true });
  await requestCvScore("app-1", "co-1", { enqueue: q.enqueue });
  await requestCvScore("app-2", "co-1", { enqueue: q.enqueue });
  assert.equal(q.live(), 2);
});

test("after the first job finishes, a deliberate re-score queues again", async () => {
  const q = queue({ index: true });
  await requestCvScore("app-1", "co-1", { enqueue: q.enqueue });
  q.jobs[0].status = "succeeded";
  const r = await requestCvScore("app-1", "co-1", { enqueue: q.enqueue });
  assert.deepEqual(r, { ok: true, outcome: "queued" });
  assert.equal(q.live(), 1);
});

test("any other enqueue failure is reported as a failure", async () => {
  const r = await requestCvScore("app-1", "co-1", {
    enqueue: async () => ({ ok: false, error: "connection refused", code: "08006" }),
  });
  assert.deepEqual(r, { ok: false, error: "connection refused" });
});
