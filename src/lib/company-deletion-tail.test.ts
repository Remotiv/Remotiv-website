/**
 * #69 step 5: the company delete's own tail. Every applicant goes through the
 * per-applicant pipeline (deleteForRemotiv in production) BEFORE anything
 * cascades; then the open calendar cleanups are tried while the tokens still
 * work, every member's calendar connection is revoked at Google (a revoke
 * Google does not confirm still deletes the row, and the super admin is told),
 * the company's logos are removed, the company row goes, and last the logins
 * that belong to nothing else (Q10).
 *
 *   node --test src/lib/company-deletion-tail.test.ts
 *
 * deleteCompanyData runs as shipped against an in-memory world that applies
 * its filters and cascades the company row to its members, jobs and
 * applicants, with the real removeObjects over a fake logo bucket. The
 * per-applicant pipeline is passed in (opts.deleteApplicant) and records what
 * it saw; the cleanup sweep and the disconnect are stand-ins that record their
 * calls, their own behaviour pinned in cleanups.test.ts and
 * remove-member-calendar.test.ts. Synthetic data only.
 */
// @ts-nocheck - same reason as the other node:test files: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../test-support/node-resolve.mjs", import.meta.url));
register(
  `data:text/javascript,${encodeURIComponent(`
const STUBS = {
  "server-only": "",
  "@/lib/supabase/server": "export function createServiceClient() { throw new Error('unused'); }",
  "@/lib/applicant-deletion-complete": "export async function deleteForRemotiv() { throw new Error('the test passes its own'); }",
  "@/lib/interviews/application-deletion": "export async function deleteUnlinkedCompanyInterviews() { return { ok: true }; }",
  "@/lib/calendar/cleanups": "export async function sweepCleanupsForCompany(id) { globalThis.__tail.events.push('sweep'); return globalThis.__tail.eventsLeft; }",
  "@/lib/calendar/connections": "export async function disconnectAllForMember(id) { globalThis.__tail.events.push('disconnect:' + id); return globalThis.__tail.disconnect(id); } export async function disconnectAllForCompany(id) { globalThis.__tail.events.push('company-disconnect:' + id); return globalThis.__tail.companyDisconnect(id); }",
  "@/app/admin/lib/roles": "export function isSuperAdminEmail(e) { return e === 'boss@remotiv.test'; }",
};
export async function resolve(specifier, context, next) {
  if (specifier in STUBS) return { url: "data:text/javascript," + encodeURIComponent(STUBS[specifier]), shortCircuit: true };
  return next(specifier, context);
}`)}`,
);

const { deleteCompanyData } = await import("./company-deletion.ts");

const A = "7aad434d-0000-4000-8000-0000000000a1";
const B = "7aad434d-0000-4000-8000-0000000000b2";

