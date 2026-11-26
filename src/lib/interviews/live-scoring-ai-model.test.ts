/**
 * #52: the live score row's ai_model says which model produced its scores,
 * by the same rule as its prompt_version: the questions' one model, "mixed"
 * when they differ, and with no AI result the stored row's model or the
 * current one. A re-run on a newer model never relabels older scores.
 *
 *   node --test src/lib/interviews/live-scoring-ai-model.test.ts
 *
 * The real rowAiModel and rowPromptVersion; live-scoring.ts's source for the
 * wiring; and scoreLiveSession itself, run twice on fake-live-db.mjs (imported,
 * never edited) with a different AI_INTERVIEW_SCORING_MODEL each time. The
 * model is a fake call. Synthetic data only.
 */
// @ts-nocheck - same reason as stage-tabs.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../test-support/node-resolve.mjs", import.meta.url));
register(
  `data:text/javascript,${encodeURIComponent(`
const STUBS = {
  "server-only": "",
  "@/lib/supabase/server": "export function createServiceClient() { return globalThis.__liveScoringService; }",
};
export async function resolve(specifier, context, next) {
  if (specifier in STUBS) return { url: "data:text/javascript," + encodeURIComponent(STUBS[specifier]), shortCircuit: true };
  return next(specifier, context);
}`)}`,
);

const {
  rowAiModel,
  rowPromptVersion,
  scoreLiveSession,
  LIVE_SCORING_MIXED_MODELS,
  LIVE_SCORING_MIXED_VERSIONS,
} = await import("./live-scoring.ts");
const { resolveNeedsCheck, resolveWordingCheck } = await import("./live-recovery.ts");
const { handleLiveTurnTranscribe } = await import("./live-transcribe.ts");
const { saveLiveExport } = await import("./live-ingest.ts");
const { parseExport } = await import("./live-provider/parse-export.ts");
const { createFakeLiveProvider } = await import("./live-provider/fake-provider.ts");
const { snapshotsFor } = await import("./frozen-questions.ts");
const { fakeLiveDb } = await import("../../test-support/fake-live-db.mjs");

const OLD = "claude-haiku-5-5";
const NOW = "gpt-6-luna";
/** Question entries as stored: an AI result carries its model and version; lowest/never-scored carry null. */
const q = (model, prompt_version = model ? `v-${model}` : null) => ({ model, prompt_version });

test("a re-run with a different current model keeps the questions' model", () => {
  // Every question was scored on the old model and is reused; today's model is newer.
  const entries = [q(OLD), q(OLD), q(null)];
  assert.equal(rowAiModel(entries, OLD), OLD, "stored row's model as the fallback");
  assert.equal(rowAiModel(entries, NOW), OLD, "the current model is only ever the fallback");
});

test("a question newly scored on today's model next to kept ones: mixed", () => {
  assert.equal(LIVE_SCORING_MIXED_MODELS, "mixed");
  assert.equal(rowAiModel([q(OLD), q(NOW), q(null)], NOW), LIVE_SCORING_MIXED_MODELS);
});

test("no question has an AI result (all lowest, left out or waiting): the stored model, else the current one", () => {
  assert.equal(rowAiModel([q(null), q(null)], OLD), OLD);
  assert.equal(rowAiModel([], NOW), NOW);
  assert.equal(rowAiModel([{ model: "" }], NOW), NOW, "an empty model is no model");
});

test("held results count, as they do for prompt_version: the rule reads every entry's AI result", () => {
  // A left-out or waiting question still holds the result it was scored with.
  assert.equal(
    rowAiModel(
      [
        { model: OLD, status: "left_out" },
        { model: null, status: "lowest" },
      ],
      NOW,
    ),
    OLD,
  );
});

test("the same rule as prompt_version, case by case", () => {
  const cases = [
    { entries: [q(OLD), q(OLD)], fallback: [NOW, "v-now"] },
    { entries: [q(OLD), q(NOW)], fallback: [NOW, "v-now"] },
    { entries: [q(OLD), q(null), q(OLD)], fallback: [NOW, "v-now"] },
    { entries: [q(null), q(null)], fallback: [OLD, "v-stored"] },
    { entries: [], fallback: [NOW, "v-now"] },
  ];
  for (const { entries, fallback } of cases) {
    const model = rowAiModel(entries, fallback[0]);
    const version = rowPromptVersion(entries, fallback[1]);
    const kind = (v, mixed, fb) => (v === mixed ? "mixed" : v === fb ? "fallback" : "one");
    assert.equal(
      kind(model, LIVE_SCORING_MIXED_MODELS, fallback[0]),
      kind(version, LIVE_SCORING_MIXED_VERSIONS, fallback[1]),
      JSON.stringify(entries),
    );
  }
});

