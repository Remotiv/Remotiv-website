/**
 * #41 follow-up: the Interviews search runs in SQL, so it no longer reads every
 * session and every applicant name to answer one query.
 *
 *   node --test src/lib/interviews/search-sql.test.ts
 *
 * listInterviewSessions runs as shipped against a fake database that applies
 * every filter it sends, the search's embedded application and job included
 * (interview-list-fake.mjs). Each search is compared, every tab, every page,
 * with the match the list has always used: the query is part of
 * "name email job title" as the row shows them (`oldMatch`, below, the
 * removed listBySearch's own test, run over the whole scoped list). Synthetic
 * data only.
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { register } from "node:module";
import { mock, test } from "node:test";

register(new URL("../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../test-support/messages-test-hook.mjs", import.meta.url));

const { call, fakeService } = await import("../../test-support/fake-postgrest.mjs");
const { answerJobsWithCounts, answerSessions, isJobsWithCounts } = await import(
  "../../test-support/interview-list-fake.mjs"
);
const { deriveStatus, listInterviewSessions } = await import("./review.ts");
const { resolveCandidate } = await import("./review-candidate.ts");

console.error = () => {};
const NOW = Date.parse("2026-11-03T12:00:00.000Z");
mock.timers.enable({ apis: ["Date"], now: NOW });
const DAY = 86_400_000;
const CO = "c0000000-0000-4000-8000-0000000000f1";
const OTHER = "c0000000-0000-4000-8000-0000000000f2";
const JOB_A = "b0000000-0000-4000-8000-0000000000a1";
const JOB_B = "b0000000-0000-4000-8000-0000000000b2";
const JOB_BLANK = "b0000000-0000-4000-8000-0000000000c3";
const JOB_OTHER = "b0000000-0000-4000-8000-0000000000d4";
const OWNER = { companyId: CO, role: "owner", memberId: "m-1", user: { id: "u-1" } };
const RECRUITER = { companyId: CO, role: "recruiter", memberId: "m-2", user: { id: "u-2" } };
const TABS = [
  "all",
  "submitted",
  "started",
  "invited",
  "expired",
  "cancelled",
  "unknown",
  "archived",
];
const iso = (ms) => new Date(ms).toISOString();
const pad = (i) => String(i).padStart(12, "0");

const JOBS = [
  { id: JOB_A, company_id: CO, title: "Senior Engineer" },
  { id: JOB_B, company_id: CO, title: "Data (ML) Analyst" },
  { id: JOB_BLANK, company_id: CO, title: "   " },
  // Another company's job on one of this company's sessions: shown as "This role".
  { id: JOB_OTHER, company_id: OTHER, title: "Designer" },
];

/** Applications: the awkward ones, then fillers. `company` is company_id_snapshot. */
const app = (n, first, last, email, company = CO) => ({
  id: `a0000000-0000-4000-8000-${pad(n)}`,
  company_id_snapshot: company,
  first_name: first,
  last_name: last,
  email,
});
const APPS = [
  app(1, "Ada", "Lovelace", "ada@calc.test"),
  app(2, "O'Brien", null, "obrien@x.test"),
  app(3, "", null, "blank@x.test"), // name falls back to the email
  app(4, "  ", "  ", null), // "Unnamed applicant"
  app(5, "50%_off", "a.b(c)", "weird*@x.test"), // characters SQL and PostgREST treat specially
  app(6, "Moved", "Away", "moved@x.test", OTHER), // another company's now: "Applicant deleted"
  app(7, "Grace", "Hopper", "grace@navy.test"),
  app(8, "Ünal", "Çelik", "unal@x.test"),
  ...Array.from({ length: 45 }, (_, i) =>
    app(100 + i, `Filler${i}`, i % 2 ? "Smith" : "Jones", `f${i}@fill.test`),
  ),
];
const appId = (n) => `a0000000-0000-4000-8000-${pad(n)}`;
const GONE = appId(9); // no row at all: "Applicant deleted"

let seq = 0;
function session(over) {
  seq += 1;
  return {
    id: `5e550000-0000-4000-8000-${pad(seq)}`,
    company_id: CO,
    application_id: null,
    job_id: JOB_A,
    kind: "async",
    status: "submitted",
    started_at: null,
    submitted_at: null,
    expires_at: iso(NOW + DAY),
    delete_after: iso(NOW + 100 * DAY),
    invited_by_name: null,
    questions_snapshot: [{ id: "q0" }],
    archived_at: null,
    created_at: iso(NOW - seq * 60_000),
    previous_attempt_id: null,
    ...over,
  };
}

