/**
 * F16 (30 Oct 2026): the provider's last interviewer line comes as its own
 * turn, turn_type "closing". It is procedural, like the greeting: stored with
 * its text and audio, never a question, a follow-up, an answer or a score, and
 * it changes no outcome. Every other unknown turn type is still refused.
 *
 * The export below is synthetic, in the provider's F16 shape: a greeting, nine
 * asked base questions with follow-ups, back-to-back acknowledgments, silence
 * reminders, the closing, and a tenth question never asked while the
 * provider's own fields claim it covered and answered.
 *
 *   node --test src/lib/interviews/live-provider/parse-export-f16.test.ts
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../../test-support/node-resolve.mjs", import.meta.url));
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

const { parseExport, LiveExportError } = await import("./parse-export.ts");
const { createFakeLiveProvider } = await import("./fake-provider.ts");
const { saveLiveExport } = await import("../live-ingest.ts");
const { snapshotsFor } = await import("../frozen-questions.ts");
const { planLiveScoring } = await import("../live-scoring.ts");
const { fakeLiveDb } = await import("../../../test-support/fake-live-db.mjs");

const SESSION = "5b0f2c1e-0000-4000-8000-000000000016";
const PROVIDER_SESSION = "f16-session";
const T0 = Date.parse("2026-10-30T09:00:00.000Z");

/** Invented questions: nothing from any real interview or CV. */
const QUESTIONS = Array.from({ length: 10 }, (_, i) => ({
  id: `q-uuid-${i + 1}`,
  text: `Tell me about invented topic number ${i + 1} and how you approached it?`,
  source: i < 7 ? "jd" : "cv",
}));

/** The F16 shape. `over` changes the top-level fields. */
function f16Export(over = {}) {
  const turns = [];
  let at = 1000;
  const add = (t) => {
    const n = turns.length + 1;
    const duration = t.role === "candidate" ? 4000 : 2500;
    turns.push({
      turn_id: `t-${n}`,
      responds_to_turn_id: null,
      role: t.role,
      turn_type: t.turn_type,
      question_id: t.q ?? null,
      base_question_id: t.q ? QUESTIONS[t.q - 1].id : null,
      question_order: t.q ?? null,
      follow_up_index: t.follow_up_index ?? null,
      text: t.text ?? `Invented line ${n}.`,
      offset_ms: at,
      audio_duration_ms: duration,
      start_ms: at,
      end_ms: at + duration - (t.role === "candidate" ? 500 : 0),
      audio_file: `${t.role === "candidate" ? "candidate" : "interviewer"}_turn_${String(n).padStart(3, "0")}.wav`,
      timestamp: new Date(T0 + at).toISOString(),
      ...t.extra,
    });
    at += duration + 700;
    return `t-${n}`;
  };
  add({
    role: "interviewer",
    turn_type: "greeting",
    text: "Hello, welcome to this invented interview.",
  });
  for (let q = 1; q <= 9; q++) {
    const base = add({
      role: "interviewer",
      turn_type: "base_question",
      q,
      text: QUESTIONS[q - 1].text,
    });
    let answerTo = base;
    if (q === 7) {
      // A silence reminder, then the answer replies to it.
      answerTo = add({
        role: "interviewer",
        turn_type: "silence_reminder",
        q,
        text: "Take your time.",
      });
    }
    const answer = add({
      role: "candidate",
      turn_type: "answer",
      q,
      extra: { responds_to_turn_id: answerTo },
    });
    let last = answer;
    if (q !== 7) {
      const fu = add({
        role: "interviewer",
        turn_type: "follow_up",
        q,
        follow_up_index: 1,
        text: `Could you say more about invented topic ${q}?`,
        extra: { responds_to_turn_id: answer },
      });
      last = add({ role: "candidate", turn_type: "answer", q, extra: { responds_to_turn_id: fu } });
    }
    add({
      role: "interviewer",
      turn_type: "acknowledgment",
      q,
      text: "Thank you.",
      extra: { responds_to_turn_id: last },
    });
    if (q === 5 || q === 7) {
      // Back to back: a second acknowledgment answering nothing, right before the next question.
      add({ role: "interviewer", turn_type: "acknowledgment", text: "That is helpful." });
    }
  }
  add({
    role: "interviewer",
    turn_type: "closing",
    text: "That is the end of our invented interview. Goodbye.",
  });
  return {
    session_id: PROVIDER_SESSION,
    started_at: new Date(T0).toISOString(),
    ended_at: new Date(T0 + at).toISOString(),
    created_at: new Date(T0).toISOString(),
    status: "completed",
    end_reason: "completed",
    completed_gracefully: true,
    // The provider's own claims about question 10. None of them may matter.
    questions_completed: 10,
    questions: QUESTIONS.map((q, i) => ({
      id: q.id,
      text: q.text,
      source: q.source,
      label: `Invented ${i + 1}`,
      goal: "Invented goal.",
      covered: true,
      asked: i < 9,
      status: "answered",
    })),
    end_of_turn: {
      method: "vad",
      decided_by: "silence",
      vad_silence_ms: 800,
      energy_threshold: 0.01,
    },
    interviewer_name: "Sarah",
    candidate_first_name: "Alex",
    duration_ms: at + 2000,
    turns,
    ...over,
  };
}

