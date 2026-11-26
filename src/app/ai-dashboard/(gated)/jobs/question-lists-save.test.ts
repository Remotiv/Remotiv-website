/**
 * #58 commit 5: the job save writes both question lists through
 * replace_interview_questions (migration 082) in one call, checks each list it
 * is given first, and cannot create a live list before commit 6.
 *
 *   - async only (today's wizard): the async list is replaced, live untouched;
 *   - both lists (with the switch on, as commit 6 will): both replaced,
 *     positions 1..n, live weight 2;
 *   - left out vs [] for each list; a list that is not an array is refused;
 *   - 9 questions, or a fairness block, in either list: refused, nothing written;
 *   - the function fails: the failure copy, and both lists unchanged;
 *   - another company's job: refused, nothing written;
 *   - while the switch is off (as shipped): a hand-built live list is refused
 *     and no live row is created;
 *   - the edit page's fetch returns each list by its kind.
 *
 *   node --test "src/app/ai-dashboard/(gated)/jobs/question-lists-save.test.ts"
 *
 * The actions are the shipped code; the database is fake-live-db.mjs, which
 * applies filters and models replace_interview_questions as 082 defines it.
 * Synthetic data.
 */
// @ts-nocheck - same reason as the other node:test files.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../../../test-support/tsx-load.mjs", import.meta.url));
register(
  `data:text/javascript,${encodeURIComponent(`
const fail = (what) => "export function " + what + "() { throw new Error('test: " + what + " must not be called'); }";
const REAL_LIVE_LIST = ${JSON.stringify(new URL("../../../../lib/interviews/live-question-list.ts", import.meta.url).href)};
const STUBS = {
  "server-only": "export {};",
  "next/cache": "export function revalidatePath() {}",
  "@/lib/supabase/server": "export function createServiceClient() { return globalThis.__jobsDb.service; }",
  "@/app/ai-dashboard/lib/company-guards": [
    "export async function requireCompanyRole(...roles) {",
    "  const ctx = globalThis.__jobsCtx;",
    "  if (!roles.includes(ctx.role)) throw new Error('forbidden');",
    "  return ctx;",
    "}",
    "export async function getCompanyContext() { return globalThis.__jobsCtx; }",
  ].join("\\n"),
  "@/app/ai-dashboard/lib/job-scope": [
    "export async function roleAllowsJobAction() { return globalThis.__jobsAllowed !== false; }",
    "export async function getJobScope() { return { all: true }; }",
    "export function isEmptyScope() { return false; }",
    "export function readJobScope() { return { all: true }; }",
    "export function scopeJobIds() { return null; }",
  ].join("\\n"),
  "@/app/api/_lib/rate-limit": "export function rateLimitByKey(key, opts) { globalThis.__limited.push([key, opts]); return { ok: globalThis.__limitOk !== false }; }",
  "@/lib/ai/interview-questions": [
    fail("generateInterviewQuestions"),
    "export async function draftAiGuidedQuestions(input) { globalThis.__drafted.push(input); return globalThis.__draftAnswer(input); }",
  ].join(";"),
  "@/lib/ai/jd-generate": fail("generateJobDescription"),
  "@/lib/ai/jd-split": fail("proposeSplit"),
  "@/lib/ai/scoring-criteria": fail("generateScoringCriteria"),
  "@/lib/ai/screening-questions": fail("generateScreeningQuestions"),
  "@/lib/calendar/availability": "export function parseRules(v) { return Array.isArray(v) ? v : []; }",
  "@/lib/notifications/company": "export async function notifyCompany() {}",
  // The shipped switch, made settable: an ESM \`let\` export is a live binding,
  // so actions.ts sees setLiveListSave() at once. It starts at the shipped value.
  "@/lib/interviews/live-question-list": [
    "import * as real from " + JSON.stringify(REAL_LIVE_LIST) + ";",
    "export * from " + JSON.stringify(REAL_LIVE_LIST) + ";",
    "export let LIVE_QUESTION_LIST_SAVE_ENABLED = real.LIVE_QUESTION_LIST_SAVE_ENABLED;",
    "globalThis.__setLiveListSave = (on) => { LIVE_QUESTION_LIST_SAVE_ENABLED = on; };",
  ].join("\\n"),
  "@/lib/jobs-queue": "export const JOB_TYPES = {}; export async function enqueue() { return { ok: true }; }",
};
export async function resolve(specifier, context, next) {
  if (specifier in STUBS) return { url: "data:text/javascript," + encodeURIComponent(STUBS[specifier]), shortCircuit: true };
  return next(specifier, context);
}`)}`,
);

