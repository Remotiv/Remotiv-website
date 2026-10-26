/**
 * The provider's current export format (F15, 26 Oct 2026), read as sent:
 * greeting and user_interrupted turns, positions from the order of
 * questions[], interviewer audio in audio_file, follow-ups without a reason,
 * acknowledgments before the next question, and the ending rule. The fixture
 * keeps the structure of his interruption export (keys in his order, the
 * 19-turn pattern and its links); every id, name, word and timing is made up.
 * Nothing leaves the machine.
 *
 *   node --test src/lib/interviews/live-provider/parse-export-f15.test.ts
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../../test-support/node-resolve.mjs", import.meta.url));

const { FOLLOW_UP_REASON_NOT_GIVEN, LiveExportError, parseExport } = await import(
  "./parse-export.ts"
);

const INTERRUPTION = JSON.parse(
  readFileSync(new URL("./__fixtures__/sample-export-interruption.json", import.meta.url), "utf8"),
);
const OLDER = JSON.parse(
  readFileSync(new URL("./__fixtures__/sample-export.json", import.meta.url), "utf8"),
);
const fixture = () => structuredClone(INTERRUPTION);
/** Turn indexes in the fixture (no sequence field: sequence is index + 1). */
const GREETING = 0;
const ACK_BEFORE_Q2 = 9;
const Q2 = 10;
const LINE = 11;
const REPEAT = 12;
const ACK_BEFORE_Q3 = 17;

const refusedWith = (code) => (err) => err instanceof LiveExportError && err.code === code;

/* ── the export as sent ───────────────────────────────────────── */

test("the interruption export parses as sent: 19 turns, 10 questions, every kind placed", () => {
  const r = parseExport(fixture());
  assert.equal(r.turns.length, 19);
  assert.equal(r.questions.length, 10);
  assert.deepEqual(
    r.turns.map((t) => [t.sequence, t.speaker, t.kind]),
    INTERRUPTION.turns.map((t, i) => [
      i + 1,
      t.role,
      t.role === "candidate"
        ? null
        : ["greeting", "acknowledgment", "user_interrupted", "repeat"].includes(t.turn_type)
          ? "procedural"
          : t.turn_type,
    ]),
  );
  assert.deepEqual(
    [r.turns[GREETING].kind, r.turns[GREETING].question_position],
    ["procedural", null],
    "the greeting asks no question",
  );
  assert.deepEqual(
    r.turns.map((t) => t.interruption_line),
    r.turns.map((_, i) => i === LINE),
  );
  assert.equal(r.warnings.overlaps.count, 0);
});

test("a greeting from a candidate, or an interruption line, is still refused", () => {
  for (const type of ["greeting", "user_interrupted"]) {
    const f = fixture();
    f.turns[2].turn_type = type;
    assert.throws(() => parseExport(f), refusedWith("unknown_turn_type"), type);
  }
});

/* ── question positions ───────────────────────────────────────── */

test("positions come from the order of questions[] when none is sent", () => {
  const r = parseExport(fixture());
  assert.deepEqual(
    r.questions.map((q) => [q.position, q.provider_question_id, q.text]),
    INTERRUPTION.questions.map((q, i) => [i + 1, q.id, q.text]),
  );
  // And they agree with question_id on every turn naming base_question_id.
  for (const [i, t] of INTERRUPTION.turns.entries()) {
    if (t.base_question_id && i !== ACK_BEFORE_Q2 && i !== ACK_BEFORE_Q3) {
      assert.equal(r.turns[i].question_position, t.question_id, `turn ${i}`);
    }
  }
});

test("positions sent are kept, never replaced by the order", () => {
  const f = structuredClone(OLDER);
  f.questions.reverse();
  const r = parseExport(f);
  assert.deepEqual(
    r.questions.map((q) => q.position),
    f.questions.map((q) => q.position),
  );
});

test("refused: positions on some questions only (bad_questions)", () => {
  const f = fixture();
  f.questions[3].position = 4;
  assert.throws(() => parseExport(f), refusedWith("bad_questions"));
  const g = structuredClone(OLDER);
  delete g.questions[0].position;
  assert.throws(() => parseExport(g), refusedWith("bad_questions"));
});

