/**
 * #50 (QA-SAFETY-40 C-1): a candidate cannot replace a confirmed answer with
 * an upload link they kept. upload-url and confirm run as shipped; the
 * session resolver, the database and the bucket are fakes. The bucket keeps
 * Supabase's rule for a signed upload link: create only, unless the link was
 * signed upsert. Nothing leaves the machine.
 *
 *   node --test src/app/api/interview/upload-once.test.ts
 *
 * The database half (a link cannot write after submit or delete, and the live
 * window) is migration 066, proven on staging by scripts/staging/proofs-066.mjs.
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
const { answerPath: realAnswerPath } = await import("../../../lib/interviews/session.ts");
const uploadUrl = (await import("./upload-url/route.ts")).POST;
const confirm = (await import("./confirm/route.ts")).POST;

const SESSION = "5b0f2c1e-0000-4000-8000-0000000000aa";
const RELOAD = "Please reload this page to record this answer again.";
const WEBM = [0x1a, 0x45, 0xdf, 0xa3];

/** One interview: an open async session, its answers table and its bucket. */
function world({ allowRerecord = true } = {}) {
  const objects = new Map(); // path -> { bytes }
  const answers = []; // { session_id, position, video_path, id, recorded_at }
  const removed = [];
  const signed = [];
  let n = 0;
  const service = fakeService((table, chain) => {
    if (table === "interview_answers") {
      const upsert = chain.find((c) => c[0] === "upsert");
      if (upsert) {
        const row = upsert[1];
        const at = answers.findIndex(
          (a) => a.session_id === row.session_id && a.position === row.position,
        );
        const saved = { ...row, id: `ans-${row.position}`, recorded_at: `t${++n}` };
        if (at >= 0) answers[at] = saved;
        else answers.push(saved);
        return { data: { id: saved.id, recorded_at: saved.recorded_at }, error: null };
      }
      const eq = Object.fromEntries(chain.filter((c) => c[0] === "eq").map((c) => [c[1], c[2]]));
      const row = answers.find((a) => a.session_id === eq.session_id && a.position === eq.position);
      return { data: row ? { video_path: row.video_path } : null, error: null };
    }
    if (chain.some((c) => c[0] === "update")) return { data: [], error: null };
    return { data: [], error: null };
  });
  service.storage = {
    from() {
      return {
        async createSignedUploadUrl(path, opts = {}) {
          signed.push({ path, upsert: opts.upsert === true });
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
          for (const p of paths) {
            removed.push(p);
            objects.delete(p);
          }
          return { data: [], error: null };
        },
      };
    },
  };
  globalThis.__service = service;
  const resolved = (answered) => ({
    row: {
      id: SESSION,
      status: "started",
      kind: "async",
      consent_at: "2026-10-01T09:00:00.000Z",
      consent_version: INTERVIEW_CONSENT_VERSION,
    },
    session: {
      state: "ready",
      allowRerecord,
      questions: [{ id: "q-1", question: "Q1", position: 1, required: true, answered }],
    },
  });
  globalThis.__resolved = resolved(false);
  // The bucket's own answer to a PUT on a signed link: create only unless upsert.
  const put = (url, marker) => {
    const u = new URL(url);
    const path = decodeURIComponent(u.pathname.replace("/upload/", ""));
    if (objects.has(path) && u.searchParams.get("upsert") !== "true") return 409;
    objects.set(path, { bytes: [...WEBM, ...new TextEncoder().encode(marker)] });
    return 200;
  };
  return {
    objects,
    answers,
    removed,
    signed,
    put,
    setAnswered: (a) => {
      globalThis.__resolved = resolved(a);
    },
  };
}

// confirm reads the first 16 bytes of the stored file through a signed URL.
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  const u = String(url);
  if (!u.startsWith("https://storage.test/read/")) return realFetch(url);
  const path = decodeURIComponent(u.replace("https://storage.test/read/", ""));
  const o = globalThis.__objects?.get(path);
  return o
    ? { ok: true, status: 206, arrayBuffer: async () => new Uint8Array(o.bytes).buffer }
    : { ok: false, status: 404 };
};

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

