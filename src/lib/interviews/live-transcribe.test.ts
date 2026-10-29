/**
 * Transcribing an AI Video Interview's candidate turns and settling the
 * outcome (lib/interviews/live-transcribe.ts), on the commit 2 fixture saved
 * by live-ingest.ts into fake-live-db.mjs. Whisper is faked by default; one
 * test drives the real request builder against a fake fetch. Every word is
 * made up. Nothing leaves the machine.
 *
 *   node --test src/lib/interviews/live-transcribe.test.ts
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
  "@/lib/supabase/server": "export function createServiceClient() { return globalThis.__liveTranscribeService; }",
};
export async function resolve(specifier, context, next) {
  if (specifier in STUBS) return { url: "data:text/javascript," + encodeURIComponent(STUBS[specifier]), shortCircuit: true };
  return next(specifier, context);
}`)}`,
);

const {
  handleLiveTurnTranscribe,
  hasRealWords,
  liveTranscribeJobId,
  queueLiveTranscription,
  requestLiveTranscription,
  settleOutcome,
} = await import("./live-transcribe.ts");
const { handleTranscribe } = await import("./transcribe.ts");
const { CONFIRMED_EXIT_CODES, saveLiveExport } = await import("./live-ingest.ts");
const { parseExport } = await import("./live-provider/parse-export.ts");
const { createFakeLiveProvider } = await import("./live-provider/fake-provider.ts");
const { snapshotsFor } = await import("./frozen-questions.ts");
const { ProviderHttpError, TerminalJobError } = await import("../queue/failure-class.ts");
const { fakeLiveDb } = await import("../../test-support/fake-live-db.mjs");

const FIXTURE = JSON.parse(
  readFileSync(new URL("./live-provider/__fixtures__/sample-export.json", import.meta.url), "utf8"),
);
const SESSION = "5b0f2c1e-0000-4000-8000-0000000000c6";
const CO = "7aad434d-0000-4000-8000-000000000001";

function frozenRow() {
  const questions = FIXTURE.questions
    .filter((q) => q.position <= 8)
    .map((q) => ({
      question_id: `q-${q.position}`,
      position: q.position,
      text: q.text,
      source: q.position <= 4 ? "job" : "cv",
      competency: "Ownership",
      scoring_guide: "Strong answer: specific. Weak answer: general.",
      weight: null,
    }));
  return {
    id: SESSION,
    company_id: CO,
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
    ...snapshotsFor(questions),
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

/** The fixture saved: 32 turns, 13 of them the candidate's, outcome provisional. */
async function saved() {
  const db = fakeLiveDb({ interview_sessions: [frozenRow()] });
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
  globalThis.__liveTranscribeService = db.service;
  return db;
}

const candidateTurns = (db) =>
  db.tables.interview_turns
    .filter((t) => t.speaker === "candidate")
    .sort((a, b) => a.sequence - b.sequence);
const outcomeOf = (db) => db.tables.interview_sessions[0].live_outcome;

/**
 * A fake Whisper. `text(turn)` gives each candidate turn's transcript by its
 * row; `fail(turn, call)` may throw instead. Records every call.
 */
function fakeWhisper(
  db,
  { text = () => "I led the work and shipped it in two weeks.", fail } = {},
) {
  const calls = [];
  const byPath = () => new Map(db.tables.interview_turns.map((t) => [t.media_path, t]));
  const transcribe = async (audio) => {
    // Find the turn by its stored bytes: the fake provider's bytes name the file.
    const turn = [...db.objects.entries()].find(
      ([, o]) =>
        o.bytes.length === audio.bytes.length && o.bytes.every((b, i) => b === audio.bytes[i]),
    );
    const row = byPath().get(turn?.[0]);
    calls.push({ sequence: row?.sequence, mime: audio.mime, ext: audio.ext });
    if (fail) {
      const thrown = fail(row, calls.filter((c) => c.sequence === row?.sequence).length);
      if (thrown) throw thrown;
    }
    return { text: text(row), segments: [] };
  };
  return { calls, transcribe };
}

