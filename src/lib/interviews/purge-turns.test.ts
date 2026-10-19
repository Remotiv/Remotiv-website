/**
 * The retention purge (lib/interviews/purge.ts) and AI Video Interview turns:
 * turn content and audio go when the session is due, never before; a failed
 * delete is retried; the orphan sweep keeps turn audio a turn still points at.
 * The database and bucket are fake-live-db.mjs, which enforces the turns
 * table's constraints on every update. Every word is made up.
 *
 *   node --test src/lib/interviews/purge-turns.test.ts
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
  "@/lib/supabase/server": "export function createServiceClient() { return globalThis.__purgeService; }",
};
export async function resolve(specifier, context, next) {
  if (specifier in STUBS) return { url: "data:text/javascript," + encodeURIComponent(STUBS[specifier]), shortCircuit: true };
  return next(specifier, context);
}`)}`,
);

const { handleInterviewPurge } = await import("./purge.ts");
const { saveLiveExport } = await import("./live-ingest.ts");
const { parseExport } = await import("./live-provider/parse-export.ts");
const { createFakeLiveProvider } = await import("./live-provider/fake-provider.ts");
const { snapshotsFor } = await import("./frozen-questions.ts");
const { fakeLiveDb } = await import("../../test-support/fake-live-db.mjs");

const FIXTURE = JSON.parse(
  readFileSync(new URL("./live-provider/__fixtures__/sample-export.json", import.meta.url), "utf8"),
);
const DUE = "5b0f2c1e-0000-4000-8000-0000000000d1";
const LATER = "5b0f2c1e-0000-4000-8000-0000000000f2";
const DAY = 24 * 60 * 60 * 1000;

function session(id, deleteAfter) {
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
    id,
    kind: "live",
    attempt: 1,
    provider_session_id: FIXTURE.session_id,
    delete_after: deleteAfter,
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
  };
}

/** Two saved live sessions: one past its retention date, one not. */
async function world() {
  const db = fakeLiveDb({
    interview_sessions: [
      session(DUE, new Date(Date.now() - DAY).toISOString()),
      session(LATER, new Date(Date.now() + 90 * DAY).toISOString()),
    ],
  });
  const provider = createFakeLiveProvider(FIXTURE);
  const orig = console.log;
  console.log = () => {};
  try {
    for (const id of [DUE, LATER]) {
      const { providerSessionId } = await provider.createSession({
        remotiv_session_id: id,
        interviewer_name: "Sarah",
        interview_minutes: 30,
        questions: [{ position: 1, text: "Q" }],
        candidate_first_name: "Alex",
        cv_text: "",
      });
      await saveLiveExport(
        id,
        {
          ...parseExport(provider.exportOf(providerSessionId)),
          provider_session_id: FIXTURE.session_id,
        },
        {
          service: db.service,
          fetchAudio: (n) => provider.fetchAudio(providerSessionId, n),
          now: () => Date.now(),
        },
      );
    }
  } finally {
    console.log = orig;
  }
  globalThis.__purgeService = db.service;
  return db;
}

async function purge() {
  const lines = [];
  const orig = { log: console.log, error: console.error };
  console.log = console.error = (...a) => lines.push(a.join(" "));
  try {
    await handleInterviewPurge({ id: "job-1", payload: {} });
  } finally {
    Object.assign(console, orig);
  }
  return lines;
}

const turnsOf = (db, id) => db.tables.interview_turns.filter((t) => t.session_id === id);
const filesOf = (db, id) => [...db.objects.keys()].filter((k) => k.startsWith(`${id}/`));

