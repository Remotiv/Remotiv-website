/**
 * B7: an application's recordings and CV are removed, or confirmed already
 * gone, before its row is deleted (application-files.ts). The database and
 * bucket are fake-live-db.mjs.
 *
 *   node --test src/lib/application-files.test.ts
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../test-support/node-resolve.mjs", import.meta.url));
register(
  `data:text/javascript,${encodeURIComponent(`
const STUBS = { "server-only": "" };
export async function resolve(specifier, context, next) {
  if (specifier in STUBS) return { url: "data:text/javascript," + encodeURIComponent(STUBS[specifier]), shortCircuit: true };
  return next(specifier, context);
}`)}`,
);

const { removeApplicationFiles } = await import("./application-files.ts");
const { fakeLiveDb } = await import("../test-support/fake-live-db.mjs");

const CO = "7aad434d-0000-4000-8000-0000000000e1";
const OTHER_CO = "7aad434d-0000-4000-8000-0000000000e2";
const APP = "03e4863f-0000-4000-8000-0000000000e1";
const OTHER_APP = "03e4863f-0000-4000-8000-0000000000e2";
const CV = `applications/${APP}.pdf`;
const REC_1 = `${CO}/rec-1.mp4`;
const REC_2 = `${CO}/rec-2.mp4`;
const OTHER_APP_REC = `${CO}/rec-3.mp4`;
const OTHER_CO_REC = `${OTHER_CO}/rec-4.mp4`;
const FILES_LEFT = "Some files could not be deleted yet - try again.";

function world({ shared = false, files = [CV, REC_1, REC_2, OTHER_APP_REC, OTHER_CO_REC] } = {}) {
  const db = fakeLiveDb({
    job_applications: [
      { id: APP, company_id_snapshot: CO, cv_path: CV },
      { id: OTHER_APP, company_id_snapshot: CO, cv_path: `applications/${OTHER_APP}.pdf` },
    ],
    talent_profiles: shared ? [{ id: "tp-1", cv_path: CV }] : [],
    client_batch_candidates: [],
    hire_remote_profiles: [],
    final_interview_recordings: [
      { id: "r1", application_id: APP, company_id: CO, storage_path: REC_1 },
      { id: "r2", application_id: APP, company_id: CO, storage_path: REC_2 },
      { id: "r3", application_id: OTHER_APP, company_id: CO, storage_path: OTHER_APP_REC },
      // Another company's row naming this application's id: never this application's.
      { id: "r4", application_id: APP, company_id: OTHER_CO, storage_path: OTHER_CO_REC },
      { id: "r5", application_id: APP, company_id: CO, storage_path: null },
    ],
  });
  for (const path of files) {
    db.objects.set(path, { bytes: new Uint8Array([1]), contentType: null, createdAt: Date.now() });
  }
  return db;
}

const quiet = async (fn) => {
  const orig = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = orig;
  }
};
const run = (db, service = db.service, company = CO) =>
  quiet(() => removeApplicationFiles(service, company, APP, CV));
const has = (db, path) => db.objects.has(path);

test("B7 files: every recording of the application and its CV go; the result is ok", async () => {
  const db = world();
  assert.deepEqual(await run(db), { ok: true });
  for (const p of [CV, REC_1, REC_2]) assert.equal(has(db, p), false, p);
});

test("B7 files: another application's and another company's recordings are untouched", async () => {
  const db = world();
  await run(db);
  assert.ok(has(db, OTHER_APP_REC), "another application of the same company");
  assert.ok(has(db, OTHER_CO_REC), "another company's row, even carrying this application's id");
});

test("B7 files: a CV that will not delete: not ok, the honest message; the retry finishes", async () => {
  const db = world();
  db.failRemove(CV);
  assert.deepEqual(await run(db), { ok: false, error: FILES_LEFT });
  assert.ok(has(db, CV), "still there, so the caller keeps the row");
  assert.equal(has(db, REC_1), false, "the recordings went first: a partial success");
  // The retry finds the recordings already gone, which counts as deleted, and removes the CV.
  assert.deepEqual(await run(db), { ok: true });
  assert.equal(has(db, CV), false);
});

test("B7 files: a recording that will not delete stops before the CV; the retry finishes", async () => {
  const db = world();
  db.failRemove(REC_2);
  assert.deepEqual(await run(db), { ok: false, error: FILES_LEFT });
  assert.ok(has(db, REC_2));
  assert.ok(has(db, CV), "the CV waits for the recordings");
  assert.deepEqual(await run(db), { ok: true });
  for (const p of [CV, REC_1, REC_2]) assert.equal(has(db, p), false, p);
});

test("B7 files: a file storage no longer has counts as deleted", async () => {
  const db = world({ files: [OTHER_APP_REC, OTHER_CO_REC] });
  assert.deepEqual(await run(db), { ok: true });
});

test("B7 files: if storage cannot say whether a file is still there, it is not counted as gone", async () => {
  const db = world();
  db.failRemove(CV);
  const service = {
    ...db.service,
    from: db.service.from.bind(db.service),
    storage: {
      from: (bucket) => ({
        ...db.service.storage.from(bucket),
        list: async () => ({ data: null, error: { message: "storage unreachable" } }),
      }),
    },
  };
  assert.deepEqual(await run(db, service), { ok: false, error: FILES_LEFT });
  assert.ok(has(db, CV));
});

test("B7 files: a CV another row still holds stays for that row; this application lets go of it", async () => {
  const db = world({ shared: true });
  assert.deepEqual(await run(db), { ok: true });
  assert.ok(has(db, CV), "a talent profile still advertises it");
});

test("B7 files: if the shared check cannot answer, the CV stays and the result is not ok", async () => {
  const db = world();
  db.failNext("talent_profiles", "select");
  assert.deepEqual(await run(db), { ok: false, error: FILES_LEFT });
  assert.ok(has(db, CV));
});

test("B7 files: Remotiv's own application (no company): no recordings asked for, its CV removed", async () => {
  const db = world();
  assert.deepEqual(await run(db, db.service, null), { ok: true });
  assert.equal(has(db, CV), false);
  assert.ok(has(db, REC_1), "recordings are a company's; none are read without one");
});

/* ── both applicant deletions stop on a file left ──────────────────── */

const source = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

function deleteApplicationBody(src) {
  const start = src.indexOf("export async function deleteApplication(");
  const end = src.indexOf("\nexport ", start + 1);
  return src.slice(start, end === -1 ? undefined : end);
}

test("B7 files wiring: both applicant deletions remove the files, and stop, before the row", () => {
  for (const [label, rel] of [
    ["company", "../app/ai-dashboard/(gated)/applicants/actions.ts"],
    ["super admin", "../app/admin/applications/actions.ts"],
  ]) {
    const body = deleteApplicationBody(source(rel));
    const files = body.indexOf("removeApplicationFiles(");
    const stop = body.indexOf("if (!files.ok) return { success: false, error: files.error };");
    const row = body.search(/\.from\("job_applications"\)\s*\.delete\(\)/);
    assert.ok(files > 0 && stop > files && row > stop, `${label}: files, stop, then the row`);
    assert.ok(body.indexOf("deleteApplicationInterviews(") < files, `${label}: interviews first`);
    assert.doesNotMatch(
      body,
      /\.from\(CV_BUCKET\)\s*\.remove|removeApplicationRecordings\(/,
      label,
    );
  }
});