function frozenRow(raw) {
  const questions = QUESTIONS.map((q, i) => ({
    question_id: `frozen-${i + 1}`,
    position: i + 1,
    text: q.text,
    source: q.source === "cv" ? "cv" : "job",
    competency: "Ownership",
    scoring_guide: "Strong answer: specific. Weak answer: general.",
    weight: null,
  }));
  return {
    id: SESSION,
    kind: "live",
    attempt: 1,
    provider_session_id: raw.session_id,
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
    delete_after: new Date(Date.now() + 90 * 86_400_000).toISOString(),
    ...snapshotsFor(questions),
  };
}

async function saved(raw = f16Export()) {
  const db = fakeLiveDb({ interview_sessions: [frozenRow(raw)] });
  const provider = createFakeLiveProvider(raw);
  const { providerSessionId } = await provider.createSession({
    remotiv_session_id: SESSION,
    interviewer_name: "Sarah",
    interview_minutes: 20,
    questions: [{ position: 1, text: "Q" }],
    candidate_first_name: "Alex",
    cv_text: "",
  });
  const orig = console.log;
  console.log = () => {};
  try {
    const result = await saveLiveExport(
      SESSION,
      { ...parseExport(provider.exportOf(providerSessionId)), provider_session_id: raw.session_id },
      {
        service: db.service,
        fetchAudio: (name) => provider.fetchAudio(providerSessionId, name),
        now: () => T0,
        requestTranscription: async () => ({ queued: 0, alreadyQueued: 0, failed: 0 }),
      },
    );
    return { db, ...result };
  } finally {
    console.log = orig;
  }
}

const rowsOf = (db) => [...db.tables.interview_turns].sort((a, b) => a.sequence - b.sequence);

test("F16 a: the export with a final closing turn is accepted as sent; the closing is stored like the greeting", async () => {
  const raw = f16Export();
  const parsed = parseExport(structuredClone(raw));
  const closing = parsed.turns.at(-1);
  const greeting = parsed.turns[0];
  for (const t of [greeting, closing]) {
    assert.equal(t.speaker, "interviewer");
    assert.equal(t.kind, "procedural");
    assert.equal(t.question_position, null);
    assert.equal(t.follow_up_index, null);
  }
  const { db, saved: ok } = await saved(raw);
  assert.equal(ok, true);
  const rows = rowsOf(db);
  assert.equal(rows.length, raw.turns.length);
  const last = rows.at(-1);
  assert.deepEqual(
    [last.speaker, last.kind, last.question_position, last.text, last.transcript_status],
    ["interviewer", "procedural", null, raw.turns.at(-1).text, null],
  );
  assert.ok(last.media_path && db.objects.has(last.media_path), "its audio is stored");
});

