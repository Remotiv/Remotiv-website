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

// #88: an in-memory notifications_company that applies the filters the code sends.
const OTHER_CO = "c0000000-0000-0000-0000-000000000002";
const SESSION = "s0000000-0000-0000-0000-0000000sssss";
const hrefOf = (id) => `/ai-dashboard/applicants?applicant=${id}`;
const pageOf = (sessionId) => `/ai-dashboard/interviews/${sessionId}`;
const bell = (id, company_id, application_id, href = hrefOf(application_id)) => ({
  id,
  company_id,
  application_id,
  href,
});
const BELL_RAW = {
  code: "57014",
  message: 'canceling statement due to statement timeout on "notifications_company"',
};
function bellFilter(calls) {
  const eq = (c) => calls.find((x) => x[0] === "eq" && x[1] === c)?.[2];
  const inHref = calls.find((x) => x[0] === "in" && x[1] === "href")?.[2];
  const isNull = calls.some((x) => x[0] === "is" && x[1] === "application_id" && x[2] === null);
  return {
    company: eq("company_id"),
    app: eq("application_id"),
    href: eq("href"),
    hrefs: inHref,
    isNull,
  };
}

function world({
  rowDeleteFails = null,
  interviews = { ok: true, sessions: 0 },
  files = { ok: true },
  snapshot = CO,
  preFails = false,
  lateFailures = 0,
  race = null,
  sessionFails = false,
  sessions = [SESSION],
} = {}) {
  const events = [];
  const bellEvents = [];
  const logged = [];
  const bells = [
    bell("b1", CO, APP.id),
    bell("b2", CO, "app-2"),
    bell("b3", OTHER_CO, APP.id),
    // Orphans that must survive: another company's, and another applicant's.
    bell("o1", OTHER_CO, null, hrefOf(APP.id)),
    bell("o2", OTHER_CO, null, pageOf(SESSION)),
    bell("o3", CO, null, hrefOf("app-2")),
  ];
  let lateLeft = lateFailures;
  const service = fakeService((table, calls) => {
    const op = calls[0]?.[0];
    if (table === "interview_sessions" && op === "select") {
      bellEvents.push("sessions:read");
      if (sessionFails) return { data: null, error: BELL_RAW };
      return { data: sessions.map((id) => ({ id })), error: null };
    }
    if (table === "job_applications" && op === "select") {
      return { data: { ...APP, company_id_snapshot: snapshot }, error: null };
    }
    if (table === "job_applications" && op === "delete") {
      events.push("row:delete");
      bellEvents.push("row:delete");
      if (rowDeleteFails) return { data: null, error: rowDeleteFails };
      if (race === "applicant") bells.push(bell("race", CO, APP.id));
      if (race === "expiry") bells.push(bell("race", CO, APP.id, pageOf(SESSION)));
      for (const b of bells) if (b.application_id === APP.id) b.application_id = null;
      return { data: null, error: null };
    }
    if (table === "notifications_company" && op === "delete") {
      const f = bellFilter(calls);
      bellEvents.push(f.isNull ? "bells:late" : "bells:pre");
      if (!f.isNull && preFails) return { data: null, error: BELL_RAW };
      if (f.isNull && lateLeft > 0) {
        lateLeft -= 1;
        return { data: null, error: BELL_RAW };
      }
      for (let i = bells.length - 1; i >= 0; i--) {
        const b = bells[i];
        if (
          (f.company === undefined || b.company_id === f.company) &&
          (f.app === undefined || b.application_id === f.app) &&
          (!f.isNull || b.application_id === null) &&
          (f.href === undefined || b.href === f.href) &&
          (f.hrefs === undefined || f.hrefs.includes(b.href))
        )
          bells.splice(i, 1);
      }
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
  return { events, bellEvents, bells, logged, service, run };
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

/* ── #88: the applicant's bells go with them ───────────────── */

const bellIds = (w) => w.bells.map((b) => b.id).sort();
const SURVIVORS = ["b2", "b3", "o1", "o2", "o3"];
const lateQueries = (w) =>
  w.service.queries.filter(
    (q) => q.table === "notifications_company" && q.calls.some((c) => c[0] === "is"),
  );

test("88a: the pre-clean removes only this applicant's bells in this company, before the row", async () => {
  const w = world();
  assert.deepEqual(await w.run(), { success: true, data: undefined });
  assert.deepEqual(bellIds(w), SURVIVORS, "other applicants' and other companies' bells survive");
  assert.ok(
    w.bellEvents.indexOf("bells:pre") < w.bellEvents.indexOf("row:delete"),
    w.bellEvents.join(","),
  );
  assert.deepEqual(
    w.events.map((e) => (Array.isArray(e) ? e[0] : e)),
    ["interviews", "files", "row:delete"],
    "files first, unchanged",
  );
});

test("88a2: the session ids are read first, scoped to the company and the applicant", async () => {
  const w = world();
  await w.run();
  assert.equal(w.bellEvents[0], "sessions:read");
  const read = w.service.queries.find((q) => q.table === "interview_sessions");
  const eq = (c) => read.calls.find((x) => x[0] === "eq" && x[1] === c)?.[2];
  assert.equal(eq("company_id"), CO);
  assert.equal(eq("application_id"), APP.id);
});

test("88b: a failed pre-clean keeps the row and returns the generic failure, code only in the log", async () => {
  const w = world({ preFails: true });
  const res = await w.run();
  assert.deepEqual(res, {
    success: false,
    error: "Couldn't finish deleting this applicant. Refresh and try again.",
  });
  assert.ok(!w.events.includes("row:delete"), "the row was deleted");
  assert.deepEqual(w.logged, ["[admin] delete applicant: bell clean failed: 57014"]);
});

test("88b2: a failed session lookup stops the delete before anything is removed", async () => {
  const w = world({ sessionFails: true });
  const res = await w.run();
  assert.deepEqual(res, {
    success: false,
    error: "Couldn't finish deleting this applicant. Refresh and try again.",
  });
  assert.deepEqual(w.events, [], "interviews, files or row were touched");
  assert.deepEqual(w.logged, ["[admin] delete applicant: interview session read failed: 57014"]);
});

test("88c: an applicant-link bell written between the pre-clean and the row delete is removed", async () => {
  const w = world({ race: "applicant" });
  await w.run();
  assert.ok(!w.bells.some((b) => b.id === "race"), "the racing bell survived");
  assert.deepEqual(bellIds(w), SURVIVORS);
});

test("88c2: an interview_expired bell (interview-page href) that raced the delete is removed", async () => {
  const w = world({ race: "expiry" });
  await w.run();
  assert.ok(!w.bells.some((b) => b.id === "race"), "the racing expiry bell survived");
  assert.deepEqual(bellIds(w), SURVIVORS, "another company's orphan on the same page survives");
});

test("88c3: every late clean is scoped to this company and to orphaned rows", async () => {
  const w = world({ race: "expiry" });
  await w.run();
  const late = lateQueries(w);
  assert.ok(late.length > 0, "no late clean ran");
  for (const q of late) {
    assert.deepEqual(bellFilter(q.calls), {
      company: CO,
      app: undefined,
      href: undefined,
      hrefs: [hrefOf(APP.id), pageOf(SESSION)],
      isNull: true,
    });
  }
});

test("88d: a late clean that fails once is retried and succeeds, with nothing logged", async () => {
  const w = world({ race: "expiry", lateFailures: 1 });
  assert.deepEqual(await w.run(), { success: true, data: undefined });
  assert.equal(lateQueries(w).length, 2, "one retry");
  assert.ok(!w.bells.some((b) => b.id === "race"));
  assert.deepEqual(w.logged, []);
});

test("88d2: both attempts fail: the delete stands, the code is logged, and no id", async () => {
  const w = world({ race: "expiry", lateFailures: 2 });
  assert.deepEqual(await w.run(), { success: true, data: undefined });
  assert.equal(lateQueries(w).length, 2, "exactly one retry");
  assert.deepEqual(w.logged, ["[admin] delete applicant: late bell clean failed: 57014"]);
  const log = w.logged.join("\n");
  assert.ok(!log.includes(APP.id) && !log.includes(SESSION));
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
