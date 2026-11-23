/**
 * The admin applicant delete for a Remotiv-owned row, run as shipped against
 * a fake database (#95, #93).
 *
 *   node --test src/app/admin/applications/actions.test.ts
 *
 * ── What is tested ─────────────────────────────────────────
 *
 * A Remotiv-owned row (no company snapshot) is deleted file first, then row.
 * The row step used to hand the database's own message back to the browser;
 * it now returns a fixed sentence and logs the error CODE only. These cases
 * seed a raw constraint failure on the row delete and assert that neither the
 * message, the constraint name nor the table name reaches the result or the
 * console.
 *
 * An internal company's applicant goes through the company delete's 071
 * pipeline since #69 step 4: delete-pipeline.test.ts. The #88 app-side bell
 * cleans this file used to pin for those rows are gone with that change: 071's
 * Finish removes the bells in its own transaction (applicant-deletion.test.ts
 * pins that SQL, delete-bells.test.ts D2 runs it).
 *
 * The file removal is stubbed to record its calls and answer as told: its own
 * behaviour has its own tests. The admin guard, the scope and the cache
 * revalidation are stubbed; the database is fake-postgrest.mjs. Synthetic data.
 */
// @ts-nocheck - same reason as the other node:test files: Node's `.ts`
// specifier vs this tsconfig, which does not set allowImportingTsExtensions.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../../test-support/fake-service-client-hook.mjs", import.meta.url));
register(
  `data:text/javascript,${encodeURIComponent(`
const STUBS = {
  "next/cache": "export function revalidatePath() {}",
  "@/app/admin/lib/role-guards": [
    "export async function requireSuperAdmin() { return globalThis.__adminDeleteCtx; }",
    "export async function requireAdmin() { return globalThis.__adminDeleteCtx; }",
  ].join("\\n"),
  "@/lib/admin-scope": "export async function adminApplicationScope() { return 'company_id_snapshot.not.is.null'; }",
  "@/lib/application-files": "export async function removeApplicationFiles(...args) { globalThis.__adminDeleteCalls.push(['files', args]); const f = globalThis.__adminDeleteFiles; return typeof f === 'function' ? f(...args) : f; }",
  "@/lib/interviews/application-deletion": "export async function removeInterviewFiles(...args) { globalThis.__adminDeleteCalls.push(['interview-files', args]); return { ok: true }; }",
  "@/lib/avatars": "export function getAvatarUrl() { return null; }",
};
export async function resolve(specifier, context, next) {
  if (specifier in STUBS) return { url: "data:text/javascript," + encodeURIComponent(STUBS[specifier]), shortCircuit: true };
  return next(specifier, context);
}`)}`,
);

const { fakeService } = await import("../../../test-support/fake-postgrest.mjs");
// ADMIN_ACTIONS_UNDER_TEST points the suite at another copy (the #88 negative control).
const { pathToFileURL } = await import("node:url");
const { deleteApplication } = await import(
  process.env.ADMIN_ACTIONS_UNDER_TEST
    ? pathToFileURL(process.env.ADMIN_ACTIONS_UNDER_TEST).href
    : "./actions.ts"
);

const CO = "c0000000-0000-0000-0000-000000000001";
const APP = { id: "app-1", company_id_snapshot: CO, cv_path: "x/app-1.pdf" };

/** A raw Postgres failure of the kind the row delete used to hand to the browser. */
const RAW = {
  code: "23503",
  message:
    'update or delete on table "job_applications" violates foreign key constraint "application_scores_application_id_fkey" on table "application_scores"',
  details: 'Key (id)=(app-1) is still referenced from table "application_scores".',
};
const LEAKS = [
  RAW.message,
  "application_scores_application_id_fkey",
  "job_applications",
  "application_scores",
  "violates",
  "Key (id)",
];

