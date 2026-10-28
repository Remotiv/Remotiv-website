/**
 * Scoring an AI Video Interview (lib/interviews/live-scoring.ts, lib/ai/
 * live-interview-scoring.ts), the job-level guides (live-guides.ts) and the
 * recovery actions (live-recovery.ts), on the commit 2 fixture saved by
 * live-ingest.ts and transcribed by live-transcribe.ts into fake-live-db.mjs,
 * which enforces migration 042's rules. The model and Whisper are fakes.
 * Every word is made up. Nothing leaves the machine.
 *
 *   node --test src/lib/interviews/live-scoring.test.ts
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
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
  scoreLiveSession,
  planLiveScoring,
  overallFrom,
  exchangeFor,
  LOWEST_SCORE,
  rowStatus,
  countingLiveScore,
  requestLiveScoring,
} = await import("./live-scoring.ts");
const {
  buildLiveScoringMessage,
  isCandidateQuote,
  LIVE_SCORING_PROMPT_VERSION,
  LIVE_SYSTEM_PROMPT,
  styleSentences,
  withoutStyleSentences,
} = await import("../ai/live-interview-scoring.ts");
const {
  retryTranscription,
  resolveNeedsCheck,
  resolveRepeatCheck,
  resolveStyleCheck,
  resolveWordingCheck,
  resolveFailedTranscription,
  LiveRecoveryError,
} = await import("./live-recovery.ts");
const { ensureJobQuestionGuide, questionSha256 } = await import("./live-guides.ts");
const { purgeLiveScoreWords } = await import("./live-score-purge.ts");
const { handleLiveTurnTranscribe } = await import("./live-transcribe.ts");
const { handleAiScorecard } = await import("../ai/interview-scoring.ts");
const { CONFIRMED_EXIT_CODES, saveLiveExport } = await import("./live-ingest.ts");

/** D10 switched on for one test: candidate_ended counts as a confirmed exit, for the whole test. */
async function withD10(fn) {
  CONFIRMED_EXIT_CODES.add("candidate_ended");
  try {
    return await fn();
  } finally {
    CONFIRMED_EXIT_CODES.delete("candidate_ended");
  }
}

const { parseExport } = await import("./live-provider/parse-export.ts");
const { createFakeLiveProvider } = await import("./live-provider/fake-provider.ts");
const { snapshotsFor } = await import("./frozen-questions.ts");
const { ProviderHttpError } = await import("../queue/failure-class.ts");
const { fakeLiveDb } = await import("../../test-support/fake-live-db.mjs");

const FIXTURE = JSON.parse(
  readFileSync(new URL("./live-provider/__fixtures__/sample-export.json", import.meta.url), "utf8"),
);
const SESSION = "5b0f2c1e-0000-4000-8000-0000000000c7";
const CO = "7aad434d-0000-4000-8000-000000000001";
const OTHER_CO = "7aad434d-0000-4000-8000-000000000002";
const JOB = "2d4a8cde-0000-4000-8000-000000000007";
const APP = "03e4863f-0000-4000-8000-000000000007";
const GUIDE = (p) => `Strong answer: a specific example for question ${p}. Weak answer: general.`;
const QUESTIONS = FIXTURE.questions
  .filter((q) => q.position <= 8)
  .map((q) => ({
    question_id: `q-${q.position}`,
    position: q.position,
    text: q.text,
    source: q.position <= 4 ? "job" : "cv",
    competency: "Ownership",
    scoring_guide: GUIDE(q.position),
    guide_source: q.position <= 4 ? "recruiter" : "ai",
    weight: null,
  }));

function frozenRow() {
  return {
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
  };
}

async function quiet(fn) {
  const orig = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try {
    return await fn();
  } finally {
    Object.assign(console, orig);
  }
}

/** The fixture (or `raw`, another export) saved; candidate turns NOT yet transcribed. */
async function saved(raw = FIXTURE) {
  const db = fakeLiveDb({
    interview_sessions: [frozenRow()],
    jobs: [{ id: JOB, company_id: CO, title: "Backend Engineer" }],
    job_applications: [
      { id: APP, job_id: JOB, company_id_snapshot: CO, first_name: "Alex", last_name: "Example" },
    ],
  });
  const provider = createFakeLiveProvider(raw);
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
  return db;
}

const turnsOf = (db) => [...db.tables.interview_turns].sort((a, b) => a.sequence - b.sequence);
const candidateTurns = (db) => turnsOf(db).filter((t) => t.speaker === "candidate");
const positionOf = (db, t) =>
  t.question_position ??
  db.tables.interview_turns.find((x) => x.id === t.responds_to_turn_id)?.question_position;
const outcomeOf = (db) => db.tables.interview_sessions[0].live_outcome;
const scoreRow = (db) => db.tables.live_interview_scores.find((r) => r.session_id === SESSION);
const words = (db, t) =>
  `On question ${positionOf(db, t)} I personally rebuilt the import service in turn ${t.sequence} and cut the runtime in half.`;

/** Whisper, faked by turn: each candidate turn says something real and distinct. */
function whisperFor(db, fail, text) {
  return async (audio) => {
    const turn = [...db.objects.entries()].find(
      ([, o]) =>
        o.bytes.length === audio.bytes.length && o.bytes.every((b, i) => b === audio.bytes[i]),
    );
    const row = db.tables.interview_turns.find((t) => t.media_path === turn?.[0]);
    if (fail?.(row)) throw new ProviderHttpError("OpenAI", 503, "busy");
    return { text: text?.(row) ?? words(db, row), segments: [] };
  };
}
const jobFor = (turn, attempts = 0) => ({
  id: `job-${turn.sequence}-${attempts}`,
  payload: { turnId: turn.id, sessionId: SESSION },
  attempts,
  max_attempts: 3,
});
async function transcribe(db, turns = candidateTurns(db), { fail, onDecided, text } = {}) {
  for (const t of turns) {
    await quiet(() =>
      handleLiveTurnTranscribe(jobFor(t), undefined, {
        service: db.service,
        transcribe: whisperFor(db, fail, text),
        onDecided: onDecided ?? (async () => {}),
      }),
    );
  }
}

/** Saved and fully transcribed: the outcome decided, questions 1-5 needing a check. */
async function decided() {
  const db = await saved();
  await transcribe(db);
  return db;
}

const SCORES = { 1: 70, 2: 60, 3: 80, 4: 50, 5: 90, 6: 99, 7: 99, 8: 99 };

