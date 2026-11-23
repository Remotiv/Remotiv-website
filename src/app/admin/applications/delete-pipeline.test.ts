/**
 * #69 step 4: the super admin's applicant delete runs the company delete's
 * safe pipeline (#16, migration 071) for an internal company's applicant:
 * Close, then Google, then storage, then Finish, all by the APPLICATION'S
 * company. A Remotiv-owned row (no company) keeps the file-then-row delete.
 *
 *   node --test src/app/admin/applications/delete-pipeline.test.ts
 *
 * deleteApplication and deleteApplicationAnyway run as shipped, with the
 * shared completeDeletion (lib/applicant-deletion-complete.ts) and the real
 * queue and bell writers, against a fake database that answers 071's Close
 * and Finish the way the SQL does (applicant-deletion.test.ts pins that SQL).
 * The calendar, interview-file and file helpers are stubbed to record which
 * company they were handed; their own behaviour has its own tests. Synthetic.
 */
// @ts-nocheck - same reason as the other node:test files.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../../test-support/fake-service-client-hook.mjs", import.meta.url));
register(
  `data:text/javascript,${encodeURIComponent(`
const STUBS = {
  "next/cache": "export function revalidatePath(p) { globalThis.__del.revalidated.push(p); }",
  "@/app/admin/lib/role-guards": [
    "export async function requireSuperAdmin() {",
    "  const ctx = globalThis.__del.admin;",
    "  if (!ctx) throw new Error('Not authenticated');",
    "  if (ctx.role !== 'super_admin') throw new Error('Forbidden: super_admin role required');",
    "  return ctx;",
    "}",
    "export async function requireAdmin() { return globalThis.__del.admin; }",
  ].join("\\n"),
  "@/lib/admin-scope": "export async function adminApplicationScope() { return globalThis.__del.scope; }",
  "@/lib/avatars": "export function getAvatarUrl() { return null; }",
  "@/lib/application-files": "export async function removeApplicationFiles(service, companyId, applicationId, cvPath) { globalThis.__del.events.push('files'); globalThis.__del.companies.push(['files', companyId]); return globalThis.__del.files.shift() ?? { ok: true }; }",
  "@/lib/interviews/application-deletion": "export async function removeInterviewFiles(service, ids) { globalThis.__del.events.push('interview-files:' + ids.length); return globalThis.__del.interviewFiles.shift() ?? { ok: true }; }",
  "@/lib/calendar/bookings": "export async function cancelScreeningBookingsForDeletion(companyId, applicationId, opts) { globalThis.__del.events.push('bookings:' + (opts?.anyway === true ? 'anyway' : 'ordinary')); globalThis.__del.companies.push(['bookings', companyId]); return globalThis.__del.bookings.shift() ?? { ok: true, cancelled: 1 }; }",
};
export async function resolve(specifier, context, next) {
  if (specifier in STUBS) return { url: "data:text/javascript," + encodeURIComponent(STUBS[specifier]), shortCircuit: true };
  return next(specifier, context);
}`)}`,
);

const { fakeService } = await import("../../../test-support/fake-postgrest.mjs");
const { deleteApplication, deleteApplicationAnyway } = await import("./actions.ts");
/** The shared module's own sentences, read from its source (it is server-only). */
const LIB = readFileSync(
  new URL("../../../lib/applicant-deletion-complete.ts", import.meta.url),
  "utf8",
);
const constant = (name) => new RegExp(`const ${name} =\\s*"([^"]+)";`).exec(LIB)[1];
const DELETION_CALENDAR_PENDING = constant("DELETION_CALENDAR_PENDING");
const DELETION_PENDING_FOR_TESTS = constant("DELETION_PENDING");
const ANYWAY_NEEDS_ACK = constant("ANYWAY_NEEDS_ACK");
const CALENDAR_EVENT_LEFT = constant("CALENDAR_EVENT_LEFT");

/** Two of Remotiv's internal companies: the admin sees both, the applicant is B's. */
const CO_A = "c0000000-0000-0000-0000-00000000000a";
const CO_B = "c0000000-0000-0000-0000-00000000000b";
const APP = "a0000000-0000-0000-0000-0000000aaaaa";
const JOB = "j0000000-0000-0000-0000-000000000001";
const SESSION = "s0000000-0000-0000-0000-0000000sssss";
const SCOPE = `company_id_snapshot.is.null,company_id_snapshot.in.(${CO_A},${CO_B})`;
const SUPER = { user: { id: "u-admin", email: "admin@example.invalid" }, role: "super_admin" };
const NOT_FOUND = "Application not found.";

