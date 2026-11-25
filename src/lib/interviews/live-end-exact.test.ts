/**
 * #23: a live interview's stored end is the real end, on the server's clock
 * only: the export's save time, never later than started_at plus the frozen
 * length; or, when nothing arrives, the backstop stores started_at plus the
 * length. The 10-minute grace only decides WHEN the backstop acts. The
 * provider's own durations and timestamps are never used. The video upload
 * window and the restart hour count from that stored end.
 *
 * The shipped code (importLiveExport, saveLiveExport, the backstop sweep, the
 * video endpoints, restartEligibility) against fake-live-db.mjs with
 * migration 069's rule (endRule "069"), as staging and production now run.
 * The provider is fake-provider.ts with the sample export. Synthetic data.
 *
 *   node --test src/lib/interviews/live-end-exact.test.ts
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../test-support/tsx-load.mjs", import.meta.url));
register(
  `data:text/javascript,${encodeURIComponent(`
const STUBS = {
  "server-only": "",
  "@/lib/supabase/server": "export function createServiceClient() { return globalThis.__endService; }",
  "@/lib/interviews/live-consent": "export const LIVE_INTERVIEW_CONSENT_VERSION = 'live-v1'; export function liveConsentReady() { return true; } export function liveConsentGiven(r) { return r.consent_at !== null && r.consent_version === 'live-v1'; }",
};
export async function resolve(specifier, context, next) {
  if (specifier in STUBS) return { url: "data:text/javascript," + encodeURIComponent(STUBS[specifier]), shortCircuit: true };
  return next(specifier, context);
}`)}`,
);

const { reservePieceUpload, confirmPiece } = await import("./live-video.ts");
const { stampOverdueLiveEnds, END_GRACE_MS, exportEndMs } = await import("./live-events.ts");
const { importLiveExport } = await import("./live-import.ts");
const { restartEligibility } = await import("./live-restart.ts");
const { hashSessionToken } = await import("./tokens.ts");
const { createFakeLiveProvider } = await import("./live-provider/fake-provider.ts");
const { snapshotsFor } = await import("./frozen-questions.ts");
const { fakeLiveDb } = await import("../../test-support/fake-live-db.mjs");

const FIXTURE = JSON.parse(
  readFileSync(new URL("./live-provider/__fixtures__/sample-export.json", import.meta.url), "utf8"),
);
const SESSION = "5b0f2c1e-0000-4000-8000-0000000023a1";
const TOKEN = "live-end-exact-token-0123456789abcdef";
const MIN = 60_000;
const DAY = 86_400_000;
/** Remotiv's own start, set by the start route on the server's clock. */
const START = Date.parse(FIXTURE.started_at);
const at = (minutes: number) => START + minutes * MIN;
const iso = (ms: number) => new Date(ms).toISOString();

const quiet = async (fn) => {
  const orig = { log: console.log, error: console.error, warn: console.warn };
  console.log = console.error = console.warn = () => {};
  try {
    return await fn();
  } finally {
    Object.assign(console, orig);
  }
};

/** Live settings v4 as the invite freezes them, with the frozen-questions marker. */
const settings = (seconds: number) => ({
  v: 4,
  interviewer_name: "Sarah",
  language: "en",
  interview_mode: "ai_guided",
  max_follow_ups_per_base_question: 2,
  max_session_seconds: seconds,
  follow_up_rules_version: "follow-up-v1",
  follow_up_rules: { when: "Thin.", scope: "Stay on it.", never: ["Reveal the answer."] },
  question_mix: {
    policy_version: "question-mix-v2",
    session_minutes: seconds / 60,
    job_questions: 6,
    cv_questions: 0,
    total: 6,
  },
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
});

function sessionRow(seconds: number) {
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
    company_id: "7aad434d-0000-4000-8000-000000000023",
    job_id: null,
    application_id: null,
    kind: "live",
    attempt: 1,
    status: "started",
    token_hash: hashSessionToken(TOKEN),
    expires_at: iso(at(0) + 5 * DAY),
    consent_at: iso(at(-5)),
    consent_version: "live-v1",
    started_at: iso(at(0)),
    provider_session_id: FIXTURE.session_id,
    live_settings: settings(seconds),
    live_outcome: null,
    live_ended_at: null,
    delete_after: iso(at(0) + 180 * DAY),
    ...snapshotsFor(questions),
  };
}