/** What the page does now: a keyed link, the PUT, then confirm with the key. */
async function record(w, marker, { keyed = true, kind = "webm" } = {}) {
  globalThis.__objects = w.objects;
  const minted = await uploadUrl(
    req({ token: "t", position: 1, kind, ...(keyed ? { keyed } : {}) }),
  );
  if (minted.status !== 200) return { minted };
  const putStatus = w.put(minted.body.url, marker);
  const confirmed = await quiet(() =>
    confirm(req({ token: "t", position: 1, kind, duration: 5, upload: minted.body.upload })),
  );
  if (confirmed.status === 200) w.setAnswered(true);
  return { minted, putStatus, confirmed };
}
const stored = (w) => {
  const path = w.answers.find((a) => a.position === 1)?.video_path;
  const o = path && w.objects.get(path);
  return o ? new TextDecoder().decode(new Uint8Array(o.bytes.slice(4))) : null;
};

test("50-1. every link is create-only (upsert false) and for its own key", async () => {
  const w = world();
  const a = await record(w, "FIRST");
  const b = await record(w, "SECOND");
  assert.equal(a.confirmed.status, 200);
  assert.equal(b.confirmed.status, 200);
  assert.ok(
    w.signed.every((s) => s.upsert === false),
    "no link may replace a file",
  );
  assert.match(w.signed[0].path, new RegExp(`^${SESSION}/q1-[0-9a-f]{32}\\.webm$`));
  assert.notEqual(w.signed[0].path, w.signed[1].path, "a re-record is a new key");
  assert.match(a.minted.body.upload, /^[0-9a-f]{32}$/);
});

test("50-2. a SAVED link cannot replace the confirmed answer: the PUT is refused, the stored bytes stay", async () => {
  const w = world();
  const first = await record(w, "FIRST");
  assert.equal(stored(w), "FIRST");
  assert.equal(w.put(first.minted.body.url, "REPLACED"), 409);
  assert.equal(stored(w), "FIRST");
});

test("50-3. re-record: the answer points at the new file and the previous one is removed", async () => {
  const w = world();
  const first = await record(w, "FIRST");
  const firstPath = w.answers[0].video_path;
  const second = await record(w, "SECOND");
  assert.equal(second.confirmed.status, 200);
  assert.equal(stored(w), "SECOND");
  assert.deepEqual(w.removed, [firstPath]);
  assert.ok(!w.objects.has(firstPath));
  // The first link, saved, still cannot write: its key's file was removed, so
  // a PUT would recreate an UNREFERENCED file (the answer points elsewhere),
  // which 066 refuses after submit and the orphan sweep removes before.
  assert.equal(w.answers.length, 1);
  assert.ok(first.minted.body.url);
});

test("50-4. after a re-record, the first link's PUT never changes what is played", async () => {
  const w = world();
  const first = await record(w, "FIRST");
  await record(w, "SECOND");
  w.put(first.minted.body.url, "SNEAKY");
  assert.equal(stored(w), "SECOND", "the answer still plays the confirmed re-record");
});

test("50-5. confirm rebuilds the path from the key: a key that was not handed out finds no file", async () => {
  const w = world();
  globalThis.__objects = w.objects;
  const minted = await uploadUrl(req({ token: "t", position: 1, kind: "webm", keyed: true }));
  w.put(minted.body.url, "FIRST");
  const other = "0".repeat(32);
  const r = await quiet(() =>
    confirm(req({ token: "t", position: 1, kind: "webm", duration: 5, upload: other })),
  );
  assert.equal(r.status, 404);
  assert.equal(w.answers.length, 0);
});

test("50-6. a key that is not 32 lowercase hex never reaches a path", async () => {
  const w = world();
  globalThis.__objects = w.objects;
  for (const upload of ["../q2", "ABCDEF0123456789ABCDEF0123456789", "abc", 12, ""]) {
    const r = await quiet(() =>
      confirm(req({ token: "t", position: 1, kind: "webm", duration: 5, upload })),
    );
    assert.deepEqual([r.status, r.body.error], [400, "Bad request."], String(upload));
  }
  assert.equal(w.answers.length, 0);
});

