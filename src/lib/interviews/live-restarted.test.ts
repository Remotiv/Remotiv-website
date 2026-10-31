/**
 * A restarted first attempt (F10 C3a: status 'abandoned' once a restart is
 * decided) is never changed by a late export, a transcription settle or a
 * scoring job: its outcome stays as the restart was decided on, nothing is
 * scored, and each job finishes instead of retrying. A restart that lands
 * while a job runs is respected at the write. Every other session is saved,
 * settled and scored as before. The same with or without migration 053 (its
 * database guard is not emulated here: these guards are the code's own).
 *
 * The export is the sample fixture; the database is fake-live-db.mjs.
 * Synthetic data only.
 *
 *   node --test src/lib/interviews/live-restarted.test.ts
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

const { saveLiveExport } = await import("./live-ingest.ts");
const { handleLiveTurnTranscribe, settleLiveOutcome } = await import("./live-transcribe.ts");
const { scoreLiveSession } = await import("./live-scoring.ts");
const { parseExport } = await import("./live-provider/parse-export.ts");
const { createFakeLiveProvider } = await import("./live-provider/fake-provider.ts");
const { snapshotsFor } = await import("./frozen-questions.ts");
const { fakeLiveDb } = await import("../../test-support/fake-live-db.mjs");

const FIXTURE = JSON.parse(
  readFileSync(new URL("./live-provider/__fixtures__/sample-export.json", import.meta.url), "utf8"),
);
const SESSION = "5b0f2c1e-0000-4000-8000-0000000000a3";
const CO = "7aad434d-0000-4000-8000-000000000003";

function frozenRow(over = {}) {
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
    status: "started",
    attempt: 1,
    provider_session_id: FIXTURE.session_id,
    live_ended_at: "2026-10-31T08:00:00.000Z",
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
    ...over,
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

const sessionOf = (db) => db.tables.interview_sessions[0];
const restart = (db) => {
  sessionOf(db).status = "abandoned";
};

/** A database with the session, the fake provider holding the fixture, and a save that records transcription requests. */
async function world(over = {}) {
  const db = fakeLiveDb({ interview_sessions: [frozenRow(over)] });
  const provider = createFakeLiveProvider(FIXTURE);
  const { providerSessionId } = await provider.createSession({
    remotiv_session_id: SESSION,
    interviewer_name: "Sarah",
    interview_minutes: 30,
    questions: [{ position: 1, text: "Q" }],
    candidate_first_name: "Alex",
    cv_text: "",
  });
  const transcriptionRequests = [];
  const save = (opts = {}) =>
    quiet(() => {
      const parsed = parseExport(provider.exportOf(providerSessionId));
      return saveLiveExport(
        SESSION,
        {
          ...parsed,
          status: { ...parsed.status, ...opts.status },
          provider_session_id: FIXTURE.session_id,
        },
        {
          service: db.service,
          fetchAudio: (n) => {
            opts.onFetch?.();
            return provider.fetchAudio(providerSessionId, n);
          },
          now: () => Date.parse("2026-10-31T09:00:00.000Z"),
          requestTranscription: async () => {
            transcriptionRequests.push(SESSION);
            return { queued: 1, alreadyQueued: 0, failed: 0 };
          },
        },
      );
    });
  return { db, save, transcriptionRequests };
}

const candidateTurns = (db) =>
  db.tables.interview_turns
    .filter((t) => t.speaker === "candidate")
    .sort((a, b) => a.sequence - b.sequence);

/** A fake Whisper: a real sentence for every turn. `during` runs inside each call. */
const whisper = (during) => async () => {
  during?.();
  return { text: "I led the work and shipped it in two weeks.", segments: [] };
};

async function transcribeAll(db, { during, onDecided = async () => {} } = {}) {
  for (const t of candidateTurns(db)) {
    await quiet(() =>
      handleLiveTurnTranscribe(
        {
          id: `job-${t.sequence}`,
          payload: { turnId: t.id, sessionId: SESSION },
          attempts: 0,
          max_attempts: 3,
        },
        undefined,
        { service: db.service, transcribe: whisper(during), onDecided },
      ),
    );
  }
}

/** A fake scoring model: quotes the candidate's first words. `during` runs inside each call. */
function fakeModel(during) {
  const calls = [];
  const call = async (request) => {
    calls.push(1);
    during?.();
    const user = request.messages[0].content;
    const line = user.split("\n").find((l) => l.startsWith("Candidate: "));
    const quote = line?.slice("Candidate: ".length).split(" ").slice(0, 6).join(" ");
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            score: 70,
            confidence: "high",
            rationale: "The candidate described their own work.",
            quotes: quote ? [quote] : [],
          }),
        },
      ],
      stop_reason: "end_turn",
      usage: { input_tokens: 900, output_tokens: 120 },
    };
  };
  return { calls, call };
}

