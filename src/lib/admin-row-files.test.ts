/**
 * #69 step 7: the four super-admin deletes (talent profile, remote talent
 * profile, client batch, client) remove the files BEFORE the rows that name
 * them, keep a key another row still names, and keep their rows (saying so)
 * when storage cannot confirm the files are gone. deleteBatch is super-admin
 * only.
 *
 *   node --test src/lib/admin-row-files.test.ts
 *
 * The four actions run as shipped against a fake database that applies eq /
 * in / range filters and records every delete, and a fake storage that keeps
 * the objects in a Set and records every remove; the order of those two event
 * kinds is what "files first" means. The role guards are stand-ins: an admin
 * passes requireAdmin, only a super admin passes requireSuperAdmin.
 * Synthetic data only.
 */
// @ts-nocheck - same reason as the other node:test files: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../test-support/fake-service-client-hook.mjs", import.meta.url));
register(
  `data:text/javascript,${encodeURIComponent(`
const STUBS = {
  "@/app/admin/lib/role-guards": [
    "export async function requireAdmin() { if (!globalThis.__rfCtx) throw new Error('Forbidden'); return globalThis.__rfCtx; }",
    "export async function requireSuperAdmin() { if (!globalThis.__rfCtx?.superAdmin) throw new Error('Forbidden: super admin required'); return globalThis.__rfCtx; }",
  ].join("\\n"),
  "next/cache": "export function revalidatePath() {}",
  "next/headers": "export async function cookies() { throw new Error('no request here'); }",
};
export async function resolve(specifier, context, next) {
  if (specifier in STUBS) return { url: "data:text/javascript," + encodeURIComponent(STUBS[specifier]), shortCircuit: true };
  return next(specifier, context);
}`)}`,
);

const { fakeService } = await import("../test-support/fake-postgrest.mjs");
const { FILES_NOT_DELETED } = await import("./admin-row-files.ts");
const { deleteTalentProfile } = await import("../app/admin/talent/actions.ts");
const { deleteRemoteTalentProfile } = await import("../app/admin/remote-talent/actions.ts");
const { deleteBatch } = await import("../app/admin/client-batches/actions.ts");
const { deleteClient } = await import("../app/admin/clients/actions.ts");

const SUPER = { superAdmin: true, user: { id: "u-super" } };
const ADMIN = { superAdmin: false, user: { id: "u-admin" } };

const passes = (row, calls) =>
  calls.every((c) => {
    if (c[0] === "eq") return row[c[1]] === c[2];
    if (c[0] === "in") return c[2].includes(row[c[1]]);
    return true;
  });

/**
 * One world: tables of rows, storage objects by bucket, and the ordered events
 * (`remove <bucket> <paths>` and `delete <table> <ids>`).
 */
function world({ tables = {}, objects = {}, errorPaths = [] } = {}) {
  const events = [];
  const deletedUsers = [];
  const db = {
    talent_profiles: [],
    hire_remote_profiles: [],
    job_applications: [],
    client_batch_candidates: [],
    client_batches: [],
    clients: [],
    ...structuredClone(tables),
  };
  const store = Object.fromEntries(
    Object.entries({ cvs: [], talent_photos: [], ...objects }).map(([b, ps]) => [b, new Set(ps)]),
  );
  const errors = new Set(errorPaths);
  const service = fakeService((table, calls) => {
    const rows = (db[table] ?? []).filter((r) => passes(r, calls));
    if (calls.some((c) => c[0] === "delete")) {
      events.push(`delete ${table} ${rows.map((r) => r.id).join(",")}`);
      db[table] = db[table].filter((r) => !rows.includes(r));
      // The schema's cascades: a client takes its batches, a batch its candidates.
      if (table === "clients") {
        const gone = db.client_batches.filter((b) => rows.some((c) => c.id === b.client_id));
        db.client_batches = db.client_batches.filter((b) => !gone.includes(b));
        db.client_batch_candidates = db.client_batch_candidates.filter(
          (c) => !gone.some((b) => b.id === c.batch_id),
        );
      }
      if (table === "client_batches") {
        db.client_batch_candidates = db.client_batch_candidates.filter(
          (c) => !rows.some((b) => b.id === c.batch_id),
        );
      }
      return { data: null, error: null };
    }
    if (calls.some((c) => c[0] === "maybeSingle")) return { data: rows[0] ?? null, error: null };
    const range = calls.find((c) => c[0] === "range");
    const out = range ? rows.slice(range[1], range[2] + 1) : rows;
    return { data: out.map((r) => ({ ...r })), error: null };
  });
  service.storage = {
    from: (bucket) => ({
      async remove(paths) {
        events.push(`remove ${bucket} ${paths.join(",")}`);
        const gone = paths.filter((p) => store[bucket].has(p) && !errors.has(p));
        for (const p of gone) store[bucket].delete(p);
        return { data: gone.map((name) => ({ name })), error: null };
      },
      async info(path) {
        if (errors.has(path)) return { data: null, error: { status: 500, statusCode: "500" } };
        if (store[bucket].has(path)) return { data: { size: 1 }, error: null };
        return {
          data: null,
          error: { status: 400, statusCode: "404", message: "Object not found" },
        };
      },
    }),
  };
  service.auth = { admin: { deleteUser: async (id) => deletedUsers.push(id) } };
  globalThis.__fakeServiceClientForTests = () => service;
  return { db, store, events, deletedUsers };
}

