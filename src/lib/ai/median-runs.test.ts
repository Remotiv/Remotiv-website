/**
 * Median of three for CV scoring (lib/ai/median-runs.ts, scoreCvRuns in
 * cv-scoring.ts): the helper on its own, then the real handleAiCvScore with a
 * fake database and a fake model (cv-scoring-test-hook.mjs). Nothing leaves
 * the machine.
 *
 *   node --test src/lib/ai/median-runs.test.ts
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../test-support/cv-scoring-test-hook.mjs", import.meta.url));

const { medianOfRuns, resolveScoringRuns } = await import("./median-runs.ts");
const { fakeService } = await import("../../test-support/fake-postgrest.mjs");
const { handleAiCvScore } = await import("./cv-scoring.ts");
const { SCORE_DIMENSIONS } = await import("./score-parsers.ts");
const { JobYield, TerminalJobError } = await import("../queue/failure-class.ts");

/* ── resolveScoringRuns ─────────────────────────────────────────── */

test("AI_SCORING_RUNS: unset, blank or 1 is 1; 3 is 3; anything else is 1 with one warning", () => {
  const warnings = [];
  const warn = console.warn;
  console.warn = (...a) => warnings.push(a.join(" "));
  try {
    for (const v of [undefined, "", "  ", "1", " 1 "]) assert.equal(resolveScoringRuns(v), 1, v);
    assert.equal(resolveScoringRuns("3"), 3);
    assert.equal(resolveScoringRuns(" 3 "), 3);
    assert.deepEqual(warnings, [], "valid values warn nothing");
    for (const v of ["2", "5", "0", "-3", "three", "3.0"]) {
      assert.equal(resolveScoringRuns(v), 1, v);
    }
    assert.equal(warnings.length, 6, "one line per invalid value");
    assert.ok(warnings.every((w) => w.includes("AI_SCORING_RUNS must be 1 or 3")));
  } finally {
    console.warn = warn;
  }
});

/* ── medianOfRuns, on its own ───────────────────────────────────── */

/** A policy whose attempts answer from `script` in call order: a number or an Error. */
function scripted(script, over = {}) {
  const calls = [];
  return {
    calls,
    policy: {
      runs: 3,
      attempt: async (retry) => {
        const i = calls.length;
        calls.push({ retry });
        const step = script[i];
        await Promise.resolve();
        if (step instanceof Error) throw step;
        return { run: i, overall: step };
      },
      overall: (v) => v.overall,
      isFinal: (err) => err.final === true,
      canRetry: () => true,
      ...over,
    },
  };
}
const fail = (message, final = false) => Object.assign(new Error(message), { final });

test("three cards: the median; ties keep run order", async () => {
  let s = scripted([60, 80, 70]);
  let out = await medianOfRuns(s.policy);
  assert.equal(out.chosen.overall, 70);
  assert.equal(out.rule, "median");
  assert.equal(s.calls.length, 3);
  s = scripted([70, 70, 50]);
  out = await medianOfRuns(s.policy);
  assert.equal(out.chosenRun, 0, "equal overalls: the earlier run");
});

test("a failed run is tried once more; two cards store the LOWER; fewer than two throw", async () => {
  // Run 0 fails, its retry (call 3) succeeds: a median of three.
  let s = scripted([fail("a"), 60, 90, 75]);
  let out = await medianOfRuns(s.policy);
  assert.deepEqual(
    s.calls.map((c) => c.retry),
    [false, false, false, true],
  );
  assert.equal(out.chosen.overall, 75);
  assert.equal(out.results.filter((r) => r.retried).length, 1);
  // Fails twice: two cards, the lower one.
  s = scripted([fail("a"), 60, 90, fail("b")]);
  out = await medianOfRuns(s.policy);
  assert.equal(out.chosen.overall, 60);
  assert.equal(out.rule, "lower of two");
  // Two runs fail twice: the first failed run's last error is thrown.
  s = scripted([fail("a"), fail("b"), 90, fail("a2"), fail("b2")]);
  await assert.rejects(medianOfRuns(s.policy), /a2/);
  assert.equal(s.calls.length, 5);
});