const score = (db, model) =>
  quiet(() => scoreLiveSession(SESSION, { service: db.service, call: model.call, enabled: true }));

/** Saved and fully transcribed as a normal session: the outcome decided. */
async function decided() {
  const w = await world();
  await w.save();
  await transcribeAll(w.db);
  assert.equal(sessionOf(w.db).live_outcome.final, true, "fixture decided");
  return w;
}

// ── a, b: a late export ─────────────────────────────────────

test("a: late export, restarted, no outcome -> turns and audio kept, outcome untouched, no transcription, done", async () => {
  const w = await world({ status: "abandoned" });
  const result = await w.save();
  assert.deepEqual(result, { outcome: null, saved: true, restarted: true });
  assert.equal(w.db.tables.interview_turns.length, FIXTURE.turns.length, "turns stored for audit");
  assert.ok(
    [...w.db.objects.keys()].some((k) => k.startsWith(`${SESSION}/t`)),
    "audio stored",
  );
  assert.equal(sessionOf(w.db).live_outcome, null);
  assert.deepEqual(w.transcriptionRequests, []);
  // Saved again (a retry): still done, nothing more.
  const again = await w.save();
  assert.deepEqual(again, { outcome: null, saved: false, restarted: true });
  assert.equal(sessionOf(w.db).live_outcome, null);
  assert.deepEqual(w.transcriptionRequests, []);
});

test("b: late export, restarted, outcome set -> nothing written, done, no error", async () => {
  const kept = {
    outcome: "technical_failure",
    final: true,
    export_hash: "another-export",
    settle_rev: 4,
  };
  const w = await world({ status: "abandoned", live_outcome: kept });
  const result = await w.save();
  assert.deepEqual(result, { outcome: kept, saved: false, restarted: true });
  assert.equal(w.db.tables.interview_turns.length, 0, "no turns");
  assert.equal(w.db.objects.size, 0, "no audio");
  assert.deepEqual(sessionOf(w.db).live_outcome, kept);
  assert.deepEqual(w.transcriptionRequests, []);
});

// ── c: a transcription settle ───────────────────────────────

test("c: transcription on a restarted attempt -> outcome untouched, jobs done, nothing decided", async () => {
  const w = await world();
  await w.save();
  restart(w.db);
  const before = structuredClone(sessionOf(w.db).live_outcome);
  const decidedCalls = [];
  await transcribeAll(w.db, { onDecided: async () => decidedCalls.push(1) });
  assert.deepEqual(sessionOf(w.db).live_outcome, before);
  assert.deepEqual(decidedCalls, [], "no scoring asked for");
  assert.deepEqual(await quiet(() => settleLiveOutcome(w.db.service, SESSION)), before);
});

// ── d: scoring ──────────────────────────────────────────────

test("d: scoring a restarted attempt -> skipped, no model call, no score row", async () => {
  const w = await decided();
  restart(w.db);
  const model = fakeModel();
  const queriesBefore = w.db.service.queries.length;
  assert.equal(await score(w.db, model), null);
  assert.deepEqual(model.calls, []);
  assert.equal(w.db.tables.live_interview_scores.length, 0);
  assert.deepEqual(
    w.db.service.queries.slice(queriesBefore).map((q) => q.table),
    ["interview_sessions"],
    "skipped at once: only the session was read",
  );
});

// ── e: a restart that lands while the job runs ──────────────

test("e: a restart landing mid-export -> outcome untouched, turns kept, no transcription, done", async () => {
  const w = await world();
  let fetched = 0;
  const result = await w.save({ onFetch: () => fetched++ === 0 && restart(w.db) });
  assert.deepEqual(result, { outcome: null, saved: true, restarted: true });
  assert.equal(sessionOf(w.db).live_outcome, null);
  assert.equal(w.db.tables.interview_turns.length, FIXTURE.turns.length);
  assert.deepEqual(w.transcriptionRequests, []);
});

test("e: a restart landing between the settle's read and its write -> outcome untouched, done", async () => {
  const w = await world();
  await w.save();
  const before = structuredClone(sessionOf(w.db).live_outcome);
  // The settle reads the session, then the action log, then writes: restart on that action read.
  const from = w.db.service.from.bind(w.db.service);
  w.db.service.from = (table) => {
    if (table === "live_interview_actions") restart(w.db);
    return from(table);
  };
  await transcribeAll(w.db);
  assert.deepEqual(sessionOf(w.db).live_outcome, before);
  assert.equal(sessionOf(w.db).status, "abandoned");
});

