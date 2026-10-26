/**
 * Saving an AI Video Interview's parsed export (lib/interviews/live-ingest.ts)
 * into a database fake that enforces interview_turns' constraints (migrations
 * 021, 022, 041) and lands a multi-row insert whole or not at all. The export
 * is the commit 2 fixture: the structure and timings of the provider's sample,
 * every word made up. Audio comes from the fake provider. Nothing leaves the
 * machine.
 *
 *   node --test src/lib/interviews/live-ingest.test.ts
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
  audioPath,
  BASE_QUESTION_TRANSITIONS,
  classifyAsked,
  classifyRepeat,
  CONTRACTIONS,
  FILLER_SOUNDS,
  CONFIRMED_EXIT_CODES,
  confirmAnswer,
  exportHash,
  isOutcomeDecided,
  LIVE_OUTCOME_VERSION,
  LiveIngestError,
  MAX_UNEXPECTED_LEAD_IN_WORDS,
  needsReview,
  outcomeFrom,
  REPEAT_LEAD_INS,
  repeatMatchesQuestion,
  saveLiveExport,
  turnRowId,
} = await import("./live-ingest.ts");
const { parseExport } = await import("./live-provider/parse-export.ts");
const { createFakeLiveProvider, fakeAudioBytes } = await import("./live-provider/fake-provider.ts");
const { readFrozenQuestionSet, snapshotsFor } = await import("./frozen-questions.ts");
const { fakeLiveDb } = await import("../../test-support/fake-live-db.mjs");

const FIXTURE = JSON.parse(
  readFileSync(new URL("./live-provider/__fixtures__/sample-export.json", import.meta.url), "utf8"),
);
const SESSION = "5b0f2c1e-0000-4000-8000-000000000001";
const PROVIDER_SESSION = FIXTURE.session_id;
const T0 = Date.parse("2026-10-19T12:00:00.000Z");

/** The session's frozen questions: the fixture's first eight, 4 job + 4 CV. */
function frozenRow(overrides = {}, texts) {
  const questions = FIXTURE.questions
    .filter((q) => q.position <= 8)
    .sort((a, b) => a.position - b.position)
    .map((q) => ({
      question_id: `q-${q.position}`,
      position: q.position,
      text: texts?.[q.position] ?? q.text,
      source: q.position <= 4 ? "job" : "cv",
      competency: "Ownership",
      scoring_guide: "Strong answer: specific. Weak answer: general.",
      weight: null,
    }));
  return {
    id: SESSION,
    kind: "live",
    attempt: 1,
    provider_session_id: PROVIDER_SESSION,
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
    live_outcome: null,
    ...snapshotsFor(questions),
    ...overrides,
  };
}

/** A database with the frozen session, a fake provider holding the fixture, and the save's deps. */
function world({ session = frozenRow(), audio = {} } = {}) {
  const db = fakeLiveDb({ interview_sessions: [session] });
  const provider = createFakeLiveProvider(FIXTURE, audio);
  return { db, provider };
}

async function save(w, parsed) {
  // The fake provider's session ids are its own; its export says PROVIDER_SESSION.
  const { providerSessionId } = await w.provider.createSession({
    remotiv_session_id: SESSION,
    interviewer_name: "Sarah",
    interview_minutes: 30,
    questions: [{ position: 1, text: "Q" }],
    candidate_first_name: "Alex",
    cv_text: "",
  });
  const exported = parsed ?? {
    ...parseExport(w.provider.exportOf(providerSessionId)),
    provider_session_id: PROVIDER_SESSION,
  };
  return quiet(() =>
    saveLiveExport(SESSION, exported, {
      service: w.db.service,
      fetchAudio: (name) => w.provider.fetchAudio(providerSessionId, name),
      now: () => T0,
    }),
  );
}

async function quiet(fn) {
  const orig = console.log;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.log = orig;
  }
}

const parsedFixture = () => parseExport(structuredClone(FIXTURE));
const frozenOf = (overrides, texts) => readFrozenQuestionSet(frozenRow(overrides, texts));

/* ── the fixture, saved ───────────────────────────────────────── */

test("the commit 2 fixture lands as 32 valid rows, in order, with the right kinds and links", async () => {
  const w = world();
  const { outcome, saved } = await save(w);
  assert.equal(saved, true);
  const rows = [...w.db.tables.interview_turns].sort((a, b) => a.sequence - b.sequence);
  assert.equal(rows.length, 32);
  assert.deepEqual(
    rows.map((r) => r.sequence),
    Array.from({ length: 32 }, (_, i) => i + 1),
  );
  const kinds = {};
  for (const r of rows)
    kinds[`${r.speaker}/${r.kind}`] = (kinds[`${r.speaker}/${r.kind}`] ?? 0) + 1;
  assert.deepEqual(kinds, {
    "interviewer/base_question": 6,
    "interviewer/follow_up": 8,
    "interviewer/procedural": 5,
    "candidate/null": 13,
  });
  // responds_to points at OUR row ids, mapped from the provider's.
  for (const [i, t] of FIXTURE.turns.entries()) {
    const r = rows[i];
    assert.equal(r.id, turnRowId(SESSION, t.turn_id));
    assert.equal(
      r.responds_to_turn_id,
      t.responds_to_turn_id ? turnRowId(SESSION, t.responds_to_turn_id) : null,
    );
  }
  // Audio stored at the fixed path, hashed from the bytes handed over.
  for (const r of rows) {
    // Scoped by the export's hash, in the file name: {session}/t{seq}.{hash8}.wav.
    assert.equal(r.media_path, audioPath(SESSION, r.sequence, outcome.export_hash, "wav"));
    assert.match(r.media_path, new RegExp(`^${SESSION}/t${r.sequence}\\.[0-9a-f]{16}\\.wav$`));
    const name =
      FIXTURE.turns[r.sequence - 1].audio_file ??
      FIXTURE.turns[r.sequence - 1].interviewer_audio_file;
    const bytes = fakeAudioBytes(name);
    assert.equal(r.media_sha256, createHash("sha256").update(bytes).digest("hex"));
    assert.equal(r.media_bytes, bytes.byteLength);
    assert.equal(r.media_mime_type, "audio/wav");
    assert.deepEqual([...w.db.objects.get(r.media_path).bytes], [...bytes]);
  }
  for (const r of rows.filter((x) => x.speaker === "candidate")) {
    assert.equal(r.text, null, "candidate words come from Remotiv's transcription");
    assert.equal(r.transcript_status, "pending");
  }
  assert.equal(w.db.objects.size, 32);
  assert.equal(outcome.turn_count, 32);
});

test("what the fixture produced: statuses, follow-ups, timing_suspect; candidate_ended is ending_unconfirmed", async () => {
  const w = world();
  const { outcome } = await save(w);
  assert.deepEqual(
    outcome.questions.map((q) => [q.position, q.source, q.status, q.follow_ups]),
    [
      [1, "job", "answered", 0],
      [2, "job", "answered", 2],
      [3, "job", "answered", 2],
      [4, "job", "answered", 2],
      [5, "cv", "answered", 2],
      [6, "cv", "skipped", 0],
      [7, "cv", "not_reached", 0],
      [8, "cv", "not_reached", 0],
    ],
  );
  assert.deepEqual(
    outcome.questions.map((q) => q.confirmed),
    [false, false, false, false, false, null, null, null],
    "answers wait for the transcript to confirm them",
  );
  assert.deepEqual(
    [
      outcome.outcome,
      outcome.answered_count,
      outcome.skipped_count,
      outcome.not_reached_count,
      outcome.total,
      outcome.completion_percent,
    ],
    ["ending_unconfirmed", 5, 1, 2, 8, 63],
  );
  assert.deepEqual(outcome.end_check, { reason: "exit_unconfirmed", never_asked: 2 });
  assert.equal(outcome.v, 5);
  // Provisional until every answer is transcribed: no restart decision yet.
  assert.deepEqual([outcome.final, outcome.restart_allowed], [false, null]);
  assert.equal(isOutcomeDecided(outcome), false);
  // Every candidate turn of the sample starts while the interviewer is still speaking, unmarked.
  assert.equal(outcome.timing_suspect, true);
  assert.equal(outcome.timing_suspect_turns.length, 13);
  // So every answered question needs a check, and the session a person.
  assert.deepEqual(
    outcome.questions.map((q) => q.needs_check),
    [true, true, true, true, true, false, false, false],
  );
  assert.deepEqual([outcome.needs_review, outcome.transcription_failed_turns], [true, []]);
  // The sample folds Sarah's greeting into question 1's turn: held for a
  // wording check until the provider sends it as its own turn (F12). Every
  // other question is asked as frozen.
  assert.deepEqual(
    outcome.questions.map((q) => q.wording_check),
    ["altered_wording", null, null, null, null, null, null, null],
  );
  assert.equal(outcome.wording_check_turns.length, 1);
  // The sample has no marked repeat: nothing to check.
  assert.deepEqual(outcome.repeat_check_turns, []);
  assert.ok(outcome.questions.every((q) => q.repeat_check === null));
  assert.equal(outcome.provider_status, "candidate_ended");
  assert.match(outcome.export_hash, /^[0-9a-f]{64}$/);
  assert.equal(outcome.saved_at, new Date(T0).toISOString());
  assert.deepEqual(w.db.tables.interview_sessions[0].live_outcome, outcome);
});

