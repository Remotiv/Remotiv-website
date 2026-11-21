/**
 * #56: the lasting alert for a calendar event a deleted applicant may have
 * left in the host's Google Calendar (cleanups.ts, migration 070).
 *
 *   node --test src/lib/calendar/cleanups.test.ts
 *
 * cancelScreeningBookingsForDeletion, the cleanup module and the bell's copy
 * run as shipped against the Final Human Interview fake database; the calendar
 * provider and the token seam are fakes that record their calls. Synthetic data.
 */
// @ts-nocheck - same reason as the other node:test files: Node's `.ts`
// specifier vs this tsconfig, which does not set allowImportingTsExtensions.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";

process.env.GOOGLE_CALENDAR_CLIENT_SECRET = "test-only-calendar-secret";

register(new URL("../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../test-support/fake-service-client-hook.mjs", import.meta.url));
register(
  `data:text/javascript,${encodeURIComponent(`
const STUBS = {
  "./provider": "export function getProvider(id) { return globalThis.__cuProvider?.(id) ?? null; }",
  "./connections": "export async function getAccessToken(memberId) { globalThis.__cuCalls.push(['token', memberId]); return globalThis.__cuToken ?? null; }",
};
export async function resolve(specifier, context, next) {
  const parent = String(context.parentURL ?? "");
  if (specifier in STUBS && (parent.includes("/lib/calendar/bookings.ts") || parent.includes("/lib/calendar/cleanups.ts"))) {
    return { url: "data:text/javascript," + encodeURIComponent(STUBS[specifier]), shortCircuit: true };
  }
  return next(specifier, context);
}`)}`,
);

const { CO, APP, JOB, finalInterviewWorld, makeDb } = await import(
  "../../test-support/final-interview-world.mjs"
);
const { cancelScreeningBookingsForDeletion } = await import("./bookings.ts");
const cleanups = await import("./cleanups.ts");
const { accountKeyFor, accountKeyFromEmail, accountKeyFromId, accountKeysOf } = await import(
  "./account-key.ts"
);
const { cleanupAlertText } = await import("../../app/ai-dashboard/_components/cleanup-copy.ts");

const OTHER_CO = "c0000000-0000-0000-0000-0000000000ff";
const FUTURE = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
const OLD_ACCOUNT = { accountId: "google-sub-111", email: "host@acme.test" };
const NEW_ACCOUNT = { accountId: "google-sub-222", email: "host.personal@other.test" };
const OLD_KEY = accountKeyFor("google", OLD_ACCOUNT);

const booking = (over = {}) => ({
  id: "b-1",
  company_id: CO,
  application_id: APP,
  job_id: JOB,
  host_member_id: "m-host",
  duration_minutes: 30,
  status: "booked",
  scheduled_start: FUTURE,
  scheduled_end: FUTURE,
  candidate_timezone: "Asia/Karachi",
  host_timezone: "Europe/London",
  meeting_mode: "auto",
  meeting_url: null,
  provider_event_id: "evt-1",
  provider: "google",
  provider_account_key: OLD_KEY,
  expires_at: FUTURE,
  cancelled_at: null,
  booked_at: "2026-10-02T00:00:00.000Z",
  cancelled_by: null,
  cancel_reason: null,
  purpose: "interview",
  final_interview_id: null,
  recording_notice_acknowledged_at: null,
  recording_notice_version: null,
  created_at: "2026-10-02T00:00:00.000Z",
  ...over,
});

/**
 * One world. `connection`: null (none), or { status, account } for the host.
 * `removes`: what Google answers each delete.
 */