/** The two forms adminApplicationScope() builds: company_id_snapshot.is.null and .in.(...). */
function inScope(company, or) {
  return or.split(/,(?![^(]*\))/).some((term) => {
    if (term === "company_id_snapshot.is.null") return company === null;
    const m = /^company_id_snapshot\.in\.\((.*)\)$/.exec(term);
    if (m) return company !== null && m[1].split(",").includes(company);
    throw new Error(`fake: unknown scope term ${term}`);
  });
}

function world({
  company = CO_B,
  admin = SUPER,
  bookings = [],
  files = [],
  interviewFiles = [],
  finalBookings = [],
} = {}) {
  const events = [];
  const inserted = [];
  const jobs = [];
  const state = {
    row: {
      id: APP,
      company_id_snapshot: company,
      cv_path: "x/a.pdf",
      job_id: JOB,
      deletion_started_at: null,
      deletion_calendar_failed_at: null,
    },
    finishArgs: [],
    closeArgs: [],
  };
  globalThis.__del = {
    events,
    companies: [],
    revalidated: [],
    admin,
    scope: SCOPE,
    bookings: [...bookings],
    files: [...files],
    interviewFiles: [...interviewFiles],
  };
  const service = fakeService((table, calls) => {
    const op = calls[0]?.[0];
    const eq = (c) => calls.find((x) => x[0] === "eq" && x[1] === c)?.[2];
    if (table === "rpc:close_application_for_deletion") {
      const a = calls[0][1];
      events.push("close");
      state.closeArgs.push(a);
      const r = state.row;
      // 071: matched by company_id_snapshot = p_company_id; a null snapshot never matches.
      if (!r || r.id !== a.p_application_id || r.company_id_snapshot !== a.p_company_id) {
        return { data: { outcome: "not_found" }, error: null };
      }
      const first = r.deletion_started_at === null;
      r.deletion_started_at ??= "2026-11-23T10:00:00.000Z";
      return {
        data: {
          outcome: "closed",
          first,
          session_ids: [SESSION],
          final_booking_ids: finalBookings,
        },
        error: null,
      };
    }
    if (table === "rpc:finish_application_deletion") {
      const a = calls[0][1];
      events.push("finish");
      state.finishArgs.push(a);
      const r = state.row;
      if (!r || r.company_id_snapshot !== a.p_company_id) {
        return { data: { outcome: "not_found" }, error: null };
      }
      if (!r.deletion_started_at) return { data: { outcome: "not_closed" }, error: null };
      state.row = null;
      return { data: { outcome: "deleted" }, error: null };
    }
    if (table === "job_applications" && op === "select") {
      const r = state.row;
      if (!r || r.id !== eq("id")) return { data: null, error: null };
      const company = eq("company_id_snapshot");
      if (company !== undefined && r.company_id_snapshot !== company) {
        return { data: null, error: null };
      }
      // .or(scope) is applied as PostgREST would: a row outside it is not returned.
      const or = calls.find((x) => x[0] === "or")?.[1];
      if (or !== undefined && !inScope(r.company_id_snapshot, or))
        return { data: null, error: null };
      return { data: { ...r }, error: null };
    }
    if (table === "job_applications" && op === "update") {
      events.push("record-calendar-failure");
      const r = state.row;
      if (r && r.id === eq("id") && r.company_id_snapshot === eq("company_id_snapshot")) {
        Object.assign(r, calls[0][1]);
        return { data: [{ id: r.id }], error: null };
      }
      return { data: [], error: null };
    }
    if (table === "job_applications" && op === "delete") {
      events.push("row:delete");
      state.row = null;
      return { data: null, error: null };
    }
    if (table === "background_jobs" && op === "insert") {
      jobs.push(calls[0][1]);
      return { data: { id: `job-${jobs.length}` }, error: null };
    }
    if (table === "notifications_company" && op === "insert") {
      events.push("bell:deleted");
      inserted.push(...[].concat(calls[0][1]));
      return { data: null, error: null };
    }
    if (table === "company_members") {
      return {
        data: [
          { id: "m-owner", role: "owner" },
          { id: "m-admin", role: "admin" },
        ],
        error: null,
      };
    }
    if (table === "job_hiring_team") return { data: [], error: null };
    throw new Error(`unexpected ${op} on ${table}`);
  });
  globalThis.__fakeServiceClientForTests = () => service;
  const quietly = async (fn) => {
    const real = console.error;
    console.error = () => {};
    try {
      return await fn();
    } finally {
      console.error = real;
    }
  };
  return {
    state,
    events,
    inserted,
    jobs,
    service,
    run: () => quietly(() => deleteApplication(APP)),
    anyway: (opts) => quietly(() => deleteApplicationAnyway(APP, opts)),
  };
}