/** A fake model. Scores by question; quotes the candidate's first line unless told to quote Sarah. */
function fakeModel({ quote = "candidate", reply } = {}) {
  const requests = [];
  const perQuestion = new Map();
  const call = async (request) => {
    requests.push(structuredClone(request));
    const user = request.messages[0].content;
    const asked = user.match(/## Question asked\n([^\n]+)/)[1];
    const position = QUESTIONS.find((q) => q.text === asked).position;
    const firstOf = (who) =>
      user
        .split("\n")
        .find((l) => l.startsWith(`${who}: `))
        ?.slice(who.length + 2)
        .split(" ")
        .slice(0, 6)
        .join(" ");
    perQuestion.set(position, (perQuestion.get(position) ?? 0) + 1);
    const body = reply?.(position, perQuestion.get(position)) ?? {
      score: SCORES[position],
      confidence: "high",
      rationale: `The candidate described their own work on question ${position}.`,
      quotes:
        quote === "sarah"
          ? [firstOf("Candidate"), firstOf("Interviewer")]
          : quote === "only-sarah"
            ? [firstOf("Interviewer")]
            : [firstOf("Candidate")],
    };
    if (body instanceof Error) throw body;
    return {
      content: [{ type: "text", text: typeof body === "string" ? body : JSON.stringify(body) }],
      stop_reason: "end_turn",
      usage: { input_tokens: 900, output_tokens: 120 },
    };
  };
  return { requests, call };
}

const scorer = (db, model) => (id) =>
  quiet(() => scoreLiveSession(id, { service: db.service, call: model.call, enabled: true }));

const OWNER = {
  kind: "company",
  userId: "u-owner",
  name: "Olu Owner",
  role: "owner",
  companyId: CO,
};
const ADMIN = {
  kind: "company",
  userId: "u-admin",
  name: "Ada Admin",
  role: "admin",
  companyId: CO,
};
const SUPER = { kind: "platform", userId: "u-super", name: null, role: "super_admin" };

function recovery(db, model, caller = ADMIN) {
  const asked = [];
  return {
    asked,
    deps: {
      service: db.service,
      caller,
      transcriptSource: async (_service, sessionId) => {
        asked.push(sessionId);
        return 1;
      },
      score: scorer(db, model),
    },
  };
}

/**
 * A person resolves every timing check, then every wording check (F12: the
 * sample folds the greeting into question 1, so question 1 always has one).
 */
async function resolveAllChecks(db, model, decision = "score", caller = ADMIN) {
  const { deps } = recovery(db, model, caller);
  for (const q of outcomeOf(db).questions.filter((x) => x.needs_check)) {
    await quiet(() =>
      resolveNeedsCheck(
        { sessionId: SESSION, position: q.position, decision, note: "Checked the audio." },
        deps,
      ),
    );
  }
  for (const q of outcomeOf(db).questions.filter((x) => x.wording_check)) {
    await quiet(() =>
      resolveWordingCheck(
        { sessionId: SESSION, position: q.position, decision, note: "Checked the recording." },
        deps,
      ),
    );
  }
}

const byPosition = (row) => Object.fromEntries(row.questions.map((q) => [q.position, q]));

/* ── eligibility ──────────────────────────────────────────────── */

test("not final: nothing is scored, no model call, the row waits", async () => {
  const db = await saved();
  const model = fakeModel();
  const row = await scorer(db, model)(SESSION);
  assert.equal(model.requests.length, 0);
  assert.equal(row.status, "pending");
  assert.equal(row.overall_score, null);
  assert.ok(row.questions.every((q) => q.status === "waiting" && q.reason === "not_final"));
  assert.deepEqual([row.outcome, row.partial], [null, false]);
});

test("needs_check waits for a person; 'score' scores it, 'exclude' leaves it out, never zero", async () => {
  const db = await decided();
  const model = fakeModel();
  let row = await scorer(db, model)(SESSION);
  assert.equal(
    model.requests.length,
    0,
    "every answered question of the fixture is timing suspect",
  );
  assert.deepEqual(
    row.questions.map((q) => [q.position, q.status, q.reason]),
    [
      [1, "waiting", "needs_check"],
      [2, "waiting", "needs_check"],
      [3, "waiting", "needs_check"],
      [4, "waiting", "needs_check"],
      [5, "waiting", "needs_check"],
      [6, "lowest", "skipped"],
      [7, "left_out", "not_reached"],
      [8, "left_out", "not_reached"],
    ],
  );
  assert.equal(row.status, "pending");
  assert.equal(row.overall_score, null, "no overall while a question waits");

  const { deps } = recovery(db, model);
  await quiet(() =>
    resolveNeedsCheck(
      {
        sessionId: SESSION,
        position: 1,
        decision: "score",
        note: "Answer starts after the question.",
      },
      deps,
    ),
  );
  await quiet(() =>
    resolveNeedsCheck(
      { sessionId: SESSION, position: 2, decision: "exclude", note: "Talked over the question." },
      deps,
    ),
  );
  // Question 1 also waits for its own wording check (the greeting is folded
  // into it, F12): the timing decision never clears that.
  assert.deepEqual(
    [byPosition(scoreRow(db))[1].status, byPosition(scoreRow(db))[1].reason],
    ["waiting", "wording_check"],
  );
  assert.equal(model.requests.length, 0, "still nothing sent");
  await quiet(() =>
    resolveWordingCheck(
      { sessionId: SESSION, position: 1, decision: "score", note: "Greeting, then the question." },
      deps,
    ),
  );
  row = scoreRow(db);
  const q = byPosition(row);
  assert.deepEqual([q[1].status, q[1].score], ["scored", 70]);
  assert.deepEqual(
    [q[2].status, q[2].reason, q[2].score],
    ["left_out", "excluded_by_reviewer", null],
  );
  assert.equal(model.requests.length, 1, "only the question resolved 'score' was sent");
  assert.equal(row.status, "pending", "3, 4 and 5 still wait");
});

test("skipped: the lowest score with no model call; not_reached: left out, not zero", async () => {
  const db = await decided();
  const model = fakeModel();
  await resolveAllChecks(db, model);
  const row = scoreRow(db);
  const q = byPosition(row);
  assert.deepEqual([q[6].status, q[6].score, q[6].model], ["lowest", LOWEST_SCORE, null]);
  assert.deepEqual(
    [q[7].status, q[7].score, q[8].status, q[8].score],
    ["left_out", null, "left_out", null],
  );
  const sent = model.requests.map(
    (r) => r.messages[0].content.match(/## Question asked\n([^\n]+)/)[1],
  );
  assert.deepEqual(
    sent.map((t) => QUESTIONS.find((x) => x.text === t).position).sort(),
    [1, 2, 3, 4, 5],
    "questions 6, 7 and 8 were never sent",
  );
});

test("a partial interview: the overall from answered and skipped only, completion % stored, flagged partial", () =>
  withD10(async () => {
    const db = await decided();
    const model = fakeModel();
    await resolveAllChecks(db, model);
    const row = scoreRow(db);
    // (70 + 60 + 80 + 50 + 90 + 0) / 6, questions 7 and 8 not in it.
    assert.deepEqual(
      [
        row.status,
        row.overall_score,
        row.scored_count,
        row.answered_count,
        row.total,
        row.completion_percent,
      ],
      ["scored", 58, 6, 5, 8, 63],
    );
    assert.deepEqual([row.outcome, row.partial], ["partial", true]);
    assert.deepEqual([row.prompt_version, row.rev >= 1], [LIVE_SCORING_PROMPT_VERSION, true]);
    assert.equal(overallFrom(row.questions).overall, 58);
  }));

test("re-scoring a scored session buys nothing again and changes no score", async () => {
  const db = await decided();
  const model = fakeModel();
  await resolveAllChecks(db, model);
  const before = structuredClone(scoreRow(db));
  const calls = model.requests.length;
  await scorer(db, model)(SESSION);
  assert.equal(model.requests.length, calls);
  assert.deepEqual(
    scoreRow(db).questions.map((q) => [q.position, q.score, q.rationale]),
    before.questions.map((q) => [q.position, q.score, q.rationale]),
  );
  assert.equal(scoreRow(db).rev, before.rev + 1);
});

/* ── a failed transcription ───────────────────────────────────── */

async function withFailedTurn() {
  const db = await saved();
  const turns = candidateTurns(db);
  const stuck = turns.find((t) => positionOf(db, t) === 3);
  await transcribe(
    db,
    turns.filter((t) => t.id !== stuck.id),
  );
  await assert.rejects(
    quiet(() =>
      handleLiveTurnTranscribe(jobFor(stuck, 2), undefined, {
        service: db.service,
        transcribe: whisperFor(db, () => true),
        onDecided: async () => {},
      }),
    ),
  );
  assert.equal(
    db.tables.interview_turns.find((t) => t.id === stuck.id).transcript_status,
    "failed",
  );
  return { db, stuck };
}

test("a failed transcription: nothing scored; retry asks the current source again, then it scores", async () => {
  const { db, stuck } = await withFailedTurn();
  const model = fakeModel();
  await resolveAllChecks(db, model);
  assert.equal(model.requests.length, 0, "the outcome is not decided while a turn has failed");
  assert.ok(scoreRow(db).questions.every((q) => q.reason === "not_final"));

  const r = recovery(db, model);
  await quiet(() =>
    retryTranscription({ sessionId: SESSION, turnId: stuck.id, note: "Whisper was down." }, r.deps),
  );
  assert.deepEqual(
    r.asked,
    [SESSION],
    "the transcript was asked for again, from the injected source",
  );
  assert.equal(
    db.tables.interview_turns.find((t) => t.id === stuck.id).transcript_status,
    "pending",
  );
  assert.deepEqual(outcomeOf(db).transcription_failed_turns, []);

  // The source delivers; the settle decides the outcome and asks for scoring once.
  const decidedCalls = [];
  await transcribe(db, [db.tables.interview_turns.find((t) => t.id === stuck.id)], {
    onDecided: async (_s, id) => decidedCalls.push(id),
  });
  assert.deepEqual(decidedCalls, [SESSION]);
  const row = await scorer(db, model)(SESSION);
  assert.deepEqual([byPosition(row)[3].status, byPosition(row)[3].score], ["scored", 80]);
  assert.equal(row.status, "scored");
});

test("a failed transcription excluded by a person: its question is left out, never zero; the rest score", async () => {
  const { db, stuck } = await withFailedTurn();
  const model = fakeModel();
  await resolveAllChecks(db, model);
  const r = recovery(db, model);
  await quiet(() =>
    resolveFailedTranscription(
      { sessionId: SESSION, turnId: stuck.id, decision: "exclude", note: "The audio is corrupt." },
      r.deps,
    ),
  );
  assert.equal(outcomeOf(db).final, true, "an excluded failed turn counts as resolved");
  assert.deepEqual(
    outcomeOf(db).transcription_failed_turns,
    [stuck.sequence],
    "the failure stays on record",
  );
  const row = scoreRow(db);
  const q = byPosition(row);
  assert.deepEqual(
    [q[3].status, q[3].reason, q[3].score],
    ["left_out", "transcription_excluded", null],
  );
  // (70 + 60 + 50 + 90 + 0) / 5
  assert.deepEqual([row.status, row.overall_score, row.scored_count], ["scored", 54, 5]);
  assert.deepEqual(r.asked, [], "excluding never asks for a transcript");
});

/* ── an empty transcript over a possible answer (B4) ──────────── */

/** A 16 kHz mono 16-bit WAV, `ms` long; a tone at `db` (RMS, dBFS) for `soundMs` of it, silence after. */
function wav(ms, soundMs = 0, db = -24) {
  const rate = 16_000;
  const frames = Math.round((rate * ms) / 1000);
  const bytes = new Uint8Array(44 + frames * 2);
  const view = new DataView(bytes.buffer);
  const tag = (at, t) => {
    for (let i = 0; i < 4; i++) bytes[at + i] = t.charCodeAt(i);
  };
  tag(0, "RIFF");
  view.setUint32(4, bytes.length - 8, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  tag(36, "data");
  view.setUint32(40, frames * 2, true);
  const loud = Math.round((rate * soundMs) / 1000);
  const amplitude = 10 ** (db / 20) * Math.SQRT2 * 32767;
  for (let f = 0; f < loud; f++) {
    view.setInt16(
      44 + f * 2,
      Math.round(amplitude * Math.sin((2 * Math.PI * 220 * f) / rate)),
      true,
    );
  }
  return bytes;
}

/**
 * Question 3's candidate turns (three in the fixture) stored with `audio(i)`,
 * transcribed as nothing at all; every other turn as a real answer.
 */
async function emptyOnQuestion3(audio) {
  const db = await saved();
  const q3 = candidateTurns(db).filter((t) => positionOf(db, t) === 3);
  q3.forEach((t, i) => {
    db.objects.get(t.media_path).bytes = audio(i);
  });
  await transcribe(db, candidateTurns(db), {
    text: (row) => (positionOf(db, row) === 3 ? "" : undefined),
  });
  return { db, q3: q3.map((t) => db.tables.interview_turns.find((x) => x.id === t.id)) };
}

test("B4: a 20-second answer transcribed as nothing is held for a person, never scored 0", async () => {
  const { db, q3 } = await emptyOnQuestion3((i) => wav(20_000 + i * 20, 15_000));
  for (const t of q3) {
    assert.deepEqual(
      [t.transcript_status, t.transcript_error],
      ["failed", "Transcription returned nothing."],
    );
  }
  const o = outcomeOf(db);
  assert.equal(o.final, false, "held: the outcome is not decided");
  assert.equal(o.needs_review, true);
  assert.deepEqual(
    o.transcription_failed_turns,
    q3.map((t) => t.sequence),
  );
  assert.equal(o.questions.find((q) => q.position === 3).status, "answered", "never skipped");
  const model = fakeModel();
  await resolveAllChecks(db, model);
  assert.equal(model.requests.length, 0, "nothing is scored while it is held");
  const row = scoreRow(db);
  assert.ok(row.questions.every((q) => q.reason === "not_final"));
  assert.ok(row.questions.every((q) => q.status !== "lowest" && q.score === null));
});

test("B4: a 1.5-second spoken 'yes' and quiet speech at -45 dBFS, transcribed as nothing, are held too", async () => {
  for (const [label, audio] of [
    ["1.5 s yes", (i) => wav(1_500 + i * 20, 400)],
    ["quiet, -45 dBFS", (i) => wav(20_000 + i * 20, 3_000, -45)],
  ]) {
    const { db, q3 } = await emptyOnQuestion3(audio);
    assert.ok(
      q3.every((t) => t.transcript_status === "failed"),
      label,
    );
    assert.equal(outcomeOf(db).final, false, label);
    assert.equal(outcomeOf(db).questions.find((q) => q.position === 3).status, "answered", label);
    const model = fakeModel();
    await resolveAllChecks(db, model);
    assert.ok(
      scoreRow(db).questions.every((q) => q.status !== "lowest" && q.score === null),
      label,
    );
  }
});

test("B4: a held answer, retried: the transcript comes back and it is scored normally", async () => {
  const { db, q3 } = await emptyOnQuestion3((i) => wav(20_000 + i * 20, 15_000));
  const model = fakeModel();
  await resolveAllChecks(db, model);
  const r = recovery(db, model);
  for (const t of q3) {
    await quiet(() =>
      retryTranscription(
        { sessionId: SESSION, turnId: t.id, note: "I can hear an answer." },
        r.deps,
      ),
    );
  }
  const now = () => q3.map((t) => db.tables.interview_turns.find((x) => x.id === t.id));
  assert.ok(now().every((t) => t.transcript_status === "pending"));
  await transcribe(db, now());
  assert.equal(outcomeOf(db).final, true);
  const row = await scorer(db, model)(SESSION);
  assert.deepEqual([byPosition(row)[3].status, byPosition(row)[3].score], ["scored", 80]);
});

test("B4: a held answer left out by a person: no score for it, never 0; the rest score", async () => {
  const { db, q3 } = await emptyOnQuestion3((i) => wav(20_000 + i * 20, 15_000));
  const model = fakeModel();
  await resolveAllChecks(db, model);
  const r = recovery(db, model);
  for (const t of q3) {
    await quiet(() =>
      resolveFailedTranscription(
        { sessionId: SESSION, turnId: t.id, decision: "exclude", note: "Nothing usable in it." },
        r.deps,
      ),
    );
  }
  const q = byPosition(scoreRow(db));
  assert.deepEqual(
    [q[3].status, q[3].reason, q[3].score],
    ["left_out", "transcription_excluded", null],
  );
  assert.equal(scoreRow(db).status, "scored");
});

test("B4: measured silence and a very short silent turn stay skipped, scored the lowest as before", async () => {
  for (const [label, audio] of [
    ["20 seconds of silence", (i) => wav(20_000 + i * 20)],
    ["1.2 seconds of silence", (i) => wav(1_200 + i * 20)],
  ]) {
    const { db, q3 } = await emptyOnQuestion3(audio);
    assert.ok(
      q3.every((t) => t.transcript_status === "done"),
      label,
    );
    assert.deepEqual(outcomeOf(db).transcription_failed_turns, [], label);
    assert.equal(outcomeOf(db).questions.find((q) => q.position === 3).status, "skipped", label);
    const model = fakeModel();
    await resolveAllChecks(db, model);
    const q = byPosition(scoreRow(db));
    assert.deepEqual([q[3].status, q[3].reason, q[3].score], ["lowest", "skipped", 0], label);
  }
});

/* ── what the scorer is given ─────────────────────────────────── */

test("the scorer never gets follow-up counts or reasons, the name, or any turn metadata", async () => {
  const db = await decided();
  const model = fakeModel();
  await resolveAllChecks(db, model);
  assert.equal(model.requests.length, 5);
  const reasons = db.tables.interview_turns.map((t) => t.follow_up_reason).filter(Boolean);
  assert.ok(reasons.length > 0, "the fixture has follow-up reasons to leak");
  const walk = (v, out = []) => {
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) for (const x of v) walk(x, out);
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk([k, x], out);
    return out;
  };
  for (const req of model.requests) {
    const strings = walk(req);
    const all = strings.join("\n");
    for (const reason of reasons)
      assert.ok(!all.includes(reason), "a follow-up reason reached the scorer");
    for (const s of strings) {
      assert.doesNotMatch(s, /\b(\d+|one|two|three)\s+follow[- ]?ups?\b/i);
      assert.doesNotMatch(
        s,
        /follow[_ -]?up[_ -]?(count|index|reason|s:)|follow_ups|repeats|needs_check|timing/i,
      );
    }
    assert.doesNotMatch(all, /\bAlex\b|\bExample\b/, "the candidate's name");
    // Only the four sections and the exchange: nothing else is in the message.
    assert.deepEqual(req.messages[0].content.match(/^## .+$/gm), [
      "## Question asked",
      "## Competency being assessed",
      "## Private scoring guide",
    ]);
  }
  // The fixture's opening line greets the candidate by name: scrubbed, not dropped.
  assert.match(
    model.requests.find((r) => r.messages[0].content.includes(QUESTIONS[0].text)).messages[0]
      .content,
    /Hi \[candidate\]/,
  );
});

test("the exchange: base question, follow-ups and answers in order; never procedural turns", async () => {
  const db = await decided();
  const turns = turnsOf(db);
  const lines = exchangeFor(2, turns, { firstName: "Alex", lastName: "Example" });
  const mine = turns.filter((t) => positionOf(db, t) === 2);
  const expected = mine.filter(
    (t) =>
      t.speaker === "candidate" || ["base_question", "follow_up", "clarification"].includes(t.kind),
  );
  assert.equal(lines.length, expected.length);
  assert.deepEqual(
    lines.map((l) => l.speaker),
    expected.map((t) => t.speaker),
  );
  assert.ok(lines.every((l) => Object.keys(l).sort().join() === "speaker,text"));
  assert.ok(
    buildLiveScoringMessage({
      question: "Q?",
      competency: null,
      guide: "G",
      exchange: lines,
    }).includes("Candidate: On question 2"),
  );
});

test("quotes: Sarah's words are rejected, the candidate's kept; mostly-Sarah fails the question, never zero", async () => {
  const db = await decided();
  const mixed = fakeModel({ quote: "sarah" });
  await resolveAllChecks(db, mixed);
  const row = scoreRow(db);
  for (const q of row.questions.filter((x) => x.status === "scored")) {
    assert.equal(q.quotes.length, 1, "Sarah's quote dropped");
    assert.equal(q.dropped_quotes, 1);
    assert.equal(q.confidence, "medium", "confidence down one step");
    assert.match(q.quotes[0], /^On question/);
  }
  const turns = turnsOf(db);
  const exchange = exchangeFor(1, turns, { firstName: "Alex", lastName: "Example" });
  const sarah = exchange
    .find((l) => l.speaker === "interviewer")
    .text.split(" ")
    .slice(0, 6)
    .join(" ");
  assert.equal(isCandidateQuote(sarah, exchange), false);

  const db2 = await decided();
  await resolveAllChecks(db2, fakeModel({ quote: "only-sarah" }));
  const q2 = byPosition(scoreRow(db2));
  assert.deepEqual([q2[1].status, q2[1].reason, q2[1].score], ["left_out", "scoring_failed", null]);
});

test("a malformed reply is retried once; twice malformed leaves the question out, never zero", async () => {
  const db = await decided();
  const model = fakeModel({
    reply: (p, n) => (p === 1 && n === 1 ? "not json" : p === 2 ? { score: "high" } : undefined),
  });
  await resolveAllChecks(db, model);
  const q = byPosition(scoreRow(db));
  assert.deepEqual([q[1].status, q[1].score], ["scored", 70], "retried once and scored");
  assert.deepEqual([q[2].status, q[2].reason, q[2].score], ["left_out", "scoring_failed", null]);
});

test("a retryable provider failure: that question waits, the rest are kept, the error goes to the queue", async () => {
  const db = await decided();
  const failing = fakeModel({
    reply: (p) => (p === 1 ? new ProviderHttpError("Anthropic", 529, "overloaded") : undefined),
  });
  const { deps } = recovery(db, failing);
  // Its wording check first (the greeting, F12): question 1 still waits for timing, so no call yet.
  await quiet(() =>
    resolveWordingCheck({ sessionId: SESSION, position: 1, decision: "score", note: "ok" }, deps),
  );
  await assert.rejects(
    quiet(() =>
      resolveNeedsCheck({ sessionId: SESSION, position: 1, decision: "score", note: "ok" }, deps),
    ),
    ProviderHttpError,
  );
  assert.deepEqual(
    [byPosition(scoreRow(db))[1].status, byPosition(scoreRow(db))[1].reason],
    ["waiting", "scoring_retry"],
  );
});

/* ── who may act, and the log ─────────────────────────────────── */

test("only the company's owner or admin may act, never a super admin; every action is logged", async () => {
  const db = await decided();
  const model = fakeModel();
  const refused = [
    { kind: "company", userId: "u-r", name: "R", role: "recruiter", companyId: CO },
    { kind: "company", userId: "u-h", name: "H", role: "hiring_manager", companyId: CO },
    { kind: "company", userId: "u-x", name: "X", role: "admin", companyId: OTHER_CO },
    { kind: "platform", userId: "u-p", name: null, role: "admin" },
    // F4: a Remotiv super admin views read-only and never acts.
    SUPER,
    { kind: "company", userId: "u-s", name: null, role: "super_admin", companyId: CO },
  ];
  const stuck = candidateTurns(db)[0];
  for (const caller of refused) {
    const { deps } = recovery(db, model, caller);
    for (const run of [
      () =>
        resolveNeedsCheck({ sessionId: SESSION, position: 1, decision: "score", note: "x" }, deps),
      () => retryTranscription({ sessionId: SESSION, turnId: stuck.id, note: "x" }, deps),
      () =>
        resolveFailedTranscription(
          { sessionId: SESSION, turnId: stuck.id, decision: "exclude", note: "x" },
          deps,
        ),
    ]) {
      await assert.rejects(
        quiet(run),
        (e) => e instanceof LiveRecoveryError && e.code === "forbidden",
      );
    }
  }
  assert.equal(db.tables.live_interview_actions.length, 0);
  assert.equal(db.tables.live_interview_scores.length, 0, "nothing re-scored for a refused caller");

  // A note is required.
  await assert.rejects(
    quiet(() =>
      resolveNeedsCheck(
        { sessionId: SESSION, position: 1, decision: "score", note: "  " },
        recovery(db, model, OWNER).deps,
      ),
    ),
    (e) => e.code === "bad_input",
  );

  for (const [caller, position] of [
    [OWNER, 1],
    [ADMIN, 2],
  ]) {
    await quiet(() =>
      resolveNeedsCheck(
        { sessionId: SESSION, position, decision: "score", note: `Checked q${position}.` },
        recovery(db, model, caller).deps,
      ),
    );
  }
  assert.deepEqual(
    db.tables.live_interview_actions.map((a) => [
      a.action,
      a.decision,
      a.question_position,
      a.actor_user_id,
      a.actor_role,
      a.note,
      a.company_id,
      typeof a.created_at,
    ]),
    [
      ["resolve_needs_check", "score", 1, "u-owner", "owner", "Checked q1.", CO, "string"],
      ["resolve_needs_check", "score", 2, "u-admin", "admin", "Checked q2.", CO, "string"],
    ],
  );
  // Append-only: the log cannot be edited.
  const { error } = await db.service
    .from("live_interview_actions")
    .update({ note: "edited" })
    .eq("session_id", SESSION);
  assert.ok(error);
});

test("resolving a question with no timing check, or retrying a turn that did not fail, is refused and not logged", async () => {
  const db = await decided();
  const model = fakeModel();
  const { deps } = recovery(db, model);
  await assert.rejects(
    quiet(() =>
      resolveNeedsCheck({ sessionId: SESSION, position: 6, decision: "score", note: "x" }, deps),
    ),
    (e) => e.code === "no_check",
  );
  await assert.rejects(
    quiet(() =>
      retryTranscription({ sessionId: SESSION, turnId: candidateTurns(db)[0].id, note: "x" }, deps),
    ),
    (e) => e.code === "not_failed",
  );
  assert.equal(db.tables.live_interview_actions.length, 0);
});

/* ── the job's guides ─────────────────────────────────────────── */

function guideClient({ delay = false } = {}) {
  const calls = [];
  let n = 0;
  return {
    calls,
    messages: {
      async create(request) {
        calls.push(request);
        n += 1;
        const mine = n;
        if (delay) await new Promise((r) => setTimeout(r, 5));
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                strong: `Names one specific incident, the candidate's own first steps and the fix (draft ${mine}).`,
                weak: "Describes what the team did without their own part, or gives no outcome at all.",
              }),
            },
          ],
          stop_reason: "end_turn",
          usage: { input_tokens: 300, output_tokens: 80 },
        };
      },
    },
  };
}

