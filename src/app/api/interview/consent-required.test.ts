/**
 * Async interview consent on the server: upload-url, confirm and submit refuse
 * without a saved agreement to the current text (consent_at with version v2),
 * and the consent route says ok only once the agreement is saved. The session
 * resolver, the database and the bucket are fakes; nothing leaves the machine.
 *
 *   node --test src/app/api/interview/consent-required.test.ts
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
export function answerPath(id, position, ext) { return id + "/q" + position + "." + ext; }
export async function resolveSessionByToken() { return structuredClone(globalThis.__resolved); }`,
  "@/lib/supabase/server": "export function createServiceClient() { return globalThis.__service; }",
  "@/lib/interviews/transcribe-request":
    "export async function requestTranscription() {} export async function cancelSupersededTranscribeJobs() {}",
  "@/lib/interviews/scorecard": "export async function requestScorecard() {}",
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
const { CONSENT_REQUIRED, CONSENT_NOT_SAVED, INTERVIEW_CONSENT_VERSION, asyncConsentGiven } =
  await import("../../../lib/interviews/consent.ts");
const uploadUrl = (await import("./upload-url/route.ts")).POST;
const confirm = (await import("./confirm/route.ts")).POST;
const submit = (await import("./submit/route.ts")).POST;
const consent = (await import("./consent/route.ts")).POST;

const SESSION = "5b0f2c1e-0000-4000-8000-0000000000aa";
const T0 = "2026-10-01T09:00:00.000Z";

/** A session in the shape resolveSessionByToken returns, with its consent fields. */
function world({
  consent_at = null,
  consent_version = null,
  answered = false,
  failUpdate = false,
  ignoreUpdate = false,
} = {}) {
  const row = { id: SESSION, status: "started", kind: "async", consent_at, consent_version };
  const calls = { storage: [], updates: [] };
  const service = fakeService((table, chain) => {
    const update = chain.find((c) => c[0] === "update");
    if (update) {
      calls.updates.push({ table, values: update[1] });
      if (failUpdate) return { data: null, error: { message: "fault" } };
      if (!ignoreUpdate && table === "interview_sessions") {
        // The route's .or() guard: only while not yet agreed to the current text.
        if (!asyncConsentGiven(row) || !("consent_at" in update[1])) Object.assign(row, update[1]);
      }
      return { data: [row], error: null };
    }
    if (table === "interview_sessions") return { data: structuredClone(row), error: null };
    return { data: [], error: null };
  });
  service.storage = {
    from() {
      return {
        async createSignedUploadUrl(path) {
          calls.storage.push(["sign", path]);
          return { data: { signedUrl: `https://storage.test/upload/${path}` }, error: null };
        },
        async list(prefix) {
          calls.storage.push(["list", prefix]);
          return { data: [], error: null };
        },
        async remove() {
          return { data: [], error: null };
        },
      };
    },
  };
  globalThis.__service = service;
  globalThis.__resolved = {
    row,
    session: {
      state: "ready",
      allowRerecord: true,
      questions: [{ position: 1, required: true, answered }],
    },
  };
  return { row, calls };
}

const req = (body) => ({ json: async () => body });
const quiet = async (fn) => {
  const orig = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = orig;
  }
};

const NOT_V2 = [
  { label: "no consent", consent_at: null, consent_version: null },
  { label: "agreed before versions were recorded", consent_at: T0, consent_version: null },
  { label: "agreed to v1", consent_at: T0, consent_version: "v1" },
  { label: "a version with no time", consent_at: null, consent_version: INTERVIEW_CONSENT_VERSION },
];

/* ── the three routes refuse without saved v2 consent ─────────── */

