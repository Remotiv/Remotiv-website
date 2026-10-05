/**
 * The CV-scoring cap, driven through the real handleAiCvScore: where the
 * allowance is reserved, what is passed, when the slot is given back, and
 * what an over-cap applicant's card ends up as.
 *
 * Only the database client, the Anthropic client and two after-the-score side
 * effects are fakes (see cv-scoring-test-hook.mjs). Every event - each read,
 * write, rpc and model call - is appended to one log, so ordering is asserted
 * on what actually happened.
 *
 *   node --test src/lib/ai/cv-scoring-allowance.test.ts
 */
// @ts-nocheck — same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../test-support/cv-scoring-test-hook.mjs", import.meta.url));

const { fakeService } = await import("../../test-support/fake-postgrest.mjs");
const { handleAiCvScore } = await import("./cv-scoring.ts");
const { SCORE_DIMENSIONS } = await import("./score-parsers.ts");
const { CV_LIMIT_REACHED_REASON, SCORING_OFF_REASON } = await import(
  "../../app/ai-dashboard/lib/applicant-types.ts"
);
const { JobYield, TerminalJobError } = await import("../queue/failure-class.ts");

// The scorer logs every provider call and failure; the assertions below are
// on the event log, so the console is quiet.
for (const m of ["log", "info", "warn", "error"]) console[m] = () => {};

const APP_ID = "11111111-1111-4111-8111-111111111111";
const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const USAGE_ID = "33333333-3333-4333-8333-333333333333";

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

const GRANTED = (over = {}) => ({
  allowed: true,
  unlimited: false,
  reason: "within_limit",
  used: 4,
  allowance: 10,
  usage_id: USAGE_ID,
  period_start: "2026-09-30T19:00:00+00:00",
  ...over,
});
const REFUSED = {
  allowed: false,
  unlimited: false,
  reason: "limit_reached",
  used: 10,
  allowance: 10,
  usage_id: null,
  period_start: "2026-09-30T19:00:00+00:00",
};

/** A reply that parses and passes the evidence gate (no quotes to fail). */
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
 * Run the handler once. `opts` decides each answer; the returned log says
 * what happened, in order.
 */
async function run(opts = {}) {
  const events = [];
  globalThis.__cvScoringEventsForTests = events;
  const app = { ...APP, ...(opts.app ?? {}) };
  const job = opts.job === null ? null : { ...JOB, ...(opts.job ?? {}) };

  const service = fakeService((table, calls) => {
    if (table === "rpc:consume_allowance") {
      events.push("rpc:consume_allowance");
      if (opts.consumeError) return { data: null, error: { message: "boom" } };
      return { data: [opts.allowance ?? GRANTED()], error: null };
    }
    if (table === "rpc:release_allowance") {
      events.push("rpc:release_allowance");
      return { data: true, error: null };
    }
    const upsert = calls.find((c) => c[0] === "upsert");
    if (upsert) {
      events.push(`write:${table}:${upsert[1].status}`);
      if (table === "application_scores" && upsert[1].status === "scored" && opts.scoreWriteError) {
        return { data: null, error: { message: "write failed" } };
      }
      return { data: null, error: null };
    }
    if (calls.some((c) => ["insert", "update", "delete"].includes(c[0]))) {
      events.push(`write:${table}`);
      return { data: null, error: null };
    }
    events.push(`read:${table}`);
    if (table === "job_applications") return { data: app, error: null };
    if (table === "jobs") return { data: job, error: null };
    if (table === "application_scores") {
      if (opts.existingError) return { data: null, error: { message: "read failed" } };
      return { data: opts.existing ?? null, error: null };
    }
    return { data: null, error: null };
  });
  globalThis.__cvScoringServiceForTests = () => service;
  globalThis.__cvScoringAnthropicForTests = {
    messages: {
      create: async () => {
        events.push("model");
        if (opts.modelThrows) throw opts.modelThrows;
        return opts.modelReply ?? MODEL_REPLY;
      },
    },
  };

  let error = null;
  try {
    await handleAiCvScore({ id: "bg-job-1", payload: { applicationId: APP_ID } }, opts.ctx);
  } catch (err) {
    error = err;
  }
  const upserts = service.queries
    .filter((q) => q.table === "application_scores")
    .flatMap((q) => q.calls.filter((c) => c[0] === "upsert").map((c) => c[1]));
  return { events, rpcs: service.rpcs, queries: service.queries, upserts, error };
}

const releases = (r) => r.rpcs.filter((x) => x.name === "release_allowance");

/* ── where the gate sits ────────────────────────────────────────── */

test("the allowance is reserved after every free check and before the paid model call", async () => {
  const r = await run();
  assert.equal(r.error, null);
  assert.deepEqual(r.events, [
    "read:job_applications",
    "read:jobs",
    "rpc:consume_allowance",
    "model",
    "write:application_scores:scored",
    "shortlist",
    "notify",
  ]);
});

test("company id, metric cv_scored and the application id are what is reserved against", async () => {
  const r = await run();
  assert.deepEqual(r.rpcs[0], {
    name: "consume_allowance",
    args: { p_company: COMPANY_ID, p_metric: "cv_scored", p_ref: APP_ID },
  });
});

test("free skips never reserve and never call the model", async () => {
  const cases = [
    ["scoring off", { job: { ai_cv_scoring_enabled: false } }, SCORING_OFF_REASON],
    ["unreadable CV", { app: { cv_text: "too short" } }, /No usable CV text/],
    ["no job id", { app: { job_id: null } }, /no job_id/],
    ["job gone", { job: null }, /no longer exists/],
  ];
  for (const [label, opts, reason] of cases) {
    const r = await run(opts);
    assert.equal(r.error, null, label);
    assert.equal(r.rpcs.length, 0, `${label}: no rpc`);
    assert.ok(!r.events.includes("model"), `${label}: no model call`);
    assert.equal(r.upserts.length, 1, label);
    assert.equal(r.upserts[0].status, "skipped", label);
    if (typeof reason === "string") assert.equal(r.upserts[0].error, reason, label);
    else assert.match(r.upserts[0].error, reason, label);
  }
});