const jobFor = (turn, attempts = 0, max_attempts = 3) => ({
  id: `job-${turn.sequence}-${attempts}`,
  payload: { turnId: turn.id, sessionId: SESSION },
  attempts,
  max_attempts,
});

async function runAll(db, whisper, turns = candidateTurns(db)) {
  for (const t of turns) {
    await quiet(() =>
      handleLiveTurnTranscribe(jobFor(t), undefined, {
        service: db.service,
        transcribe: whisper.transcribe,
      }),
    );
  }
}

/* ── the confirm rule ─────────────────────────────────────────── */

test("real words: an answer, a short one; never fillers, empty, or Whisper's silence fill", () => {
  assert.equal(hasRealWords("I rebuilt the order service and owned the cutover.", null), true);
  assert.equal(hasRealWords("Yes, three years.", null), true);
  for (const none of ["um... uh", "Um, uh, hmm.", "", "   ", "Mm. Ah. Erm.", null]) {
    assert.equal(hasRealWords(none, null), false, JSON.stringify(none));
  }
  const silence = [{ start: 0, end: 2, text: "Thank you.", noSpeech: 0.95 }];
  assert.equal(hasRealWords("Thank you.", silence), false, "Whisper filled silence");
  assert.equal(
    hasRealWords("Thank you.", [...silence, { start: 2, end: 4, text: "I did.", noSpeech: 0.1 }]),
    true,
  );
  assert.equal(
    hasRealWords("Thank you.", [{ start: 0, end: 1, text: "Thank you." }]),
    true,
    "unknown noSpeech is not silence",
  );
});

/* ── provisional until the last turn, then final ──────────────── */

test("the fixture: provisional until the last candidate turn, then final, answers confirmed", async () => {
  const db = await saved();
  assert.deepEqual([outcomeOf(db).final, outcomeOf(db).restart_allowed], [false, null]);
  const whisper = fakeWhisper(db);
  const turns = candidateTurns(db);
  assert.equal(turns.length, 13);
  await runAll(db, whisper, turns.slice(0, 12));
  assert.equal(outcomeOf(db).final, false, "one turn still pending");
  assert.equal(outcomeOf(db).restart_allowed, null);
  await runAll(db, whisper, turns.slice(12));
  const o = outcomeOf(db);
  assert.equal(o.final, true);
  assert.deepEqual(
    o.questions.map((q) => [q.position, q.status, q.confirmed]),
    [
      [1, "answered", true],
      [2, "answered", true],
      [3, "answered", true],
      [4, "answered", true],
      [5, "answered", true],
      [6, "skipped", null],
      [7, "not_reached", null],
      [8, "not_reached", null],
    ],
  );
  // candidate_ended is not a confirmed exit yet (D10): a person reviews the ending and decides the restart.
  assert.deepEqual(
    [
      o.outcome,
      o.answered_count,
      o.restart_allowed,
      o.restart_needs_person,
      o.needs_review,
      o.answers_usable,
    ],
    ["ending_unconfirmed", 5, null, true, true, true],
  );
  assert.equal(o.end_check.reason, "exit_unconfirmed");
  // Final, but every answered question is timing suspect: a person checks before scoring.
  assert.deepEqual(o.transcription_failed_turns, []);
  // timing_suspect turns are transcribed too, and keep needs_check for scoring.
  assert.ok(o.questions.slice(0, 5).every((q) => q.needs_check === true));
  assert.equal(o.timing_suspect_turns.length, 13);
  assert.ok(candidateTurns(db).every((t) => t.transcript_status === "done" && t.transcript));
});

async function downgradeTwo(db) {
  const positionOf = (row) => {
    const answered = db.tables.interview_turns.find((t) => t.id === row.responds_to_turn_id);
    return row.question_position ?? answered?.question_position;
  };
  const whisper = fakeWhisper(db, {
    text: (row) =>
      positionOf(row) === 4
        ? "um... uh"
        : positionOf(row) === 5
          ? ""
          : "I owned the migration end to end.",
  });
  await runAll(db, whisper);
}