test("upload-url refuses before anything is stored, unless consent to v2 is saved", async () => {
  for (const c of NOT_V2) {
    const w = world(c);
    const res = await uploadUrl(req({ token: `t-${c.label}`, position: 1, kind: "webm" }));
    assert.equal(res.status, 403, c.label);
    assert.equal(res.body.code, CONSENT_REQUIRED, c.label);
    assert.match(res.body.error, /Please agree to the interview terms first\./);
    assert.deepEqual(w.calls.storage, [], `${c.label}: no upload URL signed`);
  }
  const w = world({ consent_at: T0, consent_version: INTERVIEW_CONSENT_VERSION });
  const res = await uploadUrl(req({ token: "t-ok", position: 1, kind: "webm" }));
  assert.equal(res.status, 200);
  assert.match(res.body.url, /^https:\/\/storage\.test\/upload\//);
  assert.equal(w.calls.storage[0][0], "sign");
});

test("confirm refuses before checking storage or writing a row, unless consent to v2 is saved", async () => {
  for (const c of NOT_V2) {
    const w = world(c);
    const res = await confirm(
      req({ token: `t-${c.label}`, position: 1, kind: "webm", duration: 30 }),
    );
    assert.deepEqual([res.status, res.body.code], [403, CONSENT_REQUIRED], c.label);
    assert.deepEqual(
      [w.calls.storage, w.calls.updates],
      [[], []],
      `${c.label}: nothing read or written`,
    );
  }
  // With consent, the gate is passed: the route goes on to look for the object.
  const w = world({ consent_at: T0, consent_version: INTERVIEW_CONSENT_VERSION });
  const res = await confirm(req({ token: "t-ok", position: 1, kind: "webm", duration: 30 }));
  assert.notEqual(res.status, 403);
  assert.deepEqual(w.calls.storage[0], ["list", SESSION]);
});

test("submit refuses before closing the interview, unless consent to v2 is saved", async () => {
  for (const c of NOT_V2) {
    const w = world({ ...c, answered: true });
    const res = await submit(req({ token: `t-${c.label}` }));
    assert.deepEqual([res.status, res.body.code], [403, CONSENT_REQUIRED], c.label);
    assert.deepEqual(w.calls.updates, [], `${c.label}: status not changed`);
  }
  const w = world({ consent_at: T0, consent_version: INTERVIEW_CONSENT_VERSION, answered: true });
  const res = await quiet(() => submit(req({ token: "t-ok" })));
  assert.deepEqual([res.status, res.body.ok], [200, true]);
  assert.equal(w.calls.updates[0].values.status, "submitted");
});

/* ── the consent route says ok only once it is saved ──────────── */

test("consent: saved as v2 and read back, then ok", async () => {
  const w = world();
  const res = await consent(req({ token: "c-new" }));
  assert.deepEqual([res.status, res.body], [200, { ok: true }]);
  assert.equal(w.row.consent_version, INTERVIEW_CONSENT_VERSION);
  assert.ok(w.row.consent_at);
});

test("consent: a failed save answers consent_not_saved, never ok", async () => {
  const w = world({ failUpdate: true });
  const res = await quiet(() => consent(req({ token: "c-fail" })));
  assert.deepEqual([res.status, res.body.code, res.body.ok], [500, CONSENT_NOT_SAVED, undefined]);
  assert.equal(res.body.error, "We couldn't save your agreement. Please try again.");
  assert.equal(w.row.consent_at, null);
  // A write that reports success but does not read back as saved is a failure too.
  const w2 = world({ ignoreUpdate: true });
  const res2 = await quiet(() => consent(req({ token: "c-noop" })));
  assert.deepEqual([res2.status, res2.body.code], [500, CONSENT_NOT_SAVED]);
  assert.equal(w2.row.consent_at, null);
});

test("consent: an older agreement is replaced by the current text and time", async () => {
  for (const version of [null, "v1"]) {
    const w = world({ consent_at: T0, consent_version: version });
    const res = await consent(req({ token: `c-old-${version}` }));
    assert.deepEqual([res.status, res.body], [200, { ok: true }]);
    assert.equal(w.row.consent_version, INTERVIEW_CONSENT_VERSION);
    assert.notEqual(w.row.consent_at, T0, "the old timestamp is replaced");
  }
});

test("an already-consented session is unaffected: no new write, the first time kept, every route open", async () => {
  const w = world({ consent_at: T0, consent_version: INTERVIEW_CONSENT_VERSION, answered: true });
  const res = await consent(req({ token: "c-done" }));
  assert.deepEqual([res.status, res.body], [200, { ok: true }]);
  assert.deepEqual(w.calls.updates, [], "nothing written");
  assert.equal(w.row.consent_at, T0, "the first agreement is kept");
  assert.equal(
    (await uploadUrl(req({ token: "c-done-u", position: 1, kind: "webm" }))).status,
    200,
  );
  assert.notEqual(
    (await confirm(req({ token: "c-done-c", position: 1, kind: "webm" }))).status,
    403,
  );
  assert.equal((await quiet(() => submit(req({ token: "c-done-s" })))).status, 200);
});
