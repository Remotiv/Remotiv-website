/**
 * The company applicant delete and its bells (#88).
 *
 *   node --test "src/app/ai-dashboard/(gated)/applicants/delete-bells.test.ts"
 *
 * Runs the shipped deleteApplication against a fake database that keeps a
 * small notifications_company table in memory and applies the filters the code
 * actually sends (company_id, application_id, IS NULL, href / href IN). The
 * applicant row delete does what the real FK does: every bell pointing at the
 * row has its application_id set NULL. The interview and file helpers are
 * stubbed to record their calls; their own tests cover them. Synthetic data.
 *
 * What is proved: the bells go before the row and only this applicant's in
 * this company; a failed bell clean or session lookup keeps the row; a bell
 * written between the clean and the row delete is removed afterwards, by the
 * applicant link or, for interview_expired, by the interview page; the late
 * clean is retried once; a second failure does not fail the delete and logs a
 * code only; the deletion bell names nobody; the interview-page href matches
 * the one expiry.ts builds.
 *
 * APPLICANTS_ACTIONS_UNDER_TEST points the suite at another copy of actions.ts
 * (the negative control runs it against the pre-#88 file).
 */
// @ts-nocheck - same reason as the other node:test files: Node's `.ts`
// specifier vs this tsconfig, which does not set allowImportingTsExtensions.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

register(new URL("../../../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../../../test-support/applicants-test-hook.mjs", import.meta.url));
register(
  `data:text/javascript,${encodeURIComponent(`
const STUBS = {
  "@/lib/application-files": "export async function removeApplicationFiles() { globalThis.__delEvents.push('files'); return { ok: true }; }",
  "@/lib/interviews/application-deletion": "export async function deleteApplicationInterviews() { globalThis.__delEvents.push('interviews'); return { ok: true, sessions: 0 }; }",
  "@/lib/calendar/bookings": "export async function cancelScreeningBookingsForDeletion(companyId, applicationId) { globalThis.__delEvents.push('bookings'); const next = globalThis.__delBookings?.shift(); return next ?? { ok: true, cancelled: 0 }; }",
  "@/lib/calendar/cleanups": "export async function activateCalendarCleanups(companyId, applicationId) { globalThis.__delEvents.push('cleanups:activate'); return true; }",
};
export async function resolve(specifier, context, next) {
  if (specifier in STUBS) return { url: "data:text/javascript," + encodeURIComponent(STUBS[specifier]), shortCircuit: true };
  return next(specifier, context);
}`)}`,
);

const { fakeService } = await import("../../../../test-support/fake-postgrest.mjs");
const target = process.env.APPLICANTS_ACTIONS_UNDER_TEST
  ? pathToFileURL(process.env.APPLICANTS_ACTIONS_UNDER_TEST).href
  : "./actions.ts";
const { deleteApplication } = await import(target);

const CO = "c0000000-0000-0000-0000-000000000001";
const OTHER_CO = "c0000000-0000-0000-0000-000000000002";
const APP = "a0000000-0000-0000-0000-0000000aaaaa";
const OTHER_APP = "a0000000-0000-0000-0000-0000000bbbbb";
const JOB = "j0000000-0000-0000-0000-000000000001";
const SESSION = "s0000000-0000-0000-0000-0000000sssss";
// Synthetic candidate. The row carries name and email so a writer that still
// used them would show.
const ROW = {
  id: APP,
  company_id_snapshot: CO,
  cv_path: "x/a.pdf",
  job_id: JOB,
  first_name: "Candidatea",
  last_name: "Testperson",
  email: "candidate.a@example.test",
};
const hrefOf = (id) => `/ai-dashboard/applicants?applicant=${id}`;
const pageOf = (sessionId) => `/ai-dashboard/interviews/${sessionId}`;
const RAW = {
  code: "57014",
  message: 'canceling statement due to statement timeout on "notifications_company"',
};

function bell(id, company_id, application_id, href = hrefOf(application_id)) {
  return { id, company_id, application_id, href };
}