/** Company A: two applicants, an owner and two members; company B shares one login and has its own logo. */
function world() {
  const tables = {
    companies: [
      { id: A, status: "active", user_id: "u-owner" },
      { id: B, status: "active", user_id: "u-b-owner" },
    ],
    jobs: [{ id: "job-a", company_id: A, status: "open" }],
    job_applications: [
      { id: "app-1", company_id_snapshot: A, job_id: "job-a", cv_path: "applications/app-1.pdf" },
      { id: "app-2", company_id_snapshot: A, job_id: "job-a", cv_path: null },
      { id: "app-b", company_id_snapshot: B, job_id: "job-b", cv_path: null },
    ],
    company_members: [
      { id: "m-owner", company_id: A, user_id: "u-owner" },
      { id: "m-shared", company_id: A, user_id: "u-shared" },
      { id: "m-only", company_id: A, user_id: "u-only" },
      { id: "m-b-shared", company_id: B, user_id: "u-shared" },
    ],
    admin_users: [],
    clients: [],
    talent_profiles: [],
    interview_sessions: [],
    whatsapp_inbound: [],
  };
  const objects = new Set([`${A}/logo-1.png`, `${A}/logo-2.jpg`, `${B}/logo.png`]);
  const t = {
    tables,
    objects,
    events: [],
    deletedUsers: [],
    eventsLeft: 0,
    failTables: new Set(),
    logoRemoveFails: false,
    disconnect: async () => ({
      ok: true,
      results: [{ provider: "google", deleted: true, revokedAtProvider: true }],
    }),
    companyDisconnect: async () => ({ ok: true, results: [] }),
    deleteUserFails: new Set(),
    emails: { "u-owner": "o@acme.test", "u-shared": "s@acme.test", "u-only": "x@acme.test" },
  };
  globalThis.__tail = t;

  const match = (row, calls) =>
    calls.every(([op, col, val]) => {
      if (op === "eq") return row[col] === val;
      if (op === "neq") return row[col] !== val;
      if (op === "in") return val.includes(row[col]);
      if (op === "is") return row[col] === val;
      return true;
    });
  const respond = (table, calls) => {
    if (t.failTables.has(table)) return { data: null, count: null, error: { code: "57014" } };
    const rows = tables[table] ?? [];
    const hit = rows.filter((r) => match(r, calls));
    if (calls.some((c) => c[0] === "delete")) {
      t.events.push(`${table}.delete`);
      tables[table] = rows.filter((r) => !hit.includes(r));
      if (table === "companies") {
        for (const c of hit) {
          for (const [name, col] of [
            ["company_members", "company_id"],
            ["jobs", "company_id"],
            ["job_applications", "company_id_snapshot"],
          ]) {
            tables[name] = tables[name].filter((r) => r[col] !== c.id);
          }
        }
      }
      return { data: null, error: null };
    }
    const update = calls.find((c) => c[0] === "update");
    if (update) {
      for (const r of hit) Object.assign(r, update[1]);
      return { data: null, error: null };
    }
    const select = calls.find((c) => c[0] === "select");
    if (select?.[2]?.head) return { data: null, count: hit.length, error: null };
    const limit = calls.find((c) => c[0] === "limit");
    const page = limit ? hit.slice(0, limit[1]) : hit;
    if (calls.some((c) => c[0] === "maybeSingle")) return { data: page[0] ?? null, error: null };
    return { data: page, error: null };
  };
  const from = (table) => {
    const calls = [];
    const q = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "then")
            return (res, rej) =>
              Promise.resolve()
                .then(() => respond(table, calls))
                .then(res, rej);
          return (...args) => {
            calls.push([prop, ...args]);
            return q;
          };
        },
      },
    );
    return q;
  };
  const service = {
    from,
    storage: {
      from: () => ({
        async list(prefix, { limit = 100 } = {}) {
          const names = [...objects]
            .filter((k) => k.startsWith(`${prefix}/`))
            .map((k) => ({ name: k.slice(prefix.length + 1) }));
          return { data: names.slice(0, limit), error: null };
        },
        async remove(paths) {
          t.events.push("logos.remove");
          t.onLogoRemove?.();
          if (t.logoRemoveFails) return { data: [], error: { message: "fault" } };
          const gone = paths.filter((p) => objects.delete(p)).map((name) => ({ name }));
          return { data: gone, error: null };
        },
      }),
    },
    auth: {
      admin: {
        getUserById: async (id) => ({
          data: { user: { id, email: t.emails[id] ?? null } },
          error: null,
        }),
        deleteUser: async (id) => {
          t.events.push("deleteUser");
          if (t.deleteUserFails.has(id)) return { error: { status: 500, message: `${id} boom` } };
          t.deletedUsers.push(id);
          return { error: null };
        },
      },
    },
  };
  /** The per-applicant pipeline: records whether the company and its calendar access were still there. */
  const deleteApplicant = async (_service, target, notFound) => {
    t.events.push(`applicant:${target.applicationId}`);
    t.seenByApplicant ??= [];
    t.seenByApplicant.push({
      id: target.applicationId,
      company: target.applicationCompany,
      companyRowThere: tables.companies.some((c) => c.id === A),
      membersThere: tables.company_members.filter((m) => m.company_id === A).length,
      disconnectsSoFar: t.events.filter((e) => e.startsWith("disconnect:")).length,
    });
    const verdict = t.applicantVerdict?.(target.applicationId);
    if (verdict === "gone") return { success: false, error: notFound };
    if (verdict) return { success: false, error: verdict };
    tables.job_applications = tables.job_applications.filter((a) => a.id !== target.applicationId);
    return { success: true, data: undefined };
  };
  return { t, service, deleteApplicant };
}

