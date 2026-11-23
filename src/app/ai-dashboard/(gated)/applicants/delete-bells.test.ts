/**
 * The company applicant delete (#16, migration 071), its bells (#88) and
 * "Delete anyway".
 *
 *   node --test "src/app/ai-dashboard/(gated)/applicants/delete-bells.test.ts"
 *
 * Runs the shipped deleteApplication and deleteApplicationAnyway against a
 * fake database. 071's two functions are modelled as their SQL reads
 * (applicant-deletion.test.ts pins that SQL): Close marks the applicant and
 * hands back the session and final-booking ids; Finish refuses an applicant
 * not closed, then removes the sessions, the bells (by the applicant, and
 * orphaned ones by the links it is given) and the row, all or nothing. The
 * booking, interview-file and file steps are stubbed to record their calls;
 * their own tests cover them. Synthetic data.
 */
// @ts-nocheck - same reason as the other node:test files: Node's `.ts`
// specifier vs this tsconfig, which does not set allowImportingTsExtensions.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";
import { companyDeleteSource } from "../../../../test-support/company-delete-source.mjs";

register(new URL("../../../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../../../test-support/applicants-test-hook.mjs", import.meta.url));
register(
  `data:text/javascript,${encodeURIComponent(`
const STUBS = {
  "@/lib/application-files": "export async function removeApplicationFiles() { globalThis.__del.events.push('files'); return globalThis.__del.files.shift() ?? { ok: true }; }",
  "@/lib/interviews/application-deletion": "export async function removeInterviewFiles(service, ids) { globalThis.__del.events.push('interview-files:' + ids.length); return globalThis.__del.interviewFiles.shift() ?? { ok: true }; }",
  "@/lib/calendar/bookings": "export async function cancelScreeningBookingsForDeletion(companyId, applicationId, opts) { globalThis.__del.events.push('bookings:' + (opts?.anyway === true ? 'anyway' : 'ordinary')); return globalThis.__del.bookings.shift() ?? { ok: true, cancelled: 0 }; }",
};
export async function resolve(specifier, context, next) {
  if (specifier in STUBS) return { url: "data:text/javascript," + encodeURIComponent(STUBS[specifier]), shortCircuit: true };
  return next(specifier, context);
}`)}`,
);

const { fakeService } = await import("../../../../test-support/fake-postgrest.mjs");
const { deleteApplication, deleteApplicationAnyway, fetchPendingDeletions } = await import(
  "./actions.ts"
);

const CO = "c0000000-0000-0000-0000-000000000001";
const OTHER_CO = "c0000000-0000-0000-0000-000000000002";
const APP = "a0000000-0000-0000-0000-0000000aaaaa";
const OTHER_APP = "a0000000-0000-0000-0000-0000000bbbbb";
const JOB = "j0000000-0000-0000-0000-000000000001";
const SESSION = "s0000000-0000-0000-0000-0000000sssss";
const hrefOf = (id) => `/ai-dashboard/applicants?applicant=${id}`;
const pageOf = (sessionId) => `/ai-dashboard/interviews/${sessionId}`;
const RAW = { code: "57014", message: 'canceling statement due to statement timeout on "x"' };

const bell = (id, company_id, application_id, href = hrefOf(application_id)) => ({
  id,
  company_id,
  application_id,
  href,
});

/**
 * One world. `app` is the applicant row; `rpcFails` makes Close or Finish
 * answer with an error, once each listed.
 */