function world({
  rows = [booking()],
  connection = null,
  token = "tok",
  removes = [true],
  failing,
} = {}) {
  const db = makeDb();
  db.interview_bookings.push(...rows);
  db.calendar_cleanups = [];
  db.calendar_connections = connection
    ? [
        {
          company_id: CO,
          member_id: "m-host",
          provider: "google",
          status: connection.status ?? "active",
          calendar_id: "cal-1",
          provider_account: connection.account?.email ?? null,
          provider_account_key: connection.account
            ? accountKeyFor("google", connection.account)
            : "",
        },
      ]
    : [];
  const service = finalInterviewWorld(db, { failing });
  // 070's calendar_cleanup_companies, as its SQL: company ids with work, nothing else.
  service.rpc = async (name, args) => {
    if (name !== "calendar_cleanup_companies")
      return { data: null, error: { message: `no rpc ${name}` } };
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const ids = new Set(
      db.calendar_cleanups
        .filter(
          (c) =>
            (c.status === "pending" && c.pending_application_id == null) ||
            c.status === "open" ||
            (c.status === "resolved" && c.resolved_at < cutoff),
        )
        .map((c) => c.company_id),
    );
    return { data: [...ids].slice(0, args.p_limit), error: null };
  };
  globalThis.__fakeServiceClientForTests = () => service;
  globalThis.__cuCalls = [];
  globalThis.__cuToken = token;
  const answers = [...removes];
  globalThis.__cuProvider = () => ({
    async deleteEvent(_t, args) {
      globalThis.__cuCalls.push(["delete", args]);
      return answers.length > 1 ? answers.shift() : answers[0];
    },
  });
  return { db, service, calls: globalThis.__cuCalls };
}
const ctxOf = (role, memberId, companyId = CO) => ({
  companyId,
  role,
  memberId,
  user: { id: "u" },
});
const OWNER = ctxOf("owner", "m-owner");
const ADMIN = ctxOf("admin", "m-admin");
const HOST = ctxOf("recruiter", "m-host");
const OTHER_RECRUITER = ctxOf("recruiter", "m-other");
const quiet = async (fn) => {
  const real = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = real;
  }
};

/** What deleting the applicant row does to its pending records: 070's FK, ON DELETE SET NULL. */
const deleteApplicant = (w, app = APP) => {
  for (const r of w.db.calendar_cleanups) {
    if (r.pending_application_id === app) r.pending_application_id = null;
  }
};

test("C1. disconnected host: the delete goes ahead and the event is recorded PENDING, with no candidate data", async () => {
  const w = world({ connection: null });
  const out = await cancelScreeningBookingsForDeletion(CO, APP);
  assert.deepEqual(out, { ok: true, cancelled: 1, eventsLeft: 1 });
  assert.equal(w.db.calendar_cleanups.length, 1);
  const rec = w.db.calendar_cleanups[0];
  assert.equal(rec.status, "pending");
  assert.equal(rec.pending_application_id, APP);
  assert.equal(rec.provider_event_id, "evt-1");
  assert.equal(rec.calendar_id, "primary");
  assert.equal(rec.account_key, OLD_KEY);
  assert.equal(rec.event_start, FUTURE);
  // Nothing about the candidate: only these columns are written.
  assert.deepEqual(Object.keys(rec).sort(), [
    "account_key",
    "calendar_id",
    "company_id",
    "created_at",
    "event_start",
    "host_member_id",
    "host_name_snapshot",
    "id",
    "pending_application_id",
    "provider",
    "provider_event_id",
    "status",
  ]);
  // While pending, nobody sees an alert.
  assert.deepEqual(await cleanups.listOpenCleanups(OWNER), []);
});

test("C2. failed, then retried, delete: no active alert until the delete succeeds; the retry duplicates nothing and activates it", async () => {
  const w = world({ connection: null });
  await cancelScreeningBookingsForDeletion(CO, APP);
  // ... the delete then fails further on: the applicant row is still there.
  // Even an activation call now activates nothing: the id is still set.
  assert.equal(await cleanups.activateCalendarCleanups(CO), true);
  assert.equal(w.db.calendar_cleanups[0].status, "pending");
  assert.deepEqual(await cleanups.listOpenCleanups(OWNER), [], "a failed delete shows no alert");
  // Retry, twice over: still one record.
  w.db.interview_bookings[0].status = "booked";
  await cancelScreeningBookingsForDeletion(CO, APP);
  await cancelScreeningBookingsForDeletion(CO, APP);
  assert.equal(w.db.calendar_cleanups.length, 1, "a retry never duplicates");
  assert.equal(w.db.calendar_cleanups[0].status, "pending");
  // The retry finishes: the applicant row is deleted (the FK clears the id), then activated.
  deleteApplicant(w);
  assert.equal(await cleanups.activateCalendarCleanups(CO), true);
  const rec = w.db.calendar_cleanups[0];
  assert.equal(rec.status, "open");
  assert.equal(rec.pending_application_id, null, "no application id once open");
  assert.equal((await cleanups.listOpenCleanups(OWNER)).length, 1);
});

