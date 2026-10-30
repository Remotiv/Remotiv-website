/**
 * A talent or remote profile replacing or removing its own CV (uploadCv,
 * removeCv) never deletes a file another row still names. The actions run as
 * shipped; the session, the cache and the database (fake-live-db.mjs) are fakes.
 *
 *   node --test "src/app/talent/(authed)/dashboard/edit/cv-release.test.ts"
 */
// @ts-nocheck - same reason as overview-counts.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../../../../test-support/node-resolve.mjs", import.meta.url));
register(
  `data:text/javascript,${encodeURIComponent(`
const STUBS = {
  "server-only": "",
  "next/cache": "export function revalidatePath() {}",
  "@/lib/supabase/server":
    "export const createServiceClient = () => globalThis.__cvReleaseService; export const createClient = async () => ({});",
  "@/app/talent/lib/profile-owner":
    "export async function requireProfileOwner() { return { userId: 'u1', email: 'owner@example.test' }; }",
};
export async function resolve(specifier, context, next) {
  if (specifier in STUBS) return { url: "data:text/javascript," + encodeURIComponent(STUBS[specifier]), shortCircuit: true };
  return next(specifier, context);
}`)}`,
);

const { uploadCv, removeCv } = await import("./actions.ts");
const { fakeLiveDb } = await import("../../../../../test-support/fake-live-db.mjs");

const PROFILE = "00000000-0000-4000-8000-000000000001";
const REMOTE = "00000000-0000-4000-8000-000000000002";
const OLD = "talent/cvs/00000000-0000-4000-8000-0000000000aa.pdf";
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]);

/** One talent profile holding OLD, plus whatever else holds it; OLD is in the bucket. */
function world(extra = {}) {
  const w = fakeLiveDb({
    talent_profiles: [
      { id: PROFILE, email: "owner@example.test", cv_path: OLD, cv_url: null },
      ...(extra.talent_profiles ?? []),
    ],
    hire_remote_profiles: extra.hire_remote_profiles ?? [],
    job_applications: extra.job_applications ?? [],
    client_batch_candidates: extra.client_batch_candidates ?? [],
  });
  w.objects.set(OLD, { bytes: PDF, contentType: "application/pdf", createdAt: Date.now() });
  globalThis.__cvReleaseService = w.service;
  return w;
}

function form(profileId = PROFILE, sourceTable = "talent_profiles") {
  const fd = new FormData();
  fd.set("profileId", profileId);
  fd.set("sourceTable", sourceTable);
  fd.set("cv", new File([PDF], "cv.pdf", { type: "application/pdf" }));
  return fd;
}

const profile = (w) => w.tables.talent_profiles.find((r) => r.id === PROFILE);

/** Storage remove() that answers only after a timer: an unawaited delete has not happened yet. */
function slowRemove(w) {
  const from = w.service.storage.from.bind(w.service.storage);
  w.service.storage.from = (bucket) => {
    const b = from(bucket);
    return {
      ...b,
      remove: (paths) => new Promise((r) => setTimeout(() => r(b.remove(paths)), 20)),
    };
  };
}

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

test("a: replace, old key also held by an application -> old file kept, profile on the new key", async () => {
  const w = world({ job_applications: [{ id: "app-1", cv_path: OLD, cv_url: null }] });
  const r = await uploadCv(form());
  assert.equal(r.success, true);
  assert.notEqual(profile(w).cv_path, OLD);
  assert.equal(profile(w).cv_path, r.data.cvPath);
  assert.ok(w.objects.has(r.data.cvPath), "new file stored");
  assert.ok(w.objects.has(OLD), "kept for the application");
});

test("b: replace, old key also held by a batch candidate -> kept", async () => {
  const w = world({ client_batch_candidates: [{ id: "bc-1", cv_path: OLD, cv_url: null }] });
  const r = await uploadCv(form());
  assert.equal(r.success, true);
  assert.ok(w.objects.has(OLD));
  assert.equal(profile(w).cv_path, r.data.cvPath);
});