const quiet = async (fn) => {
  const orig = { log: console.log, error: console.error };
  const logs = [];
  console.log = console.error = (...a) => logs.push(a.map(String).join(" "));
  try {
    return { out: await fn(), logs };
  } finally {
    Object.assign(console, orig);
  }
};
const run = (w) =>
  quiet(() => deleteCompanyData(w.service, A, { deleteApplicant: w.deleteApplicant }));
const companyThere = (t, id) => t.tables.companies.some((c) => c.id === id);

// Negative control: delete the company row right after the freeze (step 1),
// i.e. cascade before the per-applicant pipeline, and this test fails.
test("every applicant goes through the pipeline first, while the company, its members and their calendar access are all still there", async () => {
  const w = world();
  const { out } = await run(w);
  assert.equal(out.ok, true);
  assert.equal(out.done, true);
  assert.deepEqual(
    w.t.seenByApplicant,
    [
      { id: "app-1", company: A, companyRowThere: true, membersThere: 3, disconnectsSoFar: 0 },
      { id: "app-2", company: A, companyRowThere: true, membersThere: 3, disconnectsSoFar: 0 },
    ],
    "each applicant by its own company, before any cascade or revoke",
  );
  const ev = w.t.events;
  const last = (prefix) => ev.findLastIndex((e) => e.startsWith(prefix));
  const first = (prefix) => ev.findIndex((e) => e.startsWith(prefix));
  assert.ok(last("applicant:") < first("sweep"), "applicants, then the cleanups");
  assert.ok(first("sweep") < first("disconnect:"), "cleanups while the tokens still work");
  assert.ok(last("disconnect:") < first("logos.remove"));
  assert.ok(first("logos.remove") < first("companies.delete"), "the company row after the tail");
  assert.ok(first("companies.delete") < first("deleteUser"), "logins only after the company row");
  assert.ok(companyThere(w.t, B), "company B untouched");
  assert.deepEqual(
    w.t.tables.job_applications.map((a) => a.id),
    ["app-b"],
  );
});

// Negative control: replace the disconnectAllForMember call with a canned
// `{ ok: true, results: [] }` (the revoke skipped) and this test fails.
test("every member's calendar connection is revoked before the company row; a revoke Google does not confirm still completes, with a warning", async () => {
  const w = world();
  w.t.disconnect = async (id) => ({
    ok: true,
    results: [{ provider: "google", deleted: true, revokedAtProvider: id !== "m-shared" }],
  });
  const { out, logs } = await run(w);
  assert.deepEqual(
    w.t.events.filter((e) => e.startsWith("disconnect:")),
    ["disconnect:m-owner", "disconnect:m-shared", "disconnect:m-only"],
    "each of company A's members, and nobody else's",
  );
  assert.equal(out.done, true, "an unconfirmed revoke does not block the delete");
  assert.equal(out.warnings.length, 1);
  assert.match(
    out.warnings[0],
    /1 calendar connection\. .*Google Account > Security > Third-party access/,
  );
  assert.doesNotMatch(out.warnings.join(" "), /[\u2013\u2014]/, "no long dashes");
  assert.ok(logs.some((l) => /calendar revokes unconfirmed=1/.test(l)));
});