// ── The wiring ──────────────────────────────────────────────

const src = readFileSync(new URL("./live-scoring.ts", import.meta.url), "utf8");

test("the row derives ai_model from its questions, with the stored row's model as the fallback", () => {
  assert.match(src, /ai_model: rowAiModel\(entries, stored\?\.ai_model \?\? model\),/);
  assert.doesNotMatch(
    src,
    /^\s*ai_model: model,$/m,
    "never the current model straight onto the row",
  );
  assert.match(
    src,
    /\.from\("live_interview_scores"\)\s*\.select\("session_id, questions, rev, prompt_version, ai_model"\)/,
    "the stored row's model is read back",
  );
  // prompt_version keeps its own rule, unchanged.
  assert.match(
    src,
    /prompt_version: rowPromptVersion\(\s*entries,\s*stored\?\.prompt_version \?\? LIVE_SCORING_PROMPT_VERSION,\s*\)/,
  );
});

// ── A real re-run (scoreLiveSession on fake-live-db) ────────
//
// The session set-up is live-scoring.test.ts's, trimmed to what this needs.

const FIXTURE = JSON.parse(
  readFileSync(new URL("./live-provider/__fixtures__/sample-export.json", import.meta.url), "utf8"),
);
const SESSION = "5b0f2c1e-0000-4000-8000-0000000000c7";
const CO = "7aad434d-0000-4000-8000-000000000001";
const JOB = "2d4a8cde-0000-4000-8000-000000000007";
const APP = "03e4863f-0000-4000-8000-000000000007";
const QUESTIONS = FIXTURE.questions
  .filter((x) => x.position <= 8)
  .map((x) => ({
    question_id: `q-${x.position}`,
    position: x.position,
    text: x.text,
    source: x.position <= 4 ? "job" : "cv",
    competency: "Ownership",
    scoring_guide: `Strong answer: a specific example for question ${x.position}. Weak answer: general.`,
    guide_source: x.position <= 4 ? "recruiter" : "ai",
    weight: null,
  }));

async function quiet(fn) {
  const orig = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try {
    return await fn();
  } finally {
    Object.assign(console, orig);
  }
}

async function withModel(model, fn) {
  const before = process.env.AI_INTERVIEW_SCORING_MODEL;
  process.env.AI_INTERVIEW_SCORING_MODEL = model;
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env.AI_INTERVIEW_SCORING_MODEL;
    else process.env.AI_INTERVIEW_SCORING_MODEL = before;
  }
}

/** Saved and fully transcribed: the outcome decided, its checks not yet resolved. */
async function decided() {
  const db = fakeLiveDb({
    interview_sessions: [
      {
        id: SESSION,
        company_id: CO,
        job_id: JOB,
        application_id: APP,
        kind: "live",
        attempt: 1,
        provider_session_id: FIXTURE.session_id,
        live_outcome: null,
        live_settings: {
          v: 2,
          questions_frozen: {
            at: "2026-10-16T05:40:00.000Z",
            prompt_version: "live-questions-v1",
            policy_version: "question-mix-v1",
            model: "claude-haiku-5-5",
            calls: 1,
            input_tokens: 1,
            output_tokens: 1,
            rewritten: 0,
            replaced: 0,
          },
        },
        ...snapshotsFor(QUESTIONS),
      },
    ],
    jobs: [{ id: JOB, company_id: CO, title: "Backend Engineer" }],
    job_applications: [
      { id: APP, job_id: JOB, company_id_snapshot: CO, first_name: "Alex", last_name: "Example" },
    ],
  });
  const provider = createFakeLiveProvider(FIXTURE);
  const { providerSessionId } = await provider.createSession({
    remotiv_session_id: SESSION,
    interviewer_name: "Sarah",
    interview_minutes: 30,
    questions: [{ position: 1, text: "Q" }],
    candidate_first_name: "Alex",
    cv_text: "",
  });
  await quiet(() =>
    saveLiveExport(
      SESSION,
      {
        ...parseExport(provider.exportOf(providerSessionId)),
        provider_session_id: FIXTURE.session_id,
      },
      {
        service: db.service,
        fetchAudio: (n) => provider.fetchAudio(providerSessionId, n),
        now: () => Date.now(),
      },
    ),
  );
  globalThis.__liveScoringService = db.service;
  const turns = [...db.tables.interview_turns]
    .sort((a, b) => a.sequence - b.sequence)
    .filter((t) => t.speaker === "candidate");
  const positionOf = (t) =>
    t.question_position ??
    db.tables.interview_turns.find((x) => x.id === t.responds_to_turn_id)?.question_position;
  for (const t of turns) {
    await quiet(() =>
      handleLiveTurnTranscribe(
        {
          id: `job-${t.sequence}`,
          payload: { turnId: t.id, sessionId: SESSION },
          attempts: 0,
          max_attempts: 3,
        },
        undefined,
        {
          service: db.service,
          transcribe: async (audio) => {
            const media = [...db.objects.entries()].find(
              ([, o]) =>
                o.bytes.length === audio.bytes.length &&
                o.bytes.every((b, i) => b === audio.bytes[i]),
            );
            const row = db.tables.interview_turns.find((x) => x.media_path === media?.[0]);
            return {
              text: `On question ${positionOf(row)} I personally rebuilt the import service in turn ${row.sequence} and cut the runtime in half.`,
              segments: [],
            };
          },
          onDecided: async () => {},
        },
      ),
    );
  }
  return db;
}