/* ── idempotent, all or nothing ───────────────────────────────── */

test("saving the same export again: no new rows, no new uploads, the same outcome", async () => {
  const w = world();
  const first = await save(w);
  const counts = { ...w.db.counts };
  const again = await save(w);
  assert.equal(again.saved, false);
  assert.deepEqual(again.outcome, first.outcome);
  assert.equal(w.db.tables.interview_turns.length, 32);
  assert.deepEqual(w.db.counts, counts, "nothing written the second time");
});

test("a failure midway saves nothing: a refused insert leaves no turns and no outcome", async () => {
  const w = world();
  w.db.failNext("interview_turns", "insert");
  await assert.rejects(save(w), (e) => e instanceof LiveIngestError && e.code === "db_error");
  assert.equal(w.db.tables.interview_turns.length, 0);
  assert.equal(w.db.tables.interview_sessions[0].live_outcome, null);
  // Saving again works, and lands once.
  const { saved } = await save(w);
  assert.equal(saved, true);
  assert.equal(w.db.tables.interview_turns.length, 32);
});

test("a row the table would refuse refuses the whole statement: no partial session", async () => {
  const parsed = parsedFixture();
  // Turn 20 claims a sequence another turn holds: the unique key fails mid-statement.
  parsed.turns[19] = { ...parsed.turns[19], sequence: parsed.turns[3].sequence };
  const w = world();
  await assert.rejects(
    save(w, parsed),
    (e) => e instanceof LiveIngestError && e.code === "db_error",
  );
  assert.equal(w.db.tables.interview_turns.length, 0);
});

test("a crash after the turns, before the outcome: saving again writes the outcome, no duplicate turns", async () => {
  const w = world();
  w.db.failNext("interview_sessions", "update");
  await assert.rejects(save(w), (e) => e instanceof LiveIngestError && e.code === "db_error");
  assert.equal(w.db.tables.interview_turns.length, 32);
  assert.equal(w.db.tables.interview_sessions[0].live_outcome, null);
  const uploads = w.db.counts.uploads;
  const { saved, outcome } = await save(w);
  assert.equal(saved, true);
  assert.equal(outcome.outcome, "ending_unconfirmed");
  assert.equal(w.db.tables.interview_turns.length, 32);
  assert.equal(w.db.counts.uploads, uploads, "the audio is not uploaded again");
});

test("missing or bad audio is refused before anything is uploaded", async () => {
  const name = FIXTURE.turns[7].interviewer_audio_file;
  for (const [audio, code] of [
    [{ [name]: null }, "missing_audio"],
    [{ [name]: { bytes: new Uint8Array(), mime_type: "audio/wav" } }, "bad_audio"],
    [{ [name]: { bytes: new Uint8Array([1, 2, 3]), mime_type: "video/quicktime" } }, "bad_audio"],
  ]) {
    const w = world({ audio });
    await assert.rejects(save(w), (e) => e instanceof LiveIngestError && e.code === code, code);
    assert.equal(w.db.objects.size, 0, `${code}: nothing uploaded`);
    assert.equal(w.db.tables.interview_turns.length, 0);
  }
});

test("refused: not frozen, another provider session, a different export after one was saved", async () => {
  const notFrozen = world({ session: frozenRow({ live_settings: { v: 2 } }) });
  await assert.rejects(save(notFrozen), (e) => e.code === "not_frozen");

  const wrong = world({ session: frozenRow({ provider_session_id: "sess-other" }) });
  await assert.rejects(save(wrong), (e) => e.code === "wrong_session");

  const w = world();
  await save(w);
  const other = parsedFixture();
  other.turns[0] = { ...other.turns[0], text: `${other.turns[0].text} Again.` };
  await assert.rejects(save(w, other), (e) => e.code === "already_saved");
  assert.equal(w.db.tables.interview_turns.length, 32);
});

/* ── the rules, on the facts alone ────────────────────────────── */

test("unknown question positions and a question asked twice are refused", () => {
  const p = parsedFixture();
  p.turns[3] = { ...p.turns[3], question_position: 9 };
  assert.throws(
    () => assessLiveExport(p, frozenOf(), 1),
    (e) => e.code === "unknown_question_position",
  );
  const twice = parsedFixture();
  twice.turns[3] = { ...twice.turns[3], question_position: 1 };
  assert.throws(
    () => assessLiveExport(twice, frozenOf(), 1),
    (e) => e.code === "duplicate_base_question",
  );
});

test("procedural turns never count as follow-ups; more than 2 follow-ups is refused", () => {
  const p = parsedFixture();
  // A silence reminder on question 2, then a repeat of it: both procedural.
  const base = p.turns.find((t) => t.kind === "base_question" && t.question_position === 2);
  p.turns.push(
    {
      ...base,
      provider_turn_id: "reminder",
      sequence: 33,
      kind: "procedural",
      text: "Take your time.",
      responds_to_provider_turn_id: null,
    },
    {
      ...base,
      provider_turn_id: "repeat",
      sequence: 34,
      kind: "procedural",
      text: base.text,
      responds_to_provider_turn_id: null,
    },
  );
  const facts = assessLiveExport(p, frozenOf(), 1);
  assert.equal(facts.questions[1].follow_ups, 2);

  const three = parsedFixture();
  const fu = three.turns.find((t) => t.kind === "follow_up" && t.question_position === 2);
  three.turns.push({ ...fu, provider_turn_id: "third", sequence: 33 });
  assert.throws(
    () => assessLiveExport(three, frozenOf(), 1),
    (e) => e.code === "too_many_follow_ups",
  );
});

test("timing: an interrupted turn with overlap is fine; overlap without the mark is suspect", () => {
  const p = parsedFixture();
  for (const t of p.turns) if (t.speaker === "interviewer") t.interrupted = true;
  const marked = assessLiveExport(p, frozenOf(), 1);
  assert.equal(marked.timing_suspect, false);
  assert.deepEqual(marked.timing_suspect_turns, []);

  const one = parsedFixture();
  for (const t of one.turns) if (t.speaker === "interviewer") t.interrupted = true;
  one.turns[0] = { ...one.turns[0], interrupted: false };
  const facts = assessLiveExport(one, frozenOf(), 1);
  assert.equal(facts.timing_suspect, true);
  assert.deepEqual(facts.timing_suspect_turns, [2]);
});

test("a first asking that strays from the frozen question is flagged, not refused", () => {
  const facts = assessLiveExport(
    parsedFixture(),
    frozenOf({}, { 3: "Describe your favourite kitchen appliance and why you bought it." }),
    1,
  );
  assert.equal(facts.questions[2].wording_check, "altered_wording");
  assert.ok(
    facts.wording_check_turns.includes(
      parsedFixture().turns.find((t) => t.kind === "base_question" && t.question_position === 3)
        .sequence,
    ),
  );
  assert.equal(facts.questions[2].status, "answered");
  assert.equal(facts.needs_review, true);
});

/* ── statuses and outcomes ────────────────────────────────────── */