test("a final error is not retried and ends the scoring at once; no time means no retry", async () => {
  let s = scripted([fail("billing", true), 60, 90]);
  await assert.rejects(medianOfRuns(s.policy), /billing/);
  assert.equal(s.calls.filter((c) => c.retry).length, 0);
  s = scripted([fail("slow"), 60, 90], { canRetry: () => false });
  const out = await medianOfRuns(s.policy);
  assert.equal(s.calls.length, 3, "no retry without time");
  assert.equal(out.chosen.overall, 60, "the lower of the two that finished");
});

/* ── through the real handler ───────────────────────────────────── */

const APP_ID = "11111111-1111-4111-8111-111111111111";
const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const USAGE_ID = "33333333-3333-4333-8333-333333333333";
const CV_LINE = "Senior engineer with ten years of TypeScript and Postgres. ";
const APP = {
  id: APP_ID,
  job_id: "job-1",
  company_id_snapshot: COMPANY_ID,
  cv_text: CV_LINE.repeat(10),
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
const GRANTED = {
  allowed: true,
  unlimited: false,
  reason: "within_limit",
  used: 4,
  allowance: 10,
  usage_id: USAGE_ID,
  period_start: "2026-09-30T19:00:00+00:00",
};

/** A reply that parses and passes the evidence gate; `verdict` names the call. */
function reply(overall, verdict, dims = {}) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          verdict,
          overall_score: overall,
          dimension_scores: SCORE_DIMENSIONS.map((dimension) => ({
            dimension,
            score: dims[dimension] ?? overall,
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
    stop_reason: "end_turn",
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

const retryable = () => Object.assign(new Error("overloaded"), { status: 529 });

/**
 * Run the real handler once. `steps[i]` answers the i-th model call: a reply,
 * an Error to throw, or "hang" (wait for the call's abort signal).
 */
async function run({ runs, steps, job = {}, ctx, onHang } = {}) {
  const before = process.env.AI_SCORING_RUNS;
  if (runs === undefined) delete process.env.AI_SCORING_RUNS;
  else process.env.AI_SCORING_RUNS = runs;
  const logs = [];
  const quiet = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...a) => logs.push(a);
  console.warn = console.error = () => {};

  const service = fakeService((table, calls) => {
    if (table === "rpc:consume_allowance") return { data: [GRANTED], error: null };
    if (table === "rpc:release_allowance") return { data: true, error: null };
    if (calls.some((c) => ["upsert", "insert", "update", "delete"].includes(c[0]))) {
      return { data: null, error: null };
    }
    if (table === "job_applications") return { data: APP, error: null };
    if (table === "jobs") return { data: { ...JOB, ...job }, error: null };
    return { data: null, error: null };
  });
  globalThis.__cvScoringServiceForTests = () => service;
  globalThis.__cvScoringEventsForTests = [];

  const calls = [];
  let inflight = 0;
  let maxInflight = 0;
  globalThis.__cvScoringAnthropicForTests = {
    messages: {
      create: async (params, options) => {
        const i = calls.length;
        calls.push({ params, options });
        inflight += 1;
        maxInflight = Math.max(maxInflight, inflight);
        try {
          await new Promise((r) => setImmediate(r));
          const step = steps[i];
          if (step === "hang") {
            onHang?.();
            await new Promise((_, reject) => {
              const abort = () =>
                reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
              if (options?.signal?.aborted) abort();
              options?.signal?.addEventListener("abort", abort);
            });
          }
          if (step instanceof Error) throw step;
          return step;
        } finally {
          inflight -= 1;
        }
      },
    },
  };

  const started = Date.now();
  let error = null;
  try {
    await handleAiCvScore({ id: "bg-job-1", payload: { applicationId: APP_ID } }, ctx);
  } catch (err) {
    error = err;
  } finally {
    Object.assign(console, quiet);
    if (before === undefined) delete process.env.AI_SCORING_RUNS;
    else process.env.AI_SCORING_RUNS = before;
  }
  const upserts = service.queries
    .filter((q) => q.table === "application_scores")
    .flatMap((q) => q.calls.filter((c) => c[0] === "upsert").map((c) => c[1]));
  return {
    calls,
    maxInflight,
    upserts,
    rpcs: service.rpcs.map((r) => r.name),
    logs,
    error,
    ms: Date.now() - started,
  };
}

const withoutTime = ({ scored_at, ...row }) => row;
const runLog = (r) => r.logs.find((l) => l[0] === "[cv-scoring] scored");

test("AI_SCORING_RUNS unset or 1: one call, the same request and the same stored row", async () => {
  const unset = await run({ steps: [reply(74, "v")] });
  const one = await run({ runs: "1", steps: [reply(74, "v")] });
  for (const r of [unset, one]) {
    assert.equal(r.calls.length, 1);
    assert.equal(r.error, null);
    assert.equal(runLog(r), undefined, "nothing extra logged with one run");
  }
  assert.deepEqual(one.calls[0].params, unset.calls[0].params);
  assert.deepEqual(one.calls[0].options, unset.calls[0].options);
  assert.equal(unset.upserts.length, 1);
  assert.deepEqual(withoutTime(one.upserts[0]), withoutTime(unset.upserts[0]));
  assert.equal(unset.upserts[0].overall_score, 74);
  assert.equal(unset.upserts[0].input_tokens, 10);
  assert.deepEqual(unset.rpcs, ["consume_allowance"]);
});

test("AI_SCORING_RUNS=3: three parallel calls, the median card stored, tokens summed, allowance once", async () => {
  const r = await run({
    runs: "3",
    steps: [reply(60, "run-0"), reply(80, "run-1"), reply(70, "run-2")],
  });
  assert.equal(r.error, null);
  assert.equal(r.calls.length, 3);
  assert.equal(r.maxInflight, 3, "all three in flight together");
  // Three identical requests: the runs differ only by sampling.
  assert.deepEqual(r.calls[1].params, r.calls[0].params);
  assert.deepEqual(r.calls[2].params, r.calls[0].params);
  assert.equal(r.upserts.length, 1);
  const row = r.upserts[0];
  assert.equal(row.status, "scored");
  assert.equal(row.overall_score, 70);
  assert.equal(row.verdict, "run-2", "the whole card is the median run's, not a blend");
  assert.equal(row.input_tokens, 30);
  assert.equal(row.output_tokens, 15);
  assert.equal(row.ai_model, "claude-sonnet-4-5");
  assert.deepEqual(r.rpcs, ["consume_allowance"], "reserved once, never released");
  // One line: the run overalls and the choice, numbers and the id only.
  const line = runLog(r);
  assert.deepEqual(line.slice(1, 3), [3, "times"]);
  assert.deepEqual(line[3], {
    applicationId: APP_ID,
    overalls: [60, 80, 70],
    chosen: 70,
    rule: "median",
    retried: 0,
  });
  assert.ok(!JSON.stringify(r.logs).includes(CV_LINE.trim()), "no CV text in the logs");
});

test("one run fails, its retry succeeds: still a median of three", async () => {
  const r = await run({
    runs: "3",
    steps: [retryable(), reply(60, "run-1"), reply(90, "run-2"), reply(75, "retry-0")],
  });
  assert.equal(r.error, null);
  assert.equal(r.calls.length, 4);
  assert.equal(r.upserts[0].verdict, "retry-0");
  assert.equal(r.upserts[0].overall_score, 75);
  assert.equal(r.upserts[0].input_tokens, 30, "tokens of the three cards");
  assert.equal(runLog(r)[3].retried, 1);
});

test("one run fails twice: the LOWER of the two cards is stored", async () => {
  const r = await run({
    runs: "3",
    steps: [retryable(), reply(60, "run-1"), reply(90, "run-2"), retryable()],
  });
  assert.equal(r.error, null);
  assert.equal(r.calls.length, 4);
  assert.equal(r.upserts[0].overall_score, 60);
  assert.equal(r.upserts[0].verdict, "run-1");
  assert.equal(r.upserts[0].input_tokens, 20);
  assert.deepEqual(runLog(r)[3].overalls, [null, 60, 90]);
  assert.equal(runLog(r)[3].rule, "lower of two");
});

test("two runs fail twice: today's failure path - a failed row, the error rethrown, the slot released", async () => {
  const r = await run({
    runs: "3",
    steps: [retryable(), retryable(), reply(90, "run-2"), retryable(), retryable()],
  });
  assert.equal(r.calls.length, 5);
  assert.ok(r.error, "rethrown for the queue");
  assert.equal(r.upserts.length, 1);
  assert.equal(r.upserts[0].status, "failed");
  assert.equal(r.upserts[0].overall_score, undefined, "no partial card");
  assert.deepEqual(r.rpcs, ["consume_allowance", "release_allowance"]);
});

test("billing and configuration errors are not retried and follow today's path", async () => {
  const cases = [
    [new TerminalJobError("billing", "credit balance is too low"), "billing"],
    [Object.assign(new Error("invalid x-api-key"), { status: 401 }), "configuration"],
  ];
  for (const [err, cls] of cases) {
    const r = await run({ runs: "3", steps: [err, reply(60, "run-1"), reply(90, "run-2")] });
    assert.equal(r.calls.length, 3, `${cls}: no retry`);
    assert.ok(r.error instanceof TerminalJobError, cls);
    assert.equal(r.error.failureClass, cls);
    assert.equal(r.upserts.length, 1);
    assert.equal(r.upserts[0].status, "failed", `${cls}: no card stored from the other runs`);
    assert.deepEqual(r.rpcs, ["consume_allowance", "release_allowance"]);
  }
});

test("weights are applied before the median is taken", async () => {
  // Raw model overalls 90 / 50 / 70 would choose the 70. With requirements
  // weighted 10 to 1, the final overalls are 36 / 58 / 89: the median is the 58.
  const job = {
    cv_weight_requirements: 10,
    cv_weight_experience: 1,
    cv_weight_domain: 1,
    cv_weight_responsibilities: 1,
  };
  const r = await run({
    runs: "3",
    job,
    steps: [
      reply(90, "run-0", { requirements_match: 20 }),
      reply(50, "run-1", { requirements_match: 60 }),
      reply(70, "run-2", { requirements_match: 95 }),
    ],
  });
  assert.equal(r.error, null);
  assert.deepEqual(runLog(r)[3].overalls, [36, 58, 89]);
  assert.equal(r.upserts[0].verdict, "run-1");
  assert.equal(r.upserts[0].overall_score, 58);
});

test("deadline: a slow run is cut off by the job's own signal and is not retried past the budget", async () => {
  const controller = new AbortController();
  let remaining = 25_000;
  const ctx = {
    deadlineAt: Date.now() + remaining,
    signal: controller.signal,
    remainingMs: () => remaining,
  };
  const r = await run({
    runs: "3",
    ctx,
    steps: ["hang", reply(60, "run-1"), reply(70, "run-2")],
    // The deadline arrives while the slow call is still open.
    onHang: () =>
      setTimeout(() => {
        remaining = 0;
        controller.abort();
      }, 30),
  });
  assert.equal(r.error, null);
  assert.ok(r.ms < 2_000, `finished at the deadline, not after it (${r.ms}ms)`);
  assert.equal(r.calls.length, 3, "no retry once the budget is gone");
  const slow = r.calls[0].options;
  assert.equal(slow.signal, controller.signal, "the slow call carries the job's signal");
  assert.equal(slow.timeout, 24_000, "and a timeout inside the budget");
  assert.equal(slow.maxRetries, 0);
  assert.equal(r.upserts[0].overall_score, 60, "the lower of the two that finished");
});

test("out of budget before the first call: the job yields as today, nothing is called", async () => {
  const ctx = {
    deadlineAt: Date.now() + 5_000,
    signal: new AbortController().signal,
    remainingMs: () => 5_000,
  };
  const r = await run({ runs: "3", ctx, steps: [] });
  assert.ok(r.error instanceof JobYield);
  assert.equal(r.calls.length, 0);
  assert.deepEqual(r.rpcs, ["consume_allowance", "release_allowance"]);
  assert.equal(r.upserts.length, 0);
});
