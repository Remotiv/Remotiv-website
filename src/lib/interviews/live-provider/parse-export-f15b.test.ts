/**
 * F15b (27 Oct 2026): the provider's scripted "ftest" export, as the parser
 * reads it. The fixture keeps that export's structure, ids, timestamps, turn
 * types, links and audio names; every name, candidate word, CV-specific
 * question and the job text are made up (the original stays outside git).
 *
 *   silence_reminder (interviewer)  procedural: never a question or follow-up
 *   interruption (candidate)        kept with its audio, marked
 *                                   candidate_interruption, never an answer
 *   disconnected                    its own ending, never completed
 *   in_progress                     read as unknown here; the save refuses it
 *
 * The untouched original can be run too, outside git:
 *   F15B_ORIGINAL_EXPORT=/path/to/session_ftest.json node --test src/lib/interviews/live-provider/parse-export-f15b.test.ts
 *
 *   node --test src/lib/interviews/live-provider/parse-export-f15b.test.ts
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../../test-support/node-resolve.mjs", import.meta.url));

const { parseExport, LiveExportError } = await import("./parse-export.ts");

const FTEST = JSON.parse(
  readFileSync(new URL("./__fixtures__/sample-export-ftest.json", import.meta.url), "utf8"),
);
const fixture = () => structuredClone(FTEST);
const refusedWith = (code) => (e) => e instanceof LiveExportError && e.code === code;

/** Turn indexes in the fixture; a turn's sequence is its index + 1. */
const REMINDERS = [5, 24];
const QUESTION_3 = 14;
const INTERRUPTION = 15;

/** What the parser makes of an export: the structure only. */
function shape(r) {
  return {
    turns: r.turns.length,
    questions: r.questions.map((q) => q.position),
    kinds: r.turns.map((t) => `${t.speaker}/${t.kind}`),
    positions: r.turns.map((t) => t.question_position),
    interruptionSpeech: r.turns.filter((t) => t.candidate_interruption).map((t) => t.sequence),
    followUps: r.turns
      .filter((t) => t.kind === "follow_up")
      .map((t) => [t.question_position, t.follow_up_index]),
    audio: r.turns.every((t) => t.audio_file_name !== null),
    status: r.status,
    interruptions: r.interruptions,
  };
}

test("the ftest export parses: 64 turns, 10 questions, every turn with its audio", () => {
  const r = parseExport(fixture());
  assert.equal(r.turns.length, 64);
  assert.deepEqual(
    r.questions.map((q) => q.position),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  );
  assert.ok(r.turns.every((t) => t.audio_file_name !== null));
});

test("silence_reminder: procedural on its question, never a question or a follow-up, its text and audio kept", () => {
  const r = parseExport(fixture());
  for (const i of REMINDERS) {
    const t = r.turns[i];
    assert.deepEqual(
      [t.speaker, t.kind, t.follow_up_index, t.repeat, t.candidate_interruption],
      ["interviewer", "procedural", null, false, false],
      `turn ${i}`,
    );
    assert.equal(t.text, FTEST.turns[i].text);
    assert.equal(t.audio_file_name, FTEST.turns[i].audio_file);
  }
  assert.deepEqual(
    REMINDERS.map((i) => r.turns[i].question_position),
    [1, 4],
  );
  // Follow-ups are exactly the provider's nine follow_up turns.
  assert.deepEqual(shape(r).followUps, [
    [1, 1],
    [2, 1],
    [3, 1],
    [4, 1],
    [5, 1],
    [6, 1],
    [7, 1],
    [8, 1],
    [8, 2],
  ]);
  assert.equal(r.turns.filter((t) => t.kind === "base_question").length, 10);
});