/** A clean export: `asked` questions asked in order, each answered for `answerMs` (per position). */
function cleanExport({ asked = 8, answerMs = () => 20_000, status = "completed" } = {}) {
  const turns = [];
  let seq = 0;
  let clock = 1_000;
  for (let pos = 1; pos <= asked; pos++) {
    const q = {
      provider_turn_id: `q${pos}`,
      sequence: ++seq,
      speaker: "interviewer",
      kind: "base_question",
      question_position: pos,
      follow_up_index: null,
      follow_up_reason: null,
      responds_to_provider_turn_id: null,
      text: FIXTURE.questions.find((x) => x.position === pos).text,
      offset_ms: clock,
      duration_ms: 5_000,
      interrupted: false,
      audio_stopped_ms: null,
      started_at: "2026-10-16T05:48:47.157Z",
      ended_at: "2026-10-16T05:48:52.157Z",
      audio_file_name: `interviewer_turn_${pos}.wav`,
    };
    clock += 6_000;
    const ms = answerMs(pos);
    turns.push(q);
    if (ms > 0) {
      turns.push({
        provider_turn_id: `a${pos}`,
        sequence: ++seq,
        speaker: "candidate",
        kind: null,
        question_position: pos,
        follow_up_index: null,
        follow_up_reason: null,
        responds_to_provider_turn_id: `q${pos}`,
        text: null,
        offset_ms: clock,
        duration_ms: ms,
        interrupted: false,
        audio_stopped_ms: null,
        started_at: "2026-10-16T05:48:53.157Z",
        ended_at: "2026-10-16T05:49:13.157Z",
        audio_file_name: `candidate_turn_${pos}.wav`,
      });
      clock += ms + 1_000;
    }
  }
  return {
    provider_session_id: PROVIDER_SESSION,
    status: {
      code: status,
      provider_status: status,
      end_reason: status,
      completed_gracefully: status === "completed",
    },
    interviewer_name: "Sarah",
    started_at: "2026-10-16T05:48:47.157Z",
    ended_at: null,
    duration_ms: null,
    questions: [],
    turns,
    interruptions: [],
    warnings: { overlaps: { count: 0, max_ms: 0, turns: [] } },
  };
}

/** The assessment as it will stand once every answer is transcribed and confirmed: final. */
function decidedAssess(parsed, frozen, attempt, { usable = true, exitCodes } = {}) {
  const f = assessLiveExport(parsed, frozen, attempt);
  assert.equal(
    f.final,
    !parsed.turns.some((t) => t.speaker === "candidate"),
    "provisional at save",
  );
  return {
    ...f,
    ...outcomeFrom(f.questions, f.provider_status_code, attempt, true, usable, exitCodes),
  };
}

/** D10 switched on: candidate_ended counts as a confirmed exit. */
const D10 = new Set(["candidate_ended"]);

/** D10 switched on in the shipped list, for code that reads it (confirmAnswer). */
function withExit(fn) {
  CONFIRMED_EXIT_CODES.add("candidate_ended");
  try {
    return fn();
  } finally {
    CONFIRMED_EXIT_CODES.delete("candidate_ended");
  }
}

test("all answered: completed, 8 of 8, 100%", () => {
  const f = decidedAssess(cleanExport(), frozenOf(), 1);
  assert.deepEqual(
    [f.outcome, f.answered_count, f.total, f.completion_percent, f.restart_allowed],
    ["completed", 8, 8, 100, false],
  );
  assert.ok(f.questions.every((q) => q.status === "answered"));
  assert.deepEqual([f.questions.some((q) => q.needs_check), f.needs_review], [false, false]);
  assert.equal(f.timing_suspect, false);
});

test('a 2-second answer ("Yes, three years") is answered; a silent question is skipped', () => {
  const f = decidedAssess(
    cleanExport({ answerMs: (p) => (p === 3 ? 0 : p === 6 ? 2_000 : 20_000) }),
    frozenOf(),
    1,
  );
  assert.equal(f.questions[5].status, "answered", "any captured speech counts");
  assert.equal(f.questions[5].confirmed, false);
  assert.deepEqual([f.questions[2].status, f.questions[2].confirmed], ["skipped", null]);
  assert.deepEqual(
    [f.outcome, f.answered_count, f.skipped_count, f.not_reached_count, f.completion_percent],
    ["completed", 7, 1, 0, 88],
  );
});

/* ── D2 (revised 22 Oct 2026): completed only from a normal close ── */

const view = (f) => [
  f.outcome,
  f.end_check?.reason ?? null,
  f.restart_allowed,
  f.restart_needs_person,
  f.held_from_ranking,
];

test("completed comes only from a normal close: 3 answered still completed, never downgraded by coverage", () => {
  const f = decidedAssess(cleanExport({ answerMs: (p) => (p <= 3 ? 20_000 : 0) }), frozenOf(), 1);
  assert.deepEqual(
    [f.outcome, f.answered_count, f.skipped_count, f.not_reached_count],
    ["completed", 3, 5, 0],
  );
  assert.deepEqual(view(f), ["completed", null, false, false, false]);
});

test("completed with questions never asked: still completed, flagged closed_early, held from ranking", () => {
  const f = decidedAssess(cleanExport({ asked: 6 }), frozenOf(), 1);
  assert.deepEqual(view(f), ["completed", "closed_early", false, false, true]);
  assert.deepEqual(f.end_check, { reason: "closed_early", never_asked: 2 });
  assert.equal(f.not_reached_count, 2, "not reached: left out, never zero");
});

test("every question asked is never completed without a normal close", () => {
  for (const status of ["candidate_ended", "timed_out", "unknown", "provider_error"]) {
    const f = decidedAssess(cleanExport({ status }), frozenOf(), 1, { usable: false });
    assert.notEqual(f.outcome, "completed", status);
    assert.equal(f.not_reached_count, 0);
  }
});

test("candidate_ended is not a confirmed exit yet: ending_unconfirmed at any count, a person decides the restart", () => {
  for (const asked of [8, 5, 3, 0]) {
    const f = decidedAssess(cleanExport({ asked, status: "candidate_ended" }), frozenOf(), 1);
    assert.deepEqual(
      view(f),
      ["ending_unconfirmed", "exit_unconfirmed", null, true, false],
      `asked ${asked}`,
    );
    assert.equal(f.needs_review || needsReview(f.questions, [], f.end_check), true);
  }
});

test("D10 switched on: a confirmed exit is partial (4-7) or abandoned (0-3, restart once); 8 of 8 still needs a person", () => {
  const at = (asked, attempt = 1) =>
    decidedAssess(cleanExport({ asked, status: "candidate_ended" }), frozenOf(), attempt, {
      exitCodes: D10,
    });
  assert.deepEqual(view(at(7)), ["partial", null, false, false, false]);
  assert.deepEqual(view(at(4)), ["partial", null, false, false, false]);
  assert.deepEqual(view(at(3)), ["abandoned", null, true, false, false]);
  assert.deepEqual(view(at(0)), ["abandoned", null, true, false, false]);
  assert.equal(
    at(3, 2).restart_allowed,
    false,
    "abandoned again on the restart: no further restart",
  );
  assert.deepEqual(view(at(8)), [
    "ending_unconfirmed",
    "left_after_last_answer",
    null,
    true,
    false,
  ]);
  // The switch is per status: a confirmed candidate_ended does not confirm a time limit.
  const t = decidedAssess(cleanExport({ asked: 3, status: "timed_out" }), frozenOf(), 1, {
    exitCodes: D10,
  });
  assert.equal(t.outcome, "ending_unconfirmed");
});

test("a time limit, an unknown or a missing status: ending_unconfirmed, never abandoned, never an automatic restart", () => {
  for (const status of ["timed_out", "unknown"]) {
    for (const asked of [0, 2, 3, 8]) {
      const f = decidedAssess(cleanExport({ asked, status }), frozenOf(), 1);
      assert.deepEqual(
        view(f),
        ["ending_unconfirmed", "ending_unknown", null, true, false],
        `${status} ${asked}`,
      );
    }
  }
});

test("provider_error: every answer usable is ending_unconfirmed (no automatic restart); an answer lost is technical_failure", () => {
  const saved = decidedAssess(cleanExport({ status: "provider_error" }), frozenOf(), 1, {
    usable: true,
  });
  assert.deepEqual(view(saved), ["ending_unconfirmed", "provider_error_saved", null, true, false]);
  const early = decidedAssess(cleanExport({ asked: 5, status: "provider_error" }), frozenOf(), 1, {
    usable: true,
  });
  assert.equal(early.outcome, "ending_unconfirmed", "not reached is not lost");
  for (const attempt of [1, 2]) {
    const lost = decidedAssess(
      cleanExport({ asked: 7, status: "provider_error" }),
      frozenOf(),
      attempt,
      { usable: false },
    );
    assert.deepEqual(
      view(lost),
      ["technical_failure", null, true, false, false],
      `attempt ${attempt}`,
    );
  }
  // Before every answer is settled nothing is decided, whatever the end.
  const f = assessLiveExport(cleanExport({ status: "provider_error" }), frozenOf(), 1);
  assert.deepEqual(
    [f.final, f.restart_allowed, f.restart_needs_person, f.answers_usable],
    [false, null, false, false],
  );
});

