/**
 * Deleting a company (company-deletion.ts): every applicant with their
 * interviews, recordings and CV, its unlinked interviews and its WhatsApp
 * inbox, in resumable batches; the company row last. The database and bucket
 * are fake-live-db.mjs.
 *
 *   node --test src/lib/company-deletion.test.ts
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../test-support/node-resolve.mjs", import.meta.url));
register(
  `data:text/javascript,${encodeURIComponent(`
const STUBS = {
  "server-only": "",
  "@/lib/supabase/server": "export function createServiceClient() { return globalThis.__companyDeletionService; }",
};
export async function resolve(specifier, context, next) {
  if (specifier in STUBS) return { url: "data:text/javascript," + encodeURIComponent(STUBS[specifier]), shortCircuit: true };
  return next(specifier, context);
}`)}`,
);

const { deleteCompanyData, BATCH } = await import("./company-deletion.ts");
const { publiclyVisible } = await import("./jobs.ts");
const { fakeLiveDb } = await import("../test-support/fake-live-db.mjs");

const A = "7aad434d-0000-4000-8000-0000000000f1";
const B = "7aad434d-0000-4000-8000-0000000000f2";
const JOB_A = "2d4a8cde-0000-4000-8000-0000000000f1";
const JOB_B = "2d4a8cde-0000-4000-8000-0000000000f2";
const FILES_LEFT = "Some files could not be deleted yet - try again.";
const id = (prefix, n) => `${prefix}-0000-4000-8000-${String(n).padStart(12, "0")}`;
const appId = (n) => id("03e4863f", n);
const sessionId = (n) => id("5b0f2c1e", n);
const cv = (app) => `applications/${app}.pdf`;

/** Company A: 30 applicants (one CV shared with a talent profile), interviews, a recording, an unlinked session, an inbox. Company B and Remotiv's own besides. */
function world({ applicants = 30 } = {}) {
  const apps = Array.from({ length: applicants }, (_, i) => ({
    id: appId(i + 1),
    company_id_snapshot: A,
    job_id: JOB_A,
    email: "sam@example.com",
    cv_path: cv(appId(i + 1)),
  }));
  const B_APP = appId(900);
  const REMOTIV_APP = appId(901);
  const session = (sid, company, application) => ({
    id: sid,
    company_id: company,
    application_id: application,
    job_id: company === A ? JOB_A : JOB_B,
    kind: "async",
    status: "submitted",
    delete_after: new Date(Date.now() + 90 * 86_400_000).toISOString(),
    previous_attempt_id: null,
  });
  const db = fakeLiveDb({
    companies: [
      { id: A, name: "Northwind", status: "active", user_id: "user-a" },
      { id: B, name: "Elsewhere", status: "active", user_id: "user-b" },
    ],
    jobs: [
      { id: JOB_A, company_id: A, status: "open", archived_at: null, deleted_at: null },
      { id: JOB_B, company_id: B, status: "open", archived_at: null, deleted_at: null },
    ],
    job_applications: [
      ...apps,
      {
        id: B_APP,
        company_id_snapshot: B,
        job_id: JOB_B,
        email: "sam@example.com",
        cv_path: cv(B_APP),
      },
      {
        id: REMOTIV_APP,
        company_id_snapshot: null,
        job_id: null,
        email: "sam@example.com",
        cv_path: cv(REMOTIV_APP),
      },
    ],
    talent_profiles: [{ id: "tp-1", cv_path: cv(appId(2)) }],
    client_batch_candidates: [],
    hire_remote_profiles: [],
    interview_sessions: [
      session(sessionId(1), A, appId(1)),
      session(sessionId(2), A, appId(applicants)),
      session(sessionId(3), A, null),
      session(sessionId(4), B, B_APP),
    ],
    interview_answers: [
      { id: "ans-1", session_id: sessionId(1), video_path: `${sessionId(1)}/q1.webm` },
      { id: "ans-3", session_id: sessionId(3), video_path: `${sessionId(3)}/q1.webm` },
      { id: "ans-4", session_id: sessionId(4), video_path: `${sessionId(4)}/q1.webm` },
    ],
    final_interview_recordings: [
      { id: "rec-a", application_id: appId(1), company_id: A, storage_path: `${A}/rec-a.mp4` },
      { id: "rec-b", application_id: B_APP, company_id: B, storage_path: `${B}/rec-b.mp4` },
    ],
    whatsapp_inbound: [
      { id: "wa-1", company_id: A },
      { id: "wa-2", company_id: A },
      { id: "wa-3", company_id: B },
    ],
    usage_events: [
      { id: "use-a", company_id: A, type: "interview_sent" },
      { id: "use-b", company_id: B, type: "interview_sent" },
    ],
    signed_url_logs: [{ id: "log-1", candidate_id: appId(1) }],
    admin_access_logs: [{ id: "adm-1", session_id: sessionId(1), company_id: A }],
  });
  const files = [
    ...apps.map((a) => a.cv_path),
    cv(B_APP),
    cv(REMOTIV_APP),
    `${sessionId(1)}/q1.webm`,
    `${sessionId(2)}/q1.webm`,
    `${sessionId(3)}/q1.webm`,
    `${sessionId(4)}/q1.webm`,
    `${A}/rec-a.mp4`,
    `${B}/rec-b.mp4`,
  ];
  for (const path of files) {
    db.objects.set(path, { bytes: new Uint8Array([1]), contentType: null, createdAt: Date.now() });
  }
  globalThis.__companyDeletionService = db.service;
  return { db, B_APP, REMOTIV_APP };
}