/* ── the pipeline ─────────────────────────────────────────────── */

test("P1. super admin, an internal company's applicant: Close, Google, interview files, files, Finish, bell; the row is gone", async () => {
  const w = world();
  assert.deepEqual(await w.run(), { success: true, data: undefined });
  assert.deepEqual(w.events, [
    "close",
    "bookings:ordinary",
    "interview-files:1",
    "files",
    "finish",
    "bell:deleted",
  ]);
  assert.equal(w.state.row, null);
  assert.ok(globalThis.__del.revalidated.includes("/admin/applications"));
  // The bell goes to the application's company and names no person.
  assert.ok(w.inserted.length > 0);
  for (const b of w.inserted) {
    assert.equal(b.company_id, CO_B);
    assert.match(b.body, /^A Remotiv admin permanently removed them/);
  }
  // The admin is no member of the company, so no member is left out of it.
  assert.deepEqual(w.inserted.map((b) => b.member_id).sort(), ["m-admin", "m-owner"]);
});

test("P2. Google does not confirm: kept, the honest message and Delete anyway offered, the failure recorded, no file touched", async () => {
  const w = world({ bookings: [{ ok: false, failure: "calendar" }] });
  assert.deepEqual(await w.run(), {
    success: false,
    error: DELETION_CALENDAR_PENDING,
    anywayAvailable: true,
  });
  assert.deepEqual(w.events, ["close", "bookings:ordinary", "record-calendar-failure"]);
  assert.ok(w.state.row, "the applicant is still there");
  assert.ok(w.state.row.deletion_started_at, "links closed: marked");
  assert.ok(w.state.row.deletion_calendar_failed_at, "the failure is recorded");
});

test("P3. Delete anyway: refused without the explicit acknowledgement; with it, finishes, and the event left is said", async () => {
  const w = world({
    bookings: [
      { ok: false, failure: "calendar" },
      { ok: true, cancelled: 0, eventsLeft: true },
    ],
  });
  await w.run();
  const before = w.events.length;
  assert.deepEqual(await w.anyway(), { success: false, error: ANYWAY_NEEDS_ACK });
  assert.equal(w.events.length, before, "nothing ran without the click's acknowledgement");
  assert.deepEqual(await w.anyway({ acknowledgeCalendarEvent: true }), {
    success: true,
    data: { calendarNote: CALENDAR_EVENT_LEFT },
  });
  assert.deepEqual(w.events.slice(before), [
    "close",
    "bookings:anyway",
    "interview-files:1",
    "files",
    "finish",
    "bell:deleted",
  ]);
  assert.equal(w.state.row, null);
});

test("P4. a half-finished delete resumes: a file left stops before Finish; Delete again closes again and finishes once", async () => {
  const w = world({
    files: [{ ok: false, error: "Some files could not be deleted yet - try again." }],
  });
  const first = await w.run();
  assert.equal(first.success, false);
  assert.equal(first.error, DELETION_PENDING_FOR_TESTS);
  assert.equal(first.anywayAvailable, undefined, "not a calendar failure: no Delete anyway");
  assert.ok(w.state.row.deletion_started_at);
  assert.ok(!w.events.includes("finish"));
  assert.deepEqual(await w.run(), { success: true, data: undefined });
  assert.equal(w.events.filter((e) => e === "finish").length, 1);
  assert.equal(w.events.filter((e) => e === "bell:deleted").length, 1);
  assert.equal(w.state.row, null);
});

test("P5. a company with no Google connection: deleted, and the admin is told the event may still be in that calendar", async () => {
  const w = world({ bookings: [{ ok: true, cancelled: 0, eventsLeft: true }] });
  assert.deepEqual(await w.run(), { success: true, data: { calendarNote: CALENDAR_EVENT_LEFT } });
  assert.equal(w.state.row, null);
});

/* ── Remotiv's own board ─────────────────────────────────────── */

test("P6. a Remotiv-owned row (no company): no Close, no calendar, no bell; the file, then the row", async () => {
  const w = world({ company: null });
  assert.deepEqual(await w.run(), { success: true, data: undefined });
  assert.deepEqual(w.events, ["files", "row:delete"]);
  assert.deepEqual(globalThis.__del.companies, [["files", null]]);
  assert.equal(w.state.row, null);
  const v = world({ company: null });
  assert.deepEqual(await v.anyway({ acknowledgeCalendarEvent: true }), {
    success: false,
    error: NOT_FOUND,
  });
  assert.deepEqual(v.events, [], "nothing to go past: no calendar");
});