test("an order that disagrees with question_id is refused, not trusted", () => {
  const f = fixture();
  [f.questions[0], f.questions[1]] = [f.questions[1], f.questions[0]];
  assert.throws(() => parseExport(f), refusedWith("bad_question_position"));
});

/* ── audio ────────────────────────────────────────────────────── */

test("interviewer audio is read from audio_file; interviewer_audio_file wins when both are sent", () => {
  const r = parseExport(fixture());
  assert.deepEqual(
    r.turns.map((t) => t.audio_file_name),
    INTERRUPTION.turns.map((t) => t.audio_file),
  );
  const f = fixture();
  f.turns[Q2].interviewer_audio_file = "interviewer_turn_override.wav";
  assert.equal(parseExport(f).turns[Q2].audio_file_name, "interviewer_turn_override.wav");
  // A candidate turn never reads interviewer_audio_file.
  const g = fixture();
  g.turns[2].interviewer_audio_file = "interviewer_turn_override.wav";
  assert.equal(parseExport(g).turns[2].audio_file_name, INTERRUPTION.turns[2].audio_file);
});

/* ── follow-up reasons ────────────────────────────────────────── */

test("a follow-up with no reason stores the fixed placeholder; a reason sent is kept", () => {
  assert.equal(FOLLOW_UP_REASON_NOT_GIVEN, "No reason given by the provider.");
  const r = parseExport(fixture());
  const followUps = r.turns.filter((t) => t.kind === "follow_up");
  assert.equal(followUps.length, 3);
  for (const t of followUps) assert.equal(t.follow_up_reason, FOLLOW_UP_REASON_NOT_GIVEN);
  for (const t of r.turns.filter((x) => x.kind !== "follow_up")) {
    assert.equal(t.follow_up_reason, null);
  }
  for (const blank of [null, "", "   "]) {
    const f = fixture();
    f.turns[4].follow_up_reason = blank;
    assert.equal(parseExport(f).turns[4].follow_up_reason, FOLLOW_UP_REASON_NOT_GIVEN);
  }
  const f = fixture();
  f.turns[4].follow_up_reason = "answer_lacked_detail";
  assert.equal(parseExport(f).turns[4].follow_up_reason, "answer_lacked_detail");
});

test("refused: a follow-up reason that is not text, or a reason on another turn (bad_follow_up)", () => {
  const f = fixture();
  f.turns[4].follow_up_reason = 3;
  assert.throws(() => parseExport(f), refusedWith("bad_follow_up"));
  const g = fixture();
  g.turns[Q2].follow_up_reason = "answer_lacked_detail";
  assert.throws(() => parseExport(g), refusedWith("bad_follow_up"));
});

/* ── acknowledgments before the next question ─────────────────── */

test("an acknowledgment answering nothing, right before a new base question, belongs to the previous answer", () => {
  const r = parseExport(fixture());
  assert.equal(r.turns[ACK_BEFORE_Q2].question_position, 1, "sent as question 2");
  assert.equal(r.turns[ACK_BEFORE_Q3].question_position, 2, "sent as question 3");
  // Acknowledgments that answer a turn keep their position.
  for (const i of [3, 6, 14]) {
    assert.equal(r.turns[i].question_position, INTERRUPTION.turns[i].question_id, `turn ${i}`);
  }
});

test("only that case moves: answering a turn, not before a base question, or with no answer before", () => {
  const answering = fixture();
  answering.turns[ACK_BEFORE_Q2].responds_to_turn_id = answering.turns[8].turn_id;
  assert.equal(parseExport(answering).turns[ACK_BEFORE_Q2].question_position, 2);

  const notBefore = fixture();
  notBefore.turns.splice(Q2, 1);
  for (const t of notBefore.turns) {
    if (t.responds_to_turn_id === INTERRUPTION.turns[Q2].turn_id) t.responds_to_turn_id = null;
  }
  notBefore.turns[Q2].responds_to_turn_id = notBefore.turns[8].turn_id;
  assert.equal(
    parseExport(notBefore).turns[ACK_BEFORE_Q2].question_position,
    2,
    "followed by the interruption line, not a base question",
  );

  const first = fixture();
  first.turns[GREETING].turn_type = "acknowledgment";
  first.turns[GREETING].question_id = 1;
  first.turns[GREETING].base_question_id = first.questions[0].id;
  assert.equal(parseExport(first).turns[GREETING].question_position, 1, "no answer before it");
});