test("e: a restart landing while scoring -> no score row", async () => {
  const w = await decided();
  // After the job's own read, before its write: on its read of the stored score row.
  const from = w.db.service.from.bind(w.db.service);
  let landed = false;
  w.db.service.from = (table) => {
    if (table === "live_interview_scores") {
      restart(w.db);
      landed = true;
    }
    return from(table);
  };
  assert.equal(await score(w.db, fakeModel()), null);
  assert.ok(landed, "the restart landed after scoring began");
  assert.equal(w.db.tables.live_interview_scores.length, 0);
});

// ── g: a not-final export ───────────────────────────────────

test("g: restarted + not-final export -> done, no retry, nothing written", async () => {
  const kept = { outcome: "technical_failure", final: true, export_hash: "x", settle_rev: 2 };
  for (const live_outcome of [null, kept]) {
    const w = await world({ status: "abandoned", live_outcome });
    const ended = sessionOf(w.db).live_ended_at;
    const result = await w.save({ status: { provider_status: "in_progress" } });
    assert.deepEqual(result, { outcome: live_outcome, saved: false, restarted: true });
    assert.equal(result.notFinal, undefined, "never retry later");
    assert.equal(result.retryable, undefined);
    assert.equal(w.db.tables.interview_turns.length, 0, "no turns");
    assert.equal(w.db.objects.size, 0, "no audio");
    assert.deepEqual(sessionOf(w.db).live_outcome, live_outcome);
    assert.equal(sessionOf(w.db).live_ended_at, ended, "no end stamped");
    assert.deepEqual(w.transcriptionRequests, []);
    assert.deepEqual(
      w.db.service.queries.map((q) => [q.table, q.calls[0][0]]),
      [["interview_sessions", "select"]],
      "only the session read",
    );
  }
  // Not restarted: retry later, as before.
  const w = await world();
  assert.deepEqual(await w.save({ status: { provider_status: "in_progress" } }), {
    outcome: null,
    saved: false,
    notFinal: true,
    retryable: true,
  });
});

// ── h: the transcription job's entry ────────────────────────

test("h: transcription job on an already-restarted attempt -> Whisper never called, job done", async () => {
  const w = await world();
  await w.save();
  restart(w.db);
  const before = structuredClone(sessionOf(w.db).live_outcome);
  let whisperCalls = 0;
  const decidedCalls = [];
  await transcribeAll(w.db, {
    during: () => whisperCalls++,
    onDecided: async () => decidedCalls.push(1),
  });
  assert.equal(whisperCalls, 0, "no audio sent to Whisper");
  assert.ok(candidateTurns(w.db).length > 0);
  for (const t of candidateTurns(w.db)) {
    assert.deepEqual(
      [t.transcript_status, t.transcript ?? null],
      ["pending", null],
      "no transcript",
    );
  }
  assert.deepEqual(sessionOf(w.db).live_outcome, before);
  assert.deepEqual(decidedCalls, []);
});

test("h: a restart landing during a Whisper call -> that transcript kept for audit only, outcome untouched", async () => {
  const w = await world();
  await w.save();
  const before = structuredClone(sessionOf(w.db).live_outcome);
  let whisperCalls = 0;
  const decidedCalls = [];
  await transcribeAll(w.db, {
    during: () => whisperCalls++ === 0 && restart(w.db),
    onDecided: async () => decidedCalls.push(1),
  });
  assert.equal(whisperCalls, 1, "the call in flight finished; no later turn was sent");
  const [first, ...rest] = candidateTurns(w.db);
  assert.equal(first.transcript_status, "done", "stored for audit");
  assert.ok(rest.every((t) => t.transcript_status === "pending"));
  assert.deepEqual(sessionOf(w.db).live_outcome, before);
  assert.deepEqual(decidedCalls, [], "nothing decided, no scoring asked for");
});

// ── f: a normal session, as today ───────────────────────────

test("f: a normal session is saved, settled and scored as today", async () => {
  const w = await world();
  const result = await w.save();
  assert.equal(result.saved, true);
  assert.equal(result.transcriptionQueued, true);
  assert.equal(result.restarted, undefined);
  assert.notEqual(sessionOf(w.db).live_outcome, null);
  assert.equal(sessionOf(w.db).live_outcome.final, false, "provisional until transcribed");
  assert.deepEqual(w.transcriptionRequests, [SESSION]);
  const rev = sessionOf(w.db).live_outcome.settle_rev ?? 0;

  const decidedCalls = [];
  await transcribeAll(w.db, { onDecided: async () => decidedCalls.push(1) });
  assert.equal(sessionOf(w.db).live_outcome.final, true);
  assert.ok(sessionOf(w.db).live_outcome.settle_rev > rev, "settled");
  assert.deepEqual(decidedCalls, [1], "scoring asked for once");

  const model = fakeModel();
  const row = await score(w.db, model);
  assert.ok(row, "scored");
  assert.equal(w.db.tables.live_interview_scores.length, 1);
});