test("complete and finished are unknown until D10: never completed", () => {
  for (const word of ["complete", "finished", "Finished", "COMPLETE"]) {
    const raw = structuredClone(FIXTURE);
    raw.status = word;
    const parsed = parseExport(raw);
    assert.equal(parsed.status.code, "unknown", word);
    const f = decidedAssess(parsed, frozenOf(), 1);
    assert.deepEqual(
      [f.outcome, f.end_check.reason],
      ["ending_unconfirmed", "ending_unknown"],
      word,
    );
  }
  // Status alone is never completed (F15): end_reason "completed" and completed_gracefully true are.
  assert.equal(
    parseExport({ ...structuredClone(FIXTURE), status: "completed" }).status.code,
    "unknown",
  );
  assert.equal(
    parseExport({
      ...structuredClone(FIXTURE),
      status: "completed",
      end_reason: "completed",
      completed_gracefully: true,
    }).status.code,
    "completed",
  );
});

test("both real exports (candidate_ended) are never completed, even once every answer is settled", () => {
  const repeat = JSON.parse(
    readFileSync(
      new URL("./live-provider/__fixtures__/sample-export-repeat.json", import.meta.url),
      "utf8",
    ),
  );
  for (const raw of [FIXTURE, repeat]) {
    const f = decidedAssess(parseExport(structuredClone(raw)), frozenOf(), 1, { usable: true });
    assert.equal(f.provider_status_code, "candidate_ended");
    assert.deepEqual(view(f), ["ending_unconfirmed", "exit_unconfirmed", null, true, false]);
  }
});

test("needs_review includes the ending, a repeat check and a wording check; the outcome version is 5; the shipped exit list is empty", () => {
  assert.equal(
    needsReview([{ needs_check: false }], [], { reason: "ending_unknown", never_asked: 0 }),
    true,
  );
  assert.equal(needsReview([{ needs_check: false }], [], null), false);
  assert.equal(needsReview([{ needs_check: false, repeat_check: null }], [], null), false);
  for (const check of ["unexpected_lead_in", "altered_wording"]) {
    assert.equal(needsReview([{ needs_check: false, repeat_check: check }], [], null), true, check);
  }
  // An outcome saved before version 3 has no field: read as no check.
  assert.equal(needsReview([{ needs_check: false, repeat_check: undefined }], [], null), false);
  for (const check of ["unexpected_lead_in", "altered_wording"]) {
    assert.equal(
      needsReview([{ needs_check: false, wording_check: check }], [], null),
      true,
      check,
    );
  }
  // Nor before version 4.
  assert.equal(needsReview([{ needs_check: false, wording_check: undefined }], [], null), false);
  assert.equal(LIVE_OUTCOME_VERSION, 5);
  assert.equal(CONFIRMED_EXIT_CODES.size, 0, "D10 unconfirmed: no status is a confirmed exit");
});

test("never logged: interviewer text, follow-up reasons or file names", async () => {
  const lines = [];
  const w = world();
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(" "));
  try {
    const { providerSessionId } = await w.provider.createSession({
      remotiv_session_id: SESSION,
      interviewer_name: "Sarah",
      interview_minutes: 30,
      questions: [{ position: 1, text: "Q" }],
      candidate_first_name: "Alex",
      cv_text: "",
    });
    await saveLiveExport(
      SESSION,
      {
        ...parseExport(w.provider.exportOf(providerSessionId)),
        provider_session_id: PROVIDER_SESSION,
      },
      {
        service: w.db.service,
        fetchAudio: (n) => w.provider.fetchAudio(providerSessionId, n),
        now: () => T0,
      },
    );
  } finally {
    console.log = orig;
  }
  const all = lines.join("\n");
  assert.ok(lines.some((l) => l.startsWith("[live-ingest] session")));
  for (const leak of ["Tell me", "answer_lacked", ".wav", "Sarah"])
    assert.ok(!all.includes(leak), leak);
});

/* ── repeats (agreed with the provider, 19 Oct 2026) ──────────── */

const REPEAT = JSON.parse(
  readFileSync(
    new URL("./live-provider/__fixtures__/sample-export-repeat.json", import.meta.url),
    "utf8",
  ),
);

test("a marked repeat keeps its question: no extra question, no follow-up, the answer still counts", () => {
  const f = assessLiveExport(parseExport(structuredClone(REPEAT)), frozenOf(), 1);
  assert.equal(f.questions.length, 8, "no extra scoring entry");
  assert.deepEqual(
    [f.questions[1].status, f.questions[1].follow_ups, f.questions[1].repeats],
    ["answered", 2, 1],
  );
  assert.ok(f.questions.every((q, i) => i === 1 || q.repeats === 0));
  assert.deepEqual([f.outcome, f.answered_count], ["ending_unconfirmed", 5]);
});

test("the repeat variant saves: 34 rows, the repeat a procedural turn at position 2", async () => {
  const db = fakeLiveDb({ interview_sessions: [frozenRow()] });
  const provider = createFakeLiveProvider(REPEAT);
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
    provider_session_id: PROVIDER_SESSION,
  };
  const { outcome } = await quiet(() =>
    saveLiveExport(SESSION, parsed, {
      service: db.service,
      fetchAudio: (n) => provider.fetchAudio(providerSessionId, n),
      now: () => T0,
    }),
  );
  assert.equal(db.tables.interview_turns.length, 34);
  const rep = db.tables.interview_turns.find(
    (t) => t.provider_turn_id.startsWith("30000000") && t.sequence === 6,
  );
  assert.deepEqual([rep.kind, rep.question_position], ["procedural", 2]);
  assert.equal(outcome.questions[1].repeats, 1);
});

test("an UNMARKED second base question for a position is still refused", () => {
  const p = parseExport(structuredClone(REPEAT));
  const i = p.turns.findIndex((t) => t.repeat);
  p.turns[i] = { ...p.turns[i], kind: "base_question", repeat: false };
  assert.throws(
    () => assessLiveExport(p, frozenOf(), 1),
    (e) => e.code === "duplicate_base_question",
  );
});

test("a repeat may differ in case, punctuation and spacing, and lead in only with an agreed phrase", () => {
  const q = "Tell me about a time you owned a project end to end.";
  assert.equal(REPEAT_LEAD_INS.length, 4);
  const ok = [
    q,
    "tell me about a time you OWNED a project, end-to-end",
    "  Tell me about a time   you owned a project end to end?  ",
    // Each agreed lead-in, with its case and punctuation changed.
    ...REPEAT_LEAD_INS.map((l) => `${l} ${q}`),
    "LET ME REPEAT THE QUESTION: tell me about a time you owned a project end to end",
    "Sure - here it is again... Tell me about a time you owned a project end to end.",
    "of course, tell me about a time you owned a project end to end?",
    "let me just finish the question - tell me about a time you owned a project end to end",
  ];
  for (const spoken of ok) assert.equal(repeatMatchesQuestion(q, spoken), true, spoken);
  const refused = [
    // A hint is not a lead-in.
    `Remember to mention reliability. ${q}`,
    // A short lead-in that is not on the list.
    `Sure, let me repeat that for you: ${q}`,
    `No worries. ${q}`,
    // Two agreed lead-ins together are not one of them.
    `Of course. Let me repeat the question. ${q}`,
    "Tell me about a time you owned a team end to end.",
    "Tell me about a time you owned a project.",
    `${q} And what went wrong?`,
    "Let me repeat the question.",
    "",
  ];
  for (const spoken of refused) assert.equal(repeatMatchesQuestion(q, spoken), false, spoken);
});