const GUIDE_INPUT = {
  jobId: JOB,
  companyId: CO,
  jobTitle: "Backend Engineer",
  question: "Tell me about a production incident you owned.",
  competency: null,
};

test("a job question's guide is written once: two sessions, two candidates, one generation, one guide", async () => {
  const db = await saved();
  const client = guideClient();
  const a = await quiet(() => ensureJobQuestionGuide(db.service, GUIDE_INPUT, { client }));
  const b = await quiet(() =>
    ensureJobQuestionGuide(
      db.service,
      { ...GUIDE_INPUT, question: "  tell me about a production   INCIDENT you owned. " },
      { client },
    ),
  );
  assert.equal(client.calls.length, 1);
  assert.deepEqual([a.created, b.created, b.calls], [true, false, 0]);
  assert.equal(a.guide, b.guide);
  assert.equal(db.tables.job_question_scoring_guides.length, 1);
  const row = db.tables.job_question_scoring_guides[0];
  assert.deepEqual(
    [row.source, row.ai_model != null, row.prompt_version],
    ["ai", true, "live-guide-v1"],
  );
  assert.equal(row.question_sha256, questionSha256(GUIDE_INPUT.question));
  // Nothing about any candidate in what the guide writer saw.
  assert.doesNotMatch(JSON.stringify(client.calls), /Alex|Example/);
  // Another job, or another wording, is its own guide.
  await quiet(() =>
    ensureJobQuestionGuide(
      db.service,
      { ...GUIDE_INPUT, question: "Tell me about a slow query you fixed." },
      { client },
    ),
  );
  assert.equal(db.tables.job_question_scoring_guides.length, 2);
});