/* ── how it ended ─────────────────────────────────────────────── */

test("the export's ending: candidate_left, with end_reason and completed_gracefully kept", () => {
  assert.deepEqual(parseExport(fixture()).status, {
    code: "candidate_ended",
    provider_status: "candidate_left",
    end_reason: "candidate_left",
    completed_gracefully: false,
  });
});

test("completed only when end_reason is completed AND completed_gracefully is true", () => {
  const cases = [
    // [status, end_reason, completed_gracefully, code]
    ["completed", "completed", true, "completed"],
    [undefined, "completed", true, "completed"],
    ["completed", "completed", false, "unknown"],
    ["completed", "completed", undefined, "unknown"],
    ["completed", "completed", "true", "unknown"],
    ["completed", "completed", 1, "unknown"],
    // No end_reason: status never makes it completed, whatever the flag.
    ["completed", undefined, true, "unknown"],
    ["completed", undefined, undefined, "unknown"],
    // The two words disagree: unknown, never the friendlier one.
    ["candidate_left", "completed", true, "unknown"],
    ["completed", "candidate_left", true, "unknown"],
    // Every other ending as before, from end_reason, else status.
    [undefined, "candidate_left", false, "candidate_ended"],
    ["candidate_left", undefined, undefined, "candidate_ended"],
    ["error", undefined, undefined, "provider_error"],
    ["time_limit", "timeout", false, "timed_out"],
    [undefined, "finished", true, "unknown"],
    [undefined, undefined, true, "unknown"],
  ];
  for (const [status, endReason, graceful, code] of cases) {
    const f = fixture();
    for (const [k, v] of [
      ["status", status],
      ["end_reason", endReason],
      ["completed_gracefully", graceful],
    ]) {
      if (v === undefined) delete f[k];
      else f[k] = v;
    }
    const s = parseExport(f).status;
    const label = JSON.stringify([status, endReason, graceful]);
    assert.equal(s.code, code, label);
    assert.deepEqual(
      [s.provider_status, s.end_reason, s.completed_gracefully],
      [status ?? null, endReason ?? null, typeof graceful === "boolean" ? graceful : null],
      label,
    );
  }
});

/* ── interruptions ────────────────────────────────────────────── */

test("the line places the interruption: question 2 marked interrupted, stopped where the line starts", () => {
  const r = parseExport(fixture());
  const raw = INTERRUPTION.turns;
  assert.deepEqual(r.interruptions, [
    {
      line_sequence: LINE + 1,
      interrupted_sequence: Q2 + 1,
      position: 2,
      stopped_ms: raw[LINE].offset_ms,
      stop_source: "line_start",
      ambiguity: null,
      candidate_speech_exported: false,
    },
  ]);
  assert.equal(r.turns[Q2].interrupted, true);
  assert.equal(r.turns.filter((t) => t.interrupted).length, 1);
  // The provider sent no stop time: the turn keeps none of its own.
  assert.equal(r.turns[Q2].audio_stopped_ms, null);
});

test("every turn's timestamps and audio stay exactly as sent", () => {
  const r = parseExport(fixture());
  for (const [i, t] of INTERRUPTION.turns.entries()) {
    const p = r.turns[i];
    assert.deepEqual(
      [p.offset_ms, p.duration_ms, p.audio_file_name],
      [t.offset_ms, t.audio_duration_ms, t.audio_file],
      `turn ${i}`,
    );
    assert.equal(
      p.started_at,
      new Date(Date.parse(INTERRUPTION.started_at) + t.offset_ms).toISOString(),
    );
    assert.equal(Date.parse(p.ended_at) - Date.parse(p.started_at), t.audio_duration_ms);
  }
});

