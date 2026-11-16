/**
 * The CV scorer never writes past the CV's retention date (#91).
 *
 *   node --test src/lib/ai/cv-scoring-expiry.test.ts
 *
 * Driven through the real handleAiCvScore with the same fakes as
 * cv-scoring-allowance.test.ts. The fake answers each application read (the
 * handler's main read, its retention check before any work, then the check
 * immediately before each write) with a retention date chosen PER READ, so a test can have the date pass between the
 * handler's first look and its write, the race a long model call opens. The
 * assertion that matters in every case is the list of upserts: an expired
 * application gets none, so neither the score the CV purge kept nor the words
 * it cleared can be touched.
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../test-support/cv-scoring-test-hook.mjs", import.meta.url));

const { fakeService } = await import("../../test-support/fake-postgrest.mjs");
const { handleAiCvScore } = await import("./cv-scoring.ts");
const { SCORE_DIMENSIONS } = await import("./score-parsers.ts");

for (const m of ["log", "info", "warn", "error"]) console[m] = () => {};

const APP_ID = "11111111-1111-4111-8111-111111111111";
const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const PASSED = "2026-01-01T00:00:00.000Z";
const FUTURE = "2099-01-01T00:00:00.000Z";

const APP = {
  id: APP_ID,
  job_id: "job-1",
  company_id_snapshot: COMPANY_ID,
  cv_text: "Senior engineer with ten years of TypeScript and Postgres. ".repeat(10),
  screening_answers: [],
  years_experience: 10,
  city: null,
  country: null,
  notice_period: null,
  availability: null,
  first_name: "A",
  last_name: "B",
};
const JOB = {
  id: "job-1",
  title: "Engineer",
  description: "Build things.",
  responsibilities: "Ship.",
  requirements: "TypeScript.",
  experience_level: null,
  category: null,
  screening_questions: [],
  criteria_version: 3,
  ai_cv_scoring_enabled: true,
  company_id: COMPANY_ID,
  cv_weight_requirements: null,
  cv_weight_experience: null,
  cv_weight_domain: null,
  cv_weight_responsibilities: null,
  autoshortlist_source: null,
  autoshortlist_cv_threshold: null,
  autoshortlist_interview_threshold: null,
  scoring_must_haves: [],
};
const MODEL_REPLY = {
  content: [
    {
      type: "text",
      text: JSON.stringify({
        verdict: "Good match.",
        overall_score: 74,
        dimension_scores: SCORE_DIMENSIONS.map((dimension) => ({
          dimension,
          score: 70,
          reasoning: "r",
          quote: "",
        })),
        strengths: [],
        missing_requirements: [],
        concerns: [],
        confidence: "high",
        summary: "s",
        must_haves: [],
      }),
    },
  ],
  usage: { input_tokens: 10, output_tokens: 5 },
};

/**
 * One handler run. `dates` is the cv_delete_after each successive read of the
 * application returns; the last one repeats.
 */
async function run(opts: {
  dates: (string | null)[];
  app?: object;
  job?: object;
  modelThrows?: Error;
  /** What every application_scores upsert answers; migration 061's refusal, for one. */
  upsertError?: { code: string; message: string };
}) {
  const events: string[] = [];
  globalThis.__cvScoringEventsForTests = events;
  let appReads = 0;
  const service = fakeService((table, calls) => {
    if (table === "rpc:consume_allowance") {
      events.push("rpc:consume_allowance");
      return {
        data: [
          {
            allowed: true,
            unlimited: false,
            reason: "within_limit",
            used: 1,
            allowance: 10,
            usage_id: "usage-1",
            period_start: "2026-09-30T19:00:00+00:00",
          },
        ],
        error: null,
      };
    }
    if (table === "rpc:release_allowance") {
      events.push("rpc:release_allowance");
      return { data: true, error: null };
    }
    const upsert = calls.find((c) => c[0] === "upsert");
    if (upsert) {
      events.push(`write:${table}:${upsert[1].status}`);
      return { data: null, error: opts.upsertError ?? null };
    }
    events.push(`read:${table}`);
    if (table === "job_applications") {
      const date = opts.dates[Math.min(appReads, opts.dates.length - 1)];
      appReads += 1;
      return { data: { ...APP, ...(opts.app ?? {}), cv_delete_after: date }, error: null };
    }
    if (table === "jobs") return { data: { ...JOB, ...(opts.job ?? {}) }, error: null };
    return { data: null, error: null };
  });
  globalThis.__cvScoringServiceForTests = () => service;
  globalThis.__cvScoringAnthropicForTests = {
    messages: {
      create: async () => {
        events.push("model");
        if (opts.modelThrows) throw opts.modelThrows;
        return MODEL_REPLY;
      },
    },
  };
  let error = null;
  try {
    await handleAiCvScore({ id: "bg-job-1", payload: { applicationId: APP_ID } });
  } catch (err) {
    error = err;
  }
  const upserts = service.queries
    .filter((q) => q.table === "application_scores")
    .flatMap((q) => q.calls.filter((c) => c[0] === "upsert"));
  return { events, upserts, error, rpcs: service.rpcs };
}

