/**
 * The provider's export parser (live-provider/parse-export.ts), against a
 * PII-free fixture with the structure, timings and follow-up pattern of the
 * sample export of 16 Oct 2026. Every name, answer, CV line and job line in the
 * fixture is made up. Nothing leaves the machine.
 *
 *   node --test src/lib/interviews/live-provider/parse-export.test.ts
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../../test-support/node-resolve.mjs", import.meta.url));

const { LiveExportError, parseExport } = await import("./parse-export.ts");

const FIXTURE = JSON.parse(
  readFileSync(new URL("./__fixtures__/sample-export.json", import.meta.url), "utf8"),
);
const fixture = () => structuredClone(FIXTURE);
/** How many items fall under each key. */
function count(xs, f) {
  const m = {};
  for (const x of xs) m[f(x)] = (m[f(x)] ?? 0) + 1;
  return m;
}

/** Every key anywhere in a value, at any depth. */
function allKeys(v, out = new Set()) {
  if (Array.isArray(v)) for (const x of v) allKeys(x, out);
  else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      out.add(k);
      allKeys(x, out);
    }
  }
  return out;
}

/* ── the fixture, parsed ──────────────────────────────────────── */

test("the fixture parses into 32 turns in order, with the right speakers and kinds", () => {
  const r = parseExport(fixture());
  assert.equal(r.provider_session_id, "sess-0000000000001");
  assert.equal(r.turns.length, 32);
  assert.deepEqual(
    r.turns.map((t) => t.sequence),
    Array.from({ length: 32 }, (_, i) => i + 1),
  );
  assert.deepEqual(
    r.turns.map((t) => t.provider_turn_id),
    FIXTURE.turns.map((t) => t.turn_id),
    "array order is the sequence when none is given",
  );
  assert.deepEqual(
    count(r.turns, (t) => t.speaker),
    { interviewer: 19, candidate: 13 },
  );
  assert.deepEqual(
    count(r.turns, (t) => `${t.speaker}/${t.kind}`),
    {
      "interviewer/base_question": 6,
      "interviewer/follow_up": 8,
      "interviewer/procedural": 5,
      "candidate/null": 13,
    },
  );
  // acknowledgment -> procedural, turn by turn.
  FIXTURE.turns.forEach((t, i) => {
    if (t.turn_type === "acknowledgment") assert.equal(r.turns[i].kind, "procedural");
  });
});

test("questions, positions and the follow-up pattern come through as sent", () => {
  const r = parseExport(fixture());
  assert.equal(r.questions.length, 12);
  assert.deepEqual(
    r.questions.map((q) => q.position),
    Array.from({ length: 12 }, (_, i) => i + 1),
  );
  assert.deepEqual(
    r.turns.filter((t) => t.kind === "base_question").map((t) => t.question_position),
    [1, 2, 3, 4, 5, 6],
  );
  const followUps = r.turns.filter((t) => t.kind === "follow_up");
  assert.deepEqual(
    count(followUps, (t) => t.question_position),
    { 2: 2, 3: 2, 4: 2, 5: 2 },
  );
  assert.deepEqual(
    followUps.map((t) => t.follow_up_index),
    [1, 2, 1, 2, 1, 2, 1, 2],
  );
  for (const t of followUps) assert.match(t.follow_up_reason, /^answer_lacked_/);
  for (const t of r.turns.filter((x) => x.kind !== "follow_up")) {
    assert.equal(t.follow_up_index, null);
    assert.equal(t.follow_up_reason, null);
  }
  // Every responds_to resolves to another turn of the session.
  const ids = new Set(r.turns.map((t) => t.provider_turn_id));
  for (const t of r.turns) {
    if (t.responds_to_provider_turn_id !== null) assert.ok(ids.has(t.responds_to_provider_turn_id));
  }
  assert.equal(r.turns.filter((t) => t.responds_to_provider_turn_id === null).length, 6);
});

test("timings: offsets and durations kept; wall times from session start on one clock", () => {
  const r = parseExport(fixture());
  FIXTURE.turns.forEach((t, i) => {
    const p = r.turns[i];
    assert.equal(p.offset_ms, t.offset_ms);
    assert.equal(p.duration_ms, t.audio_duration_ms);
    assert.equal(
      p.started_at,
      new Date(Date.parse(FIXTURE.started_at) + t.offset_ms).toISOString(),
    );
    assert.equal(Date.parse(p.ended_at) - Date.parse(p.started_at), t.audio_duration_ms);
  });
  assert.equal(r.started_at, FIXTURE.started_at);
  assert.equal(r.ended_at, FIXTURE.ended_at);
  assert.equal(r.duration_ms, FIXTURE.duration_ms);
  assert.equal(r.interviewer_name, "Sarah");
});