const quiet = async (fn) => {
  const orig = { log: console.log, error: console.error };
  console.log = console.error = () => {};
  try {
    return await fn();
  } finally {
    Object.assign(console, orig);
  }
};
const run = (db, company = A) => quiet(() => deleteCompanyData(db.service, company));
const rowsOf = (db, table, where) => db.tables[table].filter(where);
const companyB = (db) =>
  JSON.stringify({
    company: db.tables.companies.find((c) => c.id === B),
    jobs: rowsOf(db, "jobs", (j) => j.company_id === B),
    apps: rowsOf(db, "job_applications", (a) => a.company_id_snapshot === B),
    sessions: rowsOf(db, "interview_sessions", (s) => s.company_id === B),
    answers: rowsOf(db, "interview_answers", (a) => a.session_id === sessionId(4)),
    recordings: rowsOf(db, "final_interview_recordings", (r) => r.company_id === B),
    inbox: rowsOf(db, "whatsapp_inbound", (w) => w.company_id === B),
    files: [...db.objects.keys()].filter(
      (p) => p.startsWith(B) || p.startsWith(sessionId(4)) || p.includes(appId(900)),
    ),
  });

test("a company of 30 applicants goes in two calls: progress each time, the company row only at the end", async () => {
  const w = world();
  const before = companyB(w.db);
  const first = await run(w.db);
  assert.deepEqual(first, {
    ok: true,
    done: false,
    applicantsDeleted: BATCH,
    applicantsLeft: 30 - BATCH,
  });
  // Still there, frozen: archived, its jobs closed, so nothing new arrives.
  const a = w.db.tables.companies.find((c) => c.id === A);
  assert.equal(a.status, "archived");
  assert.equal(w.db.tables.jobs.find((j) => j.id === JOB_A).status, "closed");
  const open = await publiclyVisible(w.db.service.from("jobs").select("id").eq("company_id", A));
  assert.deepEqual(open.data, [], "no job of the company can be applied to");

  const second = await run(w.db);
  assert.deepEqual(second, {
    ok: true,
    done: true,
    applicantsDeleted: 30 - BATCH,
    applicantsLeft: 0,
  });
  assert.equal(
    w.db.tables.companies.some((c) => c.id === A),
    false,
    "the company row went last",
  );
  assert.deepEqual(
    rowsOf(w.db, "job_applications", (x) => x.company_id_snapshot === A),
    [],
  );
  assert.deepEqual(
    rowsOf(w.db, "interview_sessions", (s) => s.company_id === A),
    [],
  );
  assert.deepEqual(
    rowsOf(w.db, "interview_answers", (x) => x.session_id === sessionId(3)),
    [],
    "the unlinked session's answers",
  );
  assert.deepEqual(
    rowsOf(w.db, "whatsapp_inbound", (x) => x.company_id === A),
    [],
  );
  for (const p of [
    `${sessionId(1)}/q1.webm`,
    `${sessionId(2)}/q1.webm`,
    `${sessionId(3)}/q1.webm`,
    `${A}/rec-a.mp4`,
    cv(appId(1)),
    cv(appId(30)),
  ]) {
    assert.equal(w.db.objects.has(p), false, p);
  }
  // Kept: a CV a talent profile still holds, the usage record, the access logs.
  assert.ok(w.db.objects.has(cv(appId(2))), "the shared CV stays for the talent profile");
  assert.deepEqual(
    w.db.tables.usage_events.map((u) => u.id),
    ["use-a", "use-b"],
  );
  assert.equal(w.db.tables.signed_url_logs.length, 1);
  assert.equal(w.db.tables.admin_access_logs.length, 1);
  // Never touched: company B, and Remotiv's own applicant with the same email.
  assert.equal(companyB(w.db), before);
  assert.ok(w.db.tables.job_applications.some((x) => x.id === w.REMOTIV_APP));
  assert.ok(w.db.objects.has(cv(w.REMOTIV_APP)));
});