test("#91 control: a live CV is scored and written as before", async () => {
  const r = await run({ dates: [FUTURE] });
  assert.equal(r.error, null);
  assert.equal(r.upserts.length, 1);
  assert.equal(r.upserts[0][1].status, "scored");
});

test("#91: a job queued before the purge, run after it, writes nothing, reserves nothing and finishes", async () => {
  // The purged shape: date passed, text cleared. Without the guard the
  // "No usable CV text" skip would write a skipped card over the kept score.
  const r = await run({ dates: [PASSED], app: { cv_text: null } });
  assert.equal(r.error, null, "finished, not failed: the queue completes it normally");
  assert.deepEqual(r.upserts, [], "the kept score and the cleared words are untouched");
  assert.deepEqual(
    r.events,
    ["read:job_applications", "read:job_applications"],
    "the row and its retention check; no allowance, no model, no write",
  );
});

test("#91: a job that starts before expiry and reaches the write after it writes nothing and gives the slot back", async () => {
  const r = await run({ dates: [FUTURE, FUTURE, PASSED] });
  assert.equal(r.error, null, "finished, not failed and not left running");
  assert.deepEqual(r.upserts, [], "no scored card over the kept one, no words put back");
  assert.deepEqual(r.events, [
    "read:job_applications",
    "read:job_applications",
    "read:jobs",
    "rpc:consume_allowance",
    "model",
    "read:job_applications",
    "rpc:release_allowance",
  ]);
  assert.ok(!r.events.includes("shortlist") && !r.events.includes("notify"), "nothing announced");
});

test("#91: the failure path writes no failed card past expiry, and the job still fails for the queue's retry", async () => {
  const boom = Object.assign(new Error("upstream 500"), { status: 500 });
  const r = await run({ dates: [FUTURE, FUTURE, PASSED], modelThrows: boom });
  assert.ok(
    r.error,
    "the provider failure still reaches the queue, so its retry and dead-letter rules apply",
  );
  assert.deepEqual(r.upserts, [], "no failed card over the kept score");
  assert.ok(r.events.includes("rpc:release_allowance"), "the slot goes back as on any failure");
});

test("#91: a skip path that reaches its write after expiry writes no skipped card", async () => {
  const r = await run({ dates: [FUTURE, FUTURE, PASSED], job: { ai_cv_scoring_enabled: false } });
  assert.equal(r.error, null);
  assert.deepEqual(r.upserts, []);
});

/* ── migration 061: the trigger refuses inside the upsert itself ─── */

const { RETENTION_GUARD_SQLSTATE } = await import("./cv-scoring.ts");
const REFUSED = {
  code: RETENTION_GUARD_SQLSTATE,
  message:
    "application_scores: the CV has passed its retention date; an AI scorecard cannot be written",
};

test("#91 B: the trigger's refusal on the success write reads as expired: slot back, nothing announced, finished", async () => {
  // Every check in the code saw a live CV; the date passed inside the upsert.
  const r = await run({ dates: [FUTURE], upsertError: REFUSED });
  assert.equal(r.error, null, "finished, not failed and not left running");
  assert.deepEqual(r.events, [
    "read:job_applications",
    "read:job_applications",
    "read:jobs",
    "rpc:consume_allowance",
    "model",
    "read:job_applications",
    "write:application_scores:scored",
    "rpc:release_allowance",
  ]);
});

test("#91 B: the trigger's refusal on a skip write is quiet, and the job finishes", async () => {
  const r = await run({
    dates: [FUTURE],
    job: { ai_cv_scoring_enabled: false },
    upsertError: REFUSED,
  });
  assert.equal(r.error, null);
});

test("#91 B: the trigger's refusal on the failure write does not hide the provider error from the queue", async () => {
  const boom = Object.assign(new Error("upstream 500"), { status: 500 });
  const r = await run({ dates: [FUTURE], modelThrows: boom, upsertError: REFUSED });
  assert.ok(r.error, "the original failure still reaches the queue");
  assert.doesNotMatch(
    String(r.error?.message),
    /retention/,
    "and it is the provider's, not the refusal",
  );
  assert.ok(r.events.includes("rpc:release_allowance"));
});

test("#91 B: any other write error is still a write failure", async () => {
  const r = await run({ dates: [FUTURE], upsertError: { code: "23505", message: "duplicate" } });
  assert.match(String(r.error?.message), /score write failed: duplicate/);
});