test("candidate interruption: a candidate turn on question 3, marked, its audio kept, the provider's words not carried", () => {
  const r = parseExport(fixture());
  const t = r.turns[INTERRUPTION];
  assert.deepEqual(
    [t.speaker, t.kind, t.candidate_interruption, t.question_position, t.text],
    ["candidate", null, true, 3, null],
  );
  assert.equal(t.audio_file_name, FTEST.turns[INTERRUPTION].audio_file);
  assert.equal(t.responds_to_provider_turn_id, FTEST.turns[QUESTION_3].turn_id);
  assert.equal(t.duration_ms, FTEST.turns[INTERRUPTION].audio_duration_ms, "duration as sent");
  // Only that turn is interruption speech; every answer stays an answer.
  assert.deepEqual(shape(r).interruptionSpeech, [INTERRUPTION + 1]);
  // The interruption line is still placed as before (F15): ambiguous, speech exported.
  assert.deepEqual(
    r.interruptions.map((i) => [
      i.line_sequence,
      i.position,
      i.ambiguity,
      i.candidate_speech_exported,
    ]),
    [[17, 3, "starts_outside_turn", true]],
  );
});

test("refused: a reminder from a candidate, an interruption from the interviewer, a reminder with a follow-up index, an interruption answering nothing", () => {
  const cases = [
    [
      "unknown_turn_type",
      (f) => {
        f.turns[2].turn_type = "silence_reminder";
      },
    ],
    [
      "unknown_turn_type",
      (f) => {
        f.turns[1].turn_type = "interruption";
      },
    ],
    [
      "bad_follow_up",
      (f) => {
        f.turns[REMINDERS[0]].follow_up_index = 1;
      },
    ],
    [
      "missing_responds_to",
      (f) => {
        f.turns[INTERRUPTION].responds_to_turn_id = null;
      },
    ],
  ];
  for (const [code, mutate] of cases) {
    const f = fixture();
    mutate(f);
    assert.throws(() => parseExport(f), refusedWith(code), code);
  }
});

test("in_progress: the words are kept and the ending reads unknown (the save refuses it as not final)", () => {
  const r = parseExport(fixture());
  assert.deepEqual(r.status, {
    code: "unknown",
    provider_status: "in_progress",
    end_reason: "in_progress",
    completed_gracefully: false,
  });
});

test("disconnected: its own ending, never completed, even with completed_gracefully true", () => {
  for (const graceful of [true, false, undefined]) {
    const f = fixture();
    f.status = "disconnected";
    f.end_reason = "disconnected";
    if (graceful === undefined) delete f.completed_gracefully;
    else f.completed_gracefully = graceful;
    assert.equal(parseExport(f).status.code, "disconnected", String(graceful));
  }
  // end_reason alone is enough; a status that disagrees makes the ending unknown, as before (F15).
  const reasonOnly = fixture();
  delete reasonOnly.status;
  reasonOnly.end_reason = "disconnected";
  assert.equal(parseExport(reasonOnly).status.code, "disconnected");
  const disagree = fixture();
  disagree.status = "completed";
  disagree.end_reason = "disconnected";
  disagree.completed_gracefully = true;
  assert.equal(parseExport(disagree).status.code, "unknown");
});

test("D10 unchanged: completed needs end_reason completed AND completed_gracefully true", () => {
  const as = (status, reason, graceful) => {
    const f = fixture();
    f.status = status;
    f.end_reason = reason;
    f.completed_gracefully = graceful;
    return parseExport(f).status.code;
  };
  assert.equal(as("completed", "completed", true), "completed");
  assert.equal(as("completed", "completed", false), "unknown");
  assert.equal(as("completed", "disconnected", true), "unknown");
});

test("the untouched original export, when its path is given, parses to the same structure as the fixture", {
  skip: !process.env.F15B_ORIGINAL_EXPORT,
}, () => {
  const path = process.env.F15B_ORIGINAL_EXPORT;
  assert.ok(existsSync(path), "F15B_ORIGINAL_EXPORT points at a file");
  const original = parseExport(JSON.parse(readFileSync(path, "utf8")));
  const ours = parseExport(fixture());
  const strip = (r) => {
    const s = shape(r);
    return { ...s, status: s.status.code };
  };
  assert.deepEqual(strip(original), strip(ours));
});
