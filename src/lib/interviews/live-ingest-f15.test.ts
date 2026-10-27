/**
 * The provider's current export format (F15, 26 Oct 2026), saved whole by
 * live-ingest.ts into fake-live-db.mjs and settled by live-transcribe.ts: the
 * interruption, the repeat after it (F11), the ending rule, the follow-up
 * placeholder and interruption speech that was never exported. The fixture
 * keeps the structure of his interruption export; every id, name, word and
 * timing is made up. Nothing leaves the machine.
 *
 *   node --test src/lib/interviews/live-ingest-f15.test.ts
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
  "@/lib/supabase/server": "export function createServiceClient() { throw new Error('test: pass a service'); }",
};
export async function resolve(specifier, context, next) {
  if (specifier in STUBS) return { url: "data:text/javascript," + encodeURIComponent(STUBS[specifier]), shortCircuit: true };
  return next(specifier, context);
}`)}`,
);

const {
  assessLiveExport,
  confirmAnswer,
  LiveIngestError,
  needsReview,
  REPEAT_LEAD_INS,
  saveLiveExport,
  turnRowId,
} = await import("./live-ingest.ts");
const { settleOutcome } = await import("./live-transcribe.ts");
const { FOLLOW_UP_REASON_NOT_GIVEN, parseExport } = await import("./live-provider/parse-export.ts");
const { createFakeLiveProvider } = await import("./live-provider/fake-provider.ts");
const { readFrozenQuestionSet, snapshotsFor } = await import("./frozen-questions.ts");
const { fakeLiveDb } = await import("../../test-support/fake-live-db.mjs");

const INTERRUPTION = JSON.parse(
  readFileSync(
    new URL("./live-provider/__fixtures__/sample-export-interruption.json", import.meta.url),
    "utf8",
  ),
);
const fixture = () => structuredClone(INTERRUPTION);
const SESSION = "5b0f2c1e-0000-4000-8000-000000000015";
const T0 = Date.parse("2026-10-26T12:00:00.000Z");
/** Turn indexes in the fixture; sequence is index + 1. */
const Q2 = 10;
const LINE = 11;
const REPEAT = 12;

