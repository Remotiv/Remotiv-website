/**
 * #51: an AI Video Interview is never lost to a broken export. The raw export
 * is kept as private evidence before it is parsed; a broken one is recorded
 * as a technical failure (a reason code, restart-eligible, nothing scored); a
 * later good export replaces it once; nothing already saved is wiped; the
 * evidence goes with the session's purge and deletion.
 *
 *   node --test src/lib/interviews/live-import.test.ts
 *
 * importLiveExport, saveLiveExport, removeSessionObjects and the orphan sweep
 * are the shipped code; the database and storage are fake-live-db.mjs, the
 * provider is fake-provider.ts with the sample export. Synthetic data.
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
  "server-only": "export {};",
  "@/lib/supabase/server": "export function createServiceClient() { return globalThis.__importDb.service; }",
};
export async function resolve(specifier, context, next) {
  if (specifier in STUBS) return { url: "data:text/javascript," + encodeURIComponent(STUBS[specifier]), shortCircuit: true };
  return next(specifier, context);
}`)}`,
);

const { importLiveExport, evidencePath, EVIDENCE_MAX_BYTES } = await import("./live-import.ts");
const { isImportFailure } = await import("./live-ingest.ts");
const { importFailureReason } = await import("./live-review.ts");
const { removeSessionObjects, runInterviewOrphanSweep } = await import("./purge.ts");
const { createFakeLiveProvider } = await import("./live-provider/fake-provider.ts");
const { snapshotsFor } = await import("./frozen-questions.ts");
const { fakeLiveDb } = await import("../../test-support/fake-live-db.mjs");

const FIXTURE = JSON.parse(
  readFileSync(new URL("./live-provider/__fixtures__/sample-export.json", import.meta.url), "utf8"),
);
const SESSION = "5b0f2c1e-0000-4000-8000-000000000051";
const T0 = Date.parse("2026-10-19T12:00:00.000Z");

function frozenRow() {
  const questions = FIXTURE.questions
    .filter((q) => q.position <= 8)
    .sort((a, b) => a.position - b.position)
    .map((q) => ({
      question_id: `q-${q.position}`,
      position: q.position,
      text: q.text,
      source: "job",
      competency: "Ownership",
      scoring_guide: "Strong answer: specific. Weak answer: general.",
      weight: null,
    }));
  return {
    id: SESSION,
    company_id: "c0000000-0000-4000-8000-000000000051",
    kind: "live",
    status: "started",
    attempt: 1,
    provider_session_id: FIXTURE.session_id,
    started_at: FIXTURE.started_at,
    live_ended_at: null,
    delete_after: null,
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
  };
}

/** A database with the session, a provider holding the export, and the importer's deps. */
function world(audio = {}) {
  const db = fakeLiveDb({ interview_sessions: [frozenRow()] });
  globalThis.__importDb = db;
  const provider = createFakeLiveProvider(FIXTURE, audio);
  const transcriptions = [];
  let providerId = null;
  const deps = {
    service: db.service,
    fetchAudio: async (name) => {
      providerId ??= (
        await provider.createSession({
          remotiv_session_id: SESSION,
          interviewer_name: "Sarah",
          interview_minutes: 30,
          questions: [{ position: 1, text: "Q" }],
          candidate_first_name: "Alex",
          cv_text: "",
        })
      ).providerSessionId;
      return provider.fetchAudio(providerId, name);
    },
    now: () => T0,
    requestTranscription: async () => {
      transcriptions.push(SESSION);
      return { transcriptionQueued: true };
    },
  };
  return { db, deps, transcriptions };
}

const session = (db) => db.tables.interview_sessions[0];
const evidenceFiles = (db) => [...db.objects.keys()].filter((k) => k.includes("/export-"));

async function quiet(fn) {
  const saved = {};
  const lines = [];
  for (const m of ["error", "warn", "log"]) {
    saved[m] = console[m];
    console[m] = (...a) => lines.push(a.join(" "));
  }
  try {
    return { result: await fn(), lines };
  } finally {
    Object.assign(console, saved);
  }
}