test("downgrades change the outcome: with D10 on, two filler-only questions turn partial into abandoned, restart once", async () => {
  const db = await saved();
  CONFIRMED_EXIT_CODES.add("candidate_ended");
  try {
    await downgradeTwo(db);
  } finally {
    CONFIRMED_EXIT_CODES.delete("candidate_ended");
  }
  const o = outcomeOf(db);
  assert.equal(o.final, true);
  assert.deepEqual(
    o.questions.map((q) => q.status),
    [
      "answered",
      "answered",
      "answered",
      "skipped",
      "skipped",
      "skipped",
      "not_reached",
      "not_reached",
    ],
  );
  assert.deepEqual(
    [
      o.outcome,
      o.answered_count,
      o.skipped_count,
      o.not_reached_count,
      o.completion_percent,
      o.restart_allowed,
    ],
    ["abandoned", 3, 3, 2, 38, true],
  );
  // The same interview while D10 is unconfirmed: never abandonment, a person decides.
  const unconfirmed = await saved();
  await downgradeTwo(unconfirmed);
  assert.deepEqual(
    [outcomeOf(unconfirmed).outcome, outcomeOf(unconfirmed).restart_allowed],
    ["ending_unconfirmed", null],
  );
});

/* ── provider_error: every answer usable, or an answer lost (D2) ── */

function settledAs(db, status, states) {
  const o = { ...outcomeOf(db), provider_status_code: status };
  const turns = candidateTurns(db).map((t, i) => ({
    sequence: t.sequence,
    position: null,
    transcript_status: states[i] ?? "done",
    transcript: "I led the work and shipped it in two weeks.",
    transcript_segments: null,
  }));
  return { o, turns };
}

test("provider_error with every transcript done: ending_unconfirmed, no automatic restart", async () => {
  const db = await saved();
  const { o, turns } = settledAs(db, "provider_error", []);
  const next = settleOutcome(o, turns, 1);
  assert.deepEqual(
    [
      next.final,
      next.answers_usable,
      next.outcome,
      next.end_check.reason,
      next.restart_allowed,
      next.restart_needs_person,
    ],
    [true, true, "ending_unconfirmed", "provider_error_saved", null, true],
  );
});

test("provider_error with an answer lost: technical_failure once settled, the existing restart rule", async () => {
  const db = await saved();
  const { o, turns } = settledAs(db, "provider_error", ["failed"]);
  const waiting = settleOutcome(o, turns, 1);
  assert.deepEqual(
    [waiting.final, waiting.restart_allowed],
    [false, null],
    "a failed turn not yet left out: not decided",
  );
  const excluded = settleOutcome(o, turns, 2, new Set([turns[0].sequence]));
  assert.deepEqual(
    [
      excluded.final,
      excluded.answers_usable,
      excluded.outcome,
      excluded.restart_allowed,
      excluded.restart_needs_person,
    ],
    [true, false, "technical_failure", true, false],
  );
});

test('a 2-second "Yes, three years" confirms its question', async () => {
  const db = await saved();
  const first = candidateTurns(db)[0];
  const whisper = fakeWhisper(db, {
    text: (row) => (row.id === first.id ? "Yes, three years." : "um"),
  });
  await runAll(db, whisper);
  const o = outcomeOf(db);
  assert.deepEqual([o.questions[0].status, o.questions[0].confirmed], ["answered", true]);
});

/* ── failures ─────────────────────────────────────────────────── */