function world({
  app = {},
  role = "owner",
  team = [],
  bookings = [],
  files = [],
  interviewFiles = [],
  rpcFails = [],
  recordFails = false,
  sessions = [SESSION],
  finalBookings = [],
  pendingRead = null,
} = {}) {
  const events = [];
  const logged = [];
  const inserted = [];
  const jobs = [];
  const fails = [...rpcFails];
  const state = {
    row: {
      id: APP,
      company_id_snapshot: CO,
      cv_path: "x/a.pdf",
      job_id: JOB,
      first_name: "Candidatea",
      last_name: "Testperson",
      email: "candidate.a@example.test",
      deletion_started_at: null,
      deletion_calendar_failed_at: null,
      ...app,
    },
    sessions: [...sessions],
    bells: [
      bell("b1", CO, APP),
      bell("b2", CO, APP),
      bell("b3", CO, OTHER_APP),
      bell("b4", OTHER_CO, APP),
      bell("o1", OTHER_CO, null, hrefOf(APP)),
      bell("o2", CO, null, hrefOf(APP)), // orphaned, this applicant's link: goes
      bell("o3", CO, null, pageOf(SESSION)), // orphaned interview_expired: goes
      bell("o4", CO, null, hrefOf(OTHER_APP)), // another applicant's: stays
    ],
  };
  globalThis.__del = {
    events,
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
      if (fails[0] === "close") {
        fails.shift();
        return { data: null, error: RAW };
      }
      const r = state.row;
      if (!r || r.id !== a.p_application_id || r.company_id_snapshot !== a.p_company_id) {
        return { data: { outcome: "not_found" }, error: null };
      }
      const first = r.deletion_started_at === null;
      r.deletion_started_at ??= "2026-11-20T10:00:00.000Z";
      return {
        data: {
          outcome: "closed",
          first,
          session_ids: state.sessions,
          final_booking_ids: finalBookings,
        },
        error: null,
      };
    }
    if (table === "rpc:finish_application_deletion") {
      const a = calls[0][1];
      events.push("finish");
      state.finishArgs = a;
      if (fails[0] === "finish") {
        fails.shift();
        return { data: null, error: RAW };
      }
      const r = state.row;
      if (!r || r.company_id_snapshot !== a.p_company_id) {
        return { data: { outcome: "not_found" }, error: null };
      }
      if (!r.deletion_started_at) return { data: { outcome: "not_closed" }, error: null };
      state.sessions = [];
      state.bells = state.bells.filter(
        (b) =>
          !(
            b.company_id === a.p_company_id &&
            (b.application_id === a.p_application_id ||
              (b.application_id === null && a.p_hrefs.includes(b.href)))
          ),
      );
      state.row = null;
      return { data: { outcome: "deleted" }, error: null };
    }
    if (table === "job_applications" && op === "select") {
      if (pendingRead) return pendingRead(calls);
      const r = state.row;
      if (!r || r.id !== eq("id")) return { data: null, error: null };
      const company = eq("company_id_snapshot");
      if (company !== undefined && r.company_id_snapshot !== company) {
        return { data: null, error: null };
      }
      return { data: { ...r }, error: null };
    }
    if (table === "job_applications" && op === "update") {
      events.push("record-calendar-failure");
      if (recordFails) return { data: null, error: RAW };
      const r = state.row;
      if (
        r &&
        r.id === eq("id") &&
        r.company_id_snapshot === eq("company_id_snapshot") &&
        r.deletion_started_at &&
        !r.deletion_calendar_failed_at
      ) {
        Object.assign(r, calls[0][1]);
        return { data: [{ id: r.id }], error: null };
      }
      return { data: [], error: null };
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
          { id: "m-actor", role: "recruiter" },
        ],
        error: null,
      };
    }
    if (table === "job_hiring_team") {
      const hit = team.find((t) => t.job_id === eq("job_id") && t.member_id === eq("member_id"));
      return { data: hit ?? (op === "select" && !eq("member_id") ? [] : null), error: null };
    }
    throw new Error(`unexpected ${op} on ${table}`);
  });
  globalThis.__applicantsServiceForTests = () => service;
  globalThis.__applicantsCtxForTests = {
    companyId: CO,
    memberId: "m-actor",
    memberName: "Team Member",
    role,
    company: { id: CO, name: "Acme" },
  };
  const quietly = async (fn) => {
    const real = console.error;
    console.error = (...a) => logged.push(a.map(String).join(" "));
    try {
      return await fn();
    } finally {
      console.error = real;
    }
  };
  return {
    state,
    events,
    logged,
    inserted,
    jobs,
    service,
    run: () => quietly(() => deleteApplication(APP)),
    anyway: (opts) => quietly(() => deleteApplicationAnyway(APP, opts)),
  };
}