test("a connection whose row could not be deleted, or connections that cannot be read, stop the call: the company row stays", async () => {
  const w = world();
  w.t.disconnect = async () => ({
    ok: true,
    results: [{ provider: "google", deleted: false, revokedAtProvider: true }],
  });
  const { out } = await run(w);
  assert.equal(out.ok, false);
  assert.ok(companyThere(w.t, A));
  assert.deepEqual(w.t.deletedUsers, []);

  const w2 = world();
  w2.t.disconnect = async () => ({ ok: false });
  assert.equal((await run(w2)).out.ok, false);
  assert.ok(companyThere(w2.t, A));
});

// Negative control: drop "company_members" from deleteLoginsIfUnused's table
// list and the shared login is deleted: this test fails.
test("logins: deleted only when they belong to nothing else (Q10); another company, an admin, a client, a talent profile or the super admin keeps it", async () => {
  const w = world();
  w.t.tables.admin_users.push({ user_id: "u-owner" });
  const { out } = await run(w);
  assert.equal(out.done, true);
  assert.deepEqual(w.t.deletedUsers, ["u-only"], "only the login with nothing else");

  for (const [table, row] of [
    ["clients", { user_id: "u-only" }],
    ["talent_profiles", { user_id: "u-only" }],
  ]) {
    const w2 = world();
    w2.t.tables[table].push(row);
    await run(w2);
    assert.ok(!w2.t.deletedUsers.includes("u-only"), `kept: ${table}`);
  }

  const w3 = world();
  w3.t.emails["u-only"] = "boss@remotiv.test";
  await run(w3);
  assert.ok(!w3.t.deletedUsers.includes("u-only"), "the super admin's login is kept");
});

test("logins: a check that cannot be answered keeps the login, and says so", async () => {
  const w = world();
  w.t.failTables.add("talent_profiles");
  const { out, logs } = await run(w);
  assert.equal(out.done, true);
  assert.deepEqual(w.t.deletedUsers, []);
  assert.ok(
    out.warnings.includes(
      // u-owner and u-only (u-shared is proved in use by company B's membership).
      "2 logins could not be checked for other access and were kept; check them in Supabase Auth.",
    ),
  );
  assert.ok(
    logs.some((l) =>
      /a login was kept: its other access could not be checked \(check_failed\)/.test(l),
    ),
  );
});

// Negative control: count a failed deleteUser as deleted (drop the failed
// branch) and this test fails: the failure would be silent.
test("logins: a delete that fails is never silent: a warning for the super admin, a reason code in the log, no address", async () => {
  const w = world();
  w.t.deleteUserFails.add("u-only");
  const { out, logs } = await run(w);
  assert.equal(out.done, true, "the company is gone either way");
  assert.ok(
    out.warnings.includes("1 login could not be deleted; remove it in Supabase Auth."),
    "the super admin is told",
  );
  assert.ok(logs.some((l) => l === "[company-deletion] a login could not be deleted (500)"));
  assert.ok(logs.some((l) => /delete failed=1/.test(l)));
  for (const l of logs) {
    assert.ok(!l.includes("u-only") && !l.includes("@"), `an id or address logged: ${l}`);
  }
  assert.doesNotMatch(out.warnings.join(" "), /[\u2013\u2014]/);
});

test("logos: every object under company-logos/<company>/ goes, another company's stays; a removal storage does not confirm stops the call", async () => {
  const w = world();
  await run(w);
  assert.deepEqual([...w.t.objects], [`${B}/logo.png`]);

  const w2 = world();
  w2.t.logoRemoveFails = true;
  const { out } = await run(w2);
  assert.equal(out.ok, false);
  assert.ok(companyThere(w2.t, A), "the company row stays for the retry");
  assert.deepEqual(w2.t.deletedUsers, []);
});

