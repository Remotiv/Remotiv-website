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
} = {}) {
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
  const service = fakeService((table, calls) => {
    const op = calls[0]?.[0];
    if (table === "interview_sessions" && op === "select") {
      events.push("sessions:read");
      if (sessionFails) return { data: null, error: RAW };
      return { data: sessions.map((id) => ({ id })), error: null };
    }
    if (table === "job_applications" && op === "select") return { data: { ...ROW }, error: null };
    if (table === "job_applications" && op === "delete") {
      events.push("row:delete");
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
  assert.deepEqual(w.events.slice(0, 3), ["sessions:read", "interviews", "files"]);
  const read = w.service.queries.find((q) => q.table === "interview_sessions");
  const eq = (c) => read.calls.find((x) => x[0] === "eq" && x[1] === c)?.[2];
  assert.equal(eq("company_id"), CO);
  assert.equal(eq("application_id"), APP);
});

test("b: a failed pre-clean keeps the row and returns the generic failure, code only in the log", async () => {
  const w = world({ preFails: true });
  const res = await w.run();
  assert.equal(res.success, false);
  assert.equal(
    res.error,
    "We couldn't finish that action. Refresh to check the current state, then try again.",
  );
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
  assert.deepEqual(w.events, ["sessions:read"], "interviews, files, bells or row were touched");
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
