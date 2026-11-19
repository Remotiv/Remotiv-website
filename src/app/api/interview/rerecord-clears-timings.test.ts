/**
 * #27b: a re-recorded answer never shows the previous recording's timings.
 *
 *   node --test src/app/api/interview/rerecord-clears-timings.test.ts
 *
 * The confirm route runs as shipped. The answers table is a fake that applies
 * an upsert the way Postgres's ON CONFLICT DO UPDATE does: only the columns
 * the statement names change, everything else on the row stays. That is the
 * behaviour that let the old timings survive. Synthetic data only.
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../../test-support/node-resolve.mjs", import.meta.url));
const STUBS = {
  "server-only": "export {};",
  "next/server": `export const NextResponse = {
  json(body, init) { return { status: init?.status ?? 200, body }; },
};`,
  "@/app/api/_lib/rate-limit": "export function rateLimitByKey() { return { ok: true }; }",
  "@/lib/interviews/session": `
export const INTERVIEW_BUCKET = "interview-videos";
export const INTERVIEW_MAX_BYTES = 1e9;
export function answerPath(sessionId, position, ext, uploadKey) {
  return sessionId + "/q" + position + (uploadKey ? "-" + uploadKey : "") + "." + ext;
}
export async function resolveSessionByToken() { return structuredClone(globalThis.__resolved); }`,
  "@/lib/supabase/server": "export function createServiceClient() { return globalThis.__service; }",
  "@/lib/interviews/transcribe-request":
    "export async function requestTranscription() { return { ok: true }; } export async function cancelSupersededTranscribeJobs() {}",
};
register(
  `data:text/javascript,${encodeURIComponent(`
const STUBS = ${JSON.stringify(STUBS)};
export async function resolve(specifier, context, next) {
  const stub = STUBS[specifier];
  if (stub !== undefined) return { url: "data:text/javascript," + encodeURIComponent(stub), shortCircuit: true };
  return next(specifier, context);
}`)}`,
);

const { fakeService } = await import("../../../test-support/fake-postgrest.mjs");
const { INTERVIEW_CONSENT_VERSION } = await import("../../../lib/interviews/consent.ts");
const confirm = (await import("./confirm/route.ts")).POST;

const SESSION = "5b0f2c1e-0000-4000-8000-0000000000bb";
const KEY = "0123456789abcdef0123456789abcdef";
const NEW_PATH = `${SESSION}/q1-${KEY}.webm`;
const OLD_PATH = `${SESSION}/q1-ffffffffffffffffffffffffffffffff.webm`;
const WEBM = [0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

/** The first recording, transcribed: its timings are on the row. */
const firstRecording = () => ({
  id: "ans-1",
  session_id: SESSION,
  position: 1,
  question_id: "q-1",
  question_text: "Q1",
  video_path: OLD_PATH,
  duration_seconds: 41,
  transcript: "The first recording's words.",
  transcript_status: "done",
  transcript_error: null,
  transcript_segments: [
    { start: 0, end: 3.2, text: "The first" },
    { start: 3.2, end: 6.9, text: "recording's words." },
  ],
  transcript_duration_seconds: 40.6,
  recorded_at: "2026-11-19T10:00:00.000Z",
});

function world() {
  const answers = [firstRecording()];
  const service = fakeService((table, chain) => {
    if (table === "interview_answers") {
      const upsert = chain.find((c) => c[0] === "upsert");
      if (upsert) {
        const row = upsert[1];
        const at = answers.findIndex(
          (a) => a.session_id === row.session_id && a.position === row.position,
        );
        // ON CONFLICT DO UPDATE: only the named columns change.
        const merged = { ...(at >= 0 ? answers[at] : { id: "ans-new" }), ...row };
        merged.recorded_at = "2026-11-19T11:00:00.000Z";
        if (at >= 0) answers[at] = merged;
        else answers.push(merged);
        return { data: { id: merged.id, recorded_at: merged.recorded_at }, error: null };
      }
      const row = answers[0];
      return { data: row ? { video_path: row.video_path } : null, error: null };
    }
    return { data: [], error: null };
  });
  service.storage = {
    from() {
      return {
        async list(prefix, { search }) {
          return {
            data:
              `${prefix}/${search}` === NEW_PATH
                ? [{ name: search, metadata: { size: 1000, mimetype: "video/webm" } }]
                : [],
            error: null,
          };
        },
        async createSignedUrl(path) {
          return { data: { signedUrl: `https://storage.test/read/${path}` }, error: null };
        },
        async remove() {
          return { data: [], error: null };
        },
      };
    },
  };
  globalThis.__service = service;
  globalThis.__resolved = {
    row: {
      id: SESSION,
      status: "started",
      kind: "async",
      consent_at: "2026-10-01T09:00:00.000Z",
      consent_version: INTERVIEW_CONSENT_VERSION,
    },
    session: {
      state: "ready",
      allowRerecord: true,
      questions: [{ id: "q-1", question: "Q1", position: 1, required: true, answered: true }],
    },
  };
  return answers;
}

const realFetch = globalThis.fetch;
globalThis.fetch = async (url) =>
  String(url).startsWith("https://storage.test/read/")
    ? { ok: true, status: 206, arrayBuffer: async () => new Uint8Array(WEBM).buffer }
    : realFetch(url);

// Negative control: drop the two nulls from the confirm route's upsert and the
// old recording's segments and transcript length stay on the row.
test("a re-record replaces every per-recording field; none of the old recording's timings remain", async () => {
  const answers = world();
  const res = await confirm({
    json: async () => ({ token: "t", position: 1, kind: "webm", duration: 7, upload: KEY }),
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const row = answers[0];
  assert.equal(row.video_path, NEW_PATH);
  assert.equal(row.duration_seconds, 7);
  assert.equal(row.recorded_at, "2026-11-19T11:00:00.000Z");
  assert.equal(row.transcript_status, "pending");
  assert.equal(row.transcript, null);
  assert.equal(row.transcript_error, null);
  assert.equal(row.transcript_segments, null, "old word timings");
  assert.equal(row.transcript_duration_seconds, null, "old transcript length");
  assert.equal(answers.length, 1);
});