test("an applicant that does not finish stops the call before the tail; one already gone is not a failure", async () => {
  const w = world();
  w.t.applicantVerdict = (id) =>
    id === "app-1" ? "Deletion started but is not finished yet." : null;
  const { out } = await run(w);
  assert.equal(out.ok, false);
  assert.equal(out.error, "Deletion started but is not finished yet.");
  assert.ok(!w.t.events.some((e) => e === "sweep" || e.startsWith("disconnect:")));
  assert.ok(companyThere(w.t, A));

  const w2 = world();
  w2.t.applicantVerdict = (id) => {
    if (id !== "app-1") return null;
    w2.t.tables.job_applications = w2.t.tables.job_applications.filter((a) => a.id !== id);
    return "gone";
  };
  const { out: out2 } = await run(w2);
  assert.equal(out2.done, true);
  assert.equal(out2.applicantsDeleted, 1);
});

test("calendar events the sweep could not remove are said, not hidden", async () => {
  const w = world();
  w.t.eventsLeft = 2;
  const { out } = await run(w);
  assert.equal(out.done, true);
  assert.match(out.warnings.join(" "), /2 calendar events for deleted applicants/);

  const w2 = world();
  w2.t.eventsLeft = null;
  assert.match(
    (await run(w2)).out.warnings.join(" "),
    /may still be in the hosts' Google Calendars/,
  );
});

test("production passes deleteForRemotiv: the default is the shared per-applicant pipeline", () => {
  const src = readFileSync(new URL("./company-deletion.ts", import.meta.url), "utf8");
  assert.match(src, /const deleteApplicant = opts\.deleteApplicant \?\? deleteForRemotiv;/);
  assert.doesNotMatch(
    src,
    /\.from\("job_applications"\)\s*\.delete\(\)/,
    "no bare row delete left",
  );
});

// Negative control: drop the disconnectAllForCompany pass before the company
// row and this test fails: the late connection would go with the cascade
// unrevoked.
test("a connection made after the per-member revoke step is still revoked and deleted before the company row", async () => {
  const w = world();
  const late = [];
  // A member connects Google while the logos are being removed (after 4c).
  w.t.onLogoRemove = () => {
    if (late.length === 0) late.push({ member_id: "m-only", provider: "google" });
  };
  w.t.companyDisconnect = async () => {
    const results = late.splice(0).map((c) => {
      w.t.events.push(`revoked:${c.member_id}`);
      return {
        provider: c.provider,
        deleted: true,
        revokedAtProvider: false,
        companyRowThere: companyThere(w.t, A),
      };
    });
    return { ok: true, results };
  };
  const { out } = await run(w);
  assert.equal(out.done, true);
  const ev = w.t.events;
  assert.ok(ev.includes("revoked:m-only"), "the late connection was revoked");
  assert.ok(
    ev.indexOf("revoked:m-only") < ev.indexOf("companies.delete"),
    "before the company row and its cascade",
  );
  assert.ok(
    ev.indexOf("logos.remove") < ev.indexOf(`company-disconnect:${A}`),
    "after the per-member pass and the logos",
  );
  assert.match(
    out.warnings.join(" "),
    /1 calendar connection\. /,
    "its unconfirmed revoke is said",
  );
});

test("the last calendar pass cannot read, or cannot delete a row: the call stops and the company row stays (resumable)", async () => {
  const w = world();
  w.t.companyDisconnect = async () => ({ ok: false });
  const { out } = await run(w);
  assert.equal(out.ok, false);
  assert.ok(companyThere(w.t, A));
  assert.deepEqual(w.t.deletedUsers, []);

  const w2 = world();
  w2.t.companyDisconnect = async () => ({
    ok: true,
    results: [{ provider: "google", deleted: false, revokedAtProvider: true }],
  });
  const { out: out2 } = await run(w2);
  assert.equal(out2.ok, false);
  assert.ok(companyThere(w2.t, A));

  // The retry, with the connection now deletable, finishes.
  w2.t.companyDisconnect = async () => ({ ok: true, results: [] });
  assert.equal((await run(w2)).out.done, true);
  assert.ok(!companyThere(w2.t, A));
});
