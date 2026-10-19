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
  confirmAnswer,
  exportHash,
  LiveIngestError,
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
    assert.match(r.media_path, new RegExp(`^${SESSION}/t${r.sequence}\\.[0-9a-f]{8}\\.wav$`));
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

test("what the fixture produced: statuses, follow-ups, timing_suspect, outcome partial", async () => {
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
    ["partial", 5, 1, 2, 8, 63],
  );
  assert.equal(outcome.restart_allowed, false);
  // Every candidate turn of the sample starts while the interviewer is still speaking, unmarked.
  assert.equal(outcome.timing_suspect, true);
  assert.equal(outcome.timing_suspect_turns.length, 13);
  assert.deepEqual(outcome.wording_flags, []);
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
  assert.equal(outcome.outcome, "partial");
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

test("wording that strays from the frozen question is flagged, not refused", () => {
  const facts = assessLiveExport(
    parsedFixture(),
    frozenOf({}, { 3: "Describe your favourite kitchen appliance and why you bought it." }),
    1,
  );
  assert.deepEqual(facts.wording_flags, [3]);
  assert.equal(facts.questions[2].wording_differs, true);
  assert.equal(facts.questions[2].status, "answered");
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
      code:
        status === "provider_error"
          ? "provider_error"
          : status === "completed"
            ? "completed"
            : "candidate_ended",
      provider_status: status,
    },
    interviewer_name: "Sarah",
    started_at: "2026-10-16T05:48:47.157Z",
    ended_at: null,
    duration_ms: null,
    questions: [],
    turns,
    warnings: { overlaps: { count: 0, max_ms: 0, turns: [] } },
  };
}

test("all answered: completed, 8 of 8, 100%", () => {
  const f = assessLiveExport(cleanExport(), frozenOf(), 1);
  assert.deepEqual(
    [f.outcome, f.answered_count, f.total, f.completion_percent, f.restart_allowed],
    ["completed", 8, 8, 100, false],
  );
  assert.ok(f.questions.every((q) => q.status === "answered"));
  assert.equal(f.timing_suspect, false);
});

test('a 2-second answer ("Yes, three years") is answered; a silent question is skipped', () => {
  const f = assessLiveExport(
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

test("reached the end with only 3 answered: completed, no restart", () => {
  const f = assessLiveExport(
    cleanExport({ answerMs: (p) => (p <= 3 ? 20_000 : 0) }),
    frozenOf(),
    1,
  );
  assert.deepEqual(
    [f.outcome, f.answered_count, f.skipped_count, f.not_reached_count, f.restart_allowed],
    ["completed", 3, 5, 0, false],
  );
  // Reaching the end wins over a provider error at the very end: every question was seen.
  const late = assessLiveExport(cleanExport({ status: "provider_error" }), frozenOf(), 1);
  assert.deepEqual([late.outcome, late.restart_allowed], ["completed", false]);
});

test("ended early: 4-7 answered is partial; 0-3 is abandoned, restart once; provider end is technical_failure", () => {
  const partial = assessLiveExport(
    cleanExport({ asked: 4, status: "candidate_ended" }),
    frozenOf(),
    1,
  );
  assert.deepEqual(
    [partial.outcome, partial.answered_count, partial.restart_allowed],
    ["partial", 4, false],
  );
  assert.deepEqual(partial.questions.map((q) => q.status).slice(4), [
    "not_reached",
    "not_reached",
    "not_reached",
    "not_reached",
  ]);

  const abandoned = assessLiveExport(
    cleanExport({ asked: 3, status: "candidate_ended" }),
    frozenOf(),
    1,
  );
  assert.deepEqual(
    [
      abandoned.outcome,
      abandoned.answered_count,
      abandoned.completion_percent,
      abandoned.restart_allowed,
    ],
    ["abandoned", 3, 38, true],
  );
  const second = assessLiveExport(
    cleanExport({ asked: 3, status: "candidate_ended" }),
    frozenOf(),
    2,
  );
  assert.equal(second.restart_allowed, false, "abandoned again on the restart: no further restart");

  const tech = assessLiveExport(cleanExport({ asked: 7, status: "provider_error" }), frozenOf(), 2);
  assert.deepEqual([tech.outcome, tech.restart_allowed], ["technical_failure", true]);
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
  assert.deepEqual([f.outcome, f.answered_count], ["partial", 5]);
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

/* ── the transcription commit's hook ──────────────────────────── */

test("confirmAnswer: real words confirm; none downgrade to skipped and the outcome is worked out again", async () => {
  const w = world();
  const { outcome } = await save(w);
  const confirmed = confirmAnswer(outcome, 1, true, 1);
  assert.deepEqual(
    [confirmed.questions[0].status, confirmed.questions[0].confirmed],
    ["answered", true],
  );
  assert.equal(confirmed.outcome, "partial");
  // Two answers turn out to be silence: 3 answered is abandoned, restart once.
  const down = confirmAnswer(confirmAnswer(outcome, 4, false, 1), 5, false, 1);
  assert.deepEqual(
    [down.questions[3].status, down.questions[4].status, down.questions[4].confirmed],
    ["skipped", "skipped", null],
  );
  assert.deepEqual(
    [down.outcome, down.answered_count, down.skipped_count, down.restart_allowed],
    ["abandoned", 3, 3, true],
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
    assert.equal(outcome.outcome, "partial");
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