test("a changed question marked as a repeat is kept, flagged and held; an agreed lead-in is kept unflagged", () => {
  const base = parseExport(structuredClone(REPEAT));
  const i = base.turns.findIndex((t) => t.repeat);
  const position = base.turns[i].question_position;
  const frozenText = frozenOf().questions.find((q) => q.position === position).text;
  const withText = (text) => {
    const p = structuredClone(base);
    p.turns[i] = { ...p.turns[i], text };
    return p;
  };
  const facts = (text) => assessLiveExport(withText(text), frozenOf(), 1);

  for (const text of [frozenText, `Of course. ${frozenText.toUpperCase()}`]) {
    const f = facts(text);
    assert.deepEqual(
      [f.questions[position - 1].repeats, f.questions[position - 1].repeat_check],
      [1, null],
      text,
    );
    assert.deepEqual(f.repeat_check_turns, [], text);
  }
  for (const [text, check] of [
    [`Remember to mention reliability. ${frozenText}`, "unexpected_lead_in"],
    ["Let me repeat the question. What would you change about your last team?", "altered_wording"],
  ]) {
    const f = facts(text);
    const q = f.questions[position - 1];
    assert.deepEqual([q.repeats, q.repeat_check, q.follow_ups], [1, check, 2], text);
    assert.deepEqual(f.repeat_check_turns, [base.turns[i].sequence], text);
    assert.equal(f.needs_review, true, text);
    assert.equal(f.questions.length, 8, "no extra question");
    assert.ok(
      f.questions.every((x) => x.position === position || x.repeat_check === null),
      "only its own question",
    );
  }
});

/* ── D9: "Let me just finish the question." ───────────────────── */

const FINISH = "Let me just finish the question.";

/** The repeat fixture's marked repeat, saying `text`, through the parser like a real export. */
function repeatSaying(text) {
  const raw = structuredClone(REPEAT);
  const i = raw.turns.findIndex((t) => t.is_repeat === true || t.turn_type === "repeat");
  raw.turns[i] = { ...raw.turns[i], text };
  return raw;
}

test('D9: an export where Sarah says "Let me just finish the question." and asks it again is accepted as a repeat', () => {
  const parsed = parseExport(repeatSaying("x"));
  const turn = parsed.turns.find((t) => t.repeat);
  const position = turn.question_position;
  const frozenText = frozenOf().questions.find((q) => q.position === position).text;

  const plain = assessLiveExport(parseExport(repeatSaying(frozenText)), frozenOf(), 1);
  const finished = assessLiveExport(
    parseExport(repeatSaying(`${FINISH} ${frozenText}`)),
    frozenOf(),
    1,
  );
  const q = finished.questions[position - 1];
  assert.equal(q.repeats, 1, "a repeat");
  assert.equal(q.follow_ups, plain.questions[position - 1].follow_ups, "never a follow-up");
  assert.equal(finished.questions.length, 8, "no extra question or scoring entry");
  assert.equal(finished.questions[position - 1].wording_check, null, "no wording check");
  // Exactly what the plain repeat produces: the lead-in changes nothing about the facts or outcome.
  assert.deepEqual(finished, plain);
  // Case and punctuation aside, as for the other lead-ins.
  const shouted = assessLiveExport(
    parseExport(repeatSaying(`LET ME JUST FINISH THE QUESTION ${frozenText.toLowerCase()}`)),
    frozenOf(),
    1,
  );
  assert.equal(shouted.questions[position - 1].repeats, 1);
});

test("D9: after the lead-in the frozen wording is still checked; unknown phrases are flagged and held", () => {
  const parsed = parseExport(repeatSaying("x"));
  const position = parsed.turns.find((t) => t.repeat).question_position;
  const frozenText = frozenOf().questions.find((q) => q.position === position).text;
  const checkOf = (text) =>
    assessLiveExport(parseExport(repeatSaying(text)), frozenOf(), 1).questions[position - 1]
      .repeat_check;
  for (const text of [
    // The lead-in, then a different or shortened question, or more after it, or nothing.
    `${FINISH} What would you change about your last team?`,
    `${FINISH} ${frozenText.split(" ").slice(0, 4).join(" ")}`,
    `${FINISH} ${frozenText} And what went wrong?`,
    FINISH,
  ]) {
    assert.equal(checkOf(text), "altered_wording", text);
  }
  for (const text of [
    // A hint between the lead-in and the question: an unexpected phrase before the frozen wording.
    `${FINISH} Remember to mention reliability. ${frozenText}`,
    // Phrases that are not on the list, close as they are.
    `Let me finish the question. ${frozenText}`,
    `Let me just finish. ${frozenText}`,
    `Hold on, let me just finish the question. ${frozenText}`,
  ]) {
    assert.equal(checkOf(text), "unexpected_lead_in", text);
  }
});

/* ── repeat checks: what is flagged, what is never weakened ────── */

test("classifyRepeat: exact, the 4 known lead-ins, an unexpected lead-in up to the cap, and altered wording", () => {
  const q = "Tell me about a time you owned a project end to end.";
  assert.equal(REPEAT_LEAD_INS.length, 4);
  assert.equal(MAX_UNEXPECTED_LEAD_IN_WORDS, 12);
  assert.equal(classifyRepeat(q, q), "exact");
  assert.equal(
    classifyRepeat(q, "  tell me about a time you OWNED a project, end-to-end? "),
    "exact",
  );
  for (const l of REPEAT_LEAD_INS) {
    assert.equal(classifyRepeat(q, `${l} ${q}`), "known_lead_in", l);
    assert.equal(classifyRepeat(q, `${l.toUpperCase()} ${q.toLowerCase()}`), "known_lead_in", l);
  }
  const twelve = Array.from({ length: 12 }, (_, i) => `word${i}`).join(" ");
  for (const spoken of [
    `No worries. ${q}`,
    `Sure, let me repeat that for you: ${q}`,
    `Remember to mention reliability. ${q}`,
    `Of course. Let me repeat the question. ${q}`,
    `${twelve}. ${q}`,
  ]) {
    assert.equal(classifyRepeat(q, spoken), "unexpected_lead_in", spoken);
  }
  for (const spoken of [
    `${twelve} more. ${q}`,
    "Tell me about a time you owned a team end to end.",
    "Tell me about a time you owned a project.",
    `${q} And what went wrong?`,
    "Let me repeat the question.",
    "",
  ]) {
    assert.equal(classifyRepeat(q, spoken), "altered_wording", spoken);
  }
  assert.equal(classifyRepeat("", q), "altered_wording", "no frozen text matches nothing");
});

test("the four known lead-ins are unchanged: no flag, no hold, the same facts as a plain repeat", () => {
  const position = parseExport(repeatSaying("x")).turns.find((t) => t.repeat).question_position;
  const frozenText = frozenOf().questions.find((q) => q.position === position).text;
  const plain = assessLiveExport(parseExport(repeatSaying(frozenText)), frozenOf(), 1);
  assert.equal(plain.needs_review, true, "the sample's timing checks");
  for (const lead of REPEAT_LEAD_INS) {
    const f = assessLiveExport(parseExport(repeatSaying(`${lead} ${frozenText}`)), frozenOf(), 1);
    assert.deepEqual(f, plain, lead);
    assert.equal(f.questions[position - 1].repeat_check, null, lead);
  }
});

test("a flagged repeat never weakens the integrity checks: positions, duplicates, the parser, audio", async () => {
  const position = parseExport(repeatSaying("x")).turns.find((t) => t.repeat).question_position;
  const frozenText = frozenOf().questions.find((q) => q.position === position).text;
  const flagged = () => parseExport(repeatSaying(`No worries. ${frozenText}`));
  assert.equal(
    assessLiveExport(flagged(), frozenOf(), 1).questions[position - 1].repeat_check,
    "unexpected_lead_in",
    "the control: flagged and accepted",
  );

  const unknown = flagged();
  const b = unknown.turns.findIndex((t) => t.kind === "base_question");
  unknown.turns[b] = { ...unknown.turns[b], question_position: 9 };
  assert.throws(
    () => assessLiveExport(unknown, frozenOf(), 1),
    (e) => e.code === "unknown_question_position",
  );

  const twice = flagged();
  const r = twice.turns.findIndex((t) => t.repeat);
  twice.turns[r] = { ...twice.turns[r], kind: "base_question", repeat: false };
  assert.throws(
    () => assessLiveExport(twice, frozenOf(), 1),
    (e) => e.code === "duplicate_base_question",
  );

  // A repeat must still name its question: the parser refuses one that does not.
  const raw = repeatSaying(`No worries. ${frozenText}`);
  const ri = raw.turns.findIndex((t) => t.is_repeat === true || t.turn_type === "repeat");
  raw.turns[ri] = { ...raw.turns[ri], question_id: null, base_question_id: null };
  assert.throws(
    () => parseExport(raw),
    (e) => e.code === "bad_repeat",
  );

  // And its audio is checked like every other turn's: missing audio refuses the save.
  const exported = repeatSaying(`No worries. ${frozenText}`);
  const name = exported.turns[ri].interviewer_audio_file;
  assert.ok(name, "the repeat has its own audio file");
  const db = fakeLiveDb({ interview_sessions: [frozenRow()] });
  const provider = createFakeLiveProvider(exported, { [name]: null });
  const { providerSessionId } = await provider.createSession({
    remotiv_session_id: SESSION,
    interviewer_name: "Sarah",
    interview_minutes: 30,
    questions: [{ position: 1, text: "Q" }],
    candidate_first_name: "Alex",
    cv_text: "",
  });
  await assert.rejects(
    quiet(() =>
      saveLiveExport(
        SESSION,
        {
          ...parseExport(provider.exportOf(providerSessionId)),
          provider_session_id: PROVIDER_SESSION,
        },
        {
          service: db.service,
          fetchAudio: (n) => provider.fetchAudio(providerSessionId, n),
          now: () => T0,
        },
      ),
    ),
    (e) => e instanceof LiveIngestError && e.code === "missing_audio",
  );
  assert.equal(db.objects.size, 0, "nothing uploaded");
  assert.equal(db.tables.interview_turns.length, 0);
  assert.equal(db.tables.interview_sessions[0].live_outcome, null);
});