test("status is reported, not decided: candidate_ended, with the provider's word kept", () => {
  assert.deepEqual(parseExport(fixture()).status, {
    code: "candidate_ended",
    provider_status: "candidate_ended",
  });
  for (const [raw, code] of [
    ["completed", "completed"],
    ["time_limit", "timed_out"],
    ["provider_error", "provider_error"],
    ["something_new", "unknown"],
  ]) {
    const f = fixture();
    f.status = raw;
    assert.deepEqual(parseExport(f).status, { code, provider_status: raw }, raw);
  }
  const f = fixture();
  delete f.status;
  assert.deepEqual(parseExport(f).status, { code: "unknown", provider_status: null });
});

/* ── what is never carried ────────────────────────────────────── */

test("dropped: the CV, the job, the first-name field, the count and every candidate transcript", () => {
  const r = parseExport(fixture());
  const keys = allKeys(r);
  for (const k of [
    "cv_text",
    "jd",
    "candidate_first_name",
    "questions_completed",
    "timestamp",
    "role",
    "turn_type",
    "base_question_id",
    "question_order",
    "offset_seconds",
    "audio_duration_seconds",
  ]) {
    assert.ok(!keys.has(k), `${k} must not appear anywhere in the result`);
  }
  const json = JSON.stringify(r);
  for (const line of FIXTURE.cv_text.split("\n").filter((l) => l.trim().length > 8)) {
    assert.ok(!json.includes(line), "no CV line is carried");
  }
  assert.ok(!json.includes(FIXTURE.jd.description), "the job description is not carried");
  for (const t of FIXTURE.turns.filter((x) => x.role === "candidate")) {
    assert.ok(!json.includes(t.text), "no candidate transcript is carried");
  }
  for (const t of r.turns) {
    if (t.speaker === "candidate") assert.equal(t.text, null);
    else assert.ok(t.text.length > 0, "interviewer text is kept");
  }
});

test("a field the provider adds later is dropped too: the result is built from named fields", () => {
  const f = fixture();
  f.provider_secret_note = "must not be carried";
  f.turns[0].sentiment = "must not be carried";
  assert.ok(!JSON.stringify(parseExport(f)).includes("must not be carried"));
});

/* ── overlap: warned, not refused ─────────────────────────────── */

test("overlap: every candidate turn of the fixture starts before the interviewer finished", () => {
  const r = parseExport(fixture());
  assert.equal(r.warnings.overlaps.count, 13);
  assert.equal(r.warnings.overlaps.turns.length, 13);
  const bySeq = new Map(r.turns.map((t) => [t.sequence, t]));
  for (const o of r.warnings.overlaps.turns) {
    assert.equal(bySeq.get(o.sequence).speaker, "candidate");
    assert.ok(o.overlap_ms > 0);
  }
  assert.equal(
    r.warnings.overlaps.max_ms,
    Math.max(...r.warnings.overlaps.turns.map((o) => o.overlap_ms)),
  );
  // The sample's own figures: every candidate turn overlaps by 6.4 to 12.6 seconds.
  assert.equal(r.warnings.overlaps.max_ms, 12_571);
  assert.equal(Math.min(...r.warnings.overlaps.turns.map((o) => o.overlap_ms)), 6_372);
});

test("no overlap, no warning", () => {
  const f = fixture();
  f.turns = f.turns.slice(0, 2);
  f.turns[1].offset_ms = f.turns[0].offset_ms + f.turns[0].audio_duration_ms + 500;
  const r = parseExport(f);
  assert.deepEqual(r.warnings.overlaps, { count: 0, max_ms: 0, turns: [] });
});

/* ── sequence ─────────────────────────────────────────────────── */

test("his own sequence numbers win when every turn has one; the result is in that order", () => {
  const f = fixture();
  f.turns = f.turns.slice(0, 3).map((t, i) => ({ ...t, sequence: [2, 3, 1][i] }));
  f.turns[0].responds_to_turn_id = null;
  f.turns[1].responds_to_turn_id = f.turns[0].turn_id;
  f.turns[2].responds_to_turn_id = f.turns[1].turn_id;
  f.turns[2].turn_type = "acknowledgment";
  const r = parseExport(f);
  assert.deepEqual(
    r.turns.map((t) => [t.sequence, t.provider_turn_id]),
    [
      [1, f.turns[2].turn_id],
      [2, f.turns[0].turn_id],
      [3, f.turns[1].turn_id],
    ],
  );
});