const { createCompanyJob, updateCompanyJob, fetchInterviewQuestions } = await import(
  "./actions.ts"
);
const { EMPTY_JOB_INPUT } = await import("../../lib/job-types.ts");
const { EMPTY_QUESTION_INPUT } = await import("../../../../lib/interviews/types.ts");
const SHIPPED = await import("../../../../lib/interviews/live-question-list.ts");
const { fakeLiveDb } = await import("../../../../test-support/fake-live-db.mjs");

const CO = "c0000000-0000-4000-8000-0000000000e5";
const OTHER_CO = "c0000000-0000-4000-8000-0000000000e6";

function world() {
  const db = fakeLiveDb({ jobs: [], job_hiring_team: [], interview_questions: [] });
  const from = db.service.from.bind(db.service);
  // jobs: .single() returns the row, and an insert gets an id, as PostgREST does.
  db.service.from = (table) => {
    const q = from(table);
    if (table !== "jobs") return q;
    let single = false;
    const chain = new Proxy(q, {
      get(target, prop) {
        if (prop === "then") {
          return (resolve, reject) =>
            target
              .then((r) =>
                single && Array.isArray(r.data) ? { ...r, data: r.data[0] ?? null } : r,
              )
              .then(resolve, reject);
        }
        return (...args) => {
          if (prop === "single") single = true;
          else if (prop === "insert") {
            target.insert(
              { id: crypto.randomUUID(), deleted_at: null, archived_at: null, ...args[0] },
              ...args.slice(1),
            );
            return chain;
          } else target[prop](...args);
          return chain;
        };
      },
    });
    return chain;
  };
  globalThis.__jobsDb = db;
  globalThis.__jobsCtx = {
    companyId: CO,
    company: { id: CO, name: "Test Co" },
    user: { id: "u-save-1" },
    memberId: "m-1",
    memberName: "Test Member",
    role: "recruiter",
  };
  globalThis.__jobsAllowed = true;
  globalThis.__limited = [];
  globalThis.__limitOk = true;
  globalThis.__setLiveListSave(SHIPPED.LIVE_QUESTION_LIST_SAVE_ENABLED);
  return db;
}

async function quiet(fn) {
  const saved = {};
  for (const m of ["error", "warn", "log"]) {
    saved[m] = console[m];
    console[m] = () => {};
  }
  try {
    return await fn();
  } finally {
    Object.assign(console, saved);
  }
}

const q = (question, over = {}) => ({
  ...EMPTY_QUESTION_INPUT,
  id: `new-${crypto.randomUUID()}`,
  question,
  competency: "Ownership",
  rubric: "Names the work and the result.",
  ...over,
});
const qs = (prefix, n) =>
  Array.from({ length: n }, (_, i) => q(`${prefix} synthetic question ${i + 1}?`));
const jobInput = (over = {}) => ({
  ...structuredClone(EMPTY_JOB_INPUT),
  title: "Synthetic Support Lead",
  country: "Pakistan",
  city: "Lahore",
  status: "on_hold",
  description: "Lead a synthetic support team.",
  requirements: "Ticket triage.",
  experience_level: "Senior",
  avatar_interview_enabled: true,
  interview_questions: qs("Async", 4),
  ...over,
});
/** One kind's rows for a job, in position order: [position, first word, weight]. */
const rows = (db, jobId, kind) =>
  db.tables.interview_questions
    .filter((r) => r.job_id === jobId && r.interview_kind === kind)
    .sort((a, b) => a.position - b.position)
    .map((r) => [r.position, r.question.split(" ")[0], r.weight]);
