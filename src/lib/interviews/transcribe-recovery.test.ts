/**
 * The recovery state machine for answers stuck `pending` (Phase 5, P3).
 *
 *   node --test src/lib/interviews/transcribe-recovery.test.ts
 */
// @ts-nocheck — same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../test-support/node-resolve.mjs", import.meta.url));
const { decideRecovery, RECOVERY_AGE_MS, RECOVERY_BATCH, runTranscribeRecovery } = await import(
  "./transcribe-recovery.ts"
);

const G1 = "2026-09-30T10:00:00.123+00:00";
const G2 = "2026-09-30T10:04:30.5+00:00";

test("decision: no job → enqueue; live → leave; dead → leave; succeeded-yet-pending → anomaly", () => {
  assert.equal(decideRecovery([]), "enqueue");
  assert.equal(decideRecovery([{ status: "queued" }]), "live");
  assert.equal(decideRecovery([{ status: "running" }]), "live");
  assert.equal(decideRecovery([{ status: "dead" }]), "dead");
  assert.equal(
    decideRecovery([{ status: "dead" }, { status: "queued" }]),
    "live",
    "a live retry outranks an old death",
  );
  assert.equal(decideRecovery([{ status: "succeeded" }]), "anomaly");
});

test("threshold and batch are the designed values", () => {
  assert.equal(RECOVERY_AGE_MS, 10 * 60_000);
  assert.equal(RECOVERY_BATCH, 20);
});

/**
 * A fake service: `answers` are interview_answers rows (with the session
 * embed), `jobs` are background_jobs rows. The job lookup applies the same
 * payload filters the real query does, so only jobs for the CURRENT
 * generation are ever seen.
 */
function service({ answers, jobs }) {
  const filterable = (rows, read) => {
    const filters = [];
    const chain = {
      eq: (c, v) => {
        filters.push((r) => read(r, c) === v);
        return chain;
      },
      lt: (c, v) => {
        filters.push((r) => read(r, c) !== null && read(r, c) < v);
        return chain;
      },
      not: (c, op, v) => {
        filters.push((r) => (op === "is" && v === null ? read(r, c) !== null : true));
        return chain;
      },
      order: () => chain,
      limit: async (n) => ({
        data: rows.filter((r) => filters.every((f) => f(r))).slice(0, n),
        error: null,
      }),
    };
    return chain;
  };
  return {
    from: (table) => ({
      select: () =>
        table === "interview_answers"
          ? filterable(answers, (r, c) => r[c])
          : filterable(jobs, (r, c) =>
              c.startsWith("payload->>") ? r.payload[c.slice(10)] : r[c],
            ),
    }),
  };
}

test("only the lost-enqueue case is re-queued; jobs for OLDER generations are irrelevant", async () => {
  const now = Date.parse("2026-09-30T12:00:00Z");
  const old = new Date(now - 15 * 60_000).toISOString();
  const answers = [
    // Re-recorded: an old generation's job succeeded, the current one has NO job → enqueue.
    {
      id: "a1",
      recorded_at: G2,
      transcript_status: "pending",
      interview_sessions: { company_id: "co" },
    },
    // Current generation has a live job → leave alone.
    {
      id: "a2",
      recorded_at: G1,
      transcript_status: "pending",
      interview_sessions: { company_id: "co" },
    },
    // Current generation's job is dead → leave for admin replay.
    {
      id: "a3",
      recorded_at: G1,
      transcript_status: "pending",
      interview_sessions: { company_id: "co" },
    },
    // Too young → not selected at all.
    {
      id: "a4",
      recorded_at: new Date(now - 60_000).toISOString(),
      transcript_status: "pending",
      interview_sessions: { company_id: "co" },
    },
    // Not pending → not selected.
    {
      id: "a5",
      recorded_at: old,
      transcript_status: "done",
      interview_sessions: { company_id: "co" },
    },
  ];
  // Make the pending rows old enough by giving them old recorded_at values except a1/a2/a3 which use G1/G2 (both < now).
  const jobs = [
    { type: "transcribe", status: "succeeded", payload: { answerId: "a1", recordedAt: G1 } },
    { type: "transcribe", status: "dead", payload: { answerId: "a1", recordedAt: G1 } },
    { type: "transcribe", status: "running", payload: { answerId: "a2", recordedAt: G1 } },
    { type: "transcribe", status: "dead", payload: { answerId: "a3", recordedAt: G1 } },
  ];
  const requested = [];
  const summary = await runTranscribeRecovery(service({ answers, jobs }), {
    now: () => now,
    request: async (input) => {
      requested.push(input);
      return { ok: true, outcome: "queued" };
    },
  });
  assert.deepEqual(requested, [{ answerId: "a1", recordedAt: G2, companyId: "co" }]);
  assert.equal(summary.scanned, 3);
  assert.equal(summary.enqueued, 1);
  assert.equal(summary.live, 1);
  assert.equal(summary.dead, 1);
  assert.equal(summary.anomalies, 0);
});

test("recovery never creates a duplicate: an already_queued answer counts, not errors", async () => {
  const now = Date.parse("2026-09-30T12:00:00Z");
  const answers = [
    {
      id: "a1",
      recorded_at: G1,
      transcript_status: "pending",
      interview_sessions: { company_id: "co" },
    },
  ];
  const summary = await runTranscribeRecovery(service({ answers, jobs: [] }), {
    now: () => now,
    request: async () => ({ ok: true, outcome: "already_queued" }),
  });
  assert.equal(summary.alreadyQueued, 1);
  assert.equal(summary.enqueued, 0);
  assert.equal(summary.errors, 0);
});

test("a succeeded job with a still-pending row is reported, not looped", async () => {
  const now = Date.parse("2026-09-30T12:00:00Z");
  const answers = [
    {
      id: "a1",
      recorded_at: G1,
      transcript_status: "pending",
      interview_sessions: { company_id: "co" },
    },
  ];
  const jobs = [
    { type: "transcribe", status: "succeeded", payload: { answerId: "a1", recordedAt: G1 } },
  ];
  let requests = 0;
  const summary = await runTranscribeRecovery(service({ answers, jobs }), {
    now: () => now,
    request: async () => {
      requests++;
      return { ok: true, outcome: "queued" };
    },
  });
  assert.equal(requests, 0);
  assert.equal(summary.anomalies, 1);
});