test("a due session: every turn's content and audio go; the hiring record stays", async () => {
  const db = await world();
  const before = turnsOf(db, DUE).map((t) => structuredClone(t));
  assert.equal(filesOf(db, DUE).length, 32);
  const lines = await purge();
  assert.equal(filesOf(db, DUE).length, 0, "the audio is gone");
  for (const t of turnsOf(db, DUE)) {
    assert.equal(t.text, null);
    assert.equal(t.transcript, null);
    assert.equal(t.transcript_segments, null);
    assert.equal(t.follow_up_reason, null);
    assert.equal(t.media_path, null);
    assert.ok(t.content_purged_at);
    const was = before.find((b) => b.id === t.id);
    for (const k of [
      "speaker",
      "kind",
      "sequence",
      "question_position",
      "follow_up_index",
      "offset_ms",
      "duration_ms",
      "interrupted",
      "media_sha256",
      "media_bytes",
      "media_mime_type",
    ]) {
      assert.deepEqual(t[k], was[k], `${k} is kept`);
    }
  }
  assert.ok(lines.some((l) => /turns=32/.test(l)));
});

test("a session still inside its retention window is not touched", async () => {
  const db = await world();
  const before = structuredClone(turnsOf(db, LATER));
  await purge();
  assert.deepEqual(turnsOf(db, LATER), before);
  assert.equal(filesOf(db, LATER).length, 32);
});

test("a failed audio delete: the words go now, the path stays, and the next run finishes it", async () => {
  const db = await world();
  // Sequence 6 is a follow-up: interviewer text and a reason to clear.
  const stuck = turnsOf(db, DUE).find((t) => t.sequence === 6);
  assert.equal(stuck.kind, "follow_up");
  assert.ok(stuck.text && stuck.follow_up_reason);
  db.failRemove(stuck.media_path);
  await purge();
  const after = turnsOf(db, DUE).find((t) => t.sequence === 6);
  assert.equal(after.text, null);
  assert.equal(after.follow_up_reason, null);
  assert.equal(after.media_path, stuck.media_path, "kept until the object is confirmed gone");
  assert.ok(after.content_purged_at);
  assert.ok(db.objects.has(stuck.media_path));
  await purge();
  const done = turnsOf(db, DUE).find((t) => t.sequence === 6);
  assert.equal(done.media_path, null);
  assert.equal(db.objects.has(stuck.media_path), false);
});

test("purging twice does nothing the second time", async () => {
  const db = await world();
  await purge();
  const updates = db.counts.turnUpdates;
  const lines = await purge();
  assert.equal(db.counts.turnUpdates, updates);
  assert.ok(lines.some((l) => /turns=0/.test(l)));
});

test("the orphan sweep keeps old turn audio a turn points at, and removes what nothing references", async () => {
  const db = await world();
  // Age every file of the not-due session past the 24-hour grace, and add a stray one.
  const stray = `${LATER}/t99.wav`;
  db.objects.set(stray, {
    bytes: new Uint8Array([1]),
    contentType: "audio/wav",
    createdAt: Date.now(),
  });
  for (const p of [...filesOf(db, LATER)]) db.age(p, 2 * DAY);
  await purge();
  assert.equal(db.objects.has(stray), false, "the unreferenced file is swept");
  assert.equal(filesOf(db, LATER).length, 32, "every referenced turn file is kept");
});

test("a losing save's files (another export hash, nothing references them) are swept after the grace", async () => {
  const db = await world();
  const winner = filesOf(db, LATER);
  const loser = winner.map((p) => p.replace(/\.[0-9a-f]{8}\.wav$/, ".0badf00d.wav"));
  for (const p of loser)
    db.objects.set(p, {
      bytes: new Uint8Array([7]),
      contentType: "audio/wav",
      createdAt: Date.now(),
    });
  // Within the 24-hour grace: kept, in case a save is still in flight.
  await purge();
  assert.ok(loser.every((p) => db.objects.has(p)));
  for (const p of [...loser, ...winner]) db.age(p, 2 * DAY);
  await purge();
  assert.ok(
    loser.every((p) => !db.objects.has(p)),
    "the loser's files are swept",
  );
  assert.ok(
    winner.every((p) => db.objects.has(p)),
    "the winner's files are kept",
  );
});