/** A job saved with 4 async and 5 live questions, the switch then back to as shipped. */
async function jobWithBoth() {
  globalThis.__setLiveListSave(true);
  const made = await quiet(() =>
    createCompanyJob(jobInput({ live_interview_questions: qs("Live", 5) })),
  );
  assert.equal(made.success, true, made.error);
  globalThis.__setLiveListSave(SHIPPED.LIVE_QUESTION_LIST_SAVE_ENABLED);
  return made.data.id;
}
const NOT_UPDATED =
  "The role saved, but its interview questions were not updated. Your previous questions are kept.";

test("as shipped, the switch is off: live lists cannot be saved yet", () => {
  assert.equal(SHIPPED.LIVE_QUESTION_LIST_SAVE_ENABLED, false);
});

test("switch off: a hand-built live list is refused before anything is written, and no live row is created", async () => {
  const db = world();
  const made = await quiet(() =>
    createCompanyJob(jobInput({ live_interview_questions: qs("Live", 4) })),
  );
  assert.deepEqual(made, { success: false, error: SHIPPED.LIVE_QUESTION_LIST_NOT_YET });
  assert.equal(db.tables.jobs.length, 0, "no job written");
  assert.equal(db.tables.interview_questions.length, 0, "no question written");
  // On an existing job too, and [] (clear) is refused the same way.
  const id = (await quiet(() => createCompanyJob(jobInput()))).data.id;
  for (const live of [qs("Live", 4), []]) {
    const r = await quiet(() => updateCompanyJob(id, jobInput({ live_interview_questions: live })));
    assert.deepEqual(r, { success: false, error: SHIPPED.LIVE_QUESTION_LIST_NOT_YET });
  }
  assert.deepEqual(rows(db, id, "live"), []);
  assert.equal(rows(db, id, "async").length, 4);
});

test("save async only (today's wizard): the async list is replaced, positions 1..n; live rows untouched", async () => {
  const db = world();
  const id = await jobWithBoth();
  const live = structuredClone(
    db.tables.interview_questions.filter((r) => r.interview_kind === "live"),
  );
  const r = await quiet(() =>
    updateCompanyJob(id, jobInput({ interview_questions: qs("New", 3) })),
  );
  assert.equal(r.success, true, r.error);
  assert.equal(r.warning, undefined);
  assert.deepEqual(rows(db, id, "async"), [
    [1, "New", 2],
    [2, "New", 2],
    [3, "New", 2],
  ]);
  assert.deepEqual(
    db.tables.interview_questions.filter((x) => x.interview_kind === "live"),
    live,
    "live rows byte-equal",
  );
});

test("save both (switch on, as commit 6 will): both replaced, positions 1..n, live weight 2 whatever was sent", async () => {
  const db = world();
  const id = await jobWithBoth();
  globalThis.__setLiveListSave(true);
  const r = await quiet(() =>
    updateCompanyJob(
      id,
      jobInput({
        interview_questions: qs("A2", 2),
        live_interview_questions: [
          q("Live one?", { weight: "6" }),
          q("Live two?", { weight: "1" }),
        ],
      }),
    ),
  );
  assert.equal(r.success, true, r.error);
  assert.deepEqual(rows(db, id, "async"), [
    [1, "A2", 2],
    [2, "A2", 2],
  ]);
  assert.deepEqual(rows(db, id, "live"), [
    [1, "Live", 2],
    [2, "Live", 2],
  ]);
});

test("left out vs []: left out keeps a list, [] clears it; for both lists", async () => {
  const db = world();
  const id = await jobWithBoth();
  globalThis.__setLiveListSave(true);
  // Live [] clears live; async left out keeps async.
  const { interview_questions: _left, ...noAsync } = jobInput({ live_interview_questions: [] });
  assert.equal((await quiet(() => updateCompanyJob(id, noAsync))).success, true);
  assert.equal(rows(db, id, "async").length, 4, "async kept");
  assert.deepEqual(rows(db, id, "live"), [], "live cleared");
  // Async [] clears async; live left out keeps live (now empty, then refilled).
  await quiet(() => updateCompanyJob(id, jobInput({ live_interview_questions: qs("Live", 4) })));
  assert.equal(
    (await quiet(() => updateCompanyJob(id, jobInput({ interview_questions: [] })))).success,
    true,
  );
  assert.deepEqual(rows(db, id, "async"), [], "async cleared");
  assert.equal(rows(db, id, "live").length, 4, "live kept");
});