function world({
  rowDeleteFails = null,
  rowDeleteFailuresLeft = Number.POSITIVE_INFINITY,
  files = { ok: true },
  snapshot = null,
} = {}) {
  const events = [];
  const logged = [];
  let rowGone = false;
  const service = fakeService((table, calls) => {
    const op = calls[0]?.[0];
    if (table === "job_applications" && op === "select") {
      return { data: rowGone ? null : { ...APP, company_id_snapshot: snapshot }, error: null };
    }
    if (table === "job_applications" && op === "delete") {
      events.push("row:delete");
      if (rowDeleteFails && rowDeleteFailuresLeft > 0) {
        rowDeleteFailuresLeft -= 1;
        return { data: null, error: rowDeleteFails };
      }
      // Only a delete aimed at this applicant removes it (#93's retry test reads rowGone).
      if (calls.some((c) => c[0] === "eq" && c[1] === "id" && c[2] === APP.id)) rowGone = true;
      return { data: null, error: null };
    }
    throw new Error(`unexpected ${op} on ${table}`);
  });
  globalThis.__fakeServiceClientForTests = () => service;
  globalThis.__adminDeleteCtx = {
    user: { id: "u-admin", email: "admin@remotiv.test" },
    role: "super_admin",
  };
  globalThis.__adminDeleteCalls = events;
  globalThis.__adminDeleteFiles = files;

  const realError = console.error;
  const run = async () => {
    console.error = (...args) => logged.push(args.map(String).join(" "));
    try {
      return await deleteApplication(APP.id);
    } finally {
      console.error = realError;
    }
  };
  return { events, logged, service, run, rowGone: () => rowGone };
}

const PARTLY_DELETED =
  "Deletion was not completed. Some data may already have been removed. Refresh and try Delete again.";

test("1. the row delete fails: a fixed sentence, the code logged, and nothing of the database's message anywhere", async () => {
  const w = world({ rowDeleteFails: RAW });
  const result = await w.run();
  assert.deepEqual(result, { success: false, error: PARTLY_DELETED });
  assert.deepEqual(
    w.logged,
    ["[admin] delete applicant: row delete failed: 23503"],
    "the code only",
  );
  const everything = [result.error, ...w.logged].join("\n");
  for (const needle of LEAKS) assert.ok(!everything.includes(needle), `leaked ${needle}`);
  assert.deepEqual(
    w.events.map((e) => (Array.isArray(e) ? e[0] : e)),
    ["files", "row:delete"],
    "the file, then the row: the file was already removed when the row failed",
  );
});

test("2. the happy path: the file, then the row, and success", async () => {
  const w = world();
  assert.deepEqual(await w.run(), { success: true, data: undefined });
  assert.deepEqual(
    w.events.map((e) => (Array.isArray(e) ? e[0] : e)),
    ["files", "row:delete"],
  );
  assert.deepEqual(w.logged, []);
});

test("4. the file step's fixed string passes through unchanged and the row is not deleted", async () => {
  const w = world({
    files: { ok: false, error: "Some files could not be deleted yet - try again." },
  });
  const result = await w.run();
  assert.equal(result.success, false);
  assert.equal(result.error, "Some files could not be deleted yet - try again.");
  assert.ok(!w.events.includes("row:delete"));
});

test("88f: a Remotiv-owned row (no company snapshot) reads no sessions, sends no bell query, and is deleted", async () => {
  const w = world({ snapshot: null });
  assert.deepEqual(await w.run(), { success: true, data: undefined });
  assert.ok(
    !w.service.queries.some(
      (q) => q.table === "notifications_company" || q.table === "interview_sessions",
    ),
    "a bell or session query ran",
  );
  assert.ok(w.events.includes("row:delete"));
});

/*
 * #93: the row delete fails AFTER the file went. The admin is told it was
 * partly done, and Delete again finishes it: the second pass finds the file
 * already gone (the stub answers as removeApplicationFiles does for a missing
 * object, application-files.ts) and deletes the row.
 */
test("93: a failed row delete says partly deleted; Delete again finishes with the files counted as already gone", async () => {
  const stored = new Set([APP.cv_path]);
  const filesPasses = [];
  const w = world({
    rowDeleteFails: RAW,
    rowDeleteFailuresLeft: 1,
    files: (_service, _company, _app, cvPath) => {
      filesPasses.push(stored.has(cvPath) ? "removed" : "already gone");
      stored.delete(cvPath);
      return { ok: true };
    },
  });

  const first = await w.run();
  assert.deepEqual(first, { success: false, error: PARTLY_DELETED });
  assert.equal(w.rowGone(), false, "the applicant is still there after the failure");
  assert.equal(stored.size, 0, "but the CV was already removed");

  const retry = await w.run();
  assert.deepEqual(retry, { success: true, data: undefined });
  assert.equal(w.rowGone(), true, "Delete again removed the applicant");
  assert.deepEqual(filesPasses, ["removed", "already gone"]);
  assert.deepEqual(
    w.events.filter((e) => e === "row:delete"),
    ["row:delete", "row:delete"],
    "one failed and one successful row delete",
  );
});
