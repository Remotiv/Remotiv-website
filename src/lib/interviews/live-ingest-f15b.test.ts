/**
 * F15b (27 Oct 2026): the provider's scripted "ftest" export through
 * assessLiveExport and saveLiveExport (fake-live-db.mjs, fake audio). The
 * fixture keeps that export's structure; its words are made up.
 *
 *   interruption speech   kept and listed (outcome version 6), never an
 *                         answer: not counted, not timed, not scored
 *   silence_reminder      procedural: no question, no follow-up
 *   disconnected          ending_unconfirmed with its own end_check, needs a
 *                         person, never completed (D10 unchanged)
 *   in_progress           notFinal: nothing read or written, retry later;
 *                         the final export of the same session then saves
 *
 *   node --test src/lib/interviews/live-ingest-f15b.test.ts
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { register } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

register(new URL("../../test-support/node-resolve.mjs", import.meta.url));
register(
  `data:text/javascript,${encodeURIComponent(`
const STUBS = {
  "server-only": "",
  "@/lib/supabase/server": "export function createServiceClient() { throw new Error('test: pass a service'); }",
};
export async function resolve(specifier, context, next) {
  if (specifier in STUBS) return { url: "data:text/javascript," + encodeURIComponent(STUBS[specifier]), shortCircuit: true };
  return next(specifier, context);
}`)}`,
);

const {
  assessLiveExport,
  saveLiveExport,
  isNotFinalExport,
  NOT_FINAL_WORDS,
  LiveIngestError,
  LIVE_OUTCOME_VERSION,
} = await import("./live-ingest.ts");
const { settleOutcome } = await import("./live-transcribe.ts");
const { parseExport } = await import("./live-provider/parse-export.ts");
const { createFakeLiveProvider } = await import("./live-provider/fake-provider.ts");
const { readFrozenQuestionSet, snapshotsFor } = await import("./frozen-questions.ts");
const { fakeLiveDb } = await import("../../test-support/fake-live-db.mjs");

const FTEST = JSON.parse(
  readFileSync(
    new URL("./live-provider/__fixtures__/sample-export-ftest.json", import.meta.url),
    "utf8",
  ),
);
const SESSION = "5b0f2c1e-0000-4000-8000-0000000f15b1";
const T0 = Date.parse("2026-10-27T10:00:00.000Z");
const INTERRUPTION_SEQ = 16;

/** The export as a final one: the provider's normal close. */
function finalExport(over = {}) {
  return {
    ...structuredClone(FTEST),
    status: "completed",
    end_reason: "completed",
    completed_gracefully: true,
    ...over,
  };
}