/* ── broken input is refused, by name ─────────────────────────── */

/** [label, the code it must raise, how to break a fresh copy of the fixture]. */
const BROKEN = [
  [
    "missing session id",
    "missing_session_id",
    (f) => {
      delete f.session_id;
    },
  ],
  [
    "empty session id",
    "missing_session_id",
    (f) => {
      f.session_id = "  ";
    },
  ],
  [
    "missing turns",
    "missing_turns",
    (f) => {
      delete f.turns;
    },
  ],
  [
    "empty turns",
    "missing_turns",
    (f) => {
      f.turns = [];
    },
  ],
  [
    "missing started_at",
    "missing_started_at",
    (f) => {
      delete f.started_at;
    },
  ],
  [
    "duplicate turn ids",
    "duplicate_turn_id",
    (f) => {
      f.turns[5].turn_id = f.turns[4].turn_id;
    },
  ],
  [
    "responds_to an unknown turn",
    "unknown_responds_to",
    (f) => {
      f.turns[1].responds_to_turn_id = "99999999-0000-4000-8000-000000000000";
    },
  ],
  [
    "responds_to itself",
    "unknown_responds_to",
    (f) => {
      f.turns[1].responds_to_turn_id = f.turns[1].turn_id;
    },
  ],
  [
    "a negative offset",
    "negative_offset",
    (f) => {
      f.turns[3].offset_ms = -1;
    },
  ],
  [
    "no offset at all",
    "negative_offset",
    (f) => {
      delete f.turns[3].offset_ms;
      delete f.turns[3].offset_seconds;
    },
  ],
  [
    "an unknown speaker",
    "unknown_speaker",
    (f) => {
      f.turns[2].role = "observer";
    },
  ],
  [
    "an unknown interviewer turn type",
    "unknown_turn_type",
    (f) => {
      f.turns[2].turn_type = "chit_chat";
    },
  ],
  [
    "an unknown candidate turn type",
    "unknown_turn_type",
    (f) => {
      f.turns[1].turn_type = "question";
    },
  ],
  [
    "a zero duration",
    "bad_duration",
    (f) => {
      f.turns[0].audio_duration_ms = 0;
    },
  ],
  [
    "an interviewer turn without text",
    "missing_interviewer_text",
    (f) => {
      f.turns[0].text = "";
    },
  ],
  [
    "a follow-up index of 3",
    "bad_follow_up",
    (f) => {
      f.turns[5].follow_up_index = 3;
    },
  ],
  [
    "a follow-up without a reason",
    "bad_follow_up",
    (f) => {
      delete f.turns[5].follow_up_reason;
    },
  ],
  [
    "an index on a base question",
    "bad_follow_up",
    (f) => {
      f.turns[0].follow_up_index = 1;
    },
  ],
  [
    "question_id disagreeing with base_question_id",
    "bad_question_position",
    (f) => {
      f.turns[3].question_id = 9;
    },
  ],
  [
    "a candidate turn that answers nothing",
    "missing_responds_to",
    (f) => {
      f.turns[1].responds_to_turn_id = null;
    },
  ],
  [
    "sequence on some turns only",
    "bad_sequence",
    (f) => {
      f.turns[0].sequence = 1;
    },
  ],
  [
    "a turn that is not an object",
    "bad_turn",
    (f) => {
      f.turns[4] = "turn";
    },
  ],
];

const refusedWith = (code) => (err) => err instanceof LiveExportError && err.code === code;

for (const [label, code, breakIt] of BROKEN) {
  test(`refused: ${label} (${code})`, () => {
    const f = fixture();
    breakIt(f);
    assert.throws(() => parseExport(f), refusedWith(code));
  });
}

test("refused: not an object at all (not_an_object)", () => {
  for (const raw of ["export", null, [], 42]) {
    assert.throws(() => parseExport(raw), refusedWith("not_an_object"));
  }
});

test("an error names the rule and the turn, never the content", () => {
  const f = fixture();
  f.turns[2].role = "observer";
  f.turns[2].text = "SECRET-CONTENT-MARKER";
  try {
    parseExport(f);
    assert.fail("should have thrown");
  } catch (err) {
    assert.equal(err.code, "unknown_speaker");
    assert.equal(err.turnIndex, 2);
    assert.doesNotMatch(err.message, /SECRET-CONTENT-MARKER|observer/);
  }
});

/* ── interruptions (agreed with the provider, 19 Oct 2026) ────── */