test("C3. the record cannot be written: the delete STOPS, nothing written (nothing left untracked)", async () => {
  const w = world({ connection: null, failing: "calendar_cleanups" });
  assert.deepEqual(await quiet(() => cancelScreeningBookingsForDeletion(CO, APP)), {
    ok: false,
    failure: "database",
  });
  assert.equal(w.db.interview_bookings[0].status, "booked", "nothing written");
});

test("C4. reconnected before the retry and the event really deleted: the earlier pending record is dropped", async () => {
  const w = world({ connection: null });
  await cancelScreeningBookingsForDeletion(CO, APP);
  assert.equal(w.db.calendar_cleanups.length, 1);
  w.db.calendar_connections = [
    {
      company_id: CO,
      member_id: "m-host",
      provider: "google",
      status: "active",
      calendar_id: "cal-1",
      provider_account: OLD_ACCOUNT.email,
      provider_account_key: OLD_KEY,
    },
  ];
  w.db.interview_bookings[0].status = "booked";
  assert.deepEqual(await cancelScreeningBookingsForDeletion(CO, APP), { ok: true, cancelled: 1 });
  assert.equal(w.db.calendar_cleanups.length, 0);
});

/** An open alert, as after a successful delete. */
async function openAlert(over = {}) {
  const w = world({ connection: null, ...over });
  await cancelScreeningBookingsForDeletion(CO, APP);
  deleteApplicant(w);
  await cleanups.activateCalendarCleanups(CO);
  return w;
}

test("C5. who sees it: owners and admins all of the company's; the host their own ('your'); another recruiter nothing", async () => {
  await openAlert();
  const [o] = await cleanups.listOpenCleanups(OWNER);
  assert.equal(o.mine, false);
  assert.equal((await cleanups.listOpenCleanups(ADMIN)).length, 1);
  const [h] = await cleanups.listOpenCleanups(HOST);
  assert.equal(h.mine, true);
  assert.deepEqual(await cleanups.listOpenCleanups(OTHER_RECRUITER), []);
  assert.deepEqual(Object.keys(o).sort(), ["eventStart", "hostName", "id", "mine"]);
});

test("C6. isolation: another company can neither see nor clear it; a non-host recruiter cannot clear it", async () => {
  const w = await openAlert();
  const id = w.db.calendar_cleanups[0].id;
  for (const role of ["owner", "admin", "recruiter"]) {
    const outsider = ctxOf(role, "m-host", OTHER_CO);
    assert.deepEqual(
      await cleanups.listOpenCleanups(outsider),
      [],
      `${role} elsewhere sees nothing`,
    );
    assert.equal(
      await cleanups.markCleanupRemoved(outsider, id),
      false,
      `${role} elsewhere cannot clear`,
    );
  }
  assert.equal(await cleanups.markCleanupRemoved(OTHER_RECRUITER, id), false);
  assert.equal(w.db.calendar_cleanups[0].status, "open", "still open after every refused attempt");
});

test("C7. 'Mark as removed': the host may, an admin may; the alert is gone for everyone after", async () => {
  for (const who of [HOST, ADMIN]) {
    const w = await openAlert();
    const id = w.db.calendar_cleanups[0].id;
    assert.equal(await cleanups.markCleanupRemoved(who, id), true);
    const rec = w.db.calendar_cleanups[0];
    assert.equal(rec.status, "resolved");
    assert.equal(rec.resolution, "marked_removed");
    assert.equal(rec.resolved_by_member_id, who.memberId);
    assert.deepEqual(await cleanups.listOpenCleanups(OWNER), []);
    assert.equal(await cleanups.markCleanupRemoved(who, id), false, "already resolved");
  }
});

test("C8. reconnect with a DIFFERENT account never auto-resolves: no delete is even tried", async () => {
  const w = await openAlert();
  const n = await cleanups.resolveCleanupsOnReconnect({
    companyId: CO,
    memberId: "m-host",
    provider: "google",
    accountKeys: accountKeysOf("google", NEW_ACCOUNT),
  });
  assert.equal(n, 0);
  assert.ok(!w.calls.some((c) => c[0] === "delete"));
  assert.equal(w.db.calendar_cleanups[0].status, "open");
});