test("a retryable failure leaves the turn pending for the retry, and the retry succeeds", async () => {
  const db = await saved();
  const [first, ...rest] = candidateTurns(db);
  const whisper = fakeWhisper(db, {
    fail: (row, n) =>
      row.id === first.id && n === 1 ? new ProviderHttpError("OpenAI", 503, "busy") : null,
  });
  await assert.rejects(
    quiet(() =>
      handleLiveTurnTranscribe(jobFor(first, 0), undefined, {
        service: db.service,
        transcribe: whisper.transcribe,
      }),
    ),
    ProviderHttpError,
  );
  assert.equal(candidateTurns(db)[0].transcript_status, "pending");
  await quiet(() =>
    handleLiveTurnTranscribe(jobFor(first, 1), undefined, {
      service: db.service,
      transcribe: whisper.transcribe,
    }),
  );
  assert.equal(candidateTurns(db)[0].transcript_status, "done");
  await runAll(db, whisper, rest);
  assert.equal(outcomeOf(db).final, true);
});

test("past the last retry: the turn is failed, the session flagged for review, the outcome never final", async () => {
  const db = await saved();
  const turns = candidateTurns(db);
  const stuck = turns[4];
  const whisper = fakeWhisper(db, {
    fail: (row) => (row.id === stuck.id ? new ProviderHttpError("OpenAI", 503, "busy") : null),
  });
  await runAll(
    db,
    whisper,
    turns.filter((t) => t.id !== stuck.id),
  );
  // The last of 3 attempts.
  await assert.rejects(
    quiet(() =>
      handleLiveTurnTranscribe(jobFor(stuck, 2, 3), undefined, {
        service: db.service,
        transcribe: whisper.transcribe,
      }),
    ),
    ProviderHttpError,
  );
  const row = candidateTurns(db).find((t) => t.id === stuck.id);
  assert.equal(row.transcript_status, "failed");
  assert.ok(row.transcript_error);
  const o = outcomeOf(db);
  assert.deepEqual(
    [o.final, o.restart_allowed, o.needs_review, o.transcription_failed_turns],
    [false, null, true, [stuck.sequence]],
  );
  assert.equal(db.tables.interview_turns.length, 32, "no turn is dropped");
});

test("a failure no retry can fix (a 400) fails the turn at once", async () => {
  const db = await saved();
  const [first] = candidateTurns(db);
  const whisper = fakeWhisper(db, {
    fail: () => new ProviderHttpError("OpenAI", 400, "bad audio"),
  });
  await assert.rejects(
    quiet(() =>
      handleLiveTurnTranscribe(jobFor(first, 0), undefined, {
        service: db.service,
        transcribe: whisper.transcribe,
      }),
    ),
    TerminalJobError,
  );
  assert.equal(candidateTurns(db)[0].transcript_status, "failed");
  assert.equal(outcomeOf(db).needs_review, true);
});

/* ── only the candidate, and never twice ──────────────────────── */

test("the interviewer's turns are never sent to transcription, nor queued", async () => {
  const db = await saved();
  const whisper = fakeWhisper(db);
  for (const t of db.tables.interview_turns.filter((x) => x.speaker === "interviewer")) {
    await quiet(() =>
      handleLiveTurnTranscribe(jobFor(t), undefined, {
        service: db.service,
        transcribe: whisper.transcribe,
      }),
    );
  }
  assert.equal(whisper.calls.length, 0);
  const queued = [];
  const n = await requestLiveTranscription(db.service, SESSION, async (job) => {
    queued.push(job);
    db.tables.background_jobs.push({
      id: `j${queued.length}`,
      type: job.type,
      status: "queued",
      payload: job.payload,
    });
    return { ok: true };
  });
  assert.equal(n, 13);
  const candidateIds = new Set(candidateTurns(db).map((t) => t.id));
  assert.ok(queued.every((j) => candidateIds.has(j.payload.turnId) && j.companyId === CO));
  // Asked again while those jobs are live: nothing more is queued.
  assert.equal(await requestLiveTranscription(db.service, SESSION, async () => ({ ok: true })), 0);
});