/** The sample export with one change made to a copy. */
function exportWith(change) {
  const raw = structuredClone(FIXTURE);
  change(raw);
  return raw;
}
const followUpTurn = (raw, questionOrder, index) =>
  raw.turns.find(
    (t) =>
      t.turn_type === "follow_up" &&
      t.question_order === questionOrder &&
      t.follow_up_index === index,
  );

const BROKEN = [
  // An 11th follow-up on a question: above the cap (076), broken data.
  [
    "more than 10 follow-ups",
    "bad_follow_up",
    () =>
      exportWith((r) => {
        followUpTurn(r, 2, 2).follow_up_index = 11;
      }),
    {},
  ],
  // Two follow-ups with one index on the same question.
  [
    "a duplicate index",
    "too_many_follow_ups",
    () =>
      exportWith((r) => {
        followUpTurn(r, 2, 2).follow_up_index = 1;
      }),
    {},
  ],
  ["unreadable JSON", "bad_json", () => '{"session_id": "x", "turns": [', {}],
  ["missing audio", "missing_audio", () => structuredClone(FIXTURE), "first-audio-missing"],
];

/** The audio override that removes the export's first audio file. */
function audioFor(spec) {
  if (spec !== "first-audio-missing") return spec;
  const t = FIXTURE.turns.find(
    (x) => x.interviewer_audio_file || x.candidate_audio_file || x.audio_file,
  );
  const name = t.interviewer_audio_file ?? t.candidate_audio_file ?? t.audio_file;
  return { [name]: null };
}

/* ── a good export ─────────────────────────────────────────────── */

test("a good export is imported, and its evidence copy is deleted afterwards", async () => {
  const { db, deps } = world();
  const { result } = await quiet(() => importLiveExport(SESSION, structuredClone(FIXTURE), deps));
  assert.equal(result.saved, true);
  assert.equal(isImportFailure(session(db).live_outcome), false);
  assert.deepEqual(evidenceFiles(db), [], "kept only for a refused export");
  assert.ok(db.tables.interview_turns.length > 0);
});

test("the evidence is stored BEFORE parsing: a crash mid-parse still leaves it", async () => {
  const { db, deps } = world();
  // Read once to store the evidence, then the parser's own read crashes (not an export error).
  const raw = structuredClone(FIXTURE);
  const turns = raw.turns;
  let reads = 0;
  Object.defineProperty(raw, "turns", {
    enumerable: true,
    get() {
      reads += 1;
      if (reads > 1) throw new TypeError("crash mid-parse");
      return turns;
    },
  });
  await assert.rejects(
    quiet(() => importLiveExport(SESSION, raw, deps)).then((x) => x.result),
    /crash mid-parse/,
  );
  const [path] = evidenceFiles(db);
  assert.ok(path, "the raw export was stored before the crash");
  assert.equal(
    new TextDecoder().decode(db.objects.get(path).bytes),
    JSON.stringify({ ...FIXTURE, turns }),
  );
});

/* ── a broken export ───────────────────────────────────────────── */

for (const [label, code, rawOf, audio] of BROKEN) {
  test(`broken export (${label}): raw evidence kept privately, technical failure recorded, restart-eligible, nothing scored`, async () => {
    const { db, deps, transcriptions } = world(audioFor(audio));
    const raw = rawOf();
    const { result, lines } = await quiet(() => importLiveExport(SESSION, raw, deps));
    assert.equal(result.saved, false);
    assert.equal(result.refused, code);

    // The evidence: one file, in the session's own private folder, exactly the raw export.
    const text = typeof raw === "string" ? raw : JSON.stringify(raw);
    const [path] = evidenceFiles(db);
    assert.ok(path?.startsWith(`${SESSION}/export-`), path);
    assert.equal(new TextDecoder().decode(db.objects.get(path).bytes), text);

    // The outcome: a technical failure with a reason code, final, restart-eligible.
    const o = session(db).live_outcome;
    assert.equal(isImportFailure(o), true);
    assert.deepEqual(
      [
        o.outcome,
        o.final,
        o.restart_allowed,
        o.import_failure.code,
        o.import_failure.evidence_path,
        o.import_failure.evidence_not_retained,
      ],
      ["technical_failure", true, true, code, path, null],
    );
    assert.notEqual(o.outcome, "completed");
    assert.ok(session(db).live_ended_at, "the end is stamped, as restart requires");
    // Nothing scored: no turn stored, nothing queued for transcription or scoring.
    assert.equal(db.tables.interview_turns.length, 0);
    assert.deepEqual(transcriptions, []);
    // The log names ids and codes only, never the provider's text.
    assert.ok(lines.some((l) => l.includes(SESSION) && l.includes(code)));
    assert.ok(
      !lines.some((l) => l.includes("Hi Alex") || l.includes(FIXTURE.turns[1].text ?? "@@")),
    );
    // The reviewer is told why, by code only.
    assert.match(importFailureReason(code), new RegExp(`reason: ${code}`));
  });
}

