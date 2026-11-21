/**
 * #57 slice 1: what an async candidate's answer goes through when upload-url
 * or confirm answers 429. The recording stays on the page, the page tries
 * again, the answer is saved once, with the bytes that were recorded.
 *
 *   node --test "src/app/api/interview/interview-limits-429-async.test.ts"
 *
 * upload-url and confirm run as shipped with the real limiter and the real
 * limits (memory store: no Redis is configured here). The session resolver,
 * the database and the bucket are upload-once.test.ts's fakes. The page's
 * upload steps (_flow.tsx uploadAnswer and attemptUpload) live inside a React
 * component this repo cannot run without a DOM, so `pageUpload` below replays
 * them step for step, and the facts it relies on are pinned in _flow.tsx's
 * source: a 429 is retryable, 3 automatic tries 3 s and 8 s apart, a fresh
 * upload key per try, and the recording is let go only once it is saved or
 * the candidate presses Start over. Synthetic data only.
 */
// @ts-nocheck - same reason as upload-once.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";

import { blockNetwork } from "../../../test-support/no-network.mjs";

const guard = blockNetwork();
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
delete process.env.KV_REST_API_URL;
delete process.env.KV_REST_API_TOKEN;

register(new URL("../../../test-support/node-resolve.mjs", import.meta.url));
const STUBS = {
  "server-only": "export {};",
  "next/server": `export const NextResponse = {
  json(body, init) { return { status: init?.status ?? 200, body }; },
};`,
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

const realNow = Date.now;
let clockNow = Date.parse("2026-11-21T09:00:10.000Z");
Date.now = () => clockNow;
const errors = [];
const realError = console.error;
console.error = (...a) => errors.push(a.join(" "));

const { fakeService } = await import("../../../test-support/fake-postgrest.mjs");
const { INTERVIEW_CONSENT_VERSION } = await import("../../../lib/interviews/consent.ts");
const { limitInterview } = await import("./_lib/limits.ts");
const uploadUrl = (await import("./upload-url/route.ts")).POST;
const confirm = (await import("./confirm/route.ts")).POST;

const SESSION = "5b0f2c1e-0000-4000-8000-0000000000c7";
const WEBM = [0x1a, 0x45, 0xdf, 0xa3];
const SEC = 1_000;

/** One open async session: its answers, its bucket, and every write counted. */
function world(token) {
  const objects = new Map();
  const answers = [];
  const signed = [];
  let upserts = 0;
  const service = fakeService((table, chain) => {
    if (table === "interview_answers") {
      const upsert = chain.find((c) => c[0] === "upsert");
      if (upsert) {
        upserts++;
        const row = upsert[1];
        const at = answers.findIndex(
          (a) => a.session_id === row.session_id && a.position === row.position,
        );
        const saved = { ...row, id: `ans-${row.position}`, recorded_at: `t${upserts}` };
        if (at >= 0) answers[at] = saved;
        else answers.push(saved);
        return { data: { id: saved.id, recorded_at: saved.recorded_at }, error: null };
      }
      const eq = Object.fromEntries(chain.filter((c) => c[0] === "eq").map((c) => [c[1], c[2]]));
      const row = answers.find((a) => a.session_id === eq.session_id && a.position === eq.position);
      return { data: row ? { video_path: row.video_path } : null, error: null };
    }
    return { data: [], error: null };
  });
  service.storage = {
    from() {
      return {
        async createSignedUploadUrl(path, opts = {}) {
          signed.push(path);
          return {
            data: {
              signedUrl: `https://storage.test/upload/${path}?upsert=${opts.upsert === true}`,
            },
            error: null,
          };
        },
        async list(prefix, { search }) {
          return {
            data: [...objects.entries()]
              .filter(([p]) => p.startsWith(`${prefix}/`) && p.slice(prefix.length + 1) === search)
              .map(([p, o]) => ({
                name: p.slice(prefix.length + 1),
                metadata: { size: o.bytes.length, mimetype: "video/webm" },
              })),
            error: null,
          };
        },
        async createSignedUrl(path) {
          return { data: { signedUrl: `https://storage.test/read/${path}` }, error: null };
        },
        async remove(paths) {
          for (const p of paths) objects.delete(p);
          return { data: [], error: null };
        },
      };
    },
  };
  globalThis.__service = service;
  globalThis.__objects = objects;
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
      questions: [{ id: "q-1", question: "Q1", position: 1, required: true, answered: false }],
    },
  };
  const put = (url, bytes) => {
    const u = new URL(url);
    const path = decodeURIComponent(u.pathname.replace("/upload/", ""));
    if (objects.has(path) && u.searchParams.get("upsert") !== "true") return 409;
    objects.set(path, { bytes });
    return 200;
  };
  return { token, objects, answers, signed, put, upserts: () => upserts };
}