test("a stop time the provider sends wins, and is kept on the turn", () => {
  const f = fixture();
  const stop = f.turns[LINE].offset_ms - 400;
  f.turns[Q2].interrupted = true;
  f.turns[Q2].audio_stopped_ms = stop;
  const r = parseExport(f);
  assert.deepEqual(
    [r.interruptions[0].stopped_ms, r.interruptions[0].stop_source, r.interruptions[0].ambiguity],
    [stop, "provider", null],
  );
  assert.equal(r.turns[Q2].audio_stopped_ms, stop);
});

test("ambiguous cases are kept and named, never placed", () => {
  const cases = [
    [
      "no interviewer turn before the line",
      "no_turn_before",
      (f) => {
        const [line] = f.turns.splice(LINE, 1);
        line.offset_ms = 100;
        line.offset_seconds = 0.1;
        f.turns.unshift(line);
      },
      0,
    ],
    [
      "a second line right after the first",
      "after_another_line",
      (f) => {
        const second = structuredClone(f.turns[LINE]);
        second.turn_id = "40000000-0000-4000-8000-000000000099";
        second.offset_ms = f.turns[LINE].offset_ms + 500;
        f.turns.splice(LINE + 1, 0, second);
      },
      LINE + 1,
    ],
    [
      "the line starts after question 2 finished",
      "starts_outside_turn",
      (f) => {
        f.turns[LINE].offset_ms = f.turns[Q2].offset_ms + f.turns[Q2].audio_duration_ms;
      },
      LINE,
    ],
    [
      "the line starts exactly when question 2 started",
      "starts_outside_turn",
      (f) => {
        f.turns[LINE].offset_ms = f.turns[Q2].offset_ms;
      },
      LINE,
    ],
    [
      "the provider's stop time is after the line starts",
      "stop_after_line",
      (f) => {
        f.turns[Q2].interrupted = true;
        f.turns[Q2].audio_stopped_ms = f.turns[LINE].offset_ms + 100;
      },
      LINE,
    ],
  ];
  for (const [label, ambiguity, breakIt, lineIndex] of cases) {
    const f = fixture();
    breakIt(f);
    const r = parseExport(f);
    const i = r.interruptions.find((x) => x.line_sequence === lineIndex + 1);
    assert.ok(i, label);
    assert.deepEqual([i.ambiguity, i.stopped_ms, i.stop_source], [ambiguity, null, null], label);
  }
  // Not placed means not marked: question 2 is left as the provider sent it.
  const outside = fixture();
  outside.turns[LINE].offset_ms = outside.turns[Q2].offset_ms + outside.turns[Q2].audio_duration_ms;
  assert.equal(parseExport(outside).turns[Q2].interrupted, false);
});

test("candidate speech while cutting in counts only when a candidate turn holds it, whatever its sequence", () => {
  assert.equal(parseExport(fixture()).interruptions[0].candidate_speech_exported, false);
  const f = fixture();
  // The candidate's cut-in, exported after the line (sequenced by when it ended).
  f.turns.splice(REPEAT, 0, {
    ...structuredClone(f.turns[8]),
    turn_id: "40000000-0000-4000-8000-000000000098",
    responds_to_turn_id: f.turns[Q2].turn_id,
    question_id: 2,
    base_question_id: f.questions[1].id,
    offset_ms: f.turns[LINE].offset_ms - 900,
    audio_duration_ms: 1500,
    audio_file: "candidate_turn_cutin.wav",
  });
  const r = parseExport(f);
  assert.equal(r.interruptions[0].candidate_speech_exported, true);
  assert.equal(r.interruptions[0].ambiguity, null);
  // An answer starting after the line is not the cut-in.
  const g = fixture();
  g.turns[13].offset_ms = g.turns[LINE].offset_ms + 1;
  assert.equal(parseExport(g).interruptions[0].candidate_speech_exported, false);
  // Nor is an earlier answer, before question 2 started.
  assert.ok(INTERRUPTION.turns[8].offset_ms < INTERRUPTION.turns[Q2].offset_ms);
});

test("an export without interruption lines has none, and no turn is marked", () => {
  const r = parseExport(structuredClone(OLDER));
  assert.deepEqual(r.interruptions, []);
  assert.ok(r.turns.every((t) => !t.interruption_line && !t.interrupted));
});