test("two calls at once: both may write, one guide lands, and both return it", async () => {
  const db = await saved();
  const client = guideClient({ delay: true });
  const [a, b] = await quiet(() =>
    Promise.all([
      ensureJobQuestionGuide(db.service, GUIDE_INPUT, { client }),
      ensureJobQuestionGuide(db.service, GUIDE_INPUT, { client }),
    ]),
  );
  assert.equal(db.tables.job_question_scoring_guides.length, 1);
  assert.equal(a.guide, b.guide);
  assert.equal(a.guide, db.tables.job_question_scoring_guides[0].guide);
  assert.equal([a.created, b.created].filter(Boolean).length, 1);
});

test("a guide is the job's company's only; a later change to it never reaches a frozen session", async () => {
  const db = await decided();
  await assert.rejects(
    quiet(() =>
      ensureJobQuestionGuide(
        db.service,
        { ...GUIDE_INPUT, companyId: OTHER_CO },
        { client: guideClient() },
      ),
    ),
  );
  db.tables.job_question_scoring_guides.push({
    job_id: JOB,
    company_id: CO,
    question_sha256: questionSha256(QUESTIONS[0].text),
    source: "ai",
    guide: "A LATER GUIDE THAT MUST NOT BE USED.",
    ai_model: "m",
    prompt_version: "v",
  });
  const model = fakeModel();
  await resolveAllChecks(db, model);
  const all = JSON.stringify(model.requests);
  assert.ok(!all.includes("A LATER GUIDE"));
  assert.ok(all.includes(GUIDE(1)), "the guide frozen into the session is the one used");
});

/* ── routing, retention ───────────────────────────────────────── */

test("the ai_scorecard job routes a live session to the live scorer, never the async one", async () => {
  const db = await decided();
  const before = process.env.AI_INTERVIEW_SCORING_ENABLED;
  delete process.env.AI_INTERVIEW_SCORING_ENABLED;
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(" "));
  try {
    await handleAiScorecard({ id: "job-sc", payload: { sessionId: SESSION } });
  } finally {
    console.log = orig;
    if (before !== undefined) process.env.AI_INTERVIEW_SCORING_ENABLED = before;
  }
  assert.ok(lines.some((l) => l.includes("[live-scoring]") && l.includes("scoring is off")));
  const tables = new Set(db.service.queries.map((q) => q.table));
  assert.ok(!tables.has("interview_session_scores") && !tables.has("interview_answers"));
});

test("retention: words cleared from the scores, numbers kept; a purged session is never re-scored", async () => {
  const db = await decided();
  const model = fakeModel();
  await resolveAllChecks(db, model);
  const before = structuredClone(scoreRow(db));
  assert.ok(before.questions.some((q) => q.rationale && q.quotes.length > 0));
  assert.equal(await purgeLiveScoreWords(db.service, [SESSION]), 1);
  const after = scoreRow(db);
  for (const q of after.questions) {
    assert.equal(q.rationale, null);
    assert.deepEqual(q.quotes, []);
  }
  assert.deepEqual(
    after.questions.map((q) => [q.position, q.status, q.reason, q.score, q.confidence]),
    before.questions.map((q) => [q.position, q.status, q.reason, q.score, q.confidence]),
  );
  assert.deepEqual(
    [after.overall_score, after.scored_count, after.completion_percent, after.partial],
    [before.overall_score, before.scored_count, before.completion_percent, before.partial],
  );
  assert.equal(await purgeLiveScoreWords(db.service, [SESSION]), 0, "a second run does nothing");

  // The turns' words go with the same purge; the scorer then writes nothing back.
  for (const t of db.tables.interview_turns) t.content_purged_at = new Date().toISOString();
  const calls = model.requests.length;
  assert.equal(await scorer(db, model)(SESSION), null);
  assert.equal(model.requests.length, calls);
  assert.ok(scoreRow(db).questions.every((q) => q.rationale === null));
});

/* ── the plan, pure ───────────────────────────────────────────── */

test("planLiveScoring: every rule, in order", () => {
  const facts = (over) => ({
    position: 1,
    source: "job",
    status: "answered",
    confirmed: true,
    needs_check: false,
    ...over,
  });
  const outcome = (qs, final = true) => ({ final, questions: qs });
  const qs = (n) => Array.from({ length: n }, (_, i) => ({ position: i + 1, scoring_guide: "G" }));
  const none = { needsCheck: new Map(), excludedPositions: new Set() };
  const one = (f, resolved = none, final = true, guide = "G") =>
    planLiveScoring(
      outcome([facts(f)], final),
      [{ position: 1, scoring_guide: guide }],
      resolved,
    )[0];
  assert.deepEqual(planLiveScoring(outcome([facts({})], false), qs(1), none)[0], {
    position: 1,
    decision: "wait",
    reason: "not_final",
  });
  assert.deepEqual(planLiveScoring(null, qs(1), none)[0].reason, "not_final");
  assert.equal(one({}).decision, "ai");
  assert.deepEqual(
    [
      one({ status: "not_reached", confirmed: null }).decision,
      one({ status: "not_reached" }).reason,
    ],
    ["left_out", "not_reached"],
  );
  assert.deepEqual([one({ status: "skipped", confirmed: null }).decision], ["lowest"]);
  assert.deepEqual(
    [one({ confirmed: false }).decision, one({ confirmed: false }).reason],
    ["wait", "unconfirmed"],
  );
  assert.deepEqual(
    [one({ needs_check: true }).decision, one({ needs_check: true }).reason],
    ["wait", "needs_check"],
  );
  assert.equal(
    one({ needs_check: true }, { ...none, needsCheck: new Map([[1, "score"]]) }).decision,
    "ai",
  );
  assert.deepEqual(one({ needs_check: true }, { ...none, needsCheck: new Map([[1, "exclude"]]) }), {
    position: 1,
    decision: "left_out",
    reason: "excluded_by_reviewer",
  });
  // A timing check applies to a skipped question too: not scored at the lowest until resolved.
  assert.equal(one({ status: "skipped", confirmed: null, needs_check: true }).decision, "wait");
  assert.deepEqual(
    one({}, { ...none, excludedPositions: new Set([1]) }).reason,
    "transcription_excluded",
  );
  assert.deepEqual(one({}, none, true, null).reason, "no_guide");
});

/* ── fix round: no overall when incomplete, the attempt that counts ── */

/** Fully transcribed, with questions 4 and 5 filler-only: partial becomes abandoned, restart allowed. */
async function abandoned() {
  const db = await saved();
  await transcribe(db, candidateTurns(db), {
    text: (row) => ([4, 5].includes(positionOf(db, row)) ? "um... uh" : undefined),
  });
  return db;
}