// confirm reads the first 16 bytes of the stored file through a signed URL.
globalThis.fetch = async (url) => {
  const path = decodeURIComponent(String(url).replace("https://storage.test/read/", ""));
  const o = globalThis.__objects?.get(path);
  return o
    ? { ok: true, status: 206, arrayBuffer: async () => new Uint8Array(o.bytes).buffer }
    : { ok: false, status: 404 };
};

const req = (body) => ({ json: async () => body });

/** _flow.tsx uploadAnswer: a keyed link, the PUT, then confirm with the key. */
async function uploadAnswer(w, bytes) {
  const minted = await uploadUrl(req({ token: w.token, position: 1, kind: "webm", keyed: true }));
  if (minted.status !== 200) {
    return {
      ok: false,
      retryable: minted.status === 429 || minted.status >= 500,
      status: minted.status,
      error: minted.body.error,
    };
  }
  if (w.put(minted.body.url, bytes) !== 200) return { ok: false, retryable: true, error: "put" };
  const confirmed = await confirm(
    req({ token: w.token, position: 1, kind: "webm", duration: 5, upload: minted.body.upload }),
  );
  if (confirmed.status !== 200) {
    return {
      ok: false,
      retryable: confirmed.status === 429 || confirmed.status >= 500,
      status: confirmed.status,
      error: confirmed.body.error,
    };
  }
  return { ok: true };
}

/** _flow.tsx attemptUpload: 3 tries, 3 s then 8 s apart, a non-retryable answer stops early. */
async function attemptUpload(w, bytes) {
  const tries = [];
  for (let attempt = 1; attempt <= 3; attempt++) {
    const r = await uploadAnswer(w, bytes);
    tries.push({ at: clockNow, ...r });
    if (r.ok) return { outcome: "ok", tries };
    if (!r.retryable) break;
    if (attempt < 3) clockNow += [3 * SEC, 8 * SEC][attempt - 1];
  }
  return { outcome: "failed", tries };
}

/** Spend a route's whole minute for this token, as a burst before the answer would. */
function spend(route, token) {
  while (limitInterview(route, token).ok);
}

const stored = (w) => {
  const path = w.answers.find((a) => a.position === 1)?.video_path;
  return path ? w.objects.get(path)?.bytes : undefined;
};