test("F16 b: question 10, never asked, is not reached and never scored, whatever the provider claims", async () => {
  const { outcome } = await saved();
  const q10 = outcome.questions.find((q) => q.position === 10);
  assert.equal(q10.status, "not_reached");
  assert.deepEqual(
    [outcome.answered_count, outcome.skipped_count, outcome.not_reached_count, outcome.total],
    [9, 0, 1, 10],
  );
  // Planned as if every transcript were in and confirmed: question 10 is left out, never a score.
  const transcribed = {
    ...outcome,
    final: true,
    questions: outcome.questions.map((q) =>
      q.status === "answered" ? { ...q, confirmed: true } : q,
    ),
  };
  const plan = planLiveScoring(
    transcribed,
    QUESTIONS.map((_, i) => ({ position: i + 1, scoring_guide: "Strong: specific." })),
    {
      needsCheck: new Map(),
      repeatCheck: new Map(),
      wordingCheck: new Map(),
      excludedPositions: new Set(),
    },
  );
  assert.deepEqual(
    plan.find((p) => p.position === 10),
    { position: 10, decision: "left_out", reason: "not_reached" },
  );
  assert.equal(
    plan.filter((p) => p.decision === "ai").length,
    9,
    "only the nine answered, and never the closing",
  );
  // The provider's covered / status / asked / questions_completed change nothing.
  const claims = f16Export({ questions_completed: 0 });
  for (const q of claims.questions)
    Object.assign(q, { covered: false, asked: true, status: "skipped" });
  const other = await saved(claims);
  const strip = (o) => JSON.stringify({ ...o, saved_at: null, export_hash: null });
  assert.equal(strip(other.outcome), strip(outcome));
});

test("F16 c: completed and graceful -> completed, closed early (one never asked), held for review and from ranking", async () => {
  const { outcome } = await saved();
  assert.equal(outcome.outcome, "completed");
  assert.deepEqual(outcome.end_check, { reason: "closed_early", never_asked: 1 });
  assert.equal(outcome.needs_review, true);
  assert.equal(outcome.held_from_ranking, true);
  // No F11 or F12 flag: every asked question is the frozen one, word for word.
  assert.ok(outcome.questions.every((q) => q.wording_check === null && q.repeat_check === null));
  // The two acknowledgments in a row belong to the answer before them.
  const raw = f16Export();
  const rows = rowsOf((await saved(raw)).db);
  const type = (r) => raw.turns[r.sequence - 1].turn_type;
  const second = rows.filter(
    (r, i) => type(r) === "acknowledgment" && rows[i - 1] && type(rows[i - 1]) === "acknowledgment",
  );
  assert.deepEqual(
    second.map((r) => r.question_position),
    [5, 7],
  );
});

test("F16 d: the same export ending candidate_left, closing turn and all, is not completed", async () => {
  const { outcome } = await saved(f16Export({ end_reason: "candidate_left" }));
  assert.notEqual(outcome.outcome, "completed");
});

test("F16 e: the same export not graceful, closing turn and all, is not completed", async () => {
  const { outcome } = await saved(f16Export({ completed_gracefully: false }));
  assert.notEqual(outcome.outcome, "completed");
});

test("F16 f: any other unknown interviewer turn type is still refused", () => {
  for (const type of ["wrap_up", "Closing", "closing_remarks", "outro"]) {
    const raw = f16Export();
    raw.turns.at(-1).turn_type = type;
    assert.throws(
      () => parseExport(raw),
      (e) =>
        e instanceof LiveExportError &&
        e.code === "unknown_turn_type" &&
        e.turnIndex === raw.turns.length - 1,
      type,
    );
  }
  // And a candidate turn may never be a closing.
  const raw = f16Export();
  raw.turns.find((t) => t.role === "candidate").turn_type = "closing";
  assert.throws(
    () => parseExport(raw),
    (e) => e.code === "unknown_turn_type",
  );
});