test("a list that is not an array is refused before anything is written", async () => {
  const db = world();
  const id = await jobWithBoth();
  const before = structuredClone(db.tables);
  globalThis.__setLiveListSave(true);
  for (const bad of [
    { interview_questions: "nope" },
    { live_interview_questions: { 0: q("x") } },
    { interview_questions: null },
  ]) {
    const r = await quiet(() => updateCompanyJob(id, jobInput(bad)));
    assert.deepEqual(r, {
      success: false,
      error: "Those interview questions couldn't be read. Nothing was saved.",
    });
  }
  assert.deepEqual(db.tables, before);
});

test("9 questions, or a fairness block, in either list: refused with its message, nothing written", async () => {
  const db = world();
  const id = await jobWithBoth();
  const before = structuredClone(db.tables);
  globalThis.__setLiveListSave(true);
  const cases = [
    [
      { interview_questions: qs("Async", 9) },
      "A job can have at most 8 interview questions. Remove 1 to save.",
    ],
    [
      { live_interview_questions: qs("Live", 9) },
      "A job can have at most 8 AI Video Interview questions. Remove 1 to save.",
    ],
    [
      { live_interview_questions: [...qs("Live", 3), q("Are you married?")] },
      /^AI Video Interview question 4 \("Are you married\?"\) touches on family or marital status/,
    ],
    [
      { avatar_interview_enabled: false, interview_questions: [q("Do you have children?")] },
      /^Question 1 \("Do you have children\?"\) touches on family or marital status/,
    ],
  ];
  for (const [over, message] of cases) {
    const r = await quiet(() => updateCompanyJob(id, jobInput(over)));
    assert.equal(r.success, false, JSON.stringify(over).slice(0, 60));
    if (typeof message === "string") assert.equal(r.error, message);
    else assert.match(r.error, message);
  }
  assert.deepEqual(db.tables, before, "nothing written");
});

test("the function fails: the job's own fields save, the failure copy is shown, and both lists are unchanged", async () => {
  const db = world();
  const id = await jobWithBoth();
  const questionsBefore = structuredClone(db.tables.interview_questions);
  globalThis.__setLiveListSave(true);
  db.failNext("replace_interview_questions", "rpc");
  const r = await quiet(() =>
    updateCompanyJob(
      id,
      jobInput({
        title: "Synthetic Support Lead (renamed)",
        interview_questions: qs("New", 2),
        live_interview_questions: qs("Newer", 4),
      }),
    ),
  );
  assert.equal(r.success, true, "the role saved");
  assert.equal(r.warning, NOT_UPDATED);
  assert.equal(db.tables.jobs.find((j) => j.id === id).title, "Synthetic Support Lead (renamed)");
  assert.deepEqual(db.tables.interview_questions, questionsBefore, "both lists as they were");
});

test("company scope: another company's job is refused and nothing is written", async () => {
  const db = world();
  const id = await jobWithBoth();
  const before = structuredClone(db.tables);
  globalThis.__jobsCtx = {
    ...globalThis.__jobsCtx,
    companyId: OTHER_CO,
    company: { id: OTHER_CO, name: "Other Co" },
  };
  const r = await quiet(() => updateCompanyJob(id, jobInput({ interview_questions: [] })));
  assert.equal(r.success, false);
  assert.deepEqual(db.tables, before);
});

test("the edit page's fetch returns each list by its kind, in order", async () => {
  const db = world();
  const id = await jobWithBoth();
  const asyncList = await fetchInterviewQuestions(id, "async");
  const liveList = await fetchInterviewQuestions(id, "live");
  assert.deepEqual(
    asyncList.map((x) => x.question),
    qs("Async", 4).map((x) => x.question),
  );
  assert.deepEqual(
    liveList.map((x) => x.question),
    qs("Live", 5).map((x) => x.question),
  );
  assert.equal(db.tables.interview_questions.length, 9);
});