test("an export with a flagged repeat saves whole, and keeps the flag through the confirm step", async () => {
  const position = parseExport(repeatSaying("x")).turns.find((t) => t.repeat).question_position;
  const frozenText = frozenOf().questions.find((q) => q.position === position).text;
  const exported = repeatSaying(`No worries. ${frozenText}`);
  const db = fakeLiveDb({ interview_sessions: [frozenRow()] });
  const provider = createFakeLiveProvider(exported);
  const { providerSessionId } = await provider.createSession({
    remotiv_session_id: SESSION,
    interviewer_name: "Sarah",
    interview_minutes: 30,
    questions: [{ position: 1, text: "Q" }],
    candidate_first_name: "Alex",
    cv_text: "",
  });
  const { outcome } = await quiet(() =>
    saveLiveExport(
      SESSION,
      {
        ...parseExport(provider.exportOf(providerSessionId)),
        provider_session_id: PROVIDER_SESSION,
      },
      {
        service: db.service,
        fetchAudio: (n) => provider.fetchAudio(providerSessionId, n),
        now: () => T0,
      },
    ),
  );
  assert.equal(db.tables.interview_turns.length, 34, "every turn, the repeat included");
  assert.equal(outcome.questions[position - 1].repeat_check, "unexpected_lead_in");
  assert.deepEqual(db.tables.interview_sessions[0].live_outcome, outcome);
  // The confirm step recomputes needs_review. With every other reason taken
  // away (a normal close, every question asked, no timing check), the repeat
  // check is what keeps it set.
  const onlyRepeat = {
    ...outcome,
    provider_status_code: "completed",
    questions: outcome.questions.map((q) => ({
      ...q,
      status: "answered",
      confirmed: false,
      needs_check: false,
      wording_check: null,
    })),
  };
  const confirmed = confirmAnswer(onlyRepeat, position, true, 1);
  assert.equal(confirmed.end_check, null);
  assert.equal(confirmed.questions[position - 1].repeat_check, "unexpected_lead_in");
  assert.equal(confirmed.needs_review, true);
  const unflagged = {
    ...onlyRepeat,
    questions: onlyRepeat.questions.map((q) => ({ ...q, repeat_check: null })),
  };
  assert.equal(confirmAnswer(unflagged, position, true, 1).needs_review, false, "the control");
});

test("audio paths carry 16 hex of the export hash, and pass migration 021's path check", () => {
  const like = (value, pattern) =>
    new RegExp(
      `^${pattern
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        .replace(/%/g, ".*")
        .replace(/_/g, ".")}$`,
    ).test(value);
  const a = "0123456789abcdef".repeat(4);
  const b = `${a.slice(0, 8)}ffffffff${a.slice(16)}`;
  const path = audioPath(SESSION, 7, a, "wav");
  assert.equal(path, `${SESSION}/t7.0123456789abcdef.wav`);
  // media_path like session_id || '/t' || sequence || '.%'
  assert.equal(like(path, `${SESSION}/t7.%`), true);
  assert.equal(like(path, `${SESSION}/t17.%`), false);
  // Two exports whose hashes share the first 8 hex no longer share a file name.
  assert.notEqual(audioPath(SESSION, 7, b, "wav"), path);
});

/* ── the transcription commit's hook ──────────────────────────── */

test("confirmAnswer: real words confirm; none downgrade to skipped and the outcome is worked out again", async () => {
  const w = world();
  const { outcome } = await save(w);
  const confirmed = confirmAnswer(outcome, 1, true, 1);
  assert.deepEqual(
    [confirmed.questions[0].status, confirmed.questions[0].confirmed],
    ["answered", true],
  );
  assert.equal(
    confirmed.outcome,
    "ending_unconfirmed",
    "candidate_ended is not a confirmed exit yet",
  );
  // With D10 switched on: two answers turn out to be silence, 3 answered is abandoned.
  // Not final yet (the settle in live-transcribe.ts decides that), so no restart decision.
  const down = withExit(() => {
    assert.equal(confirmAnswer(outcome, 1, true, 1).outcome, "partial");
    return confirmAnswer(confirmAnswer(outcome, 4, false, 1), 5, false, 1);
  });
  assert.deepEqual(
    [down.questions[3].status, down.questions[4].status, down.questions[4].confirmed],
    ["skipped", "skipped", null],
  );
  assert.deepEqual(
    [down.outcome, down.answered_count, down.skipped_count, down.restart_allowed],
    ["abandoned", 3, 3, null],
  );
  assert.equal(outcome.questions[3].status, "answered", "pure: the input is unchanged");
});

/* ── safe audio: every stage can fail, and a retry finishes cleanly ── */

/** Every stored turn's audio exists, with the bytes the provider handed over. */
function assertAudioIntact(db) {
  for (const t of db.tables.interview_turns) {
    const o = db.objects.get(t.media_path);
    assert.ok(o, `${t.media_path} exists`);
    assert.equal(createHash("sha256").update(o.bytes).digest("hex"), t.media_sha256);
  }
}

for (const [stage, breakIt, code] of [
  ["an upload fails midway", (db) => db.failUploadAfter(10), "storage_error"],
  ["the insert fails", (db) => db.failNext("interview_turns", "insert"), "db_error"],
  ["the outcome write fails", (db) => db.failNext("interview_sessions", "update"), "db_error"],
]) {
  test(`${stage}: refused, then a retry saves once, with no duplicates and no lost audio`, async () => {
    const w = world();
    breakIt(w.db);
    await assert.rejects(save(w), (e) => e instanceof LiveIngestError && e.code === code);
    assert.equal(w.db.tables.interview_sessions[0].live_outcome, null, "no outcome yet");
    const { saved, outcome } = await save(w);
    assert.equal(saved, true);
    assert.equal(w.db.tables.interview_turns.length, 32);
    assert.equal(new Set(w.db.tables.interview_turns.map((t) => t.provider_turn_id)).size, 32);
    assert.equal(outcome.outcome, "ending_unconfirmed");
    assertAudioIntact(w.db);
  });
}