test("abandoned: per-question scores and evidence kept, NO overall, status incomplete", () =>
  withD10(async () => {
    const db = await abandoned();
    const o = outcomeOf(db);
    assert.deepEqual([o.outcome, o.final, o.restart_allowed], ["abandoned", true, true]);
    const model = fakeModel();
    await resolveAllChecks(db, model);
    const row = scoreRow(db);
    assert.deepEqual(
      [row.status, row.overall_score, row.outcome, row.partial],
      ["incomplete", null, "abandoned", true],
    );
    assert.deepEqual([row.answered_count, row.skipped_count, row.total], [3, 3, 8]);
    const q = byPosition(row);
    assert.deepEqual(
      [1, 2, 3].map((p) => [q[p].status, q[p].score, q[p].quotes.length > 0]),
      [
        ["scored", 70, true],
        ["scored", 60, true],
        ["scored", 80, true],
      ],
      "the evidence is kept",
    );
    assert.deepEqual(
      [4, 5, 6].map((p) => [q[p].status, q[p].score]),
      [
        ["lowest", 0],
        ["lowest", 0],
        ["lowest", 0],
      ],
    );
    assert.equal(row.scored_count, 6);
  }));

test("the row status: incomplete for abandoned and technical failure, or nothing scorable; scored otherwise", () => {
  assert.equal(rowStatus("abandoned", false, 6), "incomplete");
  assert.equal(rowStatus("technical_failure", false, 4), "incomplete");
  assert.equal(rowStatus("completed", false, 0), "incomplete", "every question excluded");
  assert.equal(rowStatus("partial", false, 0), "incomplete");
  assert.equal(rowStatus("completed", false, 8), "scored");
  assert.equal(rowStatus("partial", false, 6), "scored");
  assert.equal(rowStatus("completed", true, 8), "pending", "a question still waits");
  assert.equal(rowStatus(null, false, 0), "pending", "not decided");
  // Completed with all 8 skipped (D2): scored, overall 0, "0 of 8 answered".
  const skipped = Array.from({ length: 8 }, (_, i) => ({
    position: i + 1,
    status: "lowest",
    score: 0,
    weight: 1,
  }));
  assert.deepEqual(overallFrom(skipped), { overall: 0, scored_count: 8 });
  assert.equal(rowStatus("completed", false, 8), "scored");
});

test("a 0 for a skipped question reads differently from a 0 for a bad answer", async () => {
  const db = await decided();
  const model = fakeModel({
    reply: (p) =>
      p === 1
        ? {
            score: 0,
            confidence: "high",
            rationale: "The answer does not address the question asked.",
            quotes: [],
          }
        : undefined,
  });
  await resolveAllChecks(db, model);
  const row = scoreRow(db);
  const q = byPosition(row);
  assert.deepEqual([q[1].status, q[1].reason, q[1].score], ["scored", "answered", 0]);
  assert.deepEqual([q[6].status, q[6].reason, q[6].score], ["lowest", "skipped", 0]);
  assert.deepEqual([row.answered_count, row.skipped_count, row.total], [5, 1, 8]);
});

test("the latest attempt is the only one that counts, even while pending; the earlier stays for audit", () =>
  withD10(async () => {
    const db = await abandoned();
    const model = fakeModel();
    await resolveAllChecks(db, model);
    assert.equal(scoreRow(db).status, "incomplete");
    // Before any restart, the session itself is the attempt that counts.
    let counts = await countingLiveScore(db.service, CO, SESSION);
    assert.deepEqual(
      [counts.session_id, counts.status, counts.superseded],
      [SESSION, "incomplete", []],
    );

    const RESTART = "5b0f2c1e-0000-4000-8000-0000000000c8";
    db.tables.interview_sessions.push({
      ...frozenRow(),
      id: RESTART,
      attempt: 2,
      previous_attempt_id: SESSION,
      live_outcome: null,
    });
    counts = await countingLiveScore(db.service, CO, SESSION);
    assert.deepEqual(
      [counts.session_id, counts.attempt, counts.status, counts.score, counts.superseded],
      [RESTART, 2, "pending", null, [SESSION]],
      "the restart counts though it has no row yet; the earlier attempt's row is never returned",
    );
    await scorer(db, model)(RESTART);
    counts = await countingLiveScore(db.service, CO, RESTART);
    assert.deepEqual(
      [counts.session_id, counts.status, counts.score.session_id],
      [RESTART, "pending", RESTART],
    );
    assert.ok(scoreRow(db), "the earlier attempt's row is still there for audit");
    assert.equal(
      await countingLiveScore(db.service, OTHER_CO, SESSION),
      null,
      "another company sees nothing",
    );
  }));

/* ── fix round: style-neutral scoring ──────────────────────────── */

test("v2 prompt: content and evidence only, never speaking style", () => {
  assert.equal(LIVE_SCORING_PROMPT_VERSION, "live-interview-scoring-v2");
  for (const w of [
    "hesitation",
    "hedging",
    "filler words",
    '"I think"',
    "grammar",
    "accent",
    "fluency",
    "speaking style",
  ]) {
    assert.ok(LIVE_SYSTEM_PROMPT.includes(w), w);
  }
  assert.match(LIVE_SYSTEM_PROMPT, /must NEVER mention/);
});

test("the style check: hedging, filler, fluency, grammar, accent, tone, 'I think'; never plain content", () => {
  for (const bad of [
    "The answer stays general, with 'I think' hedging throughout.",
    "There are many filler words.",
    "The candidate was not fluent.",
    "Grammar errors made it hard to follow.",
    "Despite a strong accent, the point came across.",
    "The candidate's tone was uncertain.",
    "The candidate sounded hesitant.",
    "It was delivered confidently but said little.",
    "They said I think twice.",
  ]) {
    assert.equal(styleSentences(bad).length, 1, bad);
  }
  for (const fine of [
    "The candidate named the software delivery pipeline they rebuilt.",
    "They articulated a plan with three steps and a measured result.",
    "Report generation went from 40 minutes to 4.",
    "No result was given for the change.",
  ]) {
    assert.deepEqual(styleSentences(fine), [], fine);
  }
  assert.equal(
    withoutStyleSentences(
      "They rebuilt the import. There was some hedging. The result was 4 minutes.",
    ),
    "They rebuilt the import. The result was 4 minutes.",
  );
});

const STYLE = "The candidate hedged with 'I think' throughout.";
const CONTENT = (p) => `They described their own work on question ${p} with a measured result.`;
const styled = (positions, { persistent = true } = {}) =>
  fakeModel({
    reply: (p, n) =>
      positions.includes(p) && (persistent || n === 1)
        ? { score: SCORES[p], confidence: "high", rationale: `${STYLE} ${CONTENT(p)}`, quotes: [] }
        : undefined,
  });

test("a style mention is retried once; a clean retry is used as it is", async () => {
  const db = await decided();
  const model = styled([2], { persistent: false });
  await resolveAllChecks(db, model);
  const q = byPosition(scoreRow(db));
  const calls = model.requests.filter((r) =>
    r.messages[0].content.includes(QUESTIONS[1].text),
  ).length;
  assert.equal(calls, 2, "asked once more");
  assert.deepEqual([q[2].status, q[2].style_check], ["scored", false]);
  assert.deepEqual(styleSentences(q[2].rationale), []);
  assert.equal(scoreRow(db).status, "scored");
});

test("style still there after the retry: the sentence is removed and the question waits for a style check", async () => {
  const db = await decided();
  const model = styled([2]);
  await resolveAllChecks(db, model);
  const row = scoreRow(db);
  const q = byPosition(row);
  assert.deepEqual(
    [q[2].status, q[2].reason, q[2].style_check, q[2].timing_check],
    ["waiting", "style_check", true, true],
  );
  assert.equal(q[2].rationale, CONTENT(2), "the style sentence is gone, the content stays");
  assert.equal(q[2].score, 60, "the score is kept, not counted");
  assert.deepEqual(
    [q[2].confidence, typeof q[2].score],
    ["high", "number"],
    "confidence is its own field",
  );
  assert.deepEqual([row.status, row.overall_score], ["pending", null]);
});

test("timing and style are separate: resolving timing never clears style, and the reverse", async () => {
  const db = await decided();
  const model = styled([2]);
  await resolveAllChecks(db, model);
  const { deps } = recovery(db, model);
  const act = (fn, decision) =>
    quiet(() =>
      fn({ sessionId: SESSION, position: 2, decision, note: `Reviewed: ${decision}.` }, deps),
    );

  // Timing resolved again: the style check still holds the question.
  await act(resolveNeedsCheck, "score");
  assert.deepEqual(
    [byPosition(scoreRow(db))[2].status, byPosition(scoreRow(db))[2].reason],
    ["waiting", "style_check"],
  );

  // Style resolved 'score': counted.
  await act(resolveStyleCheck, "score");
  assert.deepEqual(
    [byPosition(scoreRow(db))[2].status, byPosition(scoreRow(db))[2].score],
    ["scored", 60],
  );
  assert.equal(scoreRow(db).status, "scored");

  // Timing 'exclude' still applies after style was resolved: style never clears timing.
  await act(resolveNeedsCheck, "exclude");
  assert.deepEqual(
    [byPosition(scoreRow(db))[2].status, byPosition(scoreRow(db))[2].reason],
    ["left_out", "excluded_by_reviewer"],
  );

  // Timing 'score' again, style 'exclude': left out for style; then timing 'score' does not undo it.
  await act(resolveNeedsCheck, "score");
  await act(resolveStyleCheck, "exclude");
  assert.deepEqual(
    [byPosition(scoreRow(db))[2].status, byPosition(scoreRow(db))[2].reason],
    ["left_out", "style_excluded"],
  );
  await act(resolveNeedsCheck, "score");
  assert.deepEqual(
    [byPosition(scoreRow(db))[2].status, byPosition(scoreRow(db))[2].reason],
    ["left_out", "style_excluded"],
  );
  assert.equal(byPosition(scoreRow(db))[2].score, 60, "the AI result is kept, never re-bought");
  const q2calls = model.requests.filter((r) =>
    r.messages[0].content.includes(QUESTIONS[1].text),
  ).length;
  assert.equal(q2calls, 2, "one reply and one retry, no more");

  // Every resolution is logged, each under its own action.
  assert.deepEqual(
    db.tables.live_interview_actions
      .filter((a) => a.question_position === 2)
      .map((a) => [a.action, a.decision]),
    [
      ["resolve_needs_check", "score"],
      ["resolve_needs_check", "score"],
      ["resolve_style_check", "score"],
      ["resolve_needs_check", "exclude"],
      ["resolve_needs_check", "score"],
      ["resolve_style_check", "exclude"],
      ["resolve_needs_check", "score"],
    ],
  );
  // A style check can only be resolved where one is held.
  await assert.rejects(
    quiet(() =>
      resolveStyleCheck({ sessionId: SESSION, position: 1, decision: "score", note: "x" }, deps),
    ),
    (e) => e.code === "no_check",
  );
});