test("the page's upload steps that these tests replay are the shipped ones", () => {
  const src = readFileSync(new URL("../../interview/[token]/_flow.tsx", import.meta.url), "utf8");
  assert.match(src, /const UPLOAD_AUTO_ATTEMPTS = 3;/);
  assert.match(src, /const UPLOAD_BACKOFF_MS = \[3_000, 8_000\];/);
  assert.match(
    src,
    /const retryableStatus = \(status: number\) => status === 429 \|\| status >= 500;/,
  );
  assert.match(src, /body: JSON\.stringify\(\{ token, position, kind, keyed: true \}\)/);
  assert.match(
    src,
    /body: JSON\.stringify\(\{ token, position, duration: seconds, kind, upload \}\)/,
  );
  // The recording is held before the first try and let go in two places only:
  // commitAnswer (saved) and Start over (the candidate's explicit choice).
  assert.match(
    src,
    /pendingRef\.current = \{ blob, position: question\.position, seconds, index: qi \};/,
  );
  assert.equal(src.match(/pendingRef\.current = null;/g).length, 2);
  assert.match(
    src,
    /const commitAnswer = useCallback\(\(index: number, seconds: number\) => \{\s*pendingRef\.current = null;/,
  );
  assert.match(
    src,
    /Discarding the held recording is the explicit cost of this\s*\/\/ button, and the only place it is ever thrown away\.\s*pendingRef\.current = null;/,
  );
  // Retry upload sends the SAME held recording again.
  assert.match(
    src,
    /const pending = pendingRef\.current;\s*if \(!pending\) return;[\s\S]{0,120}attemptUpload\(pending\.blob, pending\.position, pending\.seconds\)/,
  );
});

test("upload-url 429: nothing is minted or written, the 3 tries fail, Retry after the minute saves the same recording once", async () => {
  const w = world(`tok-upload-${"u".repeat(60)}`);
  const recording = [...WEBM, ...new TextEncoder().encode("ANSWER-ONE")];
  clockNow = Date.parse("2026-11-21T09:00:10.000Z");
  spend("interview-upload-url", w.token);

  const auto = await attemptUpload(w, recording);
  assert.equal(auto.outcome, "failed");
  assert.deepEqual(
    auto.tries.map((t) => t.status),
    [429, 429, 429],
  );
  assert.deepEqual(
    auto.tries.map((t) => t.at - auto.tries[0].at),
    [0, 3 * SEC, 11 * SEC],
  );
  assert.match(auto.tries[2].error, /^Too many uploads\. Try again in \d+s\.$/);
  assert.equal(w.signed.length, 0, "no upload link minted");
  assert.equal(w.objects.size, 0, "nothing stored");
  assert.equal(w.upserts(), 0, "no answer written");

  // The candidate presses Retry upload once the minute has passed.
  clockNow = Date.parse("2026-11-21T09:01:01.000Z");
  const retry = await attemptUpload(w, recording);
  assert.equal(retry.outcome, "ok");
  assert.equal(retry.tries.length, 1);
  assert.equal(w.upserts(), 1, "confirmed exactly once");
  assert.deepEqual(stored(w), recording, "the saved answer is the recording, byte for byte");
});

test("confirm 429 after the upload: the 3 tries fail, Retry after the minute confirms once with the same recording", async () => {
  const w = world(`tok-confirm-${"c".repeat(60)}`);
  const recording = [...WEBM, ...new TextEncoder().encode("ANSWER-TWO")];
  clockNow = Date.parse("2026-11-21T09:10:10.000Z");
  spend("interview-confirm", w.token);

  const auto = await attemptUpload(w, recording);
  assert.equal(auto.outcome, "failed");
  assert.deepEqual(
    auto.tries.map((t) => t.status),
    [429, 429, 429],
  );
  assert.equal(w.upserts(), 0, "a refused confirm writes nothing");
  assert.equal(w.answers.length, 0);
  assert.equal(w.objects.size, 3, "each try stored its own keyed object; none is referenced yet");

  clockNow = Date.parse("2026-11-21T09:11:01.000Z");
  const retry = await attemptUpload(w, recording);
  assert.equal(retry.outcome, "ok");
  assert.equal(w.upserts(), 1, "confirmed exactly once");
  assert.equal(w.answers.length, 1);
  assert.deepEqual(stored(w), recording, "the saved answer is the recording, byte for byte");
  assert.equal(
    w.objects.size,
    4,
    "the three refused tries' objects stay unreferenced in the bucket",
  );
});

test("a Retry pressed inside the same minute is refused again and still loses nothing", async () => {
  const w = world(`tok-early-${"e".repeat(60)}`);
  const recording = [...WEBM, ...new TextEncoder().encode("ANSWER-THREE")];
  clockNow = Date.parse("2026-11-21T09:20:05.000Z");
  spend("interview-upload-url", w.token);
  assert.equal((await attemptUpload(w, recording)).outcome, "failed");
  clockNow = Date.parse("2026-11-21T09:20:40.000Z");
  assert.equal((await attemptUpload(w, recording)).outcome, "failed", "still the same minute");
  assert.equal(w.upserts(), 0);
  clockNow = Date.parse("2026-11-21T09:21:00.500Z");
  assert.equal((await attemptUpload(w, recording)).outcome, "ok");
  assert.equal(w.upserts(), 1);
  assert.deepEqual(stored(w), recording);
});

test("both routes refuse before reading the session or touching the database", () => {
  for (const [dir, route] of [
    ["upload-url", "interview-upload-url"],
    ["confirm", "interview-confirm"],
  ]) {
    const src = readFileSync(new URL(`./${dir}/route.ts`, import.meta.url), "utf8");
    const limit = src.indexOf(`limitInterview("${route}", token)`);
    assert.ok(limit > 0, dir);
    for (const later of ["resolveSessionByToken(token)", "createServiceClient()"]) {
      assert.ok(src.indexOf(later) > limit, `${dir}: ${later} comes after the limit`);
    }
  }
});

test("teardown", () => {
  Date.now = realNow;
  console.error = realError;
  clearInterval(globalThis.__rateLimitCleanup);
  guard.assertNoNetwork();
});