const SRC = companyDeleteSource();
const constant = (name) => {
  const m = new RegExp(`const ${name} =\\s*"([^"]+)";`).exec(SRC);
  assert.ok(m, `${name} defined`);
  return m[1];
};
const CALENDAR_PENDING = constant("DELETION_CALENDAR_PENDING");
const PENDING = constant("DELETION_PENDING");
const NEEDS_ACK = constant("ANYWAY_NEEDS_ACK");
const NOT_AVAILABLE = constant("ANYWAY_NOT_AVAILABLE");
const EVENT_LEFT = constant("CALENDAR_EVENT_LEFT");
const NOT_FOUND = "Applicant not found in your workspace.";

/* ── the order, and the bells ────────────────────────────────── */

test("D1. Close, then Google, then the files, then Finish, then the deletion bell: in that order", async () => {
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
});

test("D2. Finish takes this applicant's bells and the orphaned ones that name them, and nothing else (#88)", async () => {
  const w = world();
  await w.run();
  assert.deepEqual(w.state.bells.map((b) => b.id).sort(), ["b3", "b4", "o1", "o4"]);
  assert.deepEqual(w.state.finishArgs.p_hrefs, [hrefOf(APP), pageOf(SESSION)]);
  assert.equal(w.state.finishArgs.p_company_id, CO);
  assert.equal(w.state.finishArgs.p_application_id, APP);
});

test("D3. Close fails or finds nothing: nothing else runs, and the database's words never reach the user", async () => {
  let w = world({ rpcFails: ["close"] });
  const res = await w.run();
  assert.equal(res.success, false);
  assert.doesNotMatch(res.error, /canceling|statement|timeout/);
  assert.deepEqual(w.events, ["close"]);
  w = world({ app: { company_id_snapshot: OTHER_CO } });
  assert.deepEqual(await w.run(), { success: false, error: NOT_FOUND });
  assert.deepEqual(w.events, [], "another company's applicant: not even closed");
});

/* ── Google connected but failing (#61 kept, #16) ───────────── */

test("D4. Google connected, does not confirm: blocked after Close; the failure is RECORDED; no file, no Finish, no bell", async () => {
  const w = world({ bookings: [{ ok: false, failure: "calendar" }] });
  assert.deepEqual(await w.run(), { success: false, error: CALENDAR_PENDING });
  assert.deepEqual(w.events, ["close", "bookings:ordinary", "record-calendar-failure"]);
  assert.ok(w.state.row.deletion_started_at, "links closed: the applicant is marked");
  assert.ok(w.state.row.deletion_calendar_failed_at, "durably recorded on the row");
  assert.deepEqual(w.inserted, []);
});

test("D5. the ordinary delete NEVER bypasses: a second Delete after a recorded failure is still the ordinary step, and still blocked", async () => {
  const w = world({
    bookings: [
      { ok: false, failure: "calendar" },
      { ok: false, failure: "calendar" },
    ],
  });
  await w.run();
  assert.deepEqual(await w.run(), { success: false, error: CALENDAR_PENDING });
  assert.ok(!w.events.includes("bookings:anyway"));
  assert.ok(!w.events.includes("finish"));
  // In source: the one `anyway: true` is in deleteApplicationAnyway.
  const flow = SRC.slice(SRC.indexOf("export async function deleteApplication("));
  const anywayFn = flow.indexOf("export async function deleteApplicationAnyway(");
  assert.equal((flow.match(/anyway: true/g) ?? []).length, 1);
  assert.ok(flow.indexOf("anyway: true") > anywayFn);
  assert.ok(flow.indexOf("anyway: false") < anywayFn);
});

test("D6. the failure could not be recorded: still blocked with the same words, and Delete anyway stays unavailable", async () => {
  const w = world({ bookings: [{ ok: false, failure: "calendar" }], recordFails: true });
  assert.deepEqual(await w.run(), { success: false, error: CALENDAR_PENDING });
  assert.equal(w.state.row.deletion_calendar_failed_at, null);
  assert.deepEqual(await w.anyway({ acknowledgeCalendarEvent: true }), {
    success: false,
    error: NOT_AVAILABLE,
  });
  assert.ok(!w.events.includes("finish"));
});