const first = session({ application_id: appId(7), status: "abandoned", kind: "live" });
const SESSIONS = [
  session({ application_id: appId(1) }),
  session({ application_id: appId(2), job_id: JOB_BLANK, status: "invited" }),
  session({ application_id: appId(3), job_id: null }),
  session({ application_id: appId(4), job_id: JOB_OTHER }),
  session({ application_id: appId(5), job_id: JOB_B, status: "started" }),
  session({ application_id: appId(6) }),
  session({ application_id: null, job_id: JOB_B }),
  session({ application_id: GONE, status: "invited", expires_at: iso(NOW - DAY) }),
  first,
  // Its restart: the chain is one row, this one; the first attempt never shows.
  session({ application_id: appId(7), previous_attempt_id: first.id, kind: "live" }),
  session({ application_id: appId(1), archived_at: iso(NOW - DAY), status: "cancelled" }),
  session({ application_id: appId(8), status: "mystery" }),
  ...Array.from({ length: 45 }, (_, i) =>
    session({
      application_id: appId(100 + i),
      job_id: i % 3 ? JOB_A : JOB_B,
      status: ["submitted", "invited", "started"][i % 3],
    }),
  ),
  // Another company's, on applications this company also has: never shown.
  session({ company_id: OTHER, application_id: appId(1), job_id: JOB_OTHER }),
  session({ company_id: OTHER, application_id: appId(6), job_id: JOB_OTHER }),
];
/** The recruiter is on JOB_A only. */
const TEAM = [{ company_id: CO, member_id: "m-2", job_id: JOB_A }];

const reads = { names: [], sessions: [] };
globalThis.__messagesServiceForTests = () =>
  fakeService((table, calls) => {
    if (table === "interview_sessions") {
      const out = answerSessions(SESSIONS, calls, {
        related: { job_applications: APPS, jobs: JOBS },
      });
      reads.sessions.push(Array.isArray(out.data) ? out.data.length : 0);
      return out;
    }
    if (isJobsWithCounts(table, calls)) return answerJobsWithCounts(JOBS, SESSIONS, calls);
    if (table === "jobs") {
      // The titles of a multi-word search's candidates, as fetchJobs reads them.
      const ids = call(calls, "in")?.[2] ?? [];
      const company = calls.find((c) => c[0] === "eq" && c[1] === "company_id")?.[2];
      return {
        data: JOBS.filter((j) => ids.includes(j.id) && j.company_id === company),
        error: null,
      };
    }
    if (table === "job_hiring_team") {
      return {
        data: TEAM.filter((t) =>
          calls.every((c) => c[0] !== "eq" || t[c[1]] === undefined || t[c[1]] === c[2]),
        ),
        error: null,
      };
    }
    if (table === "job_applications") {
      const ids = call(calls, "in")?.[2] ?? [];
      reads.names.push(ids.length);
      const company = calls.find((c) => c[0] === "eq" && c[1] === "company_id_snapshot")?.[2];
      return {
        data: APPS.filter((a) => ids.includes(a.id) && a.company_id_snapshot === company),
        error: null,
      };
    }
    if (table === "interview_answers") return { data: [], count: 0, error: null };
    if (call(calls, "maybeSingle")) return { data: null, error: null };
    return { data: [], error: null };
  });

/**
 * The match the list has always used, over the whole scoped list (the removed
 * listBySearch): scope, drop restarted first attempts, then the tab, the job
 * and "name email title" containing the query; newest first.
 */
function oldMatch(viewer, { status, jobId = null, query }) {
  const scoped = SESSIONS.filter(
    (s) => s.company_id === CO && (viewer === OWNER || s.job_id === JOB_A),
  );
  const restarted = new Set(scoped.map((s) => s.previous_attempt_id).filter(Boolean));
  const q = query.trim().toLowerCase();
  return scoped
    .filter((s) => !restarted.has(s.id))
    .filter((s) => {
      if ((status === "archived") !== (s.archived_at !== null)) return false;
      if (
        status !== "all" &&
        status !== "archived" &&
        deriveStatus(s.status, s.expires_at) !== status
      )
        return false;
      if (jobId && s.job_id !== jobId) return false;
      const a = APPS.find((x) => x.id === s.application_id && x.company_id_snapshot === CO);
      const who = resolveCandidate(s.application_id, a);
      const job = JOBS.find((j) => j.id === s.job_id && j.company_id === CO);
      const title = job ? job.title.trim() || "Untitled role" : "This role";
      return `${who.name} ${who.email} ${title}`.toLowerCase().includes(q);
    })
    .sort((x, y) => (x.created_at < y.created_at ? 1 : -1))
    .map((s) => s.id);
}