test("re-running transcription neither calls Whisper again nor overwrites a finished transcript", async () => {
  const db = await saved();
  const whisper = fakeWhisper(db);
  await runAll(db, whisper);
  const before = candidateTurns(db).map((t) => [t.id, t.transcript]);
  const outcome = structuredClone(outcomeOf(db));
  const other = fakeWhisper(db, { text: () => "A completely different transcript." });
  await runAll(db, other);
  assert.equal(other.calls.length, 0, "done turns are not sent again");
  assert.deepEqual(
    candidateTurns(db).map((t) => [t.id, t.transcript]),
    before,
  );
  const { settle_rev: _a, ...was } = outcome;
  const { settle_rev: _b, ...now } = outcomeOf(db);
  assert.deepEqual(now, was);
  assert.equal(db.tables.interview_turns.length, 32);
});

test("two turns finishing at once: the settle's compare-and-set leaves the final outcome, not a stale one", async () => {
  const db = await saved();
  const whisper = fakeWhisper(db);
  const turns = candidateTurns(db);
  await runAll(db, whisper, turns.slice(0, 11));
  await quiet(() =>
    Promise.all(
      turns.slice(11).map((t) =>
        handleLiveTurnTranscribe(jobFor(t), undefined, {
          service: db.service,
          transcribe: whisper.transcribe,
        }),
      ),
    ),
  );
  assert.equal(outcomeOf(db).final, true);
});

test("settleOutcome: a question with one real-word turn among fillers is confirmed", () => {
  const outcome = {
    questions: [
      {
        position: 1,
        source: "job",
        status: "answered",
        confirmed: false,
        follow_ups: 1,
        repeats: 0,
        answer_ms: 3000,
        wording_check: null,
        needs_check: false,
      },
    ],
    provider_status_code: "completed",
    settle_rev: 0,
  };
  const turns = [
    {
      sequence: 2,
      position: 1,
      transcript_status: "done",
      transcript: "um",
      transcript_segments: null,
    },
    {
      sequence: 4,
      position: 1,
      transcript_status: "done",
      transcript: "It took two sprints.",
      transcript_segments: null,
    },
  ];
  const s = settleOutcome(outcome, turns, 1);
  assert.deepEqual(
    [s.questions[0].status, s.questions[0].confirmed, s.final, s.outcome],
    ["answered", true, true, "completed"],
  );
});

test("needs_review: set by a needs_check question or a failed turn, each on its own; flags kept", () => {
  const q = (position, needs_check) => ({
    position,
    source: "job",
    status: "answered",
    confirmed: false,
    follow_ups: 0,
    repeats: 0,
    answer_ms: 3000,
    wording_check: null,
    needs_check,
  });
  const outcome = (checks) => ({
    questions: checks.map((c, i) => q(i + 1, c)),
    provider_status_code: "completed",
    settle_rev: 0,
  });
  const turn = (sequence, position, transcript_status) => ({
    sequence,
    position,
    transcript_status,
    transcript: transcript_status === "done" ? "I shipped it." : null,
    transcript_segments: null,
  });
  const done = [turn(2, 1, "done"), turn(4, 2, "done")];

  const clean = settleOutcome(outcome([false, false]), done, 1);
  assert.deepEqual([clean.final, clean.needs_review], [true, false]);

  const suspect = settleOutcome(outcome([false, true]), done, 1);
  assert.deepEqual([suspect.final, suspect.needs_review], [true, true]);
  assert.deepEqual(
    suspect.questions.map((x) => x.needs_check),
    [false, true],
  );
  assert.deepEqual(suspect.transcription_failed_turns, []);

  const failed = settleOutcome(outcome([false, false]), [done[0], turn(4, 2, "failed")], 1);
  assert.deepEqual(
    [failed.final, failed.needs_review, failed.transcription_failed_turns],
    [false, true, [4]],
  );
  assert.deepEqual(
    failed.questions.map((x) => x.needs_check),
    [false, false],
  );
});

/* ── through the real entry point ─────────────────────────────── */