test("two different exports saved at once: one wins, the other is refused, no audio overwritten", async () => {
  const db = fakeLiveDb({ interview_sessions: [frozenRow()] });
  // B carries different audio bytes for every file, so an overwrite would show.
  const other = Object.fromEntries(
    FIXTURE.turns.map((t) => {
      const name = t.audio_file ?? t.interviewer_audio_file;
      return [name, { bytes: new TextEncoder().encode(`OTHER-${name}`), mime_type: "audio/wav" }];
    }),
  );
  const A = createFakeLiveProvider(FIXTURE);
  const B = createFakeLiveProvider(FIXTURE, other);
  const input = {
    remotiv_session_id: SESSION,
    interviewer_name: "Sarah",
    interview_minutes: 30,
    questions: [{ position: 1, text: "Q" }],
    candidate_first_name: "Alex",
    cv_text: "",
  };
  const a = await A.createSession(input);
  const b = await B.createSession(input);
  const pa = {
    ...parseExport(A.exportOf(a.providerSessionId)),
    provider_session_id: PROVIDER_SESSION,
  };
  const pb = {
    ...parseExport(B.exportOf(b.providerSessionId)),
    provider_session_id: PROVIDER_SESSION,
  };
  pb.turns[0] = { ...pb.turns[0], text: `${pb.turns[0].text} (second export)` };
  assert.notEqual(exportHash(pa), exportHash(pb));

  const results = await quiet(() =>
    Promise.allSettled([
      saveLiveExport(SESSION, pa, {
        service: db.service,
        fetchAudio: (n) => A.fetchAudio(a.providerSessionId, n),
        now: () => T0,
      }),
      saveLiveExport(SESSION, pb, {
        service: db.service,
        fetchAudio: (n) => B.fetchAudio(b.providerSessionId, n),
        now: () => T0,
      }),
    ]),
  );
  const won = results.filter((r) => r.status === "fulfilled");
  const lost = results.filter((r) => r.status === "rejected");
  assert.equal(won.length, 1);
  assert.equal(lost.length, 1);
  assert.ok(
    ["different_export", "already_saved"].includes(lost[0].reason.code),
    lost[0].reason.code,
  );

  const stored = db.tables.interview_sessions[0].live_outcome;
  assert.equal(stored.export_hash, won[0].value.outcome.export_hash);
  assert.equal(db.tables.interview_turns.length, 32);
  assertAudioIntact(db);
  // Both exports' files exist side by side: different names, nothing overwritten.
  assert.equal(db.objects.size, 64);
  const hashes = new Set([...db.objects.keys()].map((k) => k.split(".")[1]));
  assert.equal(hashes.size, 2);
});

test("the turns decide the winner: another export arriving after A's turns but before A's outcome is refused", async () => {
  const db = fakeLiveDb({ interview_sessions: [frozenRow()] });
  const A = createFakeLiveProvider(FIXTURE);
  const B = createFakeLiveProvider(FIXTURE);
  const input = {
    remotiv_session_id: SESSION,
    interviewer_name: "Sarah",
    interview_minutes: 30,
    questions: [{ position: 1, text: "Q" }],
    candidate_first_name: "Alex",
    cv_text: "",
  };
  const a = await A.createSession(input);
  const b = await B.createSession(input);
  const pa = {
    ...parseExport(A.exportOf(a.providerSessionId)),
    provider_session_id: PROVIDER_SESSION,
  };
  const pb = {
    ...parseExport(B.exportOf(b.providerSessionId)),
    provider_session_id: PROVIDER_SESSION,
  };
  pb.turns[0] = { ...pb.turns[0], text: `${pb.turns[0].text} (second export)` };
  const depsA = {
    service: db.service,
    fetchAudio: (n) => A.fetchAudio(a.providerSessionId, n),
    now: () => T0,
  };
  const depsB = {
    service: db.service,
    fetchAudio: (n) => B.fetchAudio(b.providerSessionId, n),
    now: () => T0,
  };

  // A's turns land; its outcome write fails.
  db.failNext("interview_sessions", "update");
  await assert.rejects(
    quiet(() => saveLiveExport(SESSION, pa, depsA)),
    (e) => e.code === "db_error",
  );
  assert.equal(db.tables.interview_turns.length, 32);
  // B must not write its outcome over A's turns.
  await assert.rejects(
    quiet(() => saveLiveExport(SESSION, pb, depsB)),
    (e) => e.code === "different_export",
  );
  assert.equal(db.tables.interview_sessions[0].live_outcome, null);
  // A's retry finishes, with A's hash.
  const { saved, outcome } = await quiet(() => saveLiveExport(SESSION, pa, depsA));
  assert.equal(saved, true);
  assert.equal(outcome.export_hash, exportHash(pa));
  assertAudioIntact(db);
});

/* ── F12: the first asking of each question (23 Oct 2026) ─────── */

const EIGHT = () => frozenOf().questions.map((q) => q.text);
const lowerFirst = (t) => `${t[0].toLowerCase()}${t.slice(1)}`;