async function as(ctx, fn) {
  globalThis.__rfCtx = ctx;
  const logs = [];
  const saved = console.error;
  console.error = (...a) => logs.push(a.map(String).join(" "));
  try {
    return { result: await fn(), logs };
  } catch (err) {
    return { thrown: err, logs };
  } finally {
    console.error = saved;
  }
}

const firstIndex = (events, prefix) => events.findIndex((e) => e.startsWith(prefix));

/* ── talent and remote talent ─────────────────────────────── */

const TALENT = { id: "t-1", cv_path: "talent/t-1.pdf", photo_path: "photos/t-1.jpg" };

// Negative control: delete the row before removeRowFiles and this test fails.
test("deleteTalentProfile: the CV and photo are removed BEFORE the row", async () => {
  const w = world({
    tables: { talent_profiles: [TALENT] },
    objects: { cvs: [TALENT.cv_path], talent_photos: [TALENT.photo_path] },
  });
  const { result } = await as(SUPER, () => deleteTalentProfile(TALENT.id));
  assert.deepEqual(result, { success: true, data: undefined });
  assert.equal(w.store.cvs.size + w.store.talent_photos.size, 0, "both files gone");
  assert.ok(
    firstIndex(w.events, "remove cvs") < firstIndex(w.events, "delete talent_profiles"),
    `files first: ${w.events.join(" | ")}`,
  );
  assert.equal(w.db.talent_profiles.length, 0);
});

// Negative control: treat a storage error as gone and the row is deleted over
// a file that may still exist.
test("deleteTalentProfile: a storage error keeps the row and says so", async () => {
  const w = world({
    tables: { talent_profiles: [TALENT] },
    objects: { cvs: [TALENT.cv_path], talent_photos: [TALENT.photo_path] },
    errorPaths: [TALENT.cv_path],
  });
  const { result, logs } = await as(SUPER, () => deleteTalentProfile(TALENT.id));
  assert.deepEqual(result, { success: false, error: FILES_NOT_DELETED });
  assert.equal(w.db.talent_profiles.length, 1, "the row is kept: a delete to retry");
  assert.equal(firstIndex(w.events, "delete "), -1, "no row was deleted");
  assert.deepEqual(logs, ["[admin-talent] delete: files not removed (storage_error); row kept"]);
  assert.ok(!logs.join(" ").includes(TALENT.cv_path), "no path logged");
});

// Negative control: skip findSharedPaths and the shared CV is deleted.
test("deleteTalentProfile: a CV key another row still names is kept; the row still goes", async () => {
  const w = world({
    tables: {
      talent_profiles: [TALENT],
      client_batch_candidates: [{ id: "c-9", batch_id: "b-9", cv_path: TALENT.cv_path }],
    },
    objects: { cvs: [TALENT.cv_path], talent_photos: [TALENT.photo_path] },
  });
  const { result } = await as(SUPER, () => deleteTalentProfile(TALENT.id));
  assert.equal(result.success, true);
  assert.ok(w.store.cvs.has(TALENT.cv_path), "the batch candidate still shows this CV");
  assert.ok(!w.events.some((e) => e.includes(TALENT.cv_path)), "the shared CV was never removed");
  assert.equal(w.store.talent_photos.size, 0, "the unshared photo went");
  assert.equal(w.db.talent_profiles.length, 0);
});

test("deleteTalentProfile: a file already missing from storage is not a failure", async () => {
  const w = world({
    tables: { talent_profiles: [TALENT] },
    objects: { talent_photos: [TALENT.photo_path] },
  });
  const { result } = await as(SUPER, () => deleteTalentProfile(TALENT.id));
  assert.equal(result.success, true);
  assert.equal(w.db.talent_profiles.length, 0);
});