test("if the evidence cannot be stored, the failure is still recorded and says the evidence was NOT kept", async () => {
  const { db, deps } = world();
  db.failNext("storage", "upload");
  const { result, lines } = await quiet(() => importLiveExport(SESSION, '{"broken": ', deps));
  assert.equal(result.refused, "bad_json");
  const o = session(db).live_outcome;
  assert.deepEqual(
    [o.outcome, o.import_failure.evidence_path, o.import_failure.evidence_not_retained],
    ["technical_failure", null, "storage_failed"],
  );
  assert.deepEqual(evidenceFiles(db), []);
  assert.equal(
    lines.filter((l) => l.includes("export evidence not retained (storage_failed)")).length,
    1,
  );
  // The reviewer is told it was not kept, by code; never that it was.
  const reason = importFailureReason("bad_json", "storage_failed");
  assert.match(reason, /It was NOT kept \(reason: storage_failed\)/);
  assert.doesNotMatch(reason, /It is kept/);
});

test("the cap is 25 MB, and the evidence is kept WHOLE: byte-exact at the cap", async () => {
  assert.equal(EVIDENCE_MAX_BYTES, 25 * 1024 * 1024);
  const { db, deps } = world();
  // Exactly at the cap: kept, every byte.
  const atCap = `{"pad": "${"x".repeat(EVIDENCE_MAX_BYTES - 10)}"`;
  assert.equal(new TextEncoder().encode(atCap).byteLength, EVIDENCE_MAX_BYTES);
  await quiet(() => importLiveExport(SESSION, atCap, deps));
  const [path] = evidenceFiles(db);
  assert.equal(db.objects.get(path).bytes.byteLength, EVIDENCE_MAX_BYTES);
  assert.equal(session(db).live_outcome.import_failure.evidence_not_retained, null);
});

test("above the cap: no partial copy, the failure says 'too_large', one log line", async () => {
  const { db, deps } = world();
  const big = `{"pad": "${"x".repeat(EVIDENCE_MAX_BYTES)}"`;
  const { lines } = await quiet(() => importLiveExport(SESSION, big, deps));
  assert.deepEqual(evidenceFiles(db), [], "nothing stored, not even a part");
  const f = session(db).live_outcome.import_failure;
  assert.deepEqual([f.evidence_path, f.evidence_not_retained], [null, "too_large"]);
  assert.equal(lines.filter((l) => l.includes("not retained (too_large)")).length, 1);
  assert.ok(!lines.some((l) => l.includes("xxxx")), "no raw text in the log");
  assert.match(
    importFailureReason(f.code, f.evidence_not_retained),
    /NOT kept \(reason: too_large\)/,
  );
});

/* ── retry, and nothing wiped ──────────────────────────────────── */

test("a good export after a broken one is imported once: the failure replaced, its evidence removed", async () => {
  const { db, deps, transcriptions } = world();
  await quiet(() => importLiveExport(SESSION, '{"broken": ', deps));
  const failedEvidence = evidenceFiles(db);
  assert.equal(failedEvidence.length, 1);

  const { result } = await quiet(() => importLiveExport(SESSION, structuredClone(FIXTURE), deps));
  assert.equal(result.saved, true);
  const o = session(db).live_outcome;
  assert.equal(isImportFailure(o), false, "the interview's own outcome now");
  assert.notEqual(o.outcome, "technical_failure");
  assert.deepEqual(evidenceFiles(db), [], "the earlier evidence went with the good import");
  const turns = db.tables.interview_turns.length;

  // The same good export again: nothing duplicated, the outcome written once.
  const again = await quiet(() => importLiveExport(SESSION, structuredClone(FIXTURE), deps));
  assert.equal(again.result.saved, false);
  assert.equal(db.tables.interview_turns.length, turns);
  assert.equal(session(db).live_outcome.saved_at, o.saved_at);
  assert.deepEqual(evidenceFiles(db), []);
  assert.ok(transcriptions.length >= 1);
});