/** The filters a bell DELETE carried. */
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
  preFails = false,
  lateFailures = 0,
  race = null,
  sessionFails = false,
  sessions = [SESSION],
  rowFailures = 0,
  preFailures = 0,
  bookings = [],
} = {}) {
  // Outcomes the booking step returns, in order, then { ok: true } (#61).
  globalThis.__delBookings = [...bookings];
  let rowLeft = rowFailures;
  let preLeft = preFailures;
  const events = [];
  const logged = [];
  const bells = [
    bell("b1", CO, APP),
    bell("b2", CO, APP),
    bell("b3", CO, OTHER_APP),
    bell("b4", OTHER_CO, APP),
    // Orphans that must survive: another company's, and another applicant's.
    bell("o1", OTHER_CO, null, hrefOf(APP)),
    bell("o2", OTHER_CO, null, pageOf(SESSION)),
    bell("o3", CO, null, hrefOf(OTHER_APP)),
  ];
  const inserted = [];
  let lateLeft = lateFailures;
  let rowGone = false;
  const service = fakeService((table, calls) => {
    const op = calls[0]?.[0];
    if (table === "interview_sessions" && op === "select") {
      events.push("sessions:read");
      if (sessionFails) return { data: null, error: RAW };
      return { data: sessions.map((id) => ({ id })), error: null };
    }
    if (table === "job_applications" && op === "select") {
      if (rowGone) return { data: null, error: null };
      return { data: { ...ROW }, error: null };
    }
    if (table === "job_applications" && op === "delete") {
      events.push("row:delete");
      if (rowLeft > 0) {
        rowLeft -= 1;
        return {
          data: null,
          error: { code: "40P01", message: 'deadlock detected on "job_applications"' },
        };
      }
      rowGone = true;
      // A bell written after the pre-clean, before the row goes.
      if (race === "applicant") bells.push(bell("race", CO, APP));
      if (race === "expiry") bells.push(bell("race", CO, APP, pageOf(SESSION)));
      for (const b of bells) if (b.application_id === APP) b.application_id = null; // SET NULL
      return { data: null, error: null };
    }
    if (table === "notifications_company" && op === "delete") {
      const f = bellFilter(calls);
      events.push(f.isNull ? "bells:late" : "bells:pre");
      if (!f.isNull && preFails) return { data: null, error: RAW };
      if (!f.isNull && preLeft > 0) {
        preLeft -= 1;
        return { data: null, error: RAW };
      }
      if (f.isNull && lateLeft > 0) {
        lateLeft -= 1;
        return { data: null, error: RAW };
      }
      for (let i = bells.length - 1; i >= 0; i--) {
        const b = bells[i];
        const match =
          (f.company === undefined || b.company_id === f.company) &&
          (f.app === undefined || b.application_id === f.app) &&
          (!f.isNull || b.application_id === null) &&
          (f.href === undefined || b.href === f.href) &&
          (f.hrefs === undefined || f.hrefs.includes(b.href));
        if (match) bells.splice(i, 1);
      }
      return { data: null, error: null };
    }
    if (table === "notifications_company" && op === "insert") {
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
    if (table === "job_hiring_team") return { data: [], error: null };
    throw new Error(`unexpected ${op} on ${table}`);
  });
  globalThis.__applicantsServiceForTests = () => service;
  globalThis.__applicantsCtxForTests = {
    companyId: CO,
    memberId: "m-actor",
    memberName: "Team Member",
    role: "owner",
    company: { id: CO, name: "Acme" },
  };
  globalThis.__delEvents = events;
  const run = async () => {
    const real = console.error;
    console.error = (...a) => logged.push(a.map(String).join(" "));
    try {
      return await deleteApplication(APP);
    } finally {
      console.error = real;
    }
  };
  return { events, logged, bells, inserted, service, run };
}

const ids = (bells) => bells.map((b) => b.id).sort();
const SURVIVORS = ["b3", "b4", "o1", "o2", "o3"];
const lateQueries = (w) =>
  w.service.queries.filter(
    (q) => q.table === "notifications_company" && q.calls.some((c) => c[0] === "is"),
  );

test("a: the pre-clean removes only this applicant's bells in this company, before the row", async () => {
  const w = world();
  const res = await w.run();
  assert.deepEqual(res, { success: true, data: undefined });
  assert.deepEqual(ids(w.bells), SURVIVORS, "other applicants' and other companies' bells survive");
  const order = w.events.filter((e) => e !== "interviews" && e !== "files");
  assert.ok(
    order.indexOf("bells:pre") > -1 && order.indexOf("bells:pre") < order.indexOf("row:delete"),
    order.join(","),
  );
});

test("a2: the session ids are read before the interviews, and the order is otherwise unchanged", async () => {
  const w = world();
  await w.run();
  assert.deepEqual(w.events.slice(0, 4), ["sessions:read", "bookings", "interviews", "files"]);
  const read = w.service.queries.find((q) => q.table === "interview_sessions");
  const eq = (c) => read.calls.find((x) => x[0] === "eq" && x[1] === c)?.[2];
  assert.equal(eq("company_id"), CO);
  assert.equal(eq("application_id"), APP);
});

test("b: a failed pre-clean keeps the row and says data may already be gone (#60), code only in the log", async () => {
  const w = world({ preFails: true });
  const res = await w.run();
  assert.equal(res.success, false);
  assert.equal(res.error, PARTLY_DELETED);
  assert.ok(!w.events.includes("row:delete"), "the row was deleted");
  const all = [res.error, ...w.logged].join("\n");
  assert.ok(!all.includes("statement timeout") && !all.includes('notifications_company"'), all);
  assert.ok(
    w.logged.some((l) => l.includes("57014")),
    w.logged.join("\n"),
  );
});

test("b2: a failed session lookup stops the delete before anything is removed", async () => {
  const w = world({ sessionFails: true });
  const res = await w.run();
  assert.equal(res.success, false);
  assert.equal(
    res.error,
    "We couldn't finish that action. Refresh to check the current state, then try again.",
  );
  assert.deepEqual(
    w.events,
    ["sessions:read"],
    "bookings, interviews, files, bells or row were touched",
  );
  assert.ok(!w.logged.join("\n").includes("statement timeout"));
});

test("c: an applicant-link bell written between the pre-clean and the row delete is removed", async () => {
  const w = world({ race: "applicant" });
  await w.run();
  assert.ok(!w.bells.some((b) => b.id === "race"), "the racing bell survived");
  assert.deepEqual(ids(w.bells), SURVIVORS);
});

test("c2: an interview_expired bell (interview-page href) that raced the delete is removed", async () => {
  const w = world({ race: "expiry" });
  await w.run();
  assert.ok(!w.bells.some((b) => b.id === "race"), "the racing expiry bell survived");
  assert.deepEqual(ids(w.bells), SURVIVORS, "another company's orphan on the same page survives");
});

test("c3: every late clean is scoped to this company and to orphaned rows", async () => {
  const w = world({ race: "expiry" });
  await w.run();
  const late = lateQueries(w);
  assert.ok(late.length > 0, "no late clean ran");
  for (const q of late) {
    const f = bellFilter(q.calls);
    assert.equal(f.company, CO);
    assert.equal(f.isNull, true);
    assert.equal(f.app, undefined);
    assert.deepEqual(f.hrefs, [hrefOf(APP), pageOf(SESSION)]);
  }
});

test("c4: no sessions: the late clean still covers the applicant link", async () => {
  const w = world({ sessions: [], race: "applicant" });
  await w.run();
  assert.ok(!w.bells.some((b) => b.id === "race"));
  assert.deepEqual(bellFilter(lateQueries(w)[0].calls).hrefs, [hrefOf(APP)]);
});

test("d: a late clean that fails once is retried and succeeds, with nothing logged", async () => {
  const w = world({ race: "expiry", lateFailures: 1 });
  const res = await w.run();
  assert.deepEqual(res, { success: true, data: undefined });
  assert.equal(lateQueries(w).length, 2, "one retry");
  assert.ok(!w.bells.some((b) => b.id === "race"), "the retry did not remove the racing bell");
  assert.deepEqual(w.logged, []);
});

test("d2: both attempts fail: the delete stands, the code is logged, and no id or name", async () => {
  const w = world({ race: "expiry", lateFailures: 2 });
  const res = await w.run();
  assert.deepEqual(res, { success: true, data: undefined });
  assert.equal(lateQueries(w).length, 2, "exactly one retry");
  const log = w.logged.join("\n");
  assert.ok(log.includes("late bell clean failed: 57014"), log);
  for (const leak of [
    APP,
    APP.slice(-6),
    SESSION,
    "Candidatea",
    "Testperson",
    "statement timeout",
  ]) {
    assert.ok(!log.includes(leak), `log carries ${leak}`);
  }
});

test("e: the applicant_deleted bell carries no part of the candidate's name or email", async () => {
  const w = world();
  await w.run();
  const del = w.inserted.filter((r) => r.type === "applicant_deleted");
  assert.ok(del.length > 0, "no applicant_deleted bell written");
  for (const r of del) {
    assert.equal(r.title, "An applicant was deleted");
    const text = JSON.stringify(r);
    for (const leak of ["Candidatea", "Testperson", "candidate.a", "example.test"]) {
      assert.ok(!text.includes(leak), `bell carries ${leak}`);
    }
    assert.equal(r.application_id, null);
  }
});

test("f: the interview-page href matches the one expiry.ts writes (read, not changed)", () => {
  const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");
  // The source text, built from parts so it is not itself a template string.
  const DOLLAR = "$";
  const expiry = read("../../../../lib/interviews/expiry.ts");
  assert.ok(
    expiry.includes(`href: \`/ai-dashboard/interviews/${DOLLAR}{session.id}\``),
    "expiry.ts href moved",
  );
  for (const rel of ["./actions.ts", "../../../admin/applications/actions.ts"]) {
    assert.ok(
      read(rel).includes(`\`/ai-dashboard/interviews/${DOLLAR}{sessionId}\``),
      `${rel} no longer builds the same interview-page href`,
    );
  }
});

/* ── #60: a failure after the files went; #61: bookings first ────────── */

const PARTLY_DELETED =
  "Deletion was not completed. Some data may already have been removed. Refresh and try Delete again.";
const CALENDAR_NOT_CLEARED =
  "We couldn't remove this applicant's booked interview from Google Calendar, so nothing was deleted. Try again in a moment.";

test("60-1. the row delete fails after the files: the fixed sentence, the code logged, nothing of the database's message", async () => {
  const w = world({ rowFailures: 1 });
  const res = await w.run();
  assert.deepEqual(res, { success: false, error: PARTLY_DELETED });
  assert.ok(w.events.includes("files") && w.events.includes("interviews"));
  assert.deepEqual(w.inserted, [], "no 'applicant deleted' bell for a delete that did not finish");
  const all = [res.error, ...w.logged].join("\n");
  assert.ok(!all.includes("deadlock") && !all.includes("job_applications"), all);
  assert.ok(
    w.logged.some((l) => l.includes("row delete failed: 40P01")),
    w.logged.join("\n"),
  );
});

test("60-2. fail then retry: the second Delete finishes cleanly, with one bell and nothing done twice that matters", async () => {
  const w = world({ rowFailures: 1 });
  assert.deepEqual(await w.run(), { success: false, error: PARTLY_DELETED });
  const firstPass = w.events.length;
  assert.deepEqual(await w.run(), { success: true, data: undefined });
  const retry = w.events.slice(firstPass);
  // Every step is repeated, and each is safe to repeat: no booking is left to
  // cancel, removed files and interviews count as gone, the bells are gone.
  assert.deepEqual(retry.slice(0, 4), ["sessions:read", "bookings", "interviews", "files"]);
  assert.equal(retry.filter((e) => e === "row:delete").length, 1);
  assert.equal(
    w.inserted.filter((n) => n.type === "applicant_deleted").length,
    1,
    "one bell, from the retry",
  );
  assert.deepEqual(ids(w.bells), SURVIVORS);
  // A third Delete finds nothing: the same reply as any applicant not in the workspace.
  assert.deepEqual(await w.run(), {
    success: false,
    error: "Applicant not found in your workspace.",
  });
});

test("60-3. the pre-clean fails, then a retry: the fixed sentence, then a clean finish", async () => {
  const w = world({ preFailures: 1 });
  assert.deepEqual(await w.run(), { success: false, error: PARTLY_DELETED });
  assert.ok(!w.events.includes("row:delete"));
  assert.deepEqual(await w.run(), { success: true, data: undefined });
  assert.deepEqual(ids(w.bells), SURVIVORS);
});

test("61-1. the booking step runs before anything is removed, after the session read", async () => {
  const w = world();
  await w.run();
  const at = (e) => w.events.indexOf(e);
  assert.ok(
    at("sessions:read") < at("bookings") && at("bookings") < at("interviews"),
    w.events.join(","),
  );
});

test("61-2. Google does not confirm: NOTHING is deleted, the applicant stays, and the error says so", async () => {
  const w = world({ bookings: [{ ok: false, failure: "calendar" }] });
  const res = await w.run();
  assert.deepEqual(res, { success: false, error: CALENDAR_NOT_CLEARED });
  assert.deepEqual(
    w.events,
    ["sessions:read", "bookings"],
    "interviews, files, bells or row were touched",
  );
  assert.equal(w.bells.length, 7, "no bell removed");
  assert.deepEqual(w.inserted, []);
});

test("61-3. Google fails, then Retry: the second Delete clears the calendar and finishes", async () => {
  const w = world({ bookings: [{ ok: false, failure: "calendar" }] });
  assert.equal((await w.run()).error, CALENDAR_NOT_CLEARED);
  assert.deepEqual(await w.run(), { success: true, data: undefined });
  assert.equal(w.events.filter((e) => e === "bookings").length, 2);
  assert.equal(w.events.filter((e) => e === "row:delete").length, 1);
});

test("61-5. the booking step fails after Google deleted (its local write failed), then Retry: one finish, one bell", async () => {
  // cancelScreeningBookingsForDeletion reports a failed local write as
  // "database" with nothing else touched (delete-bookings.test.ts 61-i).
  const w = world({ bookings: [{ ok: false, failure: "database" }] });
  const first = await w.run();
  assert.equal(first.success, false);
  assert.deepEqual(w.events, ["sessions:read", "bookings"], "nothing removed on the first try");
  assert.deepEqual(w.inserted, [], "no 'applicant deleted' bell for a delete that did not happen");
  assert.deepEqual(await w.run(), { success: true, data: undefined });
  assert.equal(w.inserted.filter((n) => n.type === "applicant_deleted").length, 1);
  assert.equal(w.events.filter((e) => e === "row:delete").length, 1);
});

test("61-4. the bookings read or write fails: nothing deleted, the generic refresh-and-retry message", async () => {
  const w = world({ bookings: [{ ok: false, failure: "database" }] });
  const res = await w.run();
  assert.equal(
    res.error,
    "We couldn't finish that action. Refresh to check the current state, then try again.",
  );
  assert.deepEqual(w.events, ["sessions:read", "bookings"]);
});

test("60/61 copy: no dashes", () => {
  for (const copy of [PARTLY_DELETED, CALENDAR_NOT_CLEARED]) {
    assert.ok(!/[\u2013\u2014]/.test(copy), copy);
  }
  const src = readFileSync(new URL("./actions.ts", import.meta.url), "utf8");
  assert.ok(src.includes(PARTLY_DELETED) && src.includes(CALENDAR_NOT_CLEARED));
});

/* ── #56: a calendar event left on a calendar that is no longer connected ── */

const EVENT_LEFT =
  "This applicant is deleted. A calendar event for them may still be in the host's Google Calendar, because it is no longer connected to Remotiv. Please remove it there.";

test("56-1. the booking step went ahead but could not reach an event: deleted, and the recruiter gets the note", async () => {
  const w = world({ bookings: [{ ok: true, cancelled: 1, eventsLeft: 1 }] });
  const res = await w.run();
  assert.deepEqual(res, { success: true, data: { calendarNote: EVENT_LEFT } });
  assert.equal(w.events.filter((e) => e === "row:delete").length, 1, "the applicant is deleted");
});

test("56-2. nothing left anywhere: a plain delete, exactly as before", async () => {
  const w = world({ bookings: [{ ok: true, cancelled: 0 }] });
  assert.deepEqual(await w.run(), { success: true, data: undefined });
});

test("56-3. connected but Google does not confirm: still blocked with #61's message, nothing deleted", async () => {
  const w = world({ bookings: [{ ok: false, failure: "calendar" }] });
  const res = await w.run();
  assert.equal(res.success, false);
  assert.match(res.error, /couldn't remove this applicant's booked interview from Google Calendar/);
  assert.ok(!w.events.includes("row:delete"), "nothing deleted");
});

test("56-4. the note: no dashes, and the delete sends no candidate email; the client shows it in place of 'deleted'", async () => {
  const { readFileSync } = await import("node:fs");
  assert.doesNotMatch(EVENT_LEFT, /[\u2013\u2014]| - /);
  const actions = readFileSync(new URL("./actions.ts", import.meta.url), "utf8");
  assert.ok(
    actions.includes(`const CALENDAR_EVENT_LEFT =\n  "${EVENT_LEFT}";`),
    "the copy as given",
  );
  const body = actions.slice(
    actions.indexOf("export async function deleteApplication("),
    actions.indexOf(
      "export async function",
      actions.indexOf("export async function deleteApplication(") + 10,
    ),
  );
  assert.doesNotMatch(
    body,
    /deliverEmail|sendEmail|queueStageChange|cancelPendingRejection|Notices/,
  );
  const client = readFileSync(new URL("./_applicants-client.tsx", import.meta.url), "utf8");
  assert.match(client, /const calendarNote = result\.data\?\.calendarNote;/);
  // A notice, not a toast: it stays until the recruiter dismisses it.
  assert.match(
    client,
    /if \(calendarNote\) setCalendarNote\(calendarNote\);\s*else setToast\(`\$\{fullName\(target\)\} deleted`\);/,
  );
  assert.doesNotMatch(client, /setToast\(\s*\{?\s*(message: )?calendarNote/, "never a timed toast");
  const notice = client.slice(
    client.indexOf("{calendarNote && ("),
    client.indexOf("{calendarNote && (") + 1200,
  );
  assert.match(notice, /role="status"/);
  assert.match(notice, /<p className="m-0 flex-1">\{calendarNote\}<\/p>/);
  assert.match(notice, /aria-label="Dismiss"[\s\S]*onClick=\{\(\) => setCalendarNote\(null\)\}/);
  // Only the Dismiss button clears it: no timer anywhere sets it back to null.
  assert.equal((client.match(/setCalendarNote\(null\)/g) ?? []).length, 1);
  assert.doesNotMatch(client, /setTimeout\([^)]*setCalendarNote/);
});

test("56-5. the cleanup alert is activated only once the applicant row is really deleted", async () => {
  const w = world({ bookings: [{ ok: true, cancelled: 1, eventsLeft: 1 }] });
  await w.run();
  const at = (e) => w.events.indexOf(e);
  assert.ok(
    at("cleanups:activate") > at("row:delete") && at("row:delete") > -1,
    "after the row delete",
  );
  assert.equal(w.events.filter((e) => e === "cleanups:activate").length, 1);
});

test("56-6. a delete that fails after the booking step activates nothing (no alert about someone still there); the retry that finishes does", async () => {
  const w = world({
    bookings: [
      { ok: true, cancelled: 1, eventsLeft: 1 },
      { ok: true, cancelled: 0, eventsLeft: 1 },
    ],
    rowFailures: 1,
  });
  const failed = await w.run();
  assert.equal(failed.success, false);
  assert.ok(!w.events.includes("cleanups:activate"), "a failed delete activates nothing");
  const retry = await w.run();
  assert.equal(retry.success, true);
  assert.equal(w.events.filter((e) => e === "cleanups:activate").length, 1);
});
