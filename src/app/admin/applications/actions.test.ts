/**
 * The admin applicant delete, run as shipped against a fake database (#95).
 *
 *   node --test src/app/admin/applications/actions.test.ts
 *
 * ── What is tested ───────────────────────────────────────────
 *
 * deleteApplication runs interviews, then files, then the row. The row step
 * used to hand the database's own message back to the browser; it now returns
 * a fixed sentence and logs the error CODE only. These cases seed a raw
 * constraint failure on the row delete and assert that neither the message,
 * the constraint name nor the table name reaches the result or the console.
 *
 * The two helpers it calls (the interview deletion and the file removal) are
 * stubbed to record their calls and answer as told: their own behaviour has
 * its own tests. The admin guard, the scope and the cache revalidation are
 * stubbed; the database is fake-postgrest.mjs. Synthetic data only.
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
  "@/lib/application-files": "export async function removeApplicationFiles(...args) { globalThis.__adminDeleteCalls.push(['files', args]); return globalThis.__adminDeleteFiles; }",
  "@/lib/interviews/application-deletion": "export async function deleteApplicationInterviews(...args) { globalThis.__adminDeleteCalls.push(['interviews', args]); return globalThis.__adminDeleteInterviews; }",
  "@/lib/avatars": "export function getAvatarUrl() { return null; }",
};
export async function resolve(specifier, context, next) {
  if (specifier in STUBS) return { url: "data:text/javascript," + encodeURIComponent(STUBS[specifier]), shortCircuit: true };
  return next(specifier, context);
}`)}`,
);

const { fakeService } = await import("../../../test-support/fake-postgrest.mjs");
const { deleteApplication } = await import("./actions.ts");

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
  interviews = { ok: true, sessions: 0 },
  files = { ok: true },
} = {}) {
  const events = [];
  const logged = [];
  const service = fakeService((table, calls) => {
    const op = calls[0]?.[0];
    if (table === "job_applications" && op === "select") return { data: { ...APP }, error: null };
    if (table === "job_applications" && op === "delete") {
      events.push("row:delete");
      return rowDeleteFails ? { data: null, error: rowDeleteFails } : { data: null, error: null };
    }
    throw new Error(`unexpected ${op} on ${table}`);
  });
  globalThis.__fakeServiceClientForTests = () => service;
  globalThis.__adminDeleteCtx = {
    user: { id: "u-admin", email: "admin@remotiv.test" },
    role: "super_admin",
  };
  globalThis.__adminDeleteCalls = events;
  globalThis.__adminDeleteInterviews = interviews;
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
  return { events, logged, run };
}

test("1. the row delete fails: a fixed sentence, the code logged, and nothing of the database's message anywhere", async () => {
  const w = world({ rowDeleteFails: RAW });
  const result = await w.run();
  assert.deepEqual(result, {
    success: false,
    error: "Couldn't finish deleting this applicant. Refresh and try again.",
  });
  assert.deepEqual(
    w.logged,
    ["[admin] delete applicant: row delete failed: 23503"],
    "the code only",
  );
  const everything = [result.error, ...w.logged].join("\n");
  for (const needle of LEAKS) assert.ok(!everything.includes(needle), `leaked ${needle}`);
  assert.deepEqual(
    w.events.map((e) => (Array.isArray(e) ? e[0] : e)),
    ["interviews", "files", "row:delete"],
    "interviews, then files, then the row: the files were already removed when the row failed",
  );
});

test("2. the happy path: interviews, files, row, in that order, and success", async () => {
  const w = world();
  assert.deepEqual(await w.run(), { success: true, data: undefined });
  assert.deepEqual(
    w.events.map((e) => (Array.isArray(e) ? e[0] : e)),
    ["interviews", "files", "row:delete"],
  );
  assert.deepEqual(w.logged, []);
});

test("3. a helper's fixed string passes through unchanged and stops the sequence before the row", async () => {
  const w = world({
    interviews: { ok: false, error: "Some files could not be deleted yet - try again." },
  });
  assert.deepEqual(await w.run(), {
    success: false,
    error: "Some files could not be deleted yet - try again.",
  });
  assert.deepEqual(
    w.events.map((e) => (Array.isArray(e) ? e[0] : e)),
    ["interviews"],
    "nothing after the failed step",
  );
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