test("C9. reconnect with the SAME account: deleted silently, resolved; not confirmed: still open, the attempt noted", async () => {
  let w = await openAlert();
  assert.equal(
    await cleanups.resolveCleanupsOnReconnect({
      companyId: CO,
      memberId: "m-host",
      provider: "google",
      accountKeys: accountKeysOf("google", OLD_ACCOUNT),
    }),
    1,
  );
  const del = w.calls.find((c) => c[0] === "delete");
  const { signal, ...args } = del[1];
  assert.deepEqual(args, { calendarId: "primary", eventId: "evt-1", silent: true });
  assert.ok(signal instanceof AbortSignal, "bounded by a time limit");
  assert.equal(w.db.calendar_cleanups[0].resolution, "deleted_on_reconnect");

  w = await openAlert({ removes: [false] });
  await cleanups.resolveCleanupsOnReconnect({
    companyId: CO,
    memberId: "m-host",
    provider: "google",
    accountKeys: accountKeysOf("google", OLD_ACCOUNT),
  });
  assert.equal(w.db.calendar_cleanups[0].status, "open");
  assert.equal(w.db.calendar_cleanups[0].last_error_code, "not_confirmed");
});

test("C10. an older connection's address key still matches the same account on reconnect", async () => {
  // The booking was keyed by address (before ids were kept); the reconnect knows the id too.
  const w = await openAlert({
    rows: [booking({ provider_account_key: accountKeyFromEmail("google", OLD_ACCOUNT.email) })],
  });
  assert.equal(
    await cleanups.resolveCleanupsOnReconnect({
      companyId: CO,
      memberId: "m-host",
      provider: "google",
      accountKeys: accountKeysOf("google", OLD_ACCOUNT),
    }),
    1,
  );
  assert.ok(w);
});

test("C11. the worker sweep: activates only when the applicant is gone; retries only the same, active account; purges after 30 days", async () => {
  // Pending, applicant still there (delete not finished): left pending, even
  // though the company has other work and so IS swept.
  let w = world({ connection: null });
  await cancelScreeningBookingsForDeletion(CO, APP);
  w.db.calendar_cleanups.push({
    id: "other-open",
    company_id: CO,
    status: "open",
    account_key: "",
    provider: "google",
    calendar_id: "primary",
    provider_event_id: "evt-other",
  });
  let out = await cleanups.sweepCalendarCleanups();
  assert.equal(out.activated, 0);
  assert.equal(w.db.calendar_cleanups[0].status, "pending");
  // Applicant gone (delete succeeded, activation lost): activated.
  deleteApplicant(w);
  out = await cleanups.sweepCalendarCleanups();
  assert.equal(out.activated, 1);
  assert.equal(w.db.calendar_cleanups[0].status, "open");
  w.db.calendar_cleanups.splice(1, 1); // the other company work, done with

  // Host reconnected a DIFFERENT account: the sweep tries nothing.
  w.db.calendar_connections = [
    {
      company_id: CO,
      member_id: "m-host",
      provider: "google",
      status: "active",
      calendar_id: "cal-2",
      provider_account: NEW_ACCOUNT.email,
      provider_account_key: accountKeyFor("google", NEW_ACCOUNT),
    },
  ];
  out = await cleanups.sweepCalendarCleanups();
  assert.equal(out.resolved, 0);
  assert.ok(!w.calls.some((c) => c[0] === "delete"));
  // The SAME account, active: deleted and resolved.
  w.db.calendar_connections[0].provider_account_key = OLD_KEY;
  out = await cleanups.sweepCalendarCleanups();
  assert.equal(out.resolved, 1);

  // Purge: resolved 31 days ago goes, 29 days ago stays.
  w = world();
  const day = 24 * 60 * 60 * 1000;
  w.db.calendar_cleanups.push(
    {
      id: "old",
      company_id: CO,
      status: "resolved",
      resolved_at: new Date(Date.now() - 31 * day).toISOString(),
    },
    {
      id: "new",
      company_id: CO,
      status: "resolved",
      resolved_at: new Date(Date.now() - 29 * day).toISOString(),
    },
  );
  out = await cleanups.sweepCalendarCleanups();
  assert.equal(out.purged, 1);
  assert.deepEqual(
    w.db.calendar_cleanups.map((r) => r.id),
    ["new"],
  );
});