test("a file left stops the call before that applicant and everything after it; the retry carries on", async () => {
  const w = world();
  w.db.failRemove(cv(appId(3)));
  const first = await run(w.db);
  assert.deepEqual(first, {
    ok: false,
    error: FILES_LEFT,
    applicantsDeleted: 2,
    applicantsLeft: 28,
  });
  assert.ok(
    w.db.tables.job_applications.some((x) => x.id === appId(3)),
    "its row kept for the retry",
  );
  assert.ok(
    w.db.tables.job_applications.some((x) => x.id === appId(4)),
    "nothing after it touched",
  );
  assert.ok(
    w.db.tables.companies.some((c) => c.id === A),
    "the company stays, archived",
  );
  const second = await run(w.db);
  assert.deepEqual(second, { ok: true, done: false, applicantsDeleted: BATCH, applicantsLeft: 3 });
  const third = await run(w.db);
  assert.equal(third.done, true);
  assert.equal(w.db.objects.has(cv(appId(3))), false);
});

test("an unlinked interview whose files will not go keeps the company row; the retry finishes", async () => {
  const w = world({ applicants: 2 });
  w.db.failRemove(`${sessionId(3)}/q1.webm`);
  const first = await run(w.db);
  assert.deepEqual(first, {
    ok: false,
    error: FILES_LEFT,
    applicantsDeleted: 2,
    applicantsLeft: 0,
  });
  assert.ok(w.db.tables.companies.some((c) => c.id === A));
  assert.ok(w.db.tables.interview_sessions.some((s) => s.id === sessionId(3)));
  assert.equal((await run(w.db)).done, true);
  assert.equal(
    w.db.tables.companies.some((c) => c.id === A),
    false,
  );
});

test("a session of this company that no step can reach keeps the company row: never deleted with data left", async () => {
  // Corrupt data: company A's session pointing at company B's applicant. Neither the
  // applicant step (B's applicant is not A's) nor the unlinked step reaches it.
  const w = world({ applicants: 2 });
  w.db.tables.interview_sessions.find((x) => x.id === sessionId(3)).application_id = w.B_APP;
  const result = await run(w.db);
  assert.equal(result.ok, false);
  assert.ok(
    w.db.tables.companies.some((c) => c.id === A),
    "the company row is kept",
  );
  assert.ok(w.db.tables.interview_sessions.some((x) => x.id === sessionId(3)));
  assert.ok(
    w.db.tables.job_applications.some((x) => x.id === w.B_APP),
    "B's applicant untouched",
  );
});

test("a company already deleted: its leftover applicants and their CVs are deleted the same way", async () => {
  const w = world({ applicants: 2 });
  w.db.tables.companies.splice(
    w.db.tables.companies.findIndex((c) => c.id === A),
    1,
  );
  w.db.tables.interview_sessions.splice(
    0,
    w.db.tables.interview_sessions.length,
    ...w.db.tables.interview_sessions.filter((s) => s.company_id !== A),
  );
  assert.deepEqual(await run(w.db), {
    ok: true,
    done: true,
    applicantsDeleted: 2,
    applicantsLeft: 0,
  });
  assert.deepEqual(
    rowsOf(w.db, "job_applications", (x) => x.company_id_snapshot === A),
    [],
  );
  assert.equal(w.db.objects.has(cv(appId(1))), false);
  assert.ok(w.db.tables.companies.some((c) => c.id === B));
});

/* ── the super admin's action ──────────────────────────────────── */

const source = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

test("deleteCompany: the service first, the auth user only once done; the dashboard works through every batch", () => {
  const actions = source("../app/admin/companies/actions.ts");
  const fn = actions.slice(actions.indexOf("export async function deleteCompany("));
  const body = fn.slice(0, fn.indexOf("\n}\n") + 2);
  const service = body.indexOf("deleteCompanyData(supabase, id)");
  const done = body.indexOf("if (!step.done)");
  const authUser = body.indexOf("auth.admin.deleteUser(");
  assert.ok(
    service > 0 && done > service && authUser > done,
    "service, then done, then the auth user",
  );
  assert.doesNotMatch(
    body,
    /\.from\("companies"\)\.delete\(\)/,
    "the company row is the service's to delete",
  );
  const dashboard = source("../app/admin/_components/companies-dashboard.tsx");
  assert.match(dashboard, /for \(let call = 0; call < MAX_DELETE_CALLS; call\+\+\)/);
  assert.match(dashboard, /if \(result\.data\.done\)/);
});

test("migration 052 drops exactly the usage_events foreign key, and nothing else", () => {
  const sql = source("./supabase/migrations/052_usage_events_keep_company_id.sql")
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("--"))
    .join("\n");
  assert.match(
    sql,
    /alter table public\.usage_events drop constraint if exists usage_events_company_id_fkey;/,
  );
  assert.equal((sql.match(/\balter table\b/gi) ?? []).length, 1);
  assert.doesNotMatch(sql, /\b(drop table|delete from|truncate|update)\b/i);
});