test("an application with no company is never scored unmetered: no rpc, no model, no write", async () => {
  const r = await run({ app: { company_id_snapshot: null } });
  assert.equal(r.error, null);
  assert.equal(r.rpcs.length, 0);
  assert.ok(!r.events.includes("model"));
  assert.equal(r.upserts.length, 0);
});

test("no decision from the database means no paid call, and nothing to release", async () => {
  const r = await run({ consumeError: true });
  assert.ok(r.error instanceof Error);
  assert.doesNotMatch(r.error.message, /boom/, "the raw database error stays in the log");
  assert.ok(!r.events.includes("model"));
  assert.equal(releases(r).length, 0);
  assert.equal(r.upserts.length, 0);
});

/* ── giving the slot back ───────────────────────────────────────── */

test("a persisted score keeps its slot: no release, and no second cv_scored write", async () => {
  const r = await run();
  assert.equal(releases(r).length, 0);
  assert.deepEqual(
    r.rpcs.map((x) => x.name),
    ["consume_allowance"],
  );
  // The reservation IS the usage row; the old post-success write is gone.
  assert.equal(r.queries.filter((q) => q.table === "usage_events").length, 0);
});

test("every unsuccessful path after the reservation releases exactly the reserved usage id", async () => {
  const providerDown = Object.assign(new Error("upstream 503"), { status: 503 });
  const aborted = new AbortController();
  aborted.abort();
  const cases = [
    ["provider error", { modelThrows: providerDown }, Error],
    [
      "terminal error (malformed reply)",
      { modelReply: { content: [{ type: "text", text: "not json" }], usage: {} } },
      TerminalJobError,
    ],
    [
      "budget yield before the call",
      { ctx: { deadlineAt: 0, signal: new AbortController().signal, remainingMs: () => 0 } },
      JobYield,
    ],
    [
      "budget abort during the call",
      {
        ctx: { deadlineAt: 0, signal: aborted.signal, remainingMs: () => 600_000 },
        modelThrows: Object.assign(new Error("aborted"), { name: "AbortError" }),
      },
      Error,
    ],
    ["score write failed", { scoreWriteError: true }, Error],
  ];
  for (const [label, opts, kind] of cases) {
    const r = await run(opts);
    assert.ok(r.error instanceof kind, `${label}: rethrown as ${kind.name}`);
    assert.deepEqual(
      releases(r).map((x) => x.args),
      [{ p_usage_id: USAGE_ID }],
      `${label}: released once, with the reserved id`,
    );
    assert.ok(
      r.events.indexOf("rpc:release_allowance") > r.events.indexOf("rpc:consume_allowance"),
      label,
    );
    assert.ok(!r.events.includes("shortlist") && !r.events.includes("notify"), label);
  }
});

test("the yield releases before any model call; the others release after it", async () => {
  const yielded = await run({
    ctx: { deadlineAt: 0, signal: new AbortController().signal, remainingMs: () => 0 },
  });
  assert.ok(!yielded.events.includes("model"));
  const failed = await run({ modelThrows: new Error("x") });
  assert.ok(failed.events.indexOf("model") < failed.events.indexOf("rpc:release_allowance"));
});

/* ── unlimited answers ──────────────────────────────────────────── */

test("no plan and internal answers proceed exactly like an in-limit one", async () => {
  for (const reason of ["unlimited_no_plan", "unlimited_internal", "unlimited_metric_not_set"]) {
    const r = await run({ allowance: GRANTED({ unlimited: true, reason, allowance: null }) });
    assert.equal(r.error, null, reason);
    assert.ok(r.events.includes("model"), reason);
    assert.equal(r.upserts.at(-1).status, "scored", reason);
    assert.equal(releases(r).length, 0, reason);
  }
});

/* ── over the cap ───────────────────────────────────────────────── */

test("over the cap with no card: the fixed skip state, no model, no usage, no retry", async () => {
  const r = await run({ allowance: REFUSED });
  assert.equal(r.error, null, "the job ends; it is not retried");
  assert.ok(!r.events.includes("model"));
  assert.equal(releases(r).length, 0);
  assert.equal(r.queries.filter((q) => q.table === "usage_events").length, 0);
  assert.equal(r.upserts.length, 1);
  assert.equal(r.upserts[0].status, "skipped");
  assert.equal(r.upserts[0].error, CV_LIMIT_REACHED_REASON);
});

test("over the cap after a failed or skipped attempt: the same fixed skip state", async () => {
  for (const status of ["failed", "skipped"]) {
    const r = await run({ allowance: REFUSED, existing: { status } });
    assert.equal(r.upserts.length, 1, status);
    assert.equal(r.upserts[0].error, CV_LIMIT_REACHED_REASON, status);
  }
});

test("an over-cap re-score leaves the existing scorecard untouched", async () => {
  const r = await run({ allowance: REFUSED, existing: { status: "scored" } });
  assert.equal(r.error, null);
  assert.ok(!r.events.includes("model"));
  assert.equal(r.upserts.length, 0, "nothing is written over the card");
  assert.ok(
    r.queries.every((q) => q.calls.every((c) => !["insert", "update", "delete"].includes(c[0]))),
  );
});

test("over the cap when the card cannot be read: nothing is written, in case one exists", async () => {
  const r = await run({ allowance: REFUSED, existingError: true });
  assert.equal(r.error, null);
  assert.equal(r.upserts.length, 0);
});