test("handleTranscribe routes a turn payload here; Whisper gets the turn's real file type", async () => {
  const db = await saved();
  const [first] = candidateTurns(db);
  const before = { key: process.env.OPENAI_API_KEY, fetch: globalThis.fetch };
  process.env.OPENAI_API_KEY = "sk-test-fake";
  const sent = [];
  globalThis.fetch = async (url, init) => {
    const file = init.body.get("file");
    sent.push({
      url,
      type: file.type,
      name: file.name,
      model: init.body.get("model"),
      language: init.body.get("language"),
    });
    return new Response(
      JSON.stringify({
        text: "I did it myself.",
        segments: [{ start: 0, end: 1.5, text: "I did it myself.", no_speech_prob: 0.02 }],
      }),
      { status: 200 },
    );
  };
  try {
    await quiet(() => handleTranscribe(jobFor(first)));
  } finally {
    globalThis.fetch = before.fetch;
    if (before.key === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = before.key;
  }
  assert.deepEqual(sent, [
    {
      url: "https://api.openai.com/v1/audio/transcriptions",
      type: "audio/wav",
      name: "turn.wav",
      model: "whisper-1",
      language: "en",
    },
  ]);
  const row = candidateTurns(db)[0];
  assert.deepEqual([row.transcript_status, row.transcript], ["done", "I did it myself."]);
  assert.deepEqual(row.transcript_segments, [
    { start: 0, end: 1.5, text: "I did it myself.", noSpeech: 0.02 },
  ]);
});

/* ── transcription queued once the export is saved (B2) ────────── */

/**
 * The job table as the real queue uses it: enqueue inserts one row with the
 * caller's id (the primary key refuses a second, 23505), and a worker claims a
 * job with one conditional update, queued to running, as claimJobs does.
 * `failFor(input)` makes that enqueue fail as a database error would.
 */
function fakeQueue(db, { failFor = () => false } = {}) {
  const enqueue = async (input) => {
    if (failFor(input)) return { ok: false, error: "fault", code: "XX000" };
    const { error } = await db.service
      .from("background_jobs")
      .insert({
        id: input.id,
        type: input.type,
        payload: input.payload,
        company_id: input.companyId,
        status: "queued",
        attempts: 0,
        max_attempts: 3,
      })
      .select("id");
    return error ? { ok: false, error: error.message, code: error.code } : { ok: true };
  };
  const claim = async (id) => {
    const { data } = await db.service
      .from("background_jobs")
      .update({ status: "running" })
      .eq("id", id)
      .eq("status", "queued")
      .select("id");
    return (data ?? []).length === 1;
  };
  const finish = (id, status = "succeeded") =>
    db.service.from("background_jobs").update({ status }).eq("id", id).select("id");
  const requests = [];
  const request = (service, sessionId) => {
    requests.push(sessionId);
    return queueLiveTranscription(service, sessionId, enqueue);
  };
  return { enqueue, claim, finish, request, requests };
}

const jobsOf = (db) => db.tables.background_jobs.filter((j) => j.type === "transcribe");

/** A session with the fixture's turns but no outcome yet: ready for a save. */
async function unsaved() {
  const db = fakeLiveDb({ interview_sessions: [frozenRow()] });
  const provider = createFakeLiveProvider(FIXTURE);
  const { providerSessionId } = await provider.createSession({
    remotiv_session_id: SESSION,
    interviewer_name: "Sarah",
    interview_minutes: 30,
    questions: [{ position: 1, text: "Q" }],
    candidate_first_name: "Alex",
    cv_text: "",
  });
  const parsed = {
    ...parseExport(provider.exportOf(providerSessionId)),
    provider_session_id: FIXTURE.session_id,
  };
  globalThis.__liveTranscribeService = db.service;
  return { db, provider, providerSessionId, parsed };
}

const save = (w, queue, parsed = w.parsed) =>
  quiet(() =>
    saveLiveExport(SESSION, parsed, {
      service: w.db.service,
      fetchAudio: (n) => w.provider.fetchAudio(w.providerSessionId, n),
      now: () => Date.now(),
      requestTranscription: queue.request,
    }),
  );

/** Every queued job, run by the handler once claimed; returns the Whisper calls. */
async function work(db, queue, whisper, workers = 1) {
  const run = async () => {
    for (const job of jobsOf(db).filter((j) => j.status === "queued")) {
      if (!(await queue.claim(job.id))) continue;
      await quiet(() =>
        handleLiveTurnTranscribe(job, undefined, {
          service: db.service,
          transcribe: whisper.transcribe,
        }),
      );
      await queue.finish(job.id);
    }
  };
  await Promise.all(Array.from({ length: workers }, run));
  return whisper.calls;
}

test("B2: a final export saved queues exactly one transcription job per candidate turn, and calls no one", async () => {
  const w = await unsaved();
  const queue = fakeQueue(w.db);
  const result = await save(w, queue);
  assert.deepEqual([result.saved, result.transcriptionQueued], [true, true]);
  const turns = candidateTurns(w.db);
  assert.equal(turns.length, 13);
  const jobs = jobsOf(w.db);
  assert.equal(jobs.length, 13);
  assert.deepEqual(
    jobs.map((j) => j.payload.turnId).sort(),
    turns.map((t) => t.id).sort(),
    "one job per candidate turn, none for the interviewer's",
  );
  for (const j of jobs) {
    assert.deepEqual(j.payload, { turnId: j.payload.turnId, sessionId: SESSION, round: 1 });
    assert.equal(j.id, liveTranscribeJobId(j.payload.turnId, 1));
    assert.deepEqual([j.status, j.max_attempts], ["queued", 3]);
  }
  assert.ok(
    turns.every((t) => t.transcript_status === "pending"),
    "queued, not transcribed",
  );
});

test("B2: saving the same export again queues nothing more", async () => {
  const w = await unsaved();
  const queue = fakeQueue(w.db);
  await save(w, queue);
  const again = await save(w, queue);
  assert.deepEqual([again.saved, again.transcriptionQueued], [false, true]);
  assert.equal(jobsOf(w.db).length, 13);
});

test("B2: two saves at once: one job per turn, and competing workers call Whisper once per turn", async () => {
  const w = await unsaved();
  const queue = fakeQueue(w.db);
  const results = await Promise.all([save(w, queue), save(w, queue)]);
  assert.deepEqual(results.map((r) => r.saved).sort(), [false, true]);
  assert.ok(results.every((r) => r.transcriptionQueued));
  assert.equal(jobsOf(w.db).length, 13);
  // Three requests racing for the same pending turns still make one job each.
  await Promise.all([1, 2, 3].map(() => queue.request(w.db.service, SESSION)));
  assert.equal(jobsOf(w.db).length, 13);
  const calls = await work(w.db, queue, fakeWhisper(w.db), 3);
  assert.deepEqual(
    calls.map((c) => c.sequence).sort((a, b) => a - b),
    candidateTurns(w.db).map((t) => t.sequence),
    "one Whisper call per candidate turn",
  );
  assert.equal(outcomeOf(w.db).final, true);
});

test("B2: a not-final or a refused export queues nothing", async () => {
  const w = await unsaved();
  const queue = fakeQueue(w.db);
  const notFinal = await save(w, queue, {
    ...w.parsed,
    status: { ...w.parsed.status, end_reason: "in_progress" },
  });
  assert.equal(notFinal.notFinal, true);
  // Another provider session's export is refused before anything is written.
  await assert.rejects(save(w, queue, { ...w.parsed, provider_session_id: "someone-else" }));
  assert.deepEqual(queue.requests, [], "transcription is not even asked for");
  assert.equal(jobsOf(w.db).length, 0);
  assert.equal(w.db.tables.interview_turns.length, 0);
});

test("B2: a job that could not be queued leaves its turn pending; saving again queues it, and only it", async () => {
  const w = await unsaved();
  const [first, second] = FIXTURE.turns
    .filter((t) => t.role === "candidate")
    .slice(0, 2)
    .map((t) => t.turn_id);
  const failing = new Set();
  const broken = fakeQueue(w.db, { failFor: (input) => failing.has(input.payload.turnId) });
  // The first two candidate turns, by the provider's id: their rows exist once the save writes them.
  const result = await save(w, {
    request: (service, id) => {
      for (const t of candidateTurns(w.db)) {
        if ([first, second].includes(t.provider_turn_id)) failing.add(t.id);
      }
      return broken.request(service, id);
    },
  });
  assert.deepEqual([result.saved, result.transcriptionQueued], [true, false]);
  assert.equal(jobsOf(w.db).length, 11);
  assert.equal(failing.size, 2);
  for (const id of failing) {
    assert.equal(w.db.tables.interview_turns.find((t) => t.id === id).transcript_status, "pending");
  }
  assert.equal(outcomeOf(w.db).final, false, "never read as transcribed");
  const again = await save(w, fakeQueue(w.db));
  assert.deepEqual([again.saved, again.transcriptionQueued], [false, true]);
  assert.equal(jobsOf(w.db).length, 13, "the two missing jobs, and no duplicate of the eleven");
  assert.equal(new Set(jobsOf(w.db).map((j) => j.payload.turnId)).size, 13);
});

test("B2: a turn already transcribed, failed or held is never queued again by a save", async () => {
  const w = await unsaved();
  const queue = fakeQueue(w.db);
  await save(w, queue);
  const turns = candidateTurns(w.db);
  const held = turns[0];
  const broken = turns[1];
  w.db.objects.get(held.media_path).bytes = loudWav();
  const whisper = fakeWhisper(w.db, {
    text: (row) => (row?.id === held.id ? "" : "I led the work and shipped it in two weeks."),
    fail: (row) => (row?.id === broken.id ? new ProviderHttpError("OpenAI", 400, "bad") : null),
  });
  await assert.rejects(work(w.db, queue, whisper));
  await work(w.db, queue, whisper);
  const row = (t) => w.db.tables.interview_turns.find((x) => x.id === t.id);
  assert.deepEqual(
    [row(held).transcript_status, row(held).transcript_error],
    ["failed", "Transcription returned nothing."],
    "B4: held for a person",
  );
  assert.equal(row(broken).transcript_status, "failed");
  assert.equal(outcomeOf(w.db).needs_review, true);
  const before = jobsOf(w.db).length;
  const again = await save(w, queue);
  assert.equal(again.transcriptionQueued, true);
  assert.equal(jobsOf(w.db).length, before, "nothing queued: done, failed and held turns are left");
});

test("B2: after a manual retry the turn gets its next round, beside the old job", async () => {
  const w = await unsaved();
  const queue = fakeQueue(w.db);
  await save(w, queue);
  const turn = candidateTurns(w.db)[0];
  const old = jobsOf(w.db).find((j) => j.payload.turnId === turn.id);
  await queue.finish(old.id, "dead");
  // What retryTranscription does to a failed turn: back to pending, then asks the source.
  w.db.tables.interview_turns.find((t) => t.id === turn.id).transcript_status = "pending";
  const r = await queue.request(w.db.service, SESSION);
  assert.deepEqual(r, { queued: 1, alreadyQueued: 12, failed: 0 });
  const mine = jobsOf(w.db).filter((j) => j.payload.turnId === turn.id);
  assert.deepEqual(
    mine.map((j) => [
      j.payload.round,
      j.status,
      j.id === liveTranscribeJobId(turn.id, j.payload.round),
    ]),
    [
      [1, "dead", true],
      [2, "queued", true],
    ],
  );
  assert.equal(await requestLiveTranscription(w.db.service, SESSION, queue.enqueue), 0);
});

/** 16 kHz mono 16-bit WAV, 5 s of a speech-level tone. */
function loudWav() {
  const rate = 16_000;
  const frames = rate * 5;
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
  for (let f = 0; f < frames; f++) {
    view.setInt16(44 + f * 2, Math.round(3000 * Math.sin((2 * Math.PI * 220 * f) / rate)), true);
  }
  return bytes;
}