/** Harmless ways to say a frozen question: none may be flagged. */
const HARMLESS = {
  "case and punctuation": (t) => t.toUpperCase().replace(/[.?]/g, "!!").replace(/,/g, " ;"),
  "extra spacing": (t) => `   ${t.split(" ").join("    ")}   `,
  "curly apostrophes": (t) => t.replace(/'/g, "’"),
  "apostrophe dropped from a possessive": (t) => t.replace(/(\w)'s\b/g, "$1s"),
  "'Um,' at the start": (t) => `Um, ${lowerFirst(t)}`,
  "'uh' in the middle": (t) => {
    const w = t.split(" ");
    w.splice(Math.floor(w.length / 2), 0, "uh,");
    return w.join(" ");
  },
  "'er' and 'erm' around it": (t) => `Er, ${lowerFirst(t)} Erm.`,
  "the first name at the start": (t) => `Alex, ${lowerFirst(t)}`,
  "the first name at the end": (t) => `${t.replace(/[.?]$/, "")}, Alex?`,
  "the first name at both ends": (t) => `Alex, ${lowerFirst(t).replace(/[.?]$/, "")}, Alex?`,
  "filler then the name": (t) => `Um, Alex, ${lowerFirst(t)}`,
};

test("F12 harmless differences on ALL 8 real fixture questions are never flagged", () => {
  for (const q of EIGHT()) {
    for (const [label, say] of Object.entries(HARMLESS)) {
      assert.equal(classifyAsked(q, say(q), "Alex"), "exact", `${label}: ${say(q)}`);
    }
  }
});

test("F12 contractions: the fixture questions that contain an expanded form, both directions", () => {
  // Of the 8, only "what did" occurs (questions 2, 5 and 8); none has "you are", "do not" etc.
  const contract = (t) => t.replace(/\b([Ww])hat did\b/g, "$1hat'd");
  const eight = EIGHT();
  const applied = eight.map((q, i) => [i + 1, contract(q) !== q]).filter(([, c]) => c);
  assert.deepEqual(
    applied.map(([p]) => p),
    [2, 5, 8],
    "the contraction applies to exactly these",
  );
  for (const [p] of applied) {
    const q = eight[p - 1];
    assert.equal(classifyAsked(q, contract(q)), "exact", `spoken contracted, question ${p}`);
    assert.equal(classifyAsked(contract(q), q), "exact", `frozen contracted, question ${p}`);
  }
});

test("F12 contractions: questions written with the expanded forms on the list", () => {
  const pairs = [
    [
      "What are you most proud of in your last role?",
      "What're you most proud of in your last role?",
    ],
    ["What is the hardest bug you have fixed?", "What's the hardest bug you've fixed?"],
    [
      "Tell me why you are a good fit and what you do not enjoy.",
      "Tell me why you're a good fit and what you don't enjoy.",
    ],
    [
      "It is fine if you cannot remember every detail. What did you learn?",
      "It's fine if you can't remember every detail. What'd you learn?",
    ],
    [
      "Where is the line between fast and careless, and how do you know when you have crossed it?",
      "Where's the line between fast and careless, and how do you know when you've crossed it?",
    ],
  ];
  for (const [frozen, spoken] of pairs) {
    for (const word of spoken.match(/\b\w+'\w+\b/g)) {
      assert.ok(CONTRACTIONS[word.toLowerCase()], `${word} is on the approved list`);
    }
    assert.equal(classifyAsked(frozen, spoken), "exact", spoken);
    assert.equal(classifyAsked(spoken, frozen), "exact", `reversed: ${frozen}`);
    assert.equal(classifyAsked(frozen, `Um, ${lowerFirst(spoken)} Alex?`, "Alex"), "exact");
  }
});

test("F12 short questions take every harmless difference too", () => {
  for (const q of ["Why this role?", "Any questions?", "Why?", "What did you learn?"]) {
    for (const [label, say] of Object.entries(HARMLESS)) {
      assert.equal(classifyAsked(q, say(q), "Alex"), "exact", `${label}: ${say(q)}`);
    }
  }
  assert.equal(classifyAsked("Why?", "What'd you do?"), "altered_wording");
  assert.equal(classifyAsked("Why this role?", "Why this team?"), "altered_wording");
});

test("F12 the harmless list is strict: the name only alone at the very start or end, only the listed fillers and contractions", () => {
  const q =
    "Tell me about a production incident you handled. What happened, and what did you change afterwards?";
  const flagged = [
    [
      `Tell me about a production incident you handled, Alex. What happened, and what did you change afterwards?`,
      "altered_wording",
      "the name in the middle",
    ],
    [`Sam, ${lowerFirst(q)}`, "unexpected_lead_in", "another name"],
    [`Al, ${lowerFirst(q)}`, "unexpected_lead_in", "part of the name"],
    [`Alexander, ${lowerFirst(q)}`, "unexpected_lead_in", "a longer name"],
    [`Alex, remember reliability. ${q}`, "unexpected_lead_in", "the name, then a hint"],
    [`Hmm, ${lowerFirst(q)}`, "unexpected_lead_in", "a filler not on the list"],
    [`Umm, ${lowerFirst(q)}`, "unexpected_lead_in", "a longer filler"],
    [
      "Tell me about a production um you handled. What happened, and what did you change afterwards?",
      "altered_wording",
      "a filler in place of a word",
    ],
    [
      "Tell me about a production incident y'all handled. What happened, and what did you change afterwards?",
      "altered_wording",
      "a contraction not on the list",
    ],
  ];
  for (const [spoken, want, label] of flagged) {
    assert.equal(classifyAsked(q, spoken, "Alex"), want, label);
  }
  // No name known: a name is never set aside.
  assert.equal(classifyAsked(q, `Alex, ${lowerFirst(q)}`, null), "unexpected_lead_in");
  assert.equal(classifyAsked(q, `Alex, ${lowerFirst(q)}`, "  "), "unexpected_lead_in");
  // A question that itself ends with the same word as the name still matches.
  assert.equal(
    classifyAsked(
      "Who do you trust, and who will you call?",
      "Who do you trust, and who will you call?",
      "Call",
    ),
    "exact",
  );
  assert.deepEqual([...FILLER_SOUNDS].sort(), ["er", "erm", "uh", "um"]);
});

test("F12 every hint, extra demand, changed, shortened or different question is flagged, on all 8", () => {
  assert.deepEqual(BASE_QUESTION_TRANSITIONS, [], "no agreed transitions yet");
  for (const q of EIGHT()) {
    const words = q.split(" ");
    const cases = [
      [`Remember to mention reliability. ${q}`, "unexpected_lead_in", "hint before"],
      [`Great, thanks. Next question. ${q}`, "unexpected_lead_in", "a transition (none is agreed)"],
      [`${q} Remember to mention reliability.`, "altered_wording", "hint after"],
      [`${q} And what would you do differently?`, "altered_wording", "extra demand"],
      [
        words.map((w, i) => (i === Math.floor(words.length / 2) ? "particular" : w)).join(" "),
        "altered_wording",
        "a word changed",
      ],
      [words.slice(0, Math.ceil(words.length / 2)).join(" "), "altered_wording", "shortened"],
      ["What would you change about your last team?", "altered_wording", "a different question"],
      [
        `Alex, ${lowerFirst(q)} Remember to mention reliability.`,
        "altered_wording",
        "the name, then a hint after",
      ],
    ];
    for (const [spoken, want, label] of cases) {
      assert.equal(classifyAsked(q, spoken, "Alex"), want, `${label}: ${q}`);
    }
  }
});

test("F12 the greeting folded into question 1 holds it; sent as its own turn, question 1 is clean", () => {
  const folded = assessLiveExport(parsedFixture(), frozenOf(), 1, "Alex");
  assert.equal(folded.questions[0].wording_check, "altered_wording", "never exempt");
  assert.equal(folded.needs_review, true);

  const split = parsedFixture();
  const i = split.turns.findIndex((t) => t.kind === "base_question" && t.question_position === 1);
  const frozenText = frozenOf().questions[0].text;
  const greeting = split.turns[i].text.slice(0, split.turns[i].text.indexOf(frozenText)).trim();
  assert.ok(greeting.length > 0, "the sample's greeting");
  split.turns[i] = { ...split.turns[i], text: frozenText };
  split.turns.push({
    ...split.turns[i],
    provider_turn_id: "greeting-own-turn",
    sequence: -1,
    kind: "procedural",
    question_position: null,
    text: greeting,
  });
  const clean = assessLiveExport(split, frozenOf(), 1, "Alex");
  assert.equal(clean.questions[0].wording_check, null);
  assert.deepEqual(clean.wording_check_turns, []);
});

test("F12 a flagged first asking never weakens the integrity checks", () => {
  const p = parsedFixture();
  p.turns[3] = { ...p.turns[3], question_position: 9 };
  assert.throws(
    () => assessLiveExport(p, frozenOf(), 1),
    (e) => e.code === "unknown_question_position",
  );
  const twice = parsedFixture();
  twice.turns[3] = { ...twice.turns[3], question_position: 1 };
  assert.throws(
    () => assessLiveExport(twice, frozenOf(), 1),
    (e) => e.code === "duplicate_base_question",
  );
  // The control: the same export with only question 1's greeting is accepted and flagged.
  assert.equal(
    assessLiveExport(parsedFixture(), frozenOf(), 1).questions[0].wording_check,
    "altered_wording",
  );
});

const CO = "7aad434d-0000-4000-8000-0000000000f1";
const APP = "03e4863f-0000-4000-8000-0000000000f1";

/** The fixture with question 2 first asked as `text`, saved for a session whose candidate is `firstName`. */
async function saveAsking(
  text,
  { firstName = "Alex", appCompany = CO, failNameRead = false } = {},
) {
  const raw = structuredClone(FIXTURE);
  const i = raw.turns.findIndex((t) => t.turn_type === "base_question" && t.question_id === 2);
  raw.turns[i] = { ...raw.turns[i], text };
  const db = fakeLiveDb({
    interview_sessions: [frozenRow({ company_id: CO, application_id: APP })],
    job_applications: [{ id: APP, company_id_snapshot: appCompany, first_name: firstName }],
  });
  if (failNameRead) db.failNext("job_applications", "select");
  const provider = createFakeLiveProvider(raw);
  const { providerSessionId } = await provider.createSession({
    remotiv_session_id: SESSION,
    interviewer_name: "Sarah",
    interview_minutes: 30,
    questions: [{ position: 1, text: "Q" }],
    candidate_first_name: firstName,
    cv_text: "",
  });
  const logs = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = (...a) => logs.push(a.join(" "));
  try {
    const { outcome } = await saveLiveExport(
      SESSION,
      {
        ...parseExport(provider.exportOf(providerSessionId)),
        provider_session_id: PROVIDER_SESSION,
      },
      {
        service: db.service,
        fetchAudio: (n) => provider.fetchAudio(providerSessionId, n),
        now: () => T0,
      },
    );
    return { outcome, db, logs };
  } finally {
    Object.assign(console, orig);
  }
}

test("F12 the save reads the candidate's first name, in the session's company, only to compare", async () => {
  const q2 = frozenOf().questions[1].text;
  const named = `Alex, ${lowerFirst(q2)}`;
  const { outcome, db } = await saveAsking(named, { firstName: "Zuleika" });
  assert.equal(
    outcome.questions[1].wording_check,
    "unexpected_lead_in",
    "another candidate's name is not set aside",
  );

  const ok = await saveAsking(`Zuleika, ${lowerFirst(q2)}`, { firstName: "Zuleika" });
  assert.equal(ok.outcome.questions[1].wording_check, null, "the candidate's own name is");
  // Never stored, never logged.
  assert.doesNotMatch(JSON.stringify(ok.db.tables.interview_sessions[0].live_outcome), /zuleika/i);
  assert.ok(
    ok.logs.every((l) => !/zuleika/i.test(l)),
    "not in any log line",
  );
  assert.doesNotMatch(JSON.stringify(db.tables.interview_sessions[0].live_outcome), /zuleika/i);

  // Another company's application: no name is read, so nothing is set aside.
  const other = await saveAsking(`Zuleika, ${lowerFirst(q2)}`, {
    firstName: "Zuleika",
    appCompany: "7aad434d-0000-4000-8000-0000000000f2",
  });
  assert.equal(other.outcome.questions[1].wording_check, "unexpected_lead_in");

  // The read fails: no name, so the question is held, never let through; the log names no one.
  const failed = await saveAsking(`Zuleika, ${lowerFirst(q2)}`, {
    firstName: "Zuleika",
    failNameRead: true,
  });
  assert.equal(failed.outcome.questions[1].wording_check, "unexpected_lead_in");
  assert.ok(failed.logs.some((l) => l.includes("first name unread")));
  assert.ok(failed.logs.every((l) => !/zuleika/i.test(l)));
});