/* ── failed, then retried ─────────────────────────────────────── */

test("D7. a file left: pending, no Finish; the retry closes again (nothing reopens), finishes once, one bell", async () => {
  const w = world({ files: [{ ok: false, error: "x" }] });
  assert.deepEqual(await w.run(), { success: false, error: PENDING });
  assert.ok(!w.events.includes("finish"));
  assert.ok(w.state.row.deletion_started_at);
  assert.deepEqual(await w.run(), { success: true, data: undefined });
  assert.equal(w.events.filter((e) => e === "close").length, 2);
  assert.equal(w.events.filter((e) => e === "finish").length, 1);
  assert.equal(w.inserted.length, 1);
});

test("D8. Finish fails: pending, the code only in the log, no bell; the retry finishes", async () => {
  const w = world({ rpcFails: ["finish"] });
  assert.deepEqual(await w.run(), { success: false, error: PENDING });
  assert.ok(w.logged.some((l) => l.includes("finish failed: 57014")));
  assert.ok(!w.logged.some((l) => l.includes("canceling")));
  assert.deepEqual(w.inserted, []);
  assert.deepEqual(await w.run(), { success: true, data: undefined });
  assert.equal(w.state.row, null);
});

test("D9. interview files left: pending before any other file or Finish", async () => {
  const w = world({ interviewFiles: [{ ok: false, error: "x" }] });
  assert.deepEqual(await w.run(), { success: false, error: PENDING });
  assert.deepEqual(w.events, ["close", "bookings:ordinary", "interview-files:1"]);
});

/* ── final rounds ─────────────────────────────────────────────── */

test("D10. each cancelled final-round booking's recording bot is told to stand down", async () => {
  const w = world({ finalBookings: ["fb-1", "fb-2"] });
  await w.run();
  assert.deepEqual(
    w.jobs.map((j) => [j.type, j.payload.action, j.payload.bookingId, j.company_id]),
    [
      ["final_bot_sync", "sync", "fb-1", CO],
      ["final_bot_sync", "sync", "fb-2", CO],
    ],
  );
});

/* ── Delete anyway ────────────────────────────────────────────── */

const failedOnce = {
  deletion_started_at: "2026-11-20T10:00:00.000Z",
  deletion_calendar_failed_at: "2026-11-20T10:00:01.000Z",
};

test("A1. Delete anyway, with the flag and a recorded failure: the anyway step, then the files and Finish; the note", async () => {
  const w = world({ app: failedOnce, bookings: [{ ok: true, cancelled: 0, eventsLeft: 1 }] });
  assert.deepEqual(await w.anyway({ acknowledgeCalendarEvent: true }), {
    success: true,
    data: { calendarNote: EVENT_LEFT },
  });
  assert.deepEqual(w.events, [
    "close",
    "bookings:anyway",
    "interview-files:1",
    "files",
    "finish",
    "bell:deleted",
  ]);
});

test("A2. Delete anyway without the explicit flag: refused, nothing touched", async () => {
  for (const opts of [
    undefined,
    {},
    { acknowledgeCalendarEvent: false },
    { acknowledgeCalendarEvent: "true" },
  ]) {
    const w = world({ app: failedOnce });
    assert.deepEqual(await w.anyway(opts), { success: false, error: NEEDS_ACK });
    assert.deepEqual(w.events, [], JSON.stringify(opts));
  }
});

test("A3. Delete anyway with no recorded failure: refused (not marked, or marked for another reason)", async () => {
  for (const app of [{}, { deletion_started_at: "2026-11-20T10:00:00.000Z" }]) {
    const w = world({ app });
    assert.deepEqual(await w.anyway({ acknowledgeCalendarEvent: true }), {
      success: false,
      error: NOT_AVAILABLE,
    });
    assert.deepEqual(w.events, []);
  }
});