test("deleteRemoteTalentProfile: the CV and photo are removed BEFORE the row; an error keeps it", async () => {
  const R = { id: "r-1", cv_path: "remote/r-1.pdf", photo_path: "photos/r-1.jpg" };
  const ok = world({
    tables: { hire_remote_profiles: [R] },
    objects: { cvs: [R.cv_path], talent_photos: [R.photo_path] },
  });
  const done = await as(SUPER, () => deleteRemoteTalentProfile(R.id));
  assert.equal(done.result.success, true);
  assert.ok(
    firstIndex(ok.events, "remove ") < firstIndex(ok.events, "delete hire_remote_profiles"),
  );
  assert.equal(ok.store.cvs.size + ok.store.talent_photos.size, 0);

  const bad = world({
    tables: { hire_remote_profiles: [R] },
    objects: { cvs: [R.cv_path], talent_photos: [R.photo_path] },
    errorPaths: [R.photo_path],
  });
  const kept = await as(SUPER, () => deleteRemoteTalentProfile(R.id));
  assert.deepEqual(kept.result, { success: false, error: FILES_NOT_DELETED });
  assert.equal(bad.db.hire_remote_profiles.length, 1);
});

/* ── batches and clients ──────────────────────────────────── */

const BATCH_WORLD = () => ({
  tables: {
    client_batches: [
      { id: "b-1", client_id: "cl-1" },
      { id: "b-2", client_id: "cl-1" },
    ],
    client_batch_candidates: [
      { id: "c-1", batch_id: "b-1", cv_path: "batch/c-1.pdf" },
      // Two candidates of ONE batch share a key: each is in `self`, so neither
      // keeps it alive for the other.
      { id: "c-2", batch_id: "b-1", cv_path: "batch/shared.pdf" },
      { id: "c-3", batch_id: "b-1", cv_path: "batch/shared.pdf" },
      { id: "c-4", batch_id: "b-2", cv_path: "batch/c-4.pdf" },
    ],
    clients: [{ id: "cl-1", user_id: "u-client" }],
  },
  objects: { cvs: ["batch/c-1.pdf", "batch/shared.pdf", "batch/c-4.pdf"] },
});

// Negative control: put requireAdmin back on deleteBatch and the first half fails.
test("deleteBatch: super admin only; a plain admin is refused and nothing is touched", async () => {
  const w = world(BATCH_WORLD());
  const refused = await as(ADMIN, () => deleteBatch("b-1"));
  assert.match(String(refused.thrown), /super admin required/);
  assert.deepEqual(w.events, [], "no file and no row was touched");
  assert.equal(w.db.client_batches.length, 2);
});

test("deleteBatch: every candidate's CV is removed BEFORE the batch (and its candidates) go", async () => {
  const w = world(BATCH_WORLD());
  const { result } = await as(SUPER, () => deleteBatch("b-1"));
  assert.deepEqual(result, { success: true, data: undefined });
  assert.deepEqual([...w.store.cvs], ["batch/c-4.pdf"], "only the other batch's CV is left");
  assert.ok(firstIndex(w.events, "remove cvs") < firstIndex(w.events, "delete client_batches b-1"));
  assert.deepEqual(
    w.db.client_batch_candidates.map((c) => c.id),
    ["c-4"],
  );
});

test("deleteBatch: a storage error keeps the batch and says so", async () => {
  const w = world({ ...BATCH_WORLD(), errorPaths: ["batch/c-1.pdf"] });
  const { result } = await as(SUPER, () => deleteBatch("b-1"));
  assert.deepEqual(result, { success: false, error: FILES_NOT_DELETED });
  assert.equal(w.db.client_batches.length, 2);
  assert.equal(firstIndex(w.events, "delete "), -1);
});

test("deleteClient: every candidate's CV across its batches goes BEFORE the client; then the login", async () => {
  const w = world(BATCH_WORLD());
  const { result } = await as(SUPER, () => deleteClient("cl-1"));
  assert.deepEqual(result, { success: true, data: undefined });
  assert.equal(w.store.cvs.size, 0);
  assert.ok(firstIndex(w.events, "remove cvs") < firstIndex(w.events, "delete clients cl-1"));
  assert.deepEqual(w.db.client_batch_candidates, []);
  assert.deepEqual(w.deletedUsers, ["u-client"]);

  const bad = world({ ...BATCH_WORLD(), errorPaths: ["batch/c-4.pdf"] });
  const kept = await as(SUPER, () => deleteClient("cl-1"));
  assert.deepEqual(kept.result, { success: false, error: FILES_NOT_DELETED });
  assert.equal(bad.db.clients.length, 1, "the client is kept");
  assert.deepEqual(bad.deletedUsers, [], "and so is the login");
});