test("C12. the host has left: the alert keeps their name snapshot and stays actionable for owners and admins", async () => {
  const w = await openAlert();
  const rec = w.db.calendar_cleanups[0];
  const snapshot = rec.host_name_snapshot;
  assert.ok(snapshot, "the host's display name was kept");
  rec.host_member_id = null; // ON DELETE SET NULL
  const [o] = await cleanups.listOpenCleanups(OWNER);
  assert.equal(o.hostName, snapshot);
  assert.equal(o.mine, false);
  assert.equal(await cleanups.markCleanupRemoved(ADMIN, rec.id), true);
});

test("C13. the bell's sentence: 'your' for the host, the name otherwise; the time in the reader's zone; no dashes", () => {
  const at = "2026-11-27T09:30:00.000Z";
  assert.equal(
    cleanupAlertText(
      { id: "x", mine: true, hostName: "Hana Host", eventStart: at },
      "Asia/Karachi",
    ),
    "A calendar event from a deleted applicant may still be in your Google Calendar (Fri 27 Nov, 14:30). Please remove it.",
  );
  assert.equal(
    cleanupAlertText({ id: "x", mine: false, hostName: "Hana Host", eventStart: at }, "UTC"),
    "A calendar event from a deleted applicant may still be in Hana Host's Google Calendar (Fri 27 Nov, 09:30). Please remove it.",
  );
  assert.equal(
    cleanupAlertText({ id: "x", mine: false, hostName: null, eventStart: null }),
    "A calendar event from a deleted applicant may still be in a team member's Google Calendar. Please remove it.",
  );
  for (const mine of [true, false]) {
    assert.doesNotMatch(
      cleanupAlertText({ id: "x", mine, hostName: "A", eventStart: at }),
      /[–—]| - /,
    );
  }
});

test("C14. the account key: an HMAC with the server secret, never the address or a plain SHA-256; none without a secret", () => {
  const byId = accountKeyFromId("google", OLD_ACCOUNT.accountId);
  const byEmail = accountKeyFromEmail("google", "  HOST@acme.test ");
  assert.match(byId, /^[0-9a-f]{64}$/);
  assert.notEqual(byId, byEmail);
  assert.equal(byEmail, accountKeyFromEmail("google", "host@acme.test"), "trimmed, lower-cased");
  assert.notEqual(byEmail, createHash("sha256").update("host@acme.test").digest("hex"));
  assert.equal(accountKeyFor("google", OLD_ACCOUNT), byId, "the stable id first");
  const saved = process.env.GOOGLE_CALENDAR_CLIENT_SECRET;
  delete process.env.GOOGLE_CALENDAR_CLIENT_SECRET;
  try {
    assert.equal(accountKeyFor("google", OLD_ACCOUNT), null);
  } finally {
    process.env.GOOGLE_CALENDAR_CLIENT_SECRET = saved;
  }
});

