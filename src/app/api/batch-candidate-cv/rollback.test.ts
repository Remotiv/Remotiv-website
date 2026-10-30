/**
 * POST /api/batch-candidate-cv: when the batch candidate row is not saved, the
 * CV this request uploaded is removed (CV-LEAKS #7). The route runs as shipped;
 * the admin guard, the rate limit, NextResponse and the database
 * (fake-live-db.mjs) are fakes.
 *
 *   node --test src/app/api/batch-candidate-cv/rollback.test.ts
 */
// @ts-nocheck - same reason as overview-counts.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../../test-support/node-resolve.mjs", import.meta.url));
register(
  `data:text/javascript,${encodeURIComponent(`
const STUBS = {
  "server-only": "",
  "next/server":
    "export class NextRequest {} export const NextResponse = { json: (body, init = {}) => ({ body, status: init.status ?? 200 }) };",
  "@/lib/supabase/server": "export const createServiceClient = () => globalThis.__batchCvService;",
  "@/app/api/_lib/rate-limit": "export function rateLimit() { return { ok: true }; }",
  "@/app/admin/lib/role-guards": "export async function requireAdmin() {}",
};
export async function resolve(specifier, context, next) {
  if (specifier in STUBS) return { url: "data:text/javascript," + encodeURIComponent(STUBS[specifier]), shortCircuit: true };
  return next(specifier, context);
}`)}`,
);

const { POST } = await import("./route.ts");
const { fakeLiveDb } = await import("../../../test-support/fake-live-db.mjs");

const BATCH = "00000000-0000-4000-8000-0000000000b1";
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]);
/** A file some existing row already names: never this request's to remove. */
const EXISTING = `batch/${BATCH}/00000000-0000-4000-8000-0000000000e1.pdf`;

/**
 * An empty batch, one existing CV in the bucket, and a record of storage
 * remove() calls. remove() answers only after a timer, so a rollback the route
 * does not await has not happened yet when the response comes back.
 */
function world() {
  const w = fakeLiveDb({ client_batch_candidates: [], talent_profiles: [] });
  w.objects.set(EXISTING, { bytes: PDF, contentType: "application/pdf", createdAt: Date.now() });
  w.removeCalls = [];
  const from = w.service.storage.from.bind(w.service.storage);
  w.service.storage.from = (bucket) => {
    const b = from(bucket);
    return {
      ...b,
      remove: async (paths) => {
        w.removeCalls.push(paths);
        await new Promise((r) => setTimeout(r, 20));
        return w.removeFails ? { data: null, error: { message: "denied" } } : b.remove(paths);
      },
    };
  };
  globalThis.__batchCvService = w.service;
  return w;
}

function request() {
  const fd = new FormData();
  fd.set("batch_id", BATCH);
  fd.set("first_name", "Test");
  fd.set("email", "candidate@example.test");
  fd.set("linkedin_url", "https://www.linkedin.com/in/test-candidate");
  fd.set("cv", new File([PDF], "cv.pdf", { type: "application/pdf" }));
  return { formData: async () => fd };
}

/** Uploaded objects other than the existing one. */
const fresh = (w) => [...w.objects.keys()].filter((k) => k !== EXISTING);

/** console.error lines while `fn` runs. */
async function errorsDuring(fn) {
  const lines = [];
  const original = console.error;
  console.error = (...args) => lines.push(args.map(String).join(" "));
  try {
    return { result: await fn(), lines };
  } finally {
    console.error = original;
  }
}

test("a: insert fails -> the new file is removed, the same error response as before", async () => {
  const w = world();
  w.failNext("client_batch_candidates", "insert");
  const { result, lines } = await errorsDuring(() => POST(request()));
  assert.deepEqual(result, { body: { error: "fault" }, status: 500 });
  assert.equal(w.counts.uploads, 1, "it was uploaded");
  assert.deepEqual(fresh(w), [], "and removed again");
  assert.equal(w.removeCalls.length, 1);
  assert.match(w.removeCalls[0][0], new RegExp(`^batch/${BATCH}/`));
  assert.ok(w.objects.has(EXISTING), "an existing row's file is never touched");
  assert.deepEqual(lines, [], "a confirmed rollback logs nothing");
});

test("a2: a step after the upload throws -> the new file is removed, the same 500 as before", async () => {
  const w = world();
  const from = w.service.from.bind(w.service);
  w.service.from = (table) => {
    const q = from(table);
    if (table !== "client_batch_candidates") return q;
    return new Proxy(q, {
      get: (target, prop) =>
        prop === "insert"
          ? () => {
              throw new Error("connection reset");
            }
          : target[prop],
    });
  };
  const result = await POST(request());
  assert.deepEqual(result, { body: { error: "connection reset" }, status: 500 });
  assert.equal(w.counts.uploads, 1);
  assert.deepEqual(fresh(w), []);
  assert.ok(w.objects.has(EXISTING));
});

test("b: insert succeeds -> the file is kept and the row names it", async () => {
  const w = world();
  const result = await POST(request());
  assert.equal(result.status, 200);
  assert.equal(result.body.success, true);
  const [path] = fresh(w);
  assert.ok(path, "kept");
  assert.equal(w.tables.client_batch_candidates.length, 1);
  assert.equal(w.tables.client_batch_candidates[0].cv_path, path);
  assert.deepEqual(w.removeCalls, [], "nothing removed");
});

test("c: the rollback remove fails -> the same error response, one log line with no path or id", async () => {
  const w = world();
  w.failNext("client_batch_candidates", "insert");
  w.removeFails = true;
  const { result, lines } = await errorsDuring(() => POST(request()));
  assert.deepEqual(result, { body: { error: "fault" }, status: 500 });
  assert.equal(fresh(w).length, 1, "left for the orphan sweep");
  assert.equal(lines.length, 1);
  assert.match(lines[0], /rollback of the uploaded CV failed: 1 file left for the orphan sweep/);
  assert.doesNotMatch(lines[0], /batch\/|\.pdf|[0-9a-f]{8}-[0-9a-f]{4}/);
});

test("d: the upload itself fails -> no remove attempted, the same response", async () => {
  const w = world();
  w.failNext("storage", "upload");
  const result = await POST(request());
  assert.deepEqual(result, { body: { error: "fault" }, status: 500 });
  assert.deepEqual(w.removeCalls, [], "no remove");
  assert.deepEqual(fresh(w), []);
  assert.equal(w.tables.client_batch_candidates.length, 0, "no row");
});