test("a broken export after a good one never wipes it: the saved outcome and turns are kept", async () => {
  const { db, deps } = world();
  await quiet(() => importLiveExport(SESSION, structuredClone(FIXTURE), deps));
  const outcome = structuredClone(session(db).live_outcome);
  const turns = structuredClone(db.tables.interview_turns);

  const { result } = await quiet(() =>
    importLiveExport(
      SESSION,
      exportWith((r) => {
        followUpTurn(r, 2, 2).follow_up_index = 11;
      }),
      deps,
    ),
  );
  assert.equal(result.refused, "bad_follow_up");
  assert.deepEqual(session(db).live_outcome, outcome, "the interview's outcome is untouched");
  assert.deepEqual(db.tables.interview_turns, turns, "every saved answer kept");
  assert.equal(evidenceFiles(db).length, 1, "the broken export is kept as evidence");
});

test("answers a good part already stored are kept, and counted in the technical failure", async () => {
  const { db, deps } = world();
  await quiet(() => importLiveExport(SESSION, structuredClone(FIXTURE), deps));
  // The save stopped after the turns, before its outcome (a crash in between).
  session(db).live_outcome = null;
  const turns = structuredClone(db.tables.interview_turns);

  await quiet(() => importLiveExport(SESSION, '{"broken": ', deps));
  const o = session(db).live_outcome;
  assert.equal(o.outcome, "technical_failure");
  assert.ok(o.answered_count > 0, `${o.answered_count} answers counted from what is stored`);
  assert.equal(o.turn_count, turns.length);
  assert.deepEqual(db.tables.interview_turns, turns, "never wiped");
});

/* ── the evidence's lifetime ───────────────────────────────────── */

test("the evidence goes with the session: the purge's and every deletion's whole-folder removal", async () => {
  const { db, deps } = world();
  await quiet(() => importLiveExport(SESSION, '{"broken": ', deps));
  const [path] = evidenceFiles(db);
  const r = await removeSessionObjects(db.service, SESSION);
  assert.ok(r.present.includes(path));
  assert.equal(r.complete, true);
  assert.equal(db.objects.has(path), false);
  // Applicant deletion (and company deletion, through it) removes each session's folder this way.
  const deletion = readFileSync(new URL("./application-deletion.ts", import.meta.url), "utf8");
  assert.match(deletion, /removeSessionObjects\(/);
});

test("the orphan sweep keeps evidence its outcome names, and sweeps a copy nothing names", async () => {
  const { db, deps } = world();
  await quiet(() => importLiveExport(SESSION, '{"broken": ', deps));
  const [path] = evidenceFiles(db);
  // An older copy whose outcome no longer names it (replaced, say).
  db.objects.set(`${SESSION}/export-${"0".repeat(32)}.json`, {
    bytes: new Uint8Array([1]),
    contentType: "application/json",
    createdAt: T0 - 7 * 86_400_000,
  });
  db.objects.get(path).createdAt = T0 - 7 * 86_400_000;
  db.tables.background_jobs = [];
  await quiet(() => runInterviewOrphanSweep({ id: "sweep-51", payload: {} }, { graceMs: 0 }));
  assert.equal(db.objects.has(path), true, "named by the outcome: kept");
  assert.equal(
    db.objects.has(`${SESSION}/export-${"0".repeat(32)}.json`),
    false,
    "named by nothing: swept",
  );
});

test("the evidence path is flat in the session's folder, so a folder listing reaches it", () => {
  assert.equal(evidencePath(SESSION, "a".repeat(64)), `${SESSION}/export-${"a".repeat(32)}.json`);
});