/* ── who may, and whose company ──────────────────────────────── */

test("P7. not a super admin, or not an admin at all: refused before any read, Close or step", async () => {
  for (const admin of [{ ...SUPER, role: "admin" }, { ...SUPER, role: "viewer" }, null]) {
    for (const call of ["run", "anyway"]) {
      const w = world({ admin });
      await assert.rejects(
        call === "run" ? w.run() : w.anyway({ acknowledgeCalendarEvent: true }),
        /Forbidden|Not authenticated/,
      );
      assert.deepEqual(w.events, [], `${call}: no step ran`);
      assert.deepEqual(w.service.queries, [], `${call}: no database read`);
      assert.deepEqual(w.service.rpcs, [], `${call}: no Close`);
    }
  }
});

test("P8. cross-company: every step goes by the APPLICATION'S company (B), never another the admin can see (A)", async () => {
  const w = world({ company: CO_B, finalBookings: ["fb-1"] });
  assert.equal((await w.run()).success, true);
  assert.deepEqual(
    w.state.closeArgs.map((a) => a.p_company_id),
    [CO_B],
  );
  assert.deepEqual(
    w.state.finishArgs.map((a) => a.p_company_id),
    [CO_B],
  );
  assert.deepEqual(globalThis.__del.companies, [
    ["bookings", CO_B],
    ["files", CO_B],
  ]);
  assert.equal(w.jobs.length, 1, "the final-round recording bot is told to stand down");
  assert.equal(w.jobs[0].company_id, CO_B, "the recording bot job");
  assert.ok(w.inserted.length > 0);
  assert.ok(
    w.inserted.every((b) => b.company_id === CO_B),
    "the bell",
  );
});

test("P10. a CUSTOMER company's applicant (outside the admin's scope): not found, and nothing runs for that company", async () => {
  const CUSTOMER = "c0000000-0000-0000-0000-0000000c0570";
  for (const call of ["run", "anyway"]) {
    const w = world({ company: CUSTOMER });
    const before = structuredClone(w.state.row);
    const res = call === "run" ? await w.run() : await w.anyway({ acknowledgeCalendarEvent: true });
    assert.deepEqual(res, { success: false, error: NOT_FOUND }, call);
    assert.deepEqual(w.service.rpcs, [], `${call}: no Close, no Finish`);
    assert.deepEqual(w.events, [], `${call}: no booking, file, interview, Finish or bell step`);
    assert.deepEqual(globalThis.__del.companies, [], `${call}: no helper handed any company`);
    assert.deepEqual(w.inserted, [], `${call}: no bell`);
    assert.deepEqual(w.jobs, [], `${call}: no job`);
    assert.deepEqual(
      w.service.queries.map((q) => q.table),
      ["job_applications"],
      `${call}: only the scoped read touched the database`,
    );
    assert.ok(
      w.service.queries[0].calls.some((c) => c[0] === "or" && c[1] === SCOPE),
      `${call}: the read carried the admin scope`,
    );
    assert.deepEqual(w.state.row, before, `${call}: the row is untouched`);
  }
});

/* ── the source: one guard first, and the shared pipeline ────────── */

test("P9. both actions check super admin first, and run the shared completeDeletion after 071's Close", () => {
  const src = readFileSync(new URL("./actions.ts", import.meta.url), "utf8");
  for (const fn of ["deleteApplication", "deleteApplicationAnyway"]) {
    const start = src.indexOf(`export async function ${fn}(`);
    const body = src.slice(start, src.indexOf("\n}\n", start));
    const firstStatement = body
      .slice(body.indexOf("{\n") + 2)
      .trim()
      .split("\n")[0];
    assert.equal(firstStatement, "await requireSuperAdmin();", fn);
  }
  // Both company paths hand the row's own company to the shared pipeline.
  assert.equal(
    (src.match(/applicationCompany: (target|row)\.company_id_snapshot,/g) ?? []).length,
    2,
  );
  const remotiv = LIB.slice(LIB.indexOf("export async function deleteForRemotiv("));
  const close = remotiv.indexOf(
    "closeApplicationForDeletion(service, companyId, target.applicationId)",
  );
  assert.ok(
    close > 0 && remotiv.indexOf("completeDeletion(") > close,
    "Close, then the shared steps",
  );
  assert.match(src, /\bdeleteForRemotiv,[\s\S]*?\} from "@\/lib\/applicant-deletion-complete";/);
  assert.doesNotMatch(src, /deleteApplicationInterviews|\.from\("notifications_company"\)/);
});