/** The session's frozen questions: the export's own `count`, as they were given to the provider. */
function frozenRow(count = FTEST.questions.length) {
  const questions = FTEST.questions.slice(0, count).map((q, i) => ({
    question_id: `q-${i + 1}`,
    position: i + 1,
    text: q.text,
    source: q.source === "cv" ? "cv" : "job",
    competency: "Ownership",
    scoring_guide: "Strong answer: specific. Weak answer: general.",
    weight: null,
  }));
  return {
    id: SESSION,
    company_id: "7aad434d-0000-4000-8000-0000000f15b1",
    kind: "live",
    status: "started",
    attempt: 1,
    provider: "mock",
    provider_session_id: FTEST.session_id,
    live_ended_at: null,
    live_settings: {
      v: 2,
      questions_frozen: {
        at: "2026-10-20T08:50:00.000Z",
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
    live_outcome: null,
    ...snapshotsFor(questions),
  };
}

const frozen = (count) => readFrozenQuestionSet(frozenRow(count));
const assess = (raw, count) => assessLiveExport(parseExport(raw), frozen(count), 1);
const quiet = async (fn) => {
  const log = console.log;
  const err = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
    console.error = err;
  }
};

/* ── assessment ───────────────────────────────────────────────── */

test("interruption speech is kept and listed (version 6), but is never the answer: not counted, not timed", () => {
  const o = assess(finalExport());
  assert.equal(o.v, 6);
  assert.equal(LIVE_OUTCOME_VERSION, 6);
  assert.deepEqual(o.interruption_speech_turns, [INTERRUPTION_SEQ]);
  const q3 = o.questions.find((q) => q.position === 3);
  const answers = FTEST.turns.filter(
    (t) => t.role === "candidate" && t.turn_type === "answer" && t.question_id === 3,
  );
  assert.equal(
    q3.answer_ms,
    answers.reduce((s, t) => s + t.audio_duration_ms, 0),
    "the answers' time only",
  );
  assert.equal(q3.status, "answered");
  assert.equal(
    o.timing_suspect_turns.includes(INTERRUPTION_SEQ),
    false,
    "its overlap is expected, never a timing flag",
  );
  // The interruption line is still flagged as before (F15): ambiguous on question 3.
  assert.equal(q3.interruption_check, "ambiguous");
});

test("silence reminders add no question and no follow-up; the existing timing flags still hold their questions (D deferred)", () => {
  const o = assess(finalExport());
  const byPos = (p) => o.questions.find((q) => q.position === p);
  assert.deepEqual([byPos(1).follow_ups, byPos(4).follow_ups, byPos(8).follow_ups], [1, 1, 2]);
  assert.deepEqual(
    o.questions.map((q) => q.status),
    Array(10).fill("answered"),
  );
  // The answers listed before a later reminder are flagged by the timing check, as today.
  assert.deepEqual([byPos(1).needs_check, byPos(4).needs_check], [true, true]);
  assert.deepEqual(o.timing_suspect_turns, [7, 26]);
});

test("a question whose only candidate speech is an interruption is skipped, not answered", () => {
  const f = finalExport();
  // Question 10: its answer becomes interruption speech; nothing else was said on it.
  const answer = f.turns.findIndex((t) => t.role === "candidate" && t.question_id === 10);
  f.turns[answer].turn_type = "interruption";
  const q10 = assess(f).questions.find((q) => q.position === 10);
  assert.deepEqual([q10.status, q10.answer_ms, q10.confirmed], ["skipped", 0, null]);
});

test("the export's 10 questions against Remotiv's 8 frozen ones are still refused (X2 backstop)", () => {
  assert.throws(
    () => assess(finalExport(), 8),
    (e) => e instanceof LiveIngestError && e.code === "unknown_question_position",
  );
});

test("disconnected: ending_unconfirmed with its own reason, for a person, never completed (D10)", () => {
  for (const graceful of [true, false]) {
    const raw = finalExport({
      status: "disconnected",
      end_reason: "disconnected",
      completed_gracefully: graceful,
    });
    const o = assess(raw);
    assert.deepEqual(
      [o.provider_status_code, o.outcome, o.end_check?.reason, o.needs_review, o.restart_allowed],
      ["disconnected", "ending_unconfirmed", "disconnected", true, null],
      String(graceful),
    );
    // Like every ending, the restart waits for the outcome to be final; then it is a person's.
    assert.equal(o.restart_needs_person, false, "not final yet");
    const turns = parseExport(raw)
      .turns.filter((t) => t.speaker === "candidate")
      .map((t) => ({
        sequence: t.sequence,
        position: t.question_position,
        transcript_status: "done",
        transcript: "I led the work and shipped it.",
        transcript_segments: null,
      }));
    const settled = settleOutcome(o, turns, 1);
    assert.deepEqual(
      [
        settled.final,
        settled.outcome,
        settled.end_check?.reason,
        settled.restart_allowed,
        settled.restart_needs_person,
      ],
      [true, "ending_unconfirmed", "disconnected", null, true],
      String(graceful),
    );
  }
  // Control: the provider's normal close is completed.
  assert.equal(assess(finalExport()).outcome, "completed");
});

/* ── settling and transcription ───────────────────────────────── */

test("settling: interruption speech with real words never confirms an answer; it still has to be transcribed", () => {
  const o = assess(finalExport());
  const answered = (seq) => ({
    sequence: seq,
    position: 3,
    transcript_status: "done",
    transcript: "",
    transcript_segments: [],
  });
  const interruption = {
    sequence: INTERRUPTION_SEQ,
    position: 3,
    transcript_status: "done",
    transcript: "Sorry, one moment, could you repeat the last part?",
    transcript_segments: null,
  };
  const q3 = (outcome) => outcome.questions.find((q) => q.position === 3);
  // The only words on question 3 are the interruption's: the question is skipped, not confirmed.
  const settled = settleOutcome(o, [answered(19), answered(22), interruption], 1);
  assert.deepEqual([q3(settled).status, q3(settled).confirmed], ["skipped", null]);
  // Control: were it an answer, those words would confirm it.
  const control = settleOutcome(
    { ...o, interruption_speech_turns: [] },
    [answered(19), answered(22), interruption],
    1,
  );
  assert.deepEqual([q3(control).status, q3(control).confirmed], ["answered", true]);
  // Not transcribed yet: the outcome is not final, as for any candidate turn.
  const pending = settleOutcome(
    o,
    [answered(19), answered(22), { ...interruption, transcript_status: "pending" }],
    1,
  );
  assert.equal(pending.final, false);
});

/* ── not final: nothing happens, then the final export saves ───── */

async function world() {
  const db = fakeLiveDb({ interview_sessions: [frozenRow()] }, { now: () => T0 });
  return db;
}

async function save(db, raw) {
  const provider = createFakeLiveProvider(raw, {});
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
    provider_session_id: FTEST.session_id,
  };
  return quiet(() =>
    saveLiveExport(SESSION, parsed, {
      service: db.service,
      fetchAudio: (name) => provider.fetchAudio(providerSessionId, name),
      now: () => T0,
    }),
  );
}