test("50-7. an OLD tab (no key): its first upload works, at the fixed path, create only", async () => {
  const w = world();
  const r = await record(w, "FIRST", { keyed: false });
  assert.equal(r.confirmed.status, 200);
  assert.equal(w.signed[0].path, `${SESSION}/q1.webm`);
  assert.equal(w.signed[0].upsert, false);
  assert.equal(r.minted.body.upload, undefined);
  assert.equal(stored(w), "FIRST");
});

test("50-8. an OLD tab cannot re-record: refused at upload-url and at confirm, with a reload message", async () => {
  const w = world();
  await record(w, "FIRST", { keyed: false });
  const again = await uploadUrl(req({ token: "t", position: 1, kind: "webm" }));
  assert.deepEqual([again.status, again.body.error], [409, RELOAD]);
  // A file in the other container, PUT through some older link: confirm refuses it.
  w.objects.set(`${SESSION}/q1.mp4`, { bytes: [...WEBM, 1, 2, 3] });
  const r = await quiet(() => confirm(req({ token: "t", position: 1, kind: "mp4", duration: 5 })));
  assert.deepEqual([r.status, r.body.error], [409, RELOAD]);
  assert.equal(stored(w), "FIRST");
});

test("50-9. an OLD tab may confirm the SAME first answer again (a lost response)", async () => {
  const w = world();
  await record(w, "FIRST", { keyed: false });
  const r = await quiet(() => confirm(req({ token: "t", position: 1, kind: "webm", duration: 5 })));
  assert.equal(r.status, 200);
  assert.equal(w.answers.length, 1);
  assert.deepEqual(w.removed, [], "its own file is never removed");
});

test("50-10. an old answer at the fixed path is replaced by a keyed re-record, and the fixed file removed", async () => {
  const w = world();
  await record(w, "FIRST", { keyed: false });
  await record(w, "SECOND");
  assert.equal(stored(w), "SECOND");
  assert.deepEqual(w.removed, [`${SESSION}/q1.webm`]);
});

test("50-11. re-record not allowed: refused before any link is minted, keyed or not", async () => {
  const w = world({ allowRerecord: false });
  await record(w, "FIRST");
  const before = w.signed.length;
  const r = await uploadUrl(req({ token: "t", position: 1, kind: "webm", keyed: true }));
  assert.equal(r.status, 409);
  assert.equal(w.signed.length, before);
});

test("50-12. the real answerPath matches the one these tests use", () => {
  assert.equal(typeof realAnswerPath, "function", "the real module loaded");
  assert.equal(realAnswerPath("s", 1, "webm"), "s/q1.webm");
  assert.equal(realAnswerPath("s", 1, "webm", "a".repeat(32)), `s/q1-${"a".repeat(32)}.webm`);
});

test("50-13. the page sends keyed and hands the key back to confirm", async () => {
  const fs = await import("node:fs");
  const flow = fs.readFileSync(
    new URL("../../interview/[token]/_flow.tsx", import.meta.url),
    "utf8",
  );
  assert.match(flow, /JSON\.stringify\(\{ token, position, kind, keyed: true \}\)/);
  assert.match(flow, /JSON\.stringify\(\{ token, position, duration: seconds, kind, upload \}\)/);
});

test("50-14. migration 066's live window is the live recorder's own: 30 minutes, both places", async () => {
  const fs = await import("node:fs");
  const sql = fs.readFileSync(
    new URL(
      "../../../lib/supabase/migrations/066_interview_upload_open_session_only.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const live = fs.readFileSync(
    new URL("../../../lib/interviews/live-video.ts", import.meta.url),
    "utf8",
  );
  assert.match(live, /export const UPLOAD_WINDOW_MS = 30 \* 60_000;/);
  assert.match(sql, /s\.live_ended_at \+ interval '30 minutes'/);
  // The grace window is in the v (live piece) branch only: the q branch has none.
  const qBranch = sql.slice(sql.indexOf("-- async answer:"), sql.indexOf("-- live piece:"));
  assert.ok(!/interval/.test(qBranch), "no grace for async answers");
});