/* ── fix round: live scoring's own switch ──────────────────────── */

async function withEnv(vars, fn) {
  const before = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

async function logged(fn) {
  const lines = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = (...a) => lines.push(a.join(" "));
  try {
    await fn();
  } finally {
    Object.assign(console, orig);
  }
  return lines;
}

test("live scoring does nothing while LIVE_INTERVIEW_SCORING_ENABLED is off, whatever the async flag says", async () => {
  const db = await decided();
  const lines = await withEnv(
    { AI_INTERVIEW_SCORING_ENABLED: "true", LIVE_INTERVIEW_SCORING_ENABLED: undefined },
    () => logged(() => handleAiScorecard({ id: "job-sc", payload: { sessionId: SESSION } })),
  );
  assert.ok(lines.some((l) => l.includes("scoring is off (LIVE_INTERVIEW_SCORING_ENABLED)")));
  assert.equal(db.tables.live_interview_scores.length, 0);
  assert.ok(!db.service.queries.some((q) => q.table === "interview_session_scores"));
  const queued = await withEnv(
    { AI_INTERVIEW_SCORING_ENABLED: "true", LIVE_INTERVIEW_SCORING_ENABLED: undefined },
    () => requestLiveScoring(db.service, SESSION, async () => ({ ok: true })),
  );
  assert.equal(queued, false, "nothing is queued while the live flag is off");
  const on = await withEnv({ LIVE_INTERVIEW_SCORING_ENABLED: "true" }, () =>
    requestLiveScoring(db.service, SESSION, async () => ({ ok: true })),
  );
  assert.equal(on, true);
});

test("the async scorer still answers to AI_INTERVIEW_SCORING_ENABLED, not the live flag", async () => {
  const ASYNC = "5b0f2c1e-0000-4000-8000-0000000000a1";
  const db = fakeLiveDb({
    interview_sessions: [
      {
        id: ASYNC,
        company_id: CO,
        job_id: JOB,
        kind: "async",
        status: "submitted",
        questions_snapshot: [],
        scoring_snapshot: [],
      },
    ],
  });
  globalThis.__liveScoringService = db.service;
  await withEnv(
    { AI_INTERVIEW_SCORING_ENABLED: undefined, LIVE_INTERVIEW_SCORING_ENABLED: "true" },
    () => logged(() => handleAiScorecard({ id: "job-async", payload: { sessionId: ASYNC } })),
  );
  const skip = db.service.queries.find((q) => q.table === "interview_session_scores");
  assert.ok(skip, "the async path ran, not the live one");
  const payload = skip.calls.find((c) => c[0] === "upsert")[1];
  assert.equal(payload.status, "skipped");
  assert.match(payload.error, /AI_INTERVIEW_SCORING_ENABLED/);
  assert.equal(db.tables.live_interview_scores.length, 0);
});

/* ── D2 (revised): what the score row says about the ending ───── */

test("ending_unconfirmed is scored like partial: an overall, partial = true, never ranked with completed", async () => {
  const db = await decided();
  assert.deepEqual(
    [outcomeOf(db).outcome, outcomeOf(db).restart_allowed, outcomeOf(db).restart_needs_person],
    ["ending_unconfirmed", null, true],
  );
  await resolveAllChecks(db, fakeModel());
  const row = scoreRow(db);
  assert.deepEqual(
    [
      row.status,
      row.outcome,
      row.partial,
      row.overall_score !== null,
      row.answered_count,
      row.total,
    ],
    ["scored", "ending_unconfirmed", true, true, 5, 8],
  );
});

test("completed with questions never asked is held from ranking: partial = true on a completed row", async () => {
  const db = await decided();
  const o = outcomeOf(db);
  db.tables.interview_sessions[0].live_outcome = { ...o, provider_status_code: "completed" };
  await resolveAllChecks(db, fakeModel());
  assert.deepEqual(
    [outcomeOf(db).outcome, outcomeOf(db).held_from_ranking, outcomeOf(db).end_check?.reason],
    ["completed", true, "closed_early"],
    "re-settled from a normal close with 2 never asked",
  );
  const row = scoreRow(db);
  assert.deepEqual([row.status, row.outcome, row.partial], ["scored", "completed", true]);
});

/* ── repeat checks (decision, 23 Oct 2026) ────────────────────── */

const REPEAT = JSON.parse(
  readFileSync(
    new URL("./live-provider/__fixtures__/sample-export-repeat.json", import.meta.url),
    "utf8",
  ),
);
const Q2 = QUESTIONS.find((q) => q.position === 2).text;

/** The repeat fixture, its marked repeat of question 2 saying `text`. */
function repeatSaying(text) {
  const raw = structuredClone(REPEAT);
  const i = raw.turns.findIndex((t) => t.is_repeat === true || t.turn_type === "repeat");
  raw.turns[i] = { ...raw.turns[i], text };
  return raw;
}

/** Saved and fully transcribed, then every TIMING check resolved 'score'. */
async function repeatedAndTimed(text, transcribeOpts = {}) {
  const db = await saved(repeatSaying(text));
  await transcribe(db, candidateTurns(db), transcribeOpts);
  const model = fakeModel();
  await resolveAllChecks(db, model);
  return { db, model };
}

const q2Asked = (model) =>
  model.requests.filter((r) => r.messages[0].content.includes(`## Question asked\n${Q2}`)).length;

async function resolveRepeat(db, model, decision, caller = ADMIN, position = 2) {
  const { deps } = recovery(db, model, caller);
  return quiet(() =>
    resolveRepeatCheck(
      { sessionId: SESSION, position, decision, note: "Listened to the recording." },
      deps,
    ),
  );
}

test("repeat check: an unexpected phrase before the exact question is saved, flagged and held until a person decides", async () => {
  const { db, model } = await repeatedAndTimed(`No worries, take your time. ${Q2}`);
  const o = outcomeOf(db);
  assert.equal(o.questions[1].repeat_check, "unexpected_lead_in");
  assert.ok(o.questions.every((q) => q.position === 2 || q.repeat_check === null));
  assert.deepEqual(o.repeat_check_turns, [6]);
  assert.deepEqual([o.questions[1].repeats, o.questions[1].follow_ups], [1, 2], "a repeat");
  assert.equal(o.needs_review, true);
  assert.equal(o.final, true);

  const q2 = byPosition(scoreRow(db))[2];
  assert.deepEqual([q2.status, q2.reason, q2.score], ["waiting", "repeat_check", null]);
  assert.equal(q2Asked(model), 0, "a held question is never sent to the model");
  assert.deepEqual([scoreRow(db).status, scoreRow(db).overall_score], ["pending", null]);
  // Every other answered question scored as usual.
  assert.equal(byPosition(scoreRow(db))[1].status, "scored");

  await resolveRepeat(db, model, "score");
  const after = byPosition(scoreRow(db))[2];
  assert.deepEqual([after.status, after.reason, after.score], ["scored", "answered", 60]);
  assert.equal(scoreRow(db).status, "scored");
  assert.deepEqual(
    db.tables.live_interview_actions
      .filter((a) => a.action === "resolve_repeat_check")
      .map((a) => [a.question_position, a.decision, a.actor_role]),
    [[2, "score", "admin"]],
  );
});

test("repeat check: Leave out leaves the question out, never zero; the rest still score", async () => {
  const { db, model } = await repeatedAndTimed(`No worries, take your time. ${Q2}`);
  await resolveRepeat(db, model, "exclude", OWNER);
  const q2 = byPosition(scoreRow(db))[2];
  assert.deepEqual([q2.status, q2.reason, q2.score], ["left_out", "repeat_excluded", null]);
  assert.equal(q2Asked(model), 0);
  assert.equal(scoreRow(db).status, "scored");
  assert.ok(scoreRow(db).overall_score !== null);
});

test("repeat check: altered wording is saved, flagged as altered and held the same way", async () => {
  const { db, model } = await repeatedAndTimed(`${Q2} And what went wrong?`);
  assert.equal(outcomeOf(db).questions[1].repeat_check, "altered_wording");
  assert.deepEqual(
    [byPosition(scoreRow(db))[2].status, byPosition(scoreRow(db))[2].reason],
    ["waiting", "repeat_check"],
  );
  assert.equal(q2Asked(model), 0);
});

test("repeat check: the repeat's own words never reach the model, even once scored", async () => {
  const { db, model } = await repeatedAndTimed(`Zebrafish, here it is again for you. ${Q2}`);
  await resolveRepeat(db, model, "score");
  assert.equal(byPosition(scoreRow(db))[2].status, "scored");
  assert.ok(q2Asked(model) > 0, "question 2 was scored");
  assert.ok(
    model.requests.every((r) => !/zebrafish/i.test(JSON.stringify(r))),
    "the procedural repeat is not in any exchange",
  );
});

test("repeat check: a skipped question is held too; once resolved, skipped is the lowest and Leave out is no score", async () => {
  const silentQ2 = { text: (row) => (positionOf(db, row) === 2 ? "um... uh" : undefined) };
  let db = await saved(repeatSaying(`No worries, take your time. ${Q2}`));
  await transcribe(db, candidateTurns(db), silentQ2);
  let model = fakeModel();
  await resolveAllChecks(db, model);
  assert.equal(outcomeOf(db).questions[1].status, "skipped");
  assert.deepEqual(
    [byPosition(scoreRow(db))[2].status, byPosition(scoreRow(db))[2].reason],
    ["waiting", "repeat_check"],
    "not the lowest score until a person decides",
  );
  await resolveRepeat(db, model, "score");
  assert.deepEqual(
    [byPosition(scoreRow(db))[2].status, byPosition(scoreRow(db))[2].score],
    ["lowest", LOWEST_SCORE],
  );

  db = await saved(repeatSaying(`No worries, take your time. ${Q2}`));
  await transcribe(db, candidateTurns(db), silentQ2);
  model = fakeModel();
  await resolveAllChecks(db, model);
  await resolveRepeat(db, model, "exclude");
  assert.deepEqual(
    [byPosition(scoreRow(db))[2].status, byPosition(scoreRow(db))[2].score],
    ["left_out", null],
  );
});

test("repeat and timing checks are separate: resolving one never clears the other, either way", async () => {
  const db = await saved(repeatSaying(`No worries, take your time. ${Q2}`));
  await transcribe(db);
  const o = outcomeOf(db);
  assert.equal(o.questions[1].needs_check, true, "question 2 carries both checks");
  assert.equal(o.questions[1].repeat_check, "unexpected_lead_in");
  const model = fakeModel();
  const { deps } = recovery(db, model);
  const act = (fn, decision) =>
    quiet(() =>
      fn({ sessionId: SESSION, position: 2, decision, note: `Reviewed: ${decision}.` }, deps),
    );
  const q2 = () => [byPosition(scoreRow(db))[2].status, byPosition(scoreRow(db))[2].reason];

  // Repeat resolved first: the timing check still holds it.
  await act(resolveRepeatCheck, "score");
  assert.deepEqual(q2(), ["waiting", "needs_check"]);
  // Timing resolved: now it scores.
  await act(resolveNeedsCheck, "score");
  assert.deepEqual(q2(), ["scored", "answered"]);
  // Repeat 'exclude' later: left out, and a timing 'score' does not undo it.
  await act(resolveRepeatCheck, "exclude");
  assert.deepEqual(q2(), ["left_out", "repeat_excluded"]);
  await act(resolveNeedsCheck, "score");
  assert.deepEqual(q2(), ["left_out", "repeat_excluded"]);
  // Timing 'exclude' with the repeat resolved 'score': left out for timing.
  await act(resolveRepeatCheck, "score");
  await act(resolveNeedsCheck, "exclude");
  assert.deepEqual(q2(), ["left_out", "excluded_by_reviewer"]);
  assert.equal(q2Asked(model), 1, "the AI result is kept, never re-bought");
});

test("only a flagged question can be repeat-resolved, only by an owner or admin, and nothing is logged otherwise", async () => {
  const { db, model } = await repeatedAndTimed(`No worries, take your time. ${Q2}`);
  const before = db.tables.live_interview_actions.length;
  await assert.rejects(resolveRepeat(db, model, "score", ADMIN, 1), (e) => e.code === "no_check");
  for (const caller of [
    { kind: "company", userId: "u-r", name: "R", role: "recruiter", companyId: CO },
    { kind: "company", userId: "u-h", name: "H", role: "hiring_manager", companyId: CO },
    { kind: "company", userId: "u-x", name: "X", role: "admin", companyId: OTHER_CO },
    SUPER,
  ]) {
    await assert.rejects(
      resolveRepeat(db, model, "score", caller),
      (e) => e instanceof LiveRecoveryError,
      caller.role,
    );
  }
  await assert.rejects(resolveRepeat(db, model, "maybe"), (e) => e.code === "bad_input");
  assert.equal(db.tables.live_interview_actions.length, before);
  assert.equal(byPosition(scoreRow(db))[2].status, "waiting");
});

test("a repeat check never changes the D2 outcome: the facts match the plain repeat except the flag", async () => {
  const plain = await saved(repeatSaying(Q2));
  await transcribe(plain);
  const flagged = await saved(repeatSaying(`No worries, take your time. ${Q2}`));
  await transcribe(flagged);
  const a = outcomeOf(plain);
  const b = outcomeOf(flagged);
  const d2 = (o) => ({
    outcome: o.outcome,
    end_check: o.end_check,
    final: o.final,
    restart_allowed: o.restart_allowed,
    restart_needs_person: o.restart_needs_person,
    held_from_ranking: o.held_from_ranking,
    counts: [o.answered_count, o.skipped_count, o.not_reached_count, o.total],
    statuses: o.questions.map((q) => [q.status, q.follow_ups, q.repeats, q.needs_check]),
  });
  assert.deepEqual(d2(b), d2(a));
  assert.deepEqual(
    [a.questions[1].repeat_check, b.questions[1].repeat_check],
    [null, "unexpected_lead_in"],
  );
});

test("planLiveScoring: the repeat check, in order with the other rules", () => {
  const facts = (over) => ({
    position: 1,
    source: "job",
    status: "answered",
    confirmed: true,
    needs_check: false,
    repeat_check: "unexpected_lead_in",
    ...over,
  });
  const none = { needsCheck: new Map(), repeatCheck: new Map(), excludedPositions: new Set() };
  const one = (f, resolved = none) =>
    planLiveScoring(
      { final: true, questions: [facts(f)] },
      [{ position: 1, scoring_guide: "G" }],
      resolved,
    )[0];
  const scoreIt = { ...none, repeatCheck: new Map([[1, "score"]]) };
  const leaveOut = { ...none, repeatCheck: new Map([[1, "exclude"]]) };

  for (const check of ["unexpected_lead_in", "altered_wording"]) {
    assert.deepEqual(one({ repeat_check: check }), {
      position: 1,
      decision: "wait",
      reason: "repeat_check",
    });
    assert.equal(one({ repeat_check: check }, scoreIt).decision, "ai");
    assert.deepEqual(one({ repeat_check: check }, leaveOut), {
      position: 1,
      decision: "left_out",
      reason: "repeat_excluded",
    });
  }
  // Skipped is held too, then the lowest once resolved.
  const skipped = { status: "skipped", confirmed: null };
  assert.equal(one(skipped).reason, "repeat_check");
  assert.equal(one(skipped, scoreIt).decision, "lowest");
  // Not reached stays no score, flag or not.
  assert.deepEqual(one({ status: "not_reached", confirmed: null }).reason, "not_reached");
  // No flag, or an outcome saved before version 3 (no field): no hold.
  assert.equal(one({ repeat_check: null }).decision, "ai");
  assert.equal(one({ repeat_check: undefined }).decision, "ai");
  // Independent of the timing decision: neither map resolves the other's check.
  const timingScored = { ...none, needsCheck: new Map([[1, "score"]]) };
  assert.equal(one({ needs_check: true }, timingScored).reason, "repeat_check");
  assert.equal(one({ needs_check: true }, scoreIt).reason, "needs_check");
  assert.equal(
    one({ needs_check: true }, { ...scoreIt, needsCheck: new Map([[1, "score"]]) }).decision,
    "ai",
  );
});

/* ── F12: the first asking (23 Oct 2026) ──────────────────────── */

const Q3 = QUESTIONS.find((q) => q.position === 3).text;

/** The sample with question `position` first asked as `text`. */
function askedAs(text, position = 3, raw = FIXTURE) {
  const out = structuredClone(raw);
  const i = out.turns.findIndex(
    (t) => t.turn_type === "base_question" && t.question_id === position,
  );
  out.turns[i] = { ...out.turns[i], text };
  return out;
}

/** Every TIMING check resolved 'score', and question 1's wording check (the greeting) too. */
async function timedAndGreeted(db, model) {
  const { deps } = recovery(db, model);
  for (const q of outcomeOf(db).questions.filter((x) => x.needs_check)) {
    await quiet(() =>
      resolveNeedsCheck(
        { sessionId: SESSION, position: q.position, decision: "score", note: "Checked." },
        deps,
      ),
    );
  }
  await quiet(() =>
    resolveWordingCheck(
      { sessionId: SESSION, position: 1, decision: "score", note: "The greeting." },
      deps,
    ),
  );
}

const q3Asked = (model) =>
  model.requests.filter((r) => r.messages[0].content.includes(`## Question asked\n${Q3}`)).length;

async function heldWith(text, transcribeOpts = {}) {
  const db = await saved(askedAs(text));
  await transcribe(db, candidateTurns(db), transcribeOpts);
  const model = fakeModel();
  await timedAndGreeted(db, model);
  return { db, model };
}

test("F12 every hint, extra demand, changed, shortened or different first asking is held and never sent to the model", async () => {
  const words = Q3.split(" ");
  for (const [label, text, check] of [
    ["hint before", `Zebrafish matter here. ${Q3}`, "unexpected_lead_in"],
    ["hint after", `${Q3} Zebrafish matter here.`, "altered_wording"],
    ["extra demand", `${Q3} And what would zebrafish do differently?`, "altered_wording"],
    [
      "a word changed",
      words.map((w, i) => (i === 5 ? "zebrafish" : w)).join(" "),
      "altered_wording",
    ],
    ["shortened", words.slice(0, 6).join(" "), "altered_wording"],
    [
      "a different question",
      "What would zebrafish change about your last team?",
      "altered_wording",
    ],
  ]) {
    const { db, model } = await heldWith(text);
    assert.equal(outcomeOf(db).questions[2].wording_check, check, label);
    const q3 = byPosition(scoreRow(db))[3];
    assert.deepEqual([q3.status, q3.reason, q3.score], ["waiting", "wording_check", null], label);
    assert.equal(q3Asked(model), 0, `${label}: never sent`);
    assert.ok(
      model.requests.every((r) => !/zebrafish/i.test(JSON.stringify(r))),
      label,
    );
    assert.equal(scoreRow(db).status, "pending", label);
    assert.equal(byPosition(scoreRow(db))[2].status, "scored", `${label}: the rest score`);
  }
});

test("F12 Score as usual scores the held question; Leave out leaves it out, never zero", async () => {
  const hint = `${Q3} Remember to mention reliability.`;
  let { db, model } = await heldWith(hint);
  const act = (decision, caller = ADMIN) =>
    quiet(() =>
      resolveWordingCheck(
        { sessionId: SESSION, position: 3, decision, note: "Listened to the recording." },
        recovery(db, model, caller).deps,
      ),
    );
  await act("score");
  assert.deepEqual(
    [byPosition(scoreRow(db))[3].status, byPosition(scoreRow(db))[3].score],
    ["scored", 80],
  );
  assert.equal(scoreRow(db).status, "scored");
  assert.deepEqual(
    db.tables.live_interview_actions
      .filter((a) => a.question_position === 3)
      .map((a) => [a.action, a.decision]),
    [
      ["resolve_needs_check", "score"],
      ["resolve_wording_check", "score"],
    ],
  );

  ({ db, model } = await heldWith(hint));
  await act("exclude", OWNER);
  const q3 = byPosition(scoreRow(db))[3];
  assert.deepEqual([q3.status, q3.reason, q3.score], ["left_out", "wording_excluded", null]);
  assert.equal(q3Asked(model), 0);
  assert.equal(scoreRow(db).status, "scored");
});

test("F12 a skipped question is held too; once resolved, skipped is the lowest and Leave out is no score", async () => {
  const hint = `${Q3} Remember to mention reliability.`;
  for (const [decision, want] of [
    ["score", ["lowest", LOWEST_SCORE]],
    ["exclude", ["left_out", null]],
  ]) {
    const db = await saved(askedAs(hint));
    const silent = { text: (row) => (positionOf(db, row) === 3 ? "um... uh" : undefined) };
    await transcribe(db, candidateTurns(db), silent);
    const model = fakeModel();
    await timedAndGreeted(db, model);
    assert.equal(outcomeOf(db).questions[2].status, "skipped");
    assert.deepEqual(
      [byPosition(scoreRow(db))[3].status, byPosition(scoreRow(db))[3].reason],
      ["waiting", "wording_check"],
      "not the lowest until a person decides",
    );
    await quiet(() =>
      resolveWordingCheck(
        { sessionId: SESSION, position: 3, decision, note: "Checked." },
        recovery(db, model).deps,
      ),
    );
    assert.deepEqual(
      [byPosition(scoreRow(db))[3].status, byPosition(scoreRow(db))[3].score],
      want,
      decision,
    );
  }
});

test("F12 harmless differences end to end: filler and the candidate's name, scored as usual with no hold", async () => {
  // The candidate is Alex Example (job_applications in saved()).
  const { db, model } = await heldWith(`Um, Alex, ${Q3[0].toLowerCase()}${Q3.slice(1)} Uh.`);
  assert.equal(outcomeOf(db).questions[2].wording_check, null);
  assert.deepEqual(
    [byPosition(scoreRow(db))[3].status, byPosition(scoreRow(db))[3].score],
    ["scored", 80],
  );
  assert.ok(q3Asked(model) > 0);
  assert.doesNotMatch(JSON.stringify(outcomeOf(db)), /\balex\b/i, "the name is never stored");
});

test("F12 wording and timing checks are separate: resolving one never clears the other, either way", async () => {
  const db = await saved(askedAs(`${Q3} Remember to mention reliability.`));
  await transcribe(db);
  assert.deepEqual(
    [outcomeOf(db).questions[2].needs_check, outcomeOf(db).questions[2].wording_check],
    [true, "altered_wording"],
  );
  const model = fakeModel();
  const { deps } = recovery(db, model);
  const act = (fn, decision) =>
    quiet(() =>
      fn({ sessionId: SESSION, position: 3, decision, note: `Reviewed: ${decision}.` }, deps),
    );
  const q3 = () => [byPosition(scoreRow(db))[3].status, byPosition(scoreRow(db))[3].reason];
  await act(resolveWordingCheck, "score");
  assert.deepEqual(q3(), ["waiting", "needs_check"]);
  await act(resolveNeedsCheck, "score");
  assert.deepEqual(q3(), ["scored", "answered"]);
  await act(resolveWordingCheck, "exclude");
  assert.deepEqual(q3(), ["left_out", "wording_excluded"]);
  await act(resolveNeedsCheck, "score");
  assert.deepEqual(q3(), ["left_out", "wording_excluded"], "timing never undoes it");
  await act(resolveWordingCheck, "score");
  await act(resolveNeedsCheck, "exclude");
  assert.deepEqual(q3(), ["left_out", "excluded_by_reviewer"]);
  assert.equal(q3Asked(model), 1, "the AI result is kept, never re-bought");
});

test("F12 wording and repeat checks are separate: resolving one never clears the other, either way", async () => {
  const Q2text = QUESTIONS.find((q) => q.position === 2).text;
  const raw = askedAs(
    `${Q2text} Remember to mention reliability.`,
    2,
    repeatSaying(`No worries. ${Q2text}`),
  );
  const db = await saved(raw);
  await transcribe(db);
  const o = outcomeOf(db).questions[1];
  assert.deepEqual([o.repeat_check, o.wording_check], ["unexpected_lead_in", "altered_wording"]);
  const model = fakeModel();
  const { deps } = recovery(db, model);
  const act = (fn, decision) =>
    quiet(() =>
      fn({ sessionId: SESSION, position: 2, decision, note: `Reviewed: ${decision}.` }, deps),
    );
  const q2 = () => [byPosition(scoreRow(db))[2].status, byPosition(scoreRow(db))[2].reason];
  await act(resolveNeedsCheck, "score");
  await act(resolveRepeatCheck, "score");
  assert.deepEqual(q2(), ["waiting", "wording_check"], "the repeat decision never clears wording");
  await act(resolveWordingCheck, "score");
  assert.deepEqual(q2(), ["scored", "answered"]);
  await act(resolveRepeatCheck, "exclude");
  assert.deepEqual(q2(), ["left_out", "repeat_excluded"]);
  await act(resolveWordingCheck, "score");
  assert.deepEqual(q2(), ["left_out", "repeat_excluded"], "a wording decision never undoes it");
});

test("F12 only a flagged question can be wording-resolved, only by an owner or admin, and nothing is logged otherwise", async () => {
  const { db, model } = await heldWith(`${Q3} Remember to mention reliability.`);
  const before = db.tables.live_interview_actions.length;
  const act = (position, decision, caller = ADMIN) =>
    quiet(() =>
      resolveWordingCheck(
        { sessionId: SESSION, position, decision, note: "Listened." },
        recovery(db, model, caller).deps,
      ),
    );
  await assert.rejects(
    act(2, "score"),
    (e) => e.code === "no_check",
    "question 2 was asked as frozen",
  );
  for (const caller of [
    { kind: "company", userId: "u-r", name: "R", role: "recruiter", companyId: CO },
    { kind: "company", userId: "u-h", name: "H", role: "hiring_manager", companyId: CO },
    { kind: "company", userId: "u-x", name: "X", role: "admin", companyId: OTHER_CO },
    SUPER,
  ]) {
    await assert.rejects(
      act(3, "score", caller),
      (e) => e instanceof LiveRecoveryError,
      caller.role,
    );
  }
  await assert.rejects(act(3, "maybe"), (e) => e.code === "bad_input");
  assert.equal(db.tables.live_interview_actions.length, before);
  assert.equal(byPosition(scoreRow(db))[3].status, "waiting");
});

test("F12 a wording check never changes the D2 outcome: the facts match the plain asking except the flag", async () => {
  const plain = await saved(askedAs(Q3));
  await transcribe(plain);
  const flagged = await saved(askedAs(`${Q3} Remember to mention reliability.`));
  await transcribe(flagged);
  const d2 = (o) => ({
    outcome: o.outcome,
    end_check: o.end_check,
    final: o.final,
    restart_allowed: o.restart_allowed,
    restart_needs_person: o.restart_needs_person,
    held_from_ranking: o.held_from_ranking,
    counts: [o.answered_count, o.skipped_count, o.not_reached_count, o.total],
    statuses: o.questions.map((q) => [
      q.status,
      q.follow_ups,
      q.repeats,
      q.needs_check,
      q.repeat_check,
    ]),
  });
  assert.deepEqual(d2(outcomeOf(flagged)), d2(outcomeOf(plain)));
  assert.deepEqual(
    [outcomeOf(plain).questions[2].wording_check, outcomeOf(flagged).questions[2].wording_check],
    [null, "altered_wording"],
  );
});

test("planLiveScoring: the wording check, in order with the other rules", () => {
  const facts = (over) => ({
    position: 1,
    source: "job",
    status: "answered",
    confirmed: true,
    needs_check: false,
    repeat_check: null,
    wording_check: "altered_wording",
    ...over,
  });
  const none = {
    needsCheck: new Map(),
    repeatCheck: new Map(),
    wordingCheck: new Map(),
    excludedPositions: new Set(),
  };
  const one = (f, resolved = none) =>
    planLiveScoring(
      { final: true, questions: [facts(f)] },
      [{ position: 1, scoring_guide: "G" }],
      resolved,
    )[0];
  const scoreIt = { ...none, wordingCheck: new Map([[1, "score"]]) };
  const leaveOut = { ...none, wordingCheck: new Map([[1, "exclude"]]) };
  for (const check of ["unexpected_lead_in", "altered_wording"]) {
    assert.deepEqual(one({ wording_check: check }), {
      position: 1,
      decision: "wait",
      reason: "wording_check",
    });
    assert.equal(one({ wording_check: check }, scoreIt).decision, "ai");
    assert.deepEqual(one({ wording_check: check }, leaveOut), {
      position: 1,
      decision: "left_out",
      reason: "wording_excluded",
    });
  }
  assert.equal(one({ status: "skipped", confirmed: null }).reason, "wording_check");
  assert.equal(one({ status: "skipped", confirmed: null }, scoreIt).decision, "lowest");
  assert.equal(one({ status: "not_reached", confirmed: null }).reason, "not_reached");
  assert.equal(one({ wording_check: null }).decision, "ai");
  assert.equal(one({ wording_check: undefined }).decision, "ai", "an outcome before version 4");
  // No other decision resolves it, and it resolves no other check.
  for (const map of ["needsCheck", "repeatCheck"]) {
    assert.equal(
      one(
        { needs_check: true, repeat_check: "unexpected_lead_in" },
        { ...none, [map]: new Map([[1, "score"]]) },
      ).decision,
      "wait",
      map,
    );
  }
  assert.equal(one({ needs_check: true }, scoreIt).reason, "needs_check");
  assert.equal(one({ repeat_check: "unexpected_lead_in" }, scoreIt).reason, "repeat_check");
});

/* ── F15b: interruption speech is never scored (27 Oct 2026) ──── */

test("F15b the exchange leaves out interruption speech; everything else is as before", async () => {
  const db = await decided();
  const turns = turnsOf(db);
  const name = { firstName: "Alex", lastName: "Example" };
  const all = exchangeFor(2, turns, name);
  const spoken = turns.filter((t) => t.speaker === "candidate" && positionOf(db, t) === 2);
  assert.ok(spoken.length > 0);
  const cutIn = spoken[0];
  const without = exchangeFor(2, turns, name, new Set([cutIn.sequence]));
  assert.equal(without.length, all.length - 1);
  assert.equal(
    without.filter((l) => l.speaker === "interviewer").length,
    all.filter((l) => l.speaker === "interviewer").length,
  );
  // Control: a sequence on another question changes nothing here.
  const elsewhere = turns.find((t) => t.speaker === "candidate" && positionOf(db, t) !== 2);
  assert.deepEqual(exchangeFor(2, turns, name, new Set([elsewhere.sequence])), all);
});