test("in_progress, in status or end_reason or both, any case: notFinal and retryable, before anything is read or written", async () => {
  const variants = [
    {},
    { status: "completed", end_reason: "in_progress", completed_gracefully: true },
    { status: "in_progress", end_reason: "completed", completed_gracefully: true },
    { status: " IN_PROGRESS ", end_reason: null },
    { status: null, end_reason: "In_Progress" },
  ];
  for (const over of variants) {
    const db = await world();
    const raw = { ...structuredClone(FTEST), ...over };
    const result = await save(db, raw);
    assert.deepEqual(
      result,
      { outcome: null, saved: false, notFinal: true, retryable: true },
      JSON.stringify(over),
    );
    assert.equal(db.service.queries.length, 0, "not even a read");
    assert.equal(db.objects.size, 0, "no audio stored");
    assert.equal(db.counts.uploads, 0);
    assert.equal(db.tables.interview_turns.length, 0, "no turns");
    const row = db.tables.interview_sessions[0];
    assert.deepEqual(
      [row.live_outcome, row.live_ended_at],
      [null, null],
      "no outcome, no end stamped",
    );
  }
  assert.deepEqual(NOT_FINAL_WORDS, ["in_progress"], "only the word the provider sent");
});

test("then the final export of the same session saves: turns, audio, the outcome and the end", async () => {
  const db = await world();
  const first = await save(db, structuredClone(FTEST));
  assert.equal(first.notFinal, true);
  const final = await save(db, finalExport());
  assert.equal(final.saved, true);
  assert.equal(final.notFinal, undefined);
  assert.equal(final.outcome.outcome, "completed");
  assert.equal(db.tables.interview_turns.length, 64);
  assert.equal(db.objects.size, 64, "every turn's audio, the interruption's included");
  const row = db.tables.interview_sessions[0];
  assert.equal(row.live_outcome.v, 6);
  assert.notEqual(row.live_ended_at, null, "the export saved stamps the end (Commit 10)");
  // The interruption is stored like any candidate turn, waiting for Remotiv's transcription.
  const t = db.tables.interview_turns.find((x) => x.sequence === INTERRUPTION_SEQ);
  assert.deepEqual(
    [t.speaker, t.kind, t.text, t.transcript_status, t.question_position],
    ["candidate", null, null, "pending", 3],
  );
  assert.ok(db.objects.has(t.media_path), "its audio is stored");
  // A second, identical final save changes nothing.
  assert.equal((await save(db, finalExport())).saved, false);
});

test("isNotFinalExport reads both words and nothing else", () => {
  const s = (provider_status, end_reason) => ({
    code: "unknown",
    provider_status,
    end_reason,
    completed_gracefully: null,
  });
  assert.equal(isNotFinalExport(s("in_progress", null)), true);
  assert.equal(isNotFinalExport(s(null, "in_progress")), true);
  assert.equal(isNotFinalExport(s("completed", "completed")), false);
  assert.equal(isNotFinalExport(s("disconnected", "disconnected")), false);
  assert.equal(
    isNotFinalExport(s(null, null)),
    false,
    "a missing status is unknown, not in progress",
  );
});

/* ── the retry requirement, pinned ────────────────────────────── */

test("REQUIREMENT: any caller of saveLiveExport handles notFinal as retry later; the requirement is written on the function", () => {
  const ingest = readFileSync(new URL("./live-ingest.ts", import.meta.url), "utf8");
  assert.match(ingest, /REQUIREMENT for any caller that fetches and saves exports/);
  assert.match(ingest, /notFinal means RETRY LATER/);
  assert.match(
    ingest,
    /Never mark the session processed, and never mark it permanently\s+\* failed, on a notFinal answer/,
  );
  // Every file outside tests that calls saveLiveExport must deal with notFinal. Today there is none.
  const src = fileURLToPath(new URL("../../", import.meta.url));
  const files = (dir) =>
    readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      if (statSync(p).isDirectory()) return files(p);
      return /\.(ts|tsx)$/.test(n) && !/\.test\./.test(n) ? [p] : [];
    });
  const callers = files(src).filter(
    (p) => !p.endsWith("live-ingest.ts") && /saveLiveExport\(/.test(readFileSync(p, "utf8")),
  );
  for (const p of callers) {
    assert.match(
      readFileSync(p, "utf8"),
      /notFinal/,
      `${p} calls saveLiveExport but never handles notFinal`,
    );
  }
  assert.deepEqual(callers, [], "no caller yet; when one lands, it must handle notFinal (above)");
});