test("C15. wired: the delete activates only at the very end; the callback and the worker call the backstops", () => {
  const actions = readFileSync(
    new URL("../../app/ai-dashboard/(gated)/applicants/actions.ts", import.meta.url),
    "utf8",
  );
  // #16: activated by 071's Finish, after the row delete, in the same
  // transaction; never by the app, so a failed delete can activate nothing.
  const fn = actions.slice(
    actions.indexOf("export async function deleteApplication("),
    actions.indexOf("// ── Team comments"),
  );
  assert.doesNotMatch(fn, /activateCalendarCleanups\(/, "no app-side activation");
  assert.ok(fn.indexOf("finishApplicationDeletion(") > 0);
  const sql = readFileSync(
    new URL("../supabase/migrations/071_application_deletion.sql", import.meta.url),
    "utf8",
  );
  const finish = sql.slice(
    sql.indexOf("create or replace function public.finish_application_deletion"),
  );
  const rowDelete = finish.indexOf("delete from public.job_applications a");
  const activate = finish.indexOf("update public.calendar_cleanups c");
  assert.ok(rowDelete > 0 && activate > rowDelete, "activated after the row, same transaction");
  const notClosed = finish.search(
    /if app\.deletion_started_at is null then\s+return jsonb_build_object\('outcome', 'not_closed'\);/,
  );
  assert.ok(notClosed > 0 && notClosed < rowDelete, "and only after Close");
  const callback = readFileSync(
    new URL("../../app/api/calendar/google/callback/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    callback,
    /if \(!stored\.ok\) return finish\("store_failed"\);[\s\S]{0,400}resolveCleanupsOnReconnect\(/,
  );
  const worker = readFileSync(
    new URL("../../app/api/jobs/worker/route.ts", import.meta.url),
    "utf8",
  );
  // Last in the tick: after the job pool and the heartbeat, with the tick's deadline.
  const sweepAt = worker.indexOf("await sweepCalendarCleanups({ deadlineAt });");
  assert.ok(sweepAt > worker.indexOf("await recordHeartbeatAndAlerts(summary, startedAt);"));
  assert.ok(
    sweepAt > worker.indexOf("await Promise.all(Array.from({ length: Math.min(WORKER_CONCURRENCY"),
  );
  assert.equal(worker.match(/sweepCalendarCleanups\(/g).length, 1);
  assert.equal(cleanups.CLEANUP_SWEEP_LIMIT, 50);
  assert.equal(cleanups.RESOLVED_KEEP_MS, 30 * 24 * 60 * 60 * 1000);
});

test("C16. one record per event per calendar per account: the same Google event id elsewhere is a different event", async () => {
  const w = world({
    rows: [
      booking({ id: "b-a", provider_event_id: "evt-same", provider_account_key: OLD_KEY }),
      booking({
        id: "b-b",
        provider_event_id: "evt-same",
        provider_account_key: accountKeyFor("google", NEW_ACCOUNT),
      }),
    ],
  });
  await cancelScreeningBookingsForDeletion(CO, APP);
  assert.equal(w.db.calendar_cleanups.length, 2, "two accounts, two events");
  await cancelScreeningBookingsForDeletion(CO, APP);
  assert.equal(w.db.calendar_cleanups.length, 2, "and a retry adds none");
});

/** Two open alerts on the host's active, same-account connection. */
function openWorld(over = {}) {
  const w = world({ connection: { account: OLD_ACCOUNT }, ...over });
  for (const id of ["o-1", "o-2"]) {
    w.db.calendar_cleanups.push({
      id,
      company_id: CO,
      host_member_id: "m-host",
      status: "open",
      provider: "google",
      account_key: OLD_KEY,
      calendar_id: "primary",
      provider_event_id: `evt-${id}`,
      last_attempt_at: null,
    });
  }
  return w;
}

test("C17. the sweep cannot hold up the worker: a deadline, a cut-off per Google call, one failing company skipped", async () => {
  // A deadline already passed: nothing is read, nothing changes.
  let w = openWorld();
  let rpcCalls = 0;
  const rpc = w.service.rpc;
  w.service.rpc = (...a) => {
    rpcCalls += 1;
    return rpc(...a);
  };
  let out = await cleanups.sweepCalendarCleanups({ deadlineAt: Date.now() - 1 });
  assert.equal(rpcCalls, 0);
  assert.deepEqual(out, { activated: 0, resolved: 0, purged: 0, failed: 0 });
  assert.deepEqual(
    w.db.calendar_cleanups.map((r) => r.status),
    ["open", "open"],
  );

  // Google never answers: the call is cut off at the deadline, counted "not
  // confirmed", and the row it did not reach is left exactly as it was.
  w = openWorld();
  globalThis.__cuProvider = () => ({
    deleteEvent: (_t, args) =>
      new Promise((resolve) => {
        globalThis.__cuCalls.push(["delete", args]);
        args.signal?.addEventListener("abort", () => resolve(false));
      }),
  });
  const t0 = Date.now();
  out = await cleanups.sweepCalendarCleanups({ deadlineAt: Date.now() + 150 });
  const took = Date.now() - t0;
  assert.ok(took < 2000, `took ${took} ms`);
  assert.equal(out.resolved, 0);
  assert.equal(w.calls.filter((c) => c[0] === "delete").length, 1, "one call, then out of time");
  const [first, second] = w.db.calendar_cleanups;
  assert.equal(first.status, "open");
  assert.equal(first.last_error_code, "not_confirmed");
  assert.equal(second.last_attempt_at, null, "untouched");
  assert.equal(second.last_error_code, undefined);
  assert.ok(cleanups.CLEANUP_SWEEP_MAX_MS <= 10_000);
  assert.ok(cleanups.CLEANUP_CALL_TIMEOUT_MS <= 5_000);

  // One company fails (its token read throws): logged, skipped, the next is swept.
  w = openWorld();
  w.db.calendar_cleanups.unshift({
    id: "x-1",
    company_id: OTHER_CO,
    host_member_id: "m-x",
    status: "open",
    provider: "google",
    account_key: OLD_KEY,
    calendar_id: "primary",
    provider_event_id: "evt-x",
    last_attempt_at: null,
  });
  w.db.calendar_connections.push({
    ...w.db.calendar_connections[0],
    company_id: OTHER_CO,
    member_id: "m-x",
  });
  let first_ = true;
  Object.defineProperty(globalThis, "__cuToken", {
    configurable: true,
    get() {
      if (first_) {
        first_ = false;
        throw new Error("token store down");
      }
      return "tok";
    },
  });
  try {
    out = await quiet(() => cleanups.sweepCalendarCleanups());
  } finally {
    Object.defineProperty(globalThis, "__cuToken", {
      configurable: true,
      writable: true,
      value: "tok",
    });
  }
  assert.equal(out.failed, 1);
  assert.equal(out.resolved, 2, "the other company's two alerts still resolved");
  assert.equal(w.db.calendar_cleanups[0].status, "open", "the failed company's row untouched");
});

test("C18. the unique key has no NULLs to slip past it: every key column NOT NULL in 070, never written null; retries add nothing", async () => {
  const sql = readFileSync(
    new URL("../supabase/migrations/070_calendar_cleanups.sql", import.meta.url),
    "utf8",
  );
  const table = sql.slice(
    sql.indexOf("create table if not exists public.calendar_cleanups ("),
    sql.indexOf("create index if not exists calendar_cleanups_open_company"),
  );
  const key = ["company_id", "provider", "account_key", "calendar_id", "provider_event_id"];
  assert.match(table, new RegExp(`unique \\(${key.join(", ")}\\)`));
  for (const col of key) {
    assert.match(table, new RegExp(`^\\s*${col}\\s+[^\\n]*\\bnot null\\b`, "m"), `${col} NOT NULL`);
  }
  // The app's conflict target is exactly that key.
  const src = readFileSync(new URL("./cleanups.ts", import.meta.url), "utf8");
  assert.ok(src.includes(`const UNIQUE = "${key.join(",")}";`));
  assert.match(src, /\{ onConflict: UNIQUE, ignoreDuplicates: true \}/);

  // Nothing known about the account or the calendar: '' and 'primary', never null.
  const w = world({ rows: [booking({ provider_account_key: null })], connection: null });
  await cancelScreeningBookingsForDeletion(CO, APP);
  const [row] = w.db.calendar_cleanups;
  for (const col of key) assert.equal(typeof row[col], "string", col);
  assert.equal(row.account_key, "");
  assert.equal(row.calendar_id, "primary");
  // Retries at the same time: still one record (in Postgres, ON CONFLICT DO NOTHING).
  await Promise.all([
    cancelScreeningBookingsForDeletion(CO, APP),
    cancelScreeningBookingsForDeletion(CO, APP),
  ]);
  assert.equal(w.db.calendar_cleanups.length, 1);
});

test("C19. calendar_cleanup_companies: invoker rights, empty search_path, EXECUTE for service_role only, ids only", () => {
  const sql = readFileSync(
    new URL("../supabase/migrations/070_calendar_cleanups.sql", import.meta.url),
    "utf8",
  ).replace(/--[^\n]*/g, "");
  const fn = sql.slice(
    sql.indexOf("create or replace function public.calendar_cleanup_companies"),
    sql.indexOf("comment on table"),
  );
  assert.ok(fn.length > 0);
  assert.doesNotMatch(fn, /security definer/i);
  assert.match(fn, /\bsecurity invoker\b/);
  assert.match(fn, /set search_path = ''/);
  assert.match(fn, /returns setof uuid/);
  assert.match(fn, /from public\.calendar_cleanups c/);
  assert.match(fn, /least\(p_limit, 500\)/);
  const sig = "public.calendar_cleanup_companies\\(integer\\)";
  assert.match(fn, new RegExp(`revoke all on function ${sig} from public;`));
  assert.match(fn, new RegExp(`revoke all on function ${sig} from anon, authenticated;`));
  const grants = [...fn.matchAll(/grant execute on function [^;]+ to ([^;]+);/g)].map((m) => m[1]);
  assert.deepEqual(grants, ["service_role"]);
});