/** A fake model call: a valid score quoting the candidate's first words. */
function fakeModel() {
  const requests = [];
  const call = async (request) => {
    requests.push(request);
    const user = request.messages[0].content;
    const first = user
      .split("\n")
      .find((l) => l.startsWith("Candidate: "))
      ?.slice("Candidate: ".length)
      .split(" ")
      .slice(0, 6)
      .join(" ");
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            score: 70,
            confidence: "high",
            rationale: "The candidate described their own work.",
            quotes: [first],
          }),
        },
      ],
      stop_reason: "end_turn",
      usage: { input_tokens: 900, output_tokens: 120 },
    };
  };
  return { requests, call };
}

const runScorer = (db, model) =>
  quiet(() => scoreLiveSession(SESSION, { service: db.service, call: model.call, enabled: true }));

/** Every timing and wording check resolved "score", so every question is scored. */
async function scoredOn(modelName) {
  const db = await decided();
  const model = fakeModel();
  const deps = {
    service: db.service,
    caller: { kind: "company", userId: "u-admin", name: "Ada Admin", role: "admin", companyId: CO },
    transcriptSource: async () => 1,
    score: () => runScorer(db, model),
  };
  await withModel(modelName, async () => {
    const outcome = () => db.tables.interview_sessions[0].live_outcome;
    for (const x of outcome().questions.filter((y) => y.needs_check)) {
      await quiet(() =>
        resolveNeedsCheck(
          { sessionId: SESSION, position: x.position, decision: "score", note: "Checked." },
          deps,
        ),
      );
    }
    for (const x of outcome().questions.filter((y) => y.wording_check)) {
      await quiet(() =>
        resolveWordingCheck(
          { sessionId: SESSION, position: x.position, decision: "score", note: "Checked." },
          deps,
        ),
      );
    }
  });
  return { db, model };
}

const rowOf = (db) => db.tables.live_interview_scores.find((r) => r.session_id === SESSION);
const aiScored = (row) => row.questions.filter((x) => x.model !== null);

test("scored on one model, re-run on a newer one (0 calls): the row keeps the questions' model", async () => {
  const { db, model } = await scoredOn(OLD);
  const first = structuredClone(rowOf(db));
  assert.equal(first.status, "scored");
  assert.ok(aiScored(first).length >= 3, "enough AI scores to prove it");
  assert.equal(first.ai_model, OLD);
  const calls = model.requests.length;

  await withModel(NOW, () => runScorer(db, model));
  const row = rowOf(db);
  assert.equal(model.requests.length, calls, "nothing re-scored");
  assert.equal(row.rev, first.rev + 1, "the row was rewritten, so ai_model was decided again");
  for (const x of aiScored(row)) assert.equal(x.model, OLD, `q${x.position}`);
  assert.equal(row.ai_model, OLD, "not relabelled with today's model");
});

test("one question bought again on the newer model next to kept ones: the row says mixed", async () => {
  const { db, model } = await scoredOn(OLD);
  const target = aiScored(rowOf(db))[0];
  Object.assign(target, {
    score: null,
    confidence: null,
    rationale: null,
    quotes: [],
    dropped_quotes: 0,
    model: null,
    prompt_version: null,
    input_tokens: 0,
    output_tokens: 0,
  });
  const calls = model.requests.length;

  await withModel(NOW, () => runScorer(db, model));
  const row = rowOf(db);
  assert.equal(model.requests.length, calls + 1, "only that question was bought again");
  const models = new Set(aiScored(row).map((x) => x.model));
  assert.deepEqual([...models].sort(), [NOW, OLD].sort());
  assert.equal(row.ai_model, LIVE_SCORING_MIXED_MODELS);
  // The same session's prompt_version stays single: both runs used the same prompt.
  assert.notEqual(row.prompt_version, LIVE_SCORING_MIXED_VERSIONS);
});