test("A4. Delete anyway: another company's applicant, or a recruiter not on its job, is not found", async () => {
  let w = world({ app: { ...failedOnce, company_id_snapshot: OTHER_CO } });
  assert.deepEqual(await w.anyway({ acknowledgeCalendarEvent: true }), {
    success: false,
    error: NOT_FOUND,
  });
  assert.deepEqual(w.events, []);
  w = world({ app: failedOnce, role: "recruiter", team: [] });
  assert.deepEqual(await w.anyway({ acknowledgeCalendarEvent: true }), {
    success: false,
    error: NOT_FOUND,
  });
  assert.deepEqual(w.events, []);
  w = world({
    app: failedOnce,
    role: "recruiter",
    team: [{ job_id: JOB, member_id: "m-actor" }],
  });
  assert.equal((await w.anyway({ acknowledgeCalendarEvent: true })).success, true);
});

test("A5. Delete anyway checks the delete permission the delete does, and reads its applicant on this company", () => {
  const fn = SRC.slice(
    SRC.indexOf("export async function deleteApplicationAnyway("),
    SRC.indexOf("export async function fetchPendingDeletions("),
  );
  assert.match(fn, /await requireCompanyRole\("owner", "admin", "recruiter"\)/);
  const del = SRC.slice(SRC.indexOf("export async function deleteApplication("));
  assert.match(del, /await requireCompanyRole\("owner", "admin", "recruiter"\)/);
  assert.match(fn, /\.eq\("company_id_snapshot", ctx\.companyId\)/);
  assert.match(fn, /roleAllowsJobAction\(ctx, row\.job_id \?\? ""\)/);
  assert.match(fn, /opts\?\.acknowledgeCalendarEvent !== true/);
  assert.match(fn, /!row\.deletion_started_at \|\| !row\.deletion_calendar_failed_at/);
});

/* ── the pending list ─────────────────────────────────────────── */

test("P1. pending deletions: this company's marked applicants, with whether Delete anyway applies", async () => {
  let seen = [];
  world({
    pendingRead: (calls) => {
      seen = calls;
      return {
        data: [
          { id: "x1", deletion_calendar_failed_at: null },
          { id: "x2", deletion_calendar_failed_at: "2026-11-20T10:00:00.000Z" },
        ],
        error: null,
      };
    },
  });
  assert.deepEqual(await fetchPendingDeletions(), [
    { id: "x1", calendarFailed: false },
    { id: "x2", calendarFailed: true },
  ]);
  assert.ok(seen.some((c) => c[0] === "eq" && c[1] === "company_id_snapshot" && c[2] === CO));
  assert.ok(seen.some((c) => c[0] === "not" && c[1] === "deletion_started_at"));
  // Before 071 the column does not exist: nothing pending, nothing thrown.
  world({ pendingRead: () => ({ data: null, error: { code: "42703" } }) });
  const real = console.error;
  console.error = () => {};
  try {
    assert.deepEqual(await fetchPendingDeletions(), []);
  } finally {
    console.error = real;
  }
});

/* ── copy ─────────────────────────────────────────────────────── */

test("C1. the deletion bell names nobody; every message has no dashes", async () => {
  const w = world();
  await w.run();
  const text = JSON.stringify(w.inserted);
  for (const part of ["Candidatea", "Testperson", "candidate.a@example.test"]) {
    assert.ok(!text.includes(part), part);
  }
  for (const copy of [CALENDAR_PENDING, PENDING, NEEDS_ACK, NOT_AVAILABLE, EVENT_LEFT]) {
    assert.doesNotMatch(copy, /[–—]|\s-\s/, copy);
  }
});

test("C2. the interview-page link Finish clears is the one expiry.ts builds (read, not changed)", () => {
  const expiry = readFileSync(
    new URL("../../../../lib/interviews/expiry.ts", import.meta.url),
    "utf8",
  );
  assert.match(expiry, /`\/ai-dashboard\/interviews\/\$\{[a-zA-Z.]+\}`/);
  assert.match(
    SRC,
    /const interviewPageHref = \(sessionId: string\) => `\/ai-dashboard\/interviews\/\$\{sessionId\}`;/,
  );
});