/** A started live interview of `seconds`; one clock for the database and the server. */
function world(seconds = 1800) {
  const clock = { now: at(0) };
  const db = fakeLiveDb(
    { interview_sessions: [sessionRow(seconds)], signed_url_logs: [] },
    { now: () => clock.now, endRule: "069" },
  );
  globalThis.__endService = db.service;
  const provider = createFakeLiveProvider(FIXTURE, {});
  let providerId = null;
  const deps = {
    service: db.service,
    now: () => clock.now,
    fetchHead: async (url) =>
      db.objects.get(decodeURIComponent(new URL(url).pathname.replace(/^\/signed\//, ""))).bytes,
    fetchAudio: async (name) => {
      providerId ??= (
        await provider.createSession({
          remotiv_session_id: SESSION,
          interviewer_name: "Sarah",
          interview_minutes: seconds / 60,
          questions: [{ position: 1, text: "Q" }],
          candidate_first_name: "Alex",
          cv_text: "",
        })
      ).providerSessionId;
      return provider.fetchAudio(providerId, name);
    },
    requestTranscription: async () => ({ transcriptionQueued: true }),
  };
  const row = () => db.tables.interview_sessions[0];
  const end = () => row().live_ended_at;
  const importAt = (minutes: number, raw = structuredClone(FIXTURE)) => {
    clock.now = at(minutes);
    return quiet(() => importLiveExport(SESSION, raw, deps));
  };
  const sweepAt = (minutes: number) => {
    clock.now = at(minutes);
    return quiet(() => stampOverdueLiveEnds(db.service, deps.now));
  };
  const confirmAt = (ms: number) => {
    clock.now = ms;
    return quiet(() =>
      confirmPiece(
        {
          token: TOKEN,
          piece: 0,
          mimeType: "video/webm",
          startedAtMs: 0,
          durationMs: 120_000,
          last: true,
        },
        deps,
      ),
    );
  };
  /** Piece 0, reserved and uploaded while the call ran. */
  const pieceInFlight = async () => {
    clock.now = at(5);
    const r = await quiet(() =>
      reservePieceUpload({ token: TOKEN, piece: 0, mimeType: "video/webm" }, deps),
    );
    assert.equal(r.status, 200, "reserved while the interview ran");
    const put = await db.putSigned(
      r.body.url,
      new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1]),
      "video/webm",
    );
    assert.equal(put.error, null, "uploaded");
  };
  const restartAt = (ms: number) => {
    const verdict = restartEligibility({ ...row(), decided: false }, ms);
    return verdict.eligible ? "eligible" : verdict.code;
  };
  return { clock, db, row, end, importAt, sweepAt, confirmAt, pieceInFlight, restartAt };
}

/* ── the export saved ─────────────────────────────────────────── */

// Negative control: stamp deps.now in saveLiveExport (no cap) and this fails with 33:00.
test("30 minutes, export saved at 33:00: the end is 30:00", async () => {
  const w = world();
  assert.equal((await w.importAt(33)).outcome?.outcome !== undefined, true, "the export saved");
  assert.equal(w.end(), iso(at(30)));
});

test("30 minutes, ended early, export saved at 12:00: the end is 12:00", async () => {
  const w = world();
  await w.importAt(12);
  assert.equal(w.end(), iso(at(12)));
});

test("60 minutes: export at 63:00 ends at 60:00, export at 33:00 at 33:00", async () => {
  const late = world(3600);
  await late.importAt(63);
  assert.equal(late.end(), iso(at(60)));
  const early = world(3600);
  await early.importAt(33);
  assert.equal(early.end(), iso(at(33)), "a 60-minute interview is not capped at 30");
});

test("the provider's duration and timestamps are ignored", async () => {
  for (const [label, minutes, claim, want] of [
    ["claims 5 minutes, saved at 33:00", 33, 5, at(30)],
    ["claims 2 hours, saved at 12:00", 12, 120, at(12)],
  ]) {
    const raw = structuredClone(FIXTURE);
    raw.duration_ms = claim * MIN;
    raw.duration_seconds = claim * 60;
    raw.ended_at = iso(Date.parse(raw.started_at) + claim * MIN);
    const w = world();
    await w.importAt(minutes, raw);
    assert.equal(w.end(), iso(want), label);
  }
});

test("a refused export (import failure) saved at 33:00: the end is 30:00 too", async () => {
  const w = world();
  const r = await w.importAt(33, '{"session_id": "x", "turns": [');
  assert.equal(r.outcome?.import_failure?.code, "bad_json", "recorded as a technical failure");
  assert.equal(w.end(), iso(at(30)));
});

test("exportEndMs: never later than the end, never before the start", () => {
  const row = { id: SESSION, started_at: iso(at(0)), live_settings: settings(1800) };
  assert.equal(exportEndMs(row, at(33)), at(30));
  assert.equal(exportEndMs(row, at(12)), at(12));
  assert.equal(exportEndMs(row, at(-2)), at(0), "a save clock behind the start");
  assert.equal(exportEndMs({ ...row, started_at: null }, at(33)), at(33), "no start: now()");
});

/* ── the backstop ─────────────────────────────────────────────── */

test("30 minutes, nothing arrives: the sweep waits for the grace, then stores 30:00", async () => {
  assert.equal(END_GRACE_MS, 10 * MIN);
  const w = world();
  assert.equal(await w.sweepAt(39), 0, "inside the grace: not yet");
  assert.equal(w.end(), null);
  assert.equal(await w.sweepAt(43), 1);
  assert.equal(w.end(), iso(at(30)), "the interview's end, not 43:00 or 40:00");
});

test("60 minutes, nothing arrives: the sweep at 73:00 stores 60:00", async () => {
  const w = world(3600);
  assert.equal(await w.sweepAt(69), 0);
  assert.equal(await w.sweepAt(73), 1);
  assert.equal(w.end(), iso(at(60)));
});

test("the stored end is set once: a later export, sweep or status never moves it", async () => {
  const w = world();
  await w.sweepAt(43);
  await w.importAt(45);
  assert.equal(await w.sweepAt(50), 0);
  const { error } = await w.db.service
    .from("interview_sessions")
    .update({ live_ended_at: iso(at(20)) })
    .eq("id", SESSION);
  assert.ok(error, "a direct rewrite is refused");
  await w.db.service.from("interview_sessions").update({ status: "submitted" }).eq("id", SESSION);
  assert.equal(w.end(), iso(at(30)));
});

/* ── windows counted from the stored end ──────────────────────── */

test("upload window from the export's capped end: open at 59:59, closed at 60:01", async () => {
  const open = world();
  await open.pieceInFlight();
  await open.importAt(33);
  assert.equal((await open.confirmAt(at(60) - 1000)).status, 200, "inside 30 minutes of 30:00");
  const closed = world();
  await closed.pieceInFlight();
  await closed.importAt(33);
  assert.equal((await closed.confirmAt(at(60) + 1000)).body.code, "window_closed", "not 63:00");
});

test("upload window from the export at 12:00: closed at 42:01", async () => {
  const w = world();
  await w.pieceInFlight();
  await w.importAt(12);
  assert.equal((await w.confirmAt(at(42) + 1000)).body.code, "window_closed");
});

test("upload window from the backstop's end: open at 59:59, closed at 60:01 (not 73:00)", async () => {
  const open = world();
  await open.pieceInFlight();
  await open.sweepAt(43);
  assert.equal((await open.confirmAt(at(60) - 1000)).status, 200);
  const closed = world();
  await closed.pieceInFlight();
  await closed.sweepAt(43);
  assert.equal((await closed.confirmAt(at(60) + 1000)).body.code, "window_closed");
});

test("restart wait (no export) from the backstop's end: too soon at 89:59, eligible at 90:01", async () => {
  const w = world();
  await w.sweepAt(43);
  assert.equal(w.restartAt(at(90) - 1000), "too_soon");
  assert.equal(w.restartAt(at(90) + 1000), "eligible", "an hour after 30:00, not after 43:00");
  const sixty = world(3600);
  await sixty.sweepAt(73);
  assert.equal(sixty.restartAt(at(120) - 1000), "too_soon");
  assert.equal(sixty.restartAt(at(120) + 1000), "eligible", "60 minutes: an hour after 60:00");
});