test("c: replace, old key held only by this profile -> deleted, before the action returns", async () => {
  const w = world();
  slowRemove(w);
  const r = await uploadCv(form());
  assert.equal(r.success, true);
  assert.equal(w.objects.has(OLD), false, "deleted, and awaited");
  assert.ok(w.objects.has(r.data.cvPath));
});

test("d: remove, shared -> kept; unshared -> deleted; the row is cleared either way", async () => {
  const shared = world({ job_applications: [{ id: "app-1", cv_path: OLD, cv_url: null }] });
  const r1 = await removeCv({ profileId: PROFILE, sourceTable: "talent_profiles" });
  assert.deepEqual(r1, { success: true, data: { cleared: true } });
  assert.equal(profile(shared).cv_path, null);
  assert.ok(shared.objects.has(OLD), "kept for the application");

  const alone = world();
  slowRemove(alone);
  const r2 = await removeCv({ profileId: PROFILE, sourceTable: "talent_profiles" });
  assert.deepEqual(r2, { success: true, data: { cleared: true } });
  assert.equal(profile(alone).cv_path, null);
  assert.equal(alone.objects.has(OLD), false, "deleted, and awaited");
});

test("e: the old-file delete fails -> the action still succeeds, the file is left, the log names nothing", async () => {
  for (const act of ["upload", "remove"]) {
    const w = world();
    w.failRemove(OLD);
    const { result, lines } = await errorsDuring(() =>
      act === "upload"
        ? uploadCv(form())
        : removeCv({ profileId: PROFILE, sourceTable: "talent_profiles" }),
    );
    assert.equal(result.success, true, act);
    assert.ok(w.objects.has(OLD), `${act}: left for the sweep`);
    assert.equal(lines.length, 1, act);
    assert.match(lines[0], /previous CV not deleted: 1 file left for the orphan sweep/);
    assert.doesNotMatch(lines[0], /talent\/|\.pdf|[0-9a-f]{8}-[0-9a-f]{4}/);
  }
  // A shared check that cannot be answered keeps the file too.
  const w = world();
  w.failNext("client_batch_candidates", "select");
  const { result } = await errorsDuring(() => uploadCv(form()));
  assert.equal(result.success, true);
  assert.ok(w.objects.has(OLD));
});

test("f: the row update fails -> the old file is never deleted, the new upload is rolled back", async () => {
  const w = world();
  w.failNext("talent_profiles", "update");
  const { result, lines } = await errorsDuring(() => uploadCv(form()));
  assert.deepEqual(result, { success: false, error: "Could not save CV." });
  assert.equal(profile(w).cv_path, OLD);
  assert.deepEqual([...w.objects.keys()], [OLD], "old kept, new rolled back");
  assert.ok(!lines.some((l) => /rollback/.test(l)), "rollback confirmed");

  // A rollback storage did not confirm is logged without its path.
  const w2 = world();
  w2.failNext("talent_profiles", "update");
  const from = w2.service.storage.from.bind(w2.service.storage);
  w2.service.storage.from = (b) => ({
    ...from(b),
    remove: async () => ({ data: null, error: { message: "denied" } }),
  });
  const { result: r2, lines: l2 } = await errorsDuring(() => uploadCv(form()));
  assert.equal(r2.success, false);
  assert.ok(w2.objects.has(OLD));
  const rollback = l2.filter((l) => /rollback/.test(l));
  assert.equal(rollback.length, 1);
  assert.doesNotMatch(rollback[0], /talent\/|\.pdf|[0-9a-f]{8}-[0-9a-f]{4}/);
});

test("g: same person in talent and remote profiles with the same key -> kept, from either side", async () => {
  const both = {
    hire_remote_profiles: [{ id: REMOTE, email: "owner@example.test", cv_path: OLD, cv_url: null }],
  };
  const w = world(both);
  const r = await uploadCv(form());
  assert.equal(r.success, true);
  assert.ok(w.objects.has(OLD), "remote profile still holds it");

  const w2 = world(both);
  const r2 = await removeCv({ profileId: REMOTE, sourceTable: "hire_remote_profiles" });
  assert.equal(r2.success, true);
  assert.equal(w2.tables.hire_remote_profiles[0].cv_path, null);
  assert.ok(w2.objects.has(OLD), "talent profile still holds it");
});