/** The session's frozen questions: the export's first `count`, as the provider was given them. */
function frozenRow(count = 8) {
  const questions = INTERRUPTION.questions.slice(0, count).map((q, i) => ({
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
    kind: "live",
    attempt: 1,
    provider_session_id: INTERRUPTION.session_id,
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

async function saveRaw(raw, count) {
  const db = fakeLiveDb({ interview_sessions: [frozenRow(count)] });
  const provider = createFakeLiveProvider(raw, {});
  const { providerSessionId } = await provider.createSession({
    remotiv_session_id: SESSION,
    interviewer_name: "Sarah",
    interview_minutes: 20,
    questions: [{ position: 1, text: "Q" }],
    candidate_first_name: "Alex",
    cv_text: "",
  });
  const parsed = {
    ...parseExport(provider.exportOf(providerSessionId)),
    provider_session_id: INTERRUPTION.session_id,
  };
  const orig = console.log;
  console.log = () => {};
  try {
    const result = await saveLiveExport(SESSION, parsed, {
      service: db.service,
      fetchAudio: (name) => provider.fetchAudio(providerSessionId, name),
      now: () => T0,
    });
    return { db, ...result };
  } finally {
    console.log = orig;
  }
}

const rowsOf = (db) => [...db.tables.interview_turns].sort((a, b) => a.sequence - b.sequence);
const summary = (outcome) =>
  outcome.questions.map((q) => [
    q.position,
    q.status,
    q.follow_ups,
    q.repeats,
    q.wording_check,
    q.repeat_check,
    q.interruption_check,
    q.needs_check,
  ]);

/* ── the export as sent, saved ────────────────────────────────── */

test("the interruption export saves as sent: 19 rows, every turn's audio, timestamps untouched", async () => {
  const { db, saved } = await saveRaw(fixture());
  assert.equal(saved, true);
  const rows = rowsOf(db);
  assert.equal(rows.length, 19);
  assert.equal(db.objects.size, 19, "interviewer audio included");
  for (const [i, t] of INTERRUPTION.turns.entries()) {
    const r = rows[i];
    assert.deepEqual(
      [r.id, r.sequence, r.offset_ms, r.duration_ms],
      [turnRowId(SESSION, t.turn_id), i + 1, t.offset_ms, t.audio_duration_ms],
      `turn ${i}`,
    );
  }
  // Question 2's first asking is marked interrupted; its own stop time stays what was sent: none.
  assert.deepEqual(
    rows.filter((r) => r.interrupted).map((r) => [r.sequence, r.audio_stopped_ms]),
    [[Q2 + 1, null]],
  );
  assert.deepEqual([rows[0].kind, rows[0].question_position], ["procedural", null], "the greeting");
  assert.deepEqual(
    [rows[LINE].kind, rows[LINE].question_position, rows[LINE].text],
    ["procedural", null, "Let me just finish the question."],
    "the interruption line",
  );
  assert.deepEqual(
    rows.filter((r) => r.kind === "follow_up").map((r) => r.follow_up_reason),
    [FOLLOW_UP_REASON_NOT_GIVEN, FOLLOW_UP_REASON_NOT_GIVEN, FOLLOW_UP_REASON_NOT_GIVEN],
  );
  assert.deepEqual([rows[9].question_position, rows[17].question_position], [1, 2], "acks");
});

test("the outcome: ending not confirmed, the interruption kept, its missing speech flagged", async () => {
  const { outcome } = await saveRaw(fixture());
  assert.equal(outcome.v, 6);
  assert.deepEqual(
    [
      outcome.provider_status,
      outcome.provider_end_reason,
      outcome.completed_gracefully,
      outcome.provider_status_code,
      outcome.outcome,
    ],
    ["candidate_left", "candidate_left", false, "candidate_ended", "ending_unconfirmed"],
  );
  assert.deepEqual(outcome.end_check, { reason: "exit_unconfirmed", never_asked: 5 });
  assert.deepEqual(summary(outcome), [
    [1, "answered", 2, 0, null, null, null, false],
    [2, "answered", 1, 1, null, null, "speech_missing", false],
    [3, "skipped", 0, 0, null, null, null, false],
    [4, "not_reached", 0, 0, null, null, null, false],
    [5, "not_reached", 0, 0, null, null, null, false],
    [6, "not_reached", 0, 0, null, null, null, false],
    [7, "not_reached", 0, 0, null, null, null, false],
    [8, "not_reached", 0, 0, null, null, null, false],
  ]);
  assert.deepEqual(outcome.interruptions, parseExport(fixture()).interruptions);
  assert.deepEqual(outcome.interruption_check_turns, [LINE + 1]);
  assert.deepEqual(
    [outcome.timing_suspect, outcome.repeat_check_turns, outcome.wording_check_turns],
    [false, [], []],
  );
  assert.deepEqual(
    [outcome.answers_usable, outcome.needs_review, outcome.final, outcome.restart_allowed],
    [false, true, false, null],
  );
});

/* ── the repeat after the line (F11) ──────────────────────────── */

const withLine = (text) => {
  const f = fixture();
  f.turns[LINE].text = text;
  return f;
};

test("the repeat is read with the line in front: each known lead-in passes unflagged", () => {
  for (const lead of REPEAT_LEAD_INS) {
    const f = assess(withLine(lead));
    assert.deepEqual(
      [f.questions[1].repeat_check, f.repeat_check_turns, f.questions[1].repeats],
      [null, [], 1],
      lead,
    );
  }
});

test("any other line is an unexpected lead-in, a long one altered wording: flagged and held", () => {
  const hint = assess(withLine("Think about the release you mentioned earlier."));
  assert.deepEqual(
    [hint.questions[1].repeat_check, hint.repeat_check_turns, hint.needs_review],
    ["unexpected_lead_in", [REPEAT + 1], true],
  );
  const long = assess(
    withLine(
      "Before I finish, remember that we value people who mention the deployment pipeline and its rollback steps.",
    ),
  );
  assert.equal(long.questions[1].repeat_check, "altered_wording");
  // After a known line the frozen wording is still checked.
  const f = fixture();
  f.turns[REPEAT].text = "Tell me about a project you are proud of.";
  assert.equal(assess(f).questions[1].repeat_check, "altered_wording");
  // The repeat's own lead-in after the line is more than a known phrase: flagged.
  const g = fixture();
  g.turns[REPEAT].text = `Of course. ${g.turns[REPEAT].text}`;
  assert.equal(assess(g).questions[1].repeat_check, "unexpected_lead_in");
});

test("a repeat not right after a line is read alone, as before", () => {
  const f = withLine("Think about the release you mentioned earlier.");
  const ack = { ...structuredClone(f.turns[3]), turn_id: "40000000-0000-4000-8000-000000000097" };
  ack.responds_to_turn_id = f.turns[8].turn_id;
  ack.question_id = 2;
  ack.base_question_id = f.questions[1].id;
  ack.offset_ms = f.turns[LINE].offset_ms + f.turns[LINE].audio_duration_ms + 10;
  ack.audio_duration_ms = 20;
  f.turns.splice(REPEAT, 0, ack);
  const a = assess(f);
  assert.deepEqual([a.questions[1].repeat_check, a.questions[1].repeats], [null, 1]);
});

/* ── the integrity checks, unchanged ──────────────────────────── */

test("F11/F12 integrity: an unmarked second asking, a 9th question named, a changed first asking", () => {
  const twice = fixture();
  twice.turns[REPEAT].turn_type = "base_question";
  assert.throws(
    () => assess(twice),
    (e) => e instanceof LiveIngestError && e.code === "duplicate_base_question",
  );
  const ninth = fixture();
  ninth.turns[18].question_id = 9;
  ninth.turns[18].base_question_id = ninth.questions[8].id;
  assert.throws(
    () => assess(ninth),
    (e) => e instanceof LiveIngestError && e.code === "unknown_question_position",
  );
  const changed = fixture();
  changed.turns[Q2].text = `Quick hint first. ${changed.turns[Q2].text}`;
  assert.equal(assess(changed).questions[1].wording_check, "unexpected_lead_in");
  const greeted = fixture();
  greeted.turns[1].text = `${greeted.turns[0].text} ${greeted.turns[1].text}`;
  assert.equal(assess(greeted).questions[0].wording_check, "altered_wording");
});

/* ── how it ended, through the save ───────────────────────────── */

test("completed only with end_reason completed and completed_gracefully true; never from status", async () => {
  const ending = (fields) => {
    const f = fixture();
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined) delete f[k];
      else f[k] = v;
    }
    return f;
  };
  const done = await saveRaw(
    ending({ status: "completed", end_reason: "completed", completed_gracefully: true }),
  );
  assert.deepEqual(
    [done.outcome.outcome, done.outcome.end_check, done.outcome.held_from_ranking],
    ["completed", { reason: "closed_early", never_asked: 5 }, true],
  );
  assert.equal(done.outcome.completed_gracefully, true);
  for (const fields of [
    { status: "completed", end_reason: undefined, completed_gracefully: true },
    { status: "completed", end_reason: "completed", completed_gracefully: false },
    { status: "completed", end_reason: "completed", completed_gracefully: undefined },
  ]) {
    const { outcome } = await saveRaw(ending(fields));
    assert.deepEqual(
      [outcome.outcome, outcome.end_check.reason, outcome.held_from_ranking],
      ["ending_unconfirmed", "ending_unknown", false],
      JSON.stringify(fields),
    );
  }
});

/* ── missing interruption speech is never counted as captured ─── */

function candidateStates(db, status = "done") {
  return rowsOf(db)
    .filter((r) => r.speaker === "candidate")
    .map((r) => ({
      sequence: r.sequence,
      position: r.question_position,
      transcript_status: status,
      transcript: "I led the work and shipped it in two weeks.",
      transcript_segments: null,
    }));
}

/**
 * The fixture with the candidate's cut-in exported as its own turn, in start
 * order: before the line. (Sequenced after the line it starts before the
 * line ends, and the timing check rightly marks it suspect.)
 */
function withCutIn() {
  const f = fixture();
  f.turns.splice(LINE, 0, {
    ...structuredClone(f.turns[8]),
    turn_id: "40000000-0000-4000-8000-000000000098",
    responds_to_turn_id: f.turns[Q2].turn_id,
    question_id: 2,
    base_question_id: f.questions[1].id,
    offset_ms: f.turns[LINE].offset_ms - 900,
    audio_duration_ms: 1500,
    audio_file: "candidate_turn_cutin.wav",
  });
  return f;
}

test("settled with every transcript done: still not usable while the cut-in speech is missing", async () => {
  const { db, outcome } = await saveRaw(fixture());
  const next = settleOutcome(outcome, candidateStates(db), 1);
  assert.deepEqual(
    [next.final, next.answers_usable, next.needs_review, next.interruption_check_turns],
    [true, false, true, [LINE + 1]],
  );
  // provider_error with that speech lost is an answer lost (D2): technical_failure.
  const lost = settleOutcome(
    { ...outcome, provider_status_code: "provider_error" },
    candidateStates(db),
    1,
  );
  assert.deepEqual([lost.outcome, lost.restart_allowed], ["technical_failure", true]);
  // A transcript confirming an answer keeps the flag.
  assert.equal(confirmAnswer(next, 2, true, 1).needs_review, true);
});

test("the control: the cut-in exported, the same ending is usable and needs no interruption check", async () => {
  const { db, outcome } = await saveRaw(withCutIn());
  assert.deepEqual(
    [
      outcome.interruptions[0].candidate_speech_exported,
      outcome.interruption_check_turns,
      outcome.questions[1].interruption_check,
    ],
    [true, [], null],
  );
  const next = settleOutcome(
    { ...outcome, provider_status_code: "provider_error" },
    candidateStates(db),
    1,
  );
  assert.deepEqual(
    [next.answers_usable, next.outcome, next.end_check.reason],
    [true, "ending_unconfirmed", "provider_error_saved"],
  );
});

test("an ambiguous interruption is flagged on its question, ahead of missing speech", () => {
  const f = fixture();
  f.turns[LINE].offset_ms = f.turns[Q2].offset_ms + f.turns[Q2].audio_duration_ms + 50;
  const a = assess(f);
  assert.deepEqual(
    [a.questions[1].interruption_check, a.interruption_check_turns, a.needs_review],
    ["ambiguous", [LINE + 1], true],
  );
  // A second line on the same question, placed cleanly, its speech missing: still ambiguous.
  const second = {
    ...structuredClone(f.turns[LINE]),
    turn_id: "40000000-0000-4000-8000-000000000096",
    offset_ms: f.turns[REPEAT].offset_ms + 1000,
  };
  f.turns.splice(REPEAT + 1, 0, second);
  const b = assess(f);
  assert.deepEqual(
    [b.interruptions.map((i) => i.ambiguity), b.interruption_check_turns],
    [
      ["starts_outside_turn", null],
      [LINE + 1, REPEAT + 2],
    ],
  );
  assert.equal(b.questions[1].interruption_check, "ambiguous");
});

/** Three questions, a normal close: no ending check, so only the interruption can need a person. */
function closedNormally(raw) {
  raw.status = "completed";
  raw.end_reason = "completed";
  raw.completed_gracefully = true;
  return raw;
}

test("the interruption alone makes a person look: at save, after the settle and after a confirm", async () => {
  const { db, outcome } = await saveRaw(closedNormally(fixture()), 3);
  assert.deepEqual(
    [outcome.outcome, outcome.end_check, outcome.needs_review],
    ["completed", null, true],
  );
  const next = settleOutcome(outcome, candidateStates(db), 1);
  assert.deepEqual([next.end_check, next.needs_review], [null, true]);
  assert.equal(confirmAnswer(next, 2, true, 1).needs_review, true);
  // The control: the cut-in exported, nothing to look at.
  const clean = await saveRaw(closedNormally(withCutIn()), 3);
  assert.equal(clean.outcome.needs_review, false);
  const settled = settleOutcome(clean.outcome, candidateStates(clean.db), 1);
  assert.equal(settled.needs_review, false);
  assert.equal(confirmAnswer(settled, 2, true, 1).needs_review, false);
});

test("final at save (no candidate turn): missing cut-in speech is still not usable", () => {
  const f = fixture();
  f.turns = [f.turns[0], f.turns[Q2], f.turns[LINE], f.turns[REPEAT]].map((t) => ({
    ...t,
    responds_to_turn_id: null,
  }));
  f.end_reason = "provider_error";
  f.status = "error";
  const a = assess(f);
  assert.deepEqual(
    [a.final, a.answers_usable, a.outcome, a.restart_allowed],
    [true, false, "technical_failure", true],
  );
  // The control: the same export with the line's speech exported is usable.
  const g = structuredClone(f);
  g.turns.splice(2, 0, {
    ...structuredClone(INTERRUPTION.turns[8]),
    turn_id: "40000000-0000-4000-8000-000000000095",
    responds_to_turn_id: g.turns[1].turn_id,
    question_id: 2,
    base_question_id: g.questions[1].id,
    offset_ms: g.turns[2].offset_ms - 900,
    audio_duration_ms: 500,
  });
  const b = assess(g);
  assert.equal(b.interruptions[0].candidate_speech_exported, true);
  assert.equal(b.final, false, "a candidate turn to transcribe");
});

test("needs_review counts interruption checks; an outcome saved before version 5 settles as before", async () => {
  assert.equal(needsReview([{ needs_check: false }], [], null, [12]), true);
  assert.equal(needsReview([{ needs_check: false }], [], null, []), false);
  assert.equal(needsReview([{ needs_check: false }], [], null), false);
  const { db, outcome } = await saveRaw(withCutIn());
  const old = { ...outcome, v: 4 };
  delete old.interruptions;
  delete old.interruption_check_turns;
  for (const q of old.questions) delete q.interruption_check;
  const next = settleOutcome(old, candidateStates(db), 1);
  assert.deepEqual([next.final, next.answers_usable], [true, true]);
});