test("interruption: false and no stop time unless sent; a marked interruption is parsed", () => {
  const plain = parseExport(fixture());
  assert.ok(plain.turns.every((t) => t.interrupted === false && t.audio_stopped_ms === null));

  const f = fixture();
  // Turn 0 is the first base question (offset 3256, 10210 long); the candidate cut in.
  f.turns[0].interrupted = true;
  f.turns[0].audio_stopped_ms = f.turns[0].offset_ms + 900;
  const r = parseExport(f);
  assert.equal(r.turns[0].interrupted, true);
  assert.equal(r.turns[0].audio_stopped_ms, f.turns[0].offset_ms + 900);
  // The overlap after a marked interruption is expected, so it is not warned about.
  assert.equal(r.warnings.overlaps.count, 12);
  assert.ok(!r.warnings.overlaps.turns.some((o) => o.sequence === 2));

  const s = fixture();
  s.turns[0].interrupted = true;
  s.turns[0].audio_stopped_seconds = (s.turns[0].offset_ms + 1500) / 1000;
  assert.equal(parseExport(s).turns[0].audio_stopped_ms, s.turns[0].offset_ms + 1500);
});

for (const [label, breakIt] of [
  [
    "interrupted on a candidate turn",
    (f) => {
      f.turns[1].interrupted = true;
    },
  ],
  [
    "a stop time without interrupted",
    (f) => {
      f.turns[0].audio_stopped_ms = f.turns[0].offset_ms + 100;
    },
  ],
  [
    "a stop time before the turn starts",
    (f) => {
      f.turns[0].interrupted = true;
      f.turns[0].audio_stopped_ms = f.turns[0].offset_ms - 1;
    },
  ],
  [
    "a stop time after the turn ends",
    (f) => {
      f.turns[0].interrupted = true;
      f.turns[0].audio_stopped_ms = f.turns[0].offset_ms + f.turns[0].audio_duration_ms + 1;
    },
  ],
  [
    "interrupted that is not a boolean",
    (f) => {
      f.turns[0].interrupted = "yes";
    },
  ],
]) {
  test(`refused: ${label} (bad_interruption)`, () => {
    const f = fixture();
    breakIt(f);
    assert.throws(() => parseExport(f), refusedWith("bad_interruption"));
  });
}

/* ── repeats (agreed with the provider, 19 Oct 2026) ──────────── */

const REPEAT = JSON.parse(
  readFileSync(new URL("./__fixtures__/sample-export-repeat.json", import.meta.url), "utf8"),
);

test("repeat variant: a marked repeat is a procedural turn at the question's position, flagged repeat", () => {
  const r = parseExport(structuredClone(REPEAT));
  assert.equal(r.turns.length, 34);
  const rep = r.turns.find((t) => t.provider_turn_id === "30000000-0000-4000-8000-000000000002");
  assert.deepEqual([rep.kind, rep.question_position, rep.repeat], ["procedural", 2, true]);
  const reminder = r.turns.find(
    (t) => t.provider_turn_id === "30000000-0000-4000-8000-000000000001",
  );
  assert.deepEqual(
    [reminder.kind, reminder.question_position, reminder.repeat],
    ["procedural", 2, false],
  );
  assert.equal(
    r.turns.filter((t) => t.kind === "base_question").length,
    6,
    "no extra main question",
  );
  assert.ok(parseExport(fixture()).turns.every((t) => t.repeat === false));
});

test("repeat: turn_type repeat is the same as a base_question marked is_repeat", () => {
  const f = structuredClone(REPEAT);
  const i = f.turns.findIndex((t) => t.is_repeat === true);
  delete f.turns[i].is_repeat;
  f.turns[i].turn_type = "repeat";
  const rep = parseExport(f).turns[i];
  assert.deepEqual([rep.kind, rep.question_position, rep.repeat], ["procedural", 2, true]);
});

for (const [label, breakIt] of [
  [
    "is_repeat on a follow-up",
    (f) => {
      f.turns[5].is_repeat = true;
    },
  ],
  [
    "is_repeat that is not a boolean",
    (f) => {
      f.turns[0].is_repeat = "yes";
    },
  ],
  [
    "a repeat that names no question",
    (f) => {
      f.turns[0].turn_type = "repeat";
      delete f.turns[0].question_id;
      delete f.turns[0].base_question_id;
    },
  ],
]) {
  test(`refused: ${label} (bad_repeat)`, () => {
    const f = fixture();
    breakIt(f);
    assert.throws(() => parseExport(f), refusedWith("bad_repeat"));
  });
}