/** Every row the new list serves for a search, page by page, and its totals. */
async function served(viewer, opts) {
  const ids = [];
  let total = null;
  let counts = null;
  for (let page = 1; page < 20; page += 1) {
    const r = await listInterviewSessions(viewer, { ...opts, page });
    assert.equal(r.ok, true, JSON.stringify(opts));
    total ??= r.value.total;
    counts ??= r.value.counts;
    assert.equal(r.value.total, total, "the total does not move with the page");
    ids.push(...r.value.rows.map((x) => x.id));
    if (page * 20 >= r.value.total) break;
  }
  return { ids, total, counts };
}

const QUERIES = [
  "ada",
  "LOVELACE",
  "ada lovelace",
  "lovelace ada",
  "lace ada@",
  "@x.test",
  "o'brien",
  "blank@",
  "unnamed",
  "applicant",
  "deleted",
  "linked",
  "no applicant linked",
  "this role",
  "role",
  "untitled",
  "senior",
  "designer",
  "(ml)",
  "data (ml) analyst",
  "50%",
  "_off",
  "a.b(c)",
  "weird*",
  "%",
  "_",
  ".",
  "*",
  ",",
  '"',
  "\\",
  "ünal",
  "ÇELIK",
  "grace",
  "hopper grace",
  "filler1",
  "smith",
  "jones f2",
  "smith f3@fill",
  "zzz-no-match",
  "  ada  ",
];

test("S1. every search, every tab, page and viewer: the same rows, in the same order, as the old match", async () => {
  let compared = 0;
  for (const viewer of [OWNER, RECRUITER]) {
    const plain = await served(viewer, { status: "all" });
    for (const query of QUERIES) {
      for (const status of TABS) {
        for (const jobId of [null, JOB_B]) {
          const got = await served(viewer, { status, jobId, query });
          const want = oldMatch(viewer, { status, jobId, query });
          const label = `${viewer.role} ${status} ${jobId ? "job B" : "any job"} "${query}"`;
          assert.deepEqual(got.ids, want, label);
          assert.equal(got.total, want.length, label);
          assert.deepEqual(got.counts, plain.counts, `${label}: the counts are the list's`);
          compared += 1;
        }
      }
    }
  }
  assert.equal(compared, 2 * QUERIES.length * TABS.length * 2);
});

test("S2. the awkward rows are found by what they show", async () => {
  const one = async (query) => (await served(OWNER, { status: "all", query })).ids.length;
  assert.equal(await one("applicant deleted"), 2, "another company's application, and none at all");
  assert.equal(await one("no applicant linked"), 1);
  assert.equal(await one("unnamed applicant"), 1);
  assert.equal(await one("this role"), 2, "no job, and another company's job");
  assert.equal(await one("untitled role"), 1);
  assert.equal(await one("blank@x.test blank@x.test"), 1, "a blank name shows the email twice");
  assert.equal(await one("grace"), 1, "the restart only, never its first attempt");
  assert.equal(await one("moved"), 0, "a name from another company's application never matches");
  assert.equal(await one("designer"), 0, "nor a title from another company's job");
});

test("S3. isolation: another company's sessions never match; a scoped recruiter sees their jobs only", async () => {
  const owner = await served(OWNER, { status: "all", query: "ada" });
  assert.ok(owner.ids.every((id) => SESSIONS.find((s) => s.id === id).company_id === CO));
  const scoped = await served(RECRUITER, { status: "all", query: "@" });
  assert.ok(scoped.ids.length > 0);
  assert.ok(scoped.ids.every((id) => SESSIONS.find((s) => s.id === id).job_id === JOB_A));
  const hidden = await served(RECRUITER, { status: "all", query: "(ml)" });
  assert.deepEqual(hidden.ids, [], "JOB_B's title matches, but JOB_B is not theirs");
});

test("S4. a search reads one page of rows and one page of names, whatever matches", async () => {
  reads.names.length = 0;
  reads.sessions.length = 0;
  const r = await listInterviewSessions(OWNER, { status: "all", query: "filler" });
  assert.equal(r.value.total, 45);
  assert.equal(r.value.rows.length, 20);
  assert.deepEqual(reads.names, [20], "names for the visible page only");
  assert.ok(
    Math.max(...reads.sessions) <= 20,
    `largest session read: ${Math.max(...reads.sessions)}`,
  );
});
