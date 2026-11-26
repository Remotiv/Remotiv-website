/**
 * #59 commit 1: one go-live gate. A job with AI Video Interview on can be
 * Published only with 4 to 8 live questions, on every path that makes a job
 * live: the wizard's Publish and Save changes (unchanged), the jobs list's
 * status menu, restore and unarchive (back On hold, never refused), and the
 * admin's status, edit and restore. AI Video Interview off: any count. Async
 * questions never count.
 *
 *   node --test "src/app/ai-dashboard/(gated)/jobs/go-live-gate.test.ts"
 *
 * The actions are the shipped code; the database is fake-live-db.mjs, which
 * applies filters. Synthetic data.
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
  "@/app/admin/lib/role-guards": "export async function requireAdmin() { return { userId: 'admin-1' }; } export async function requireSuperAdmin() { return { userId: 'admin-1' }; }",
  "@/lib/jobs-queue": "export const JOB_TYPES = {}; export async function enqueue() { return { ok: true }; }",
};
export async function resolve(specifier, context, next) {
  if (specifier in STUBS) return { url: "data:text/javascript," + encodeURIComponent(STUBS[specifier]), shortCircuit: true };
  return next(specifier, context);
}`)}`,
);

const {
  createCompanyJob,
  updateCompanyJob,
  updateCompanyJobStatus,
  restoreCompanyJob,
  setCompanyJobArchived,
} = await import("./actions.ts");
const admin = await import("../../../admin/jobs/actions.ts");
const { EMPTY_JOB_INPUT } = await import("../../lib/job-types.ts");
const { EMPTY_QUESTION_INPUT } = await import("../../../../lib/interviews/types.ts");
const SHIPPED = await import("../../../../lib/interviews/live-question-list.ts");
const GATE = await import("../../../../lib/interviews/live-go-live.ts");
const { fakeLiveDb } = await import("../../../../test-support/fake-live-db.mjs");

const CO = "c0000000-0000-4000-8000-0000000000e9";

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
            // The database makes the id, always: this fake returns whole rows
            // (no column projection), so a duplicate's copied row carries the
            // source's id, which a real insert would never be sent.
            target.insert(
              { deleted_at: null, archived_at: null, ...args[0], id: crypto.randomUUID() },
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
/**
 * AI Video Interview OFF unless a test turns it on, and no live list unless a
 * test sends one: a client from before step 6, whose save leaves live rows alone.
 */
const { live_interview_questions: _noLiveList, ...EMPTY_BEFORE_STEP_6 } = EMPTY_JOB_INPUT;
const jobInput = (over = {}) => ({
  ...structuredClone(EMPTY_BEFORE_STEP_6),
  title: "Synthetic Support Lead",
  country: "Pakistan",
  city: "Lahore",
  status: "on_hold",
  description: "Lead a synthetic support team.",
  requirements: "Ticket triage.",
  experience_level: "Senior",
  avatar_interview_enabled: false,
  interview_questions: qs("Async", 4),
  ...over,
});
/**
 * A job as stored: Published or not, AI Video Interview on or off, n live and
 * m async questions. Made through the save (AI Video Interview off, so any
 * count saves), then set to the state under test in the table itself.
 */
async function job(
  db,
  { status = "on_hold", avatar = true, live = 3, async = 2, extra = {} } = {},
) {
  const made = await quiet(() =>
    createCompanyJob(
      jobInput({
        avatar_interview_enabled: false,
        interview_questions: qs("Async", async),
        live_interview_questions: qs("Live", live),
      }),
    ),
  );
  assert.equal(made.success, true, made.error);
  Object.assign(
    db.tables.jobs.find((j) => j.id === made.data.id),
    {
      status,
      avatar_interview_enabled: avatar,
      ...extra,
    },
  );
  return made.data.id;
}
const stored = (db, id) => db.tables.jobs.find((j) => j.id === id);
const ADMIN_INPUT = {
  title: "Synthetic board role",
  company: "Test Co",
  company_rating: "4.5",
  location: "Remote",
  salary_min: "",
  salary_max: "",
  salary_currency: "USD",
  contract_type: "Full time",
  work_type: "Remote",
  category: "Engineering",
  experience_level: "Intermediate",
  language: "English",
  positions: "1",
  description: "",
  responsibilities: "",
  requirements: "",
  screening_questions: [],
  display_order: "",
  status: "open",
};

test("the rule: AI Video Interview on needs 4 to 8 live questions; off, any count", () => {
  for (const [on, n, ok] of [
    [true, 3, false],
    [true, 4, true],
    [true, 8, true],
    [true, 9, false],
    [true, 0, false],
    [false, 0, true],
    [false, 3, true],
    [false, 12, true],
  ]) {
    assert.equal(GATE.liveQuestionCountOk(on, n), ok, `${on} ${n}`);
  }
});

test("jobs list status menu: Publish with 3 live questions is refused, nothing written; 4 and 8 publish", async () => {
  const db = world();
  const id = await job(db, { live: 3 });
  const before = structuredClone(db.tables.jobs);
  assert.deepEqual(await quiet(() => updateCompanyJobStatus(id, "open")), {
    success: false,
    error: GATE.GO_LIVE_REFUSED,
  });
  assert.deepEqual(db.tables.jobs, before);
  for (const n of [4, 8]) {
    const ok = await job(db, { live: n });
    const r = await quiet(() => updateCompanyJobStatus(ok, "open"));
    assert.equal(r.success, true, `${n}: ${r.error}`);
    assert.equal(stored(db, ok).status, "open");
  }
});

test("jobs list status menu: AI Video Interview off publishes with any count; async-only jobs are unaffected", async () => {
  const db = world();
  for (const [live, async] of [
    [0, 0],
    [3, 0],
    [0, 9],
  ]) {
    const id = await job(db, { avatar: false, live, async: Math.min(async, 8) });
    const r = await quiet(() => updateCompanyJobStatus(id, "open"));
    assert.equal(r.success, true, `${live}/${async}: ${r.error}`);
  }
  // Async questions never count toward the live 4: 8 async + 3 live is still refused.
  const mixed = await job(db, { live: 3, async: 8 });
  assert.equal((await quiet(() => updateCompanyJobStatus(mixed, "open"))).success, false);
});

test("jobs list status menu: On hold and Closed are never gated", async () => {
  const db = world();
  const id = await job(db, { status: "open", live: 0 });
  for (const status of ["on_hold", "closed"]) {
    const r = await quiet(() => updateCompanyJobStatus(id, status));
    assert.equal(r.success, true, `${status}: ${r.error}`);
    assert.equal(stored(db, id).status, status);
  }
});

test("restore: a Published job that fails comes back On hold, with the reason; never refused", async () => {
  const db = world();
  const fails = await job(db, {
    status: "open",
    live: 3,
    extra: { deleted_at: "2026-11-20T10:00:00.000Z" },
  });
  const r = await quiet(() => restoreCompanyJob(fails));
  assert.deepEqual(r, { success: true, data: undefined, warning: GATE.RESTORED_ON_HOLD });
  assert.deepEqual([stored(db, fails).deleted_at, stored(db, fails).status], [null, "on_hold"]);
  // 4 live, or AI Video Interview off: back as it was, no warning.
  for (const extra of [{ live: 4 }, { live: 0, avatar: false }]) {
    const ok = await job(db, {
      status: "open",
      ...extra,
      extra: { deleted_at: "2026-11-20T10:00:00.000Z" },
    });
    const back = await quiet(() => restoreCompanyJob(ok));
    assert.deepEqual(back, { success: true, data: undefined });
    assert.equal(stored(db, ok).status, "open");
  }
  // A job that was On hold anyway: no warning.
  const draft = await job(db, { live: 0, extra: { deleted_at: "2026-11-20T10:00:00.000Z" } });
  assert.deepEqual(await quiet(() => restoreCompanyJob(draft)), { success: true, data: undefined });
});

test("unarchive: a Published job that fails comes back On hold, with the reason; archiving is never gated", async () => {
  const db = world();
  const fails = await job(db, {
    status: "open",
    live: 3,
    extra: { archived_at: "2026-11-20T10:00:00.000Z" },
  });
  const r = await quiet(() => setCompanyJobArchived(fails, false));
  assert.deepEqual(r, { success: true, data: undefined, warning: GATE.UNARCHIVED_ON_HOLD });
  assert.deepEqual([stored(db, fails).archived_at, stored(db, fails).status], [null, "on_hold"]);
  const ok = await job(db, {
    status: "open",
    live: 8,
    extra: { archived_at: "2026-11-20T10:00:00.000Z" },
  });
  assert.deepEqual(await quiet(() => setCompanyJobArchived(ok, false)), {
    success: true,
    data: undefined,
  });
  assert.equal(stored(db, ok).status, "open");
  const live = await job(db, { status: "open", live: 0 });
  assert.deepEqual(await quiet(() => setCompanyJobArchived(live, true)), {
    success: true,
    data: undefined,
  });
  assert.equal(stored(db, live).status, "open", "archiving changes no status");
});

test("wizard Publish and Save changes: unchanged - a sent live list outside 4 to 8 is refused", async () => {
  const db = world();
  const refusal =
    "AI Video Interview needs 4 to 8 questions. Add them on the AI Video Interview step, or turn AI Video Interview off to save without them.";
  const three = await quiet(() =>
    createCompanyJob(
      jobInput({
        status: "open",
        avatar_interview_enabled: true,
        live_interview_questions: qs("Live", 3),
      }),
    ),
  );
  assert.deepEqual(three, { success: false, error: refusal });
  const id = await job(db, { live: 4 });
  const save = await quiet(() =>
    updateCompanyJob(id, jobInput({ status: "open", avatar_interview_enabled: true })),
  );
  assert.equal(save.success, true, save.error);
  db.tables.interview_questions = db.tables.interview_questions.filter(
    (x) => !(x.job_id === id && x.interview_kind === "live" && x.position === 4),
  );
  const short = await quiet(() =>
    updateCompanyJob(id, jobInput({ status: "open", avatar_interview_enabled: true })),
  );
  assert.deepEqual(short, { success: false, error: refusal });
});

test("wizard Publish: a NEW job with AI Video Interview on and 4 submitted live questions publishes; an existing job with 2 stored publishes with 4 submitted (the gate reads the submitted list)", async () => {
  const db = world();
  const made = await quiet(() =>
    createCompanyJob(
      jobInput({
        status: "open",
        avatar_interview_enabled: true,
        live_interview_questions: qs("Live", 4),
      }),
    ),
  );
  assert.equal(made.success, true, made.error);
  assert.equal(stored(db, made.data.id).status, "open", "(a) new job published");
  // (b) Stored: 2 live questions (fails the gate on its own). Submitted: 4.
  const id = await job(db, { live: 2, avatar: false });
  const saved = await quiet(() =>
    updateCompanyJob(
      id,
      jobInput({
        status: "open",
        avatar_interview_enabled: true,
        live_interview_questions: qs("New", 4),
      }),
    ),
  );
  assert.equal(saved.success, true, saved.error);
  assert.deepEqual(
    [stored(db, id).status, stored(db, id).avatar_interview_enabled],
    ["open", true],
    "(b) existing job saved and published",
  );
  assert.equal(
    db.tables.interview_questions.filter((x) => x.job_id === id && x.interview_kind === "live")
      .length,
    4,
  );
});

test("admin status control: Publish with 3 live questions is refused by the job's own company's questions; 4 publishes", async () => {
  const db = world();
  const id = await job(db, { live: 3 });
  const before = structuredClone(db.tables.jobs);
  assert.deepEqual(await quiet(() => admin.updateJobStatus(id, "open")), {
    success: false,
    error: GATE.ADMIN_GO_LIVE_REFUSED,
  });
  assert.deepEqual(db.tables.jobs, before);
  const ok = await job(db, { live: 4 });
  assert.equal((await quiet(() => admin.updateJobStatus(ok, "open"))).success, true);
  const off = await job(db, { avatar: false, live: 0 });
  assert.equal((await quiet(() => admin.updateJobStatus(off, "open"))).success, true);
  assert.equal(
    (await quiet(() => admin.updateJobStatus(id, "closed"))).success,
    true,
    "Closed is never gated",
  );
});

test("admin edit: saving it as Published with 3 live questions is refused; 8 saves", async () => {
  const db = world();
  const id = await job(db, { live: 3 });
  const before = structuredClone(db.tables.jobs);
  assert.deepEqual(await quiet(() => admin.updateJob(id, ADMIN_INPUT)), {
    success: false,
    error: GATE.ADMIN_GO_LIVE_REFUSED,
  });
  assert.deepEqual(db.tables.jobs, before);
  const onHold = await quiet(() => admin.updateJob(id, { ...ADMIN_INPUT, status: "on_hold" }));
  assert.equal(onHold.success, true, onHold.error);
  const ok = await job(db, { live: 8 });
  assert.equal((await quiet(() => admin.updateJob(ok, ADMIN_INPUT))).success, true);
});

test("admin restore: a Published job that fails comes back On hold, with the reason; never refused", async () => {
  const db = world();
  const fails = await job(db, {
    status: "open",
    live: 3,
    extra: { deleted_at: "2026-11-20T10:00:00.000Z" },
  });
  assert.deepEqual(await quiet(() => admin.restoreJob(fails)), {
    success: true,
    data: undefined,
    warning: GATE.ADMIN_RESTORED_ON_HOLD,
  });
  assert.deepEqual([stored(db, fails).deleted_at, stored(db, fails).status], [null, "on_hold"]);
  const ok = await job(db, {
    status: "open",
    live: 4,
    extra: { deleted_at: "2026-11-20T10:00:00.000Z" },
  });
  assert.deepEqual(await quiet(() => admin.restoreJob(ok)), { success: true, data: undefined });
  assert.equal(stored(db, ok).status, "open");
});

test("a failed read fails closed: the status menu refuses with the unreadable message", async () => {
  const db = world();
  const id = await job(db, { live: 8 });
  db.failNext("interview_questions", "select");
  assert.deepEqual(await quiet(() => updateCompanyJobStatus(id, "open")), {
    success: false,
    error: GATE.GO_LIVE_UNREADABLE,
  });
  assert.equal(stored(db, id).status, "on_hold");
});

test("every new message: hyphens only", () => {
  for (const m of [
    GATE.GO_LIVE_REFUSED,
    GATE.GO_LIVE_UNREADABLE,
    GATE.RESTORED_ON_HOLD,
    GATE.UNARCHIVED_ON_HOLD,
    GATE.ADMIN_GO_LIVE_REFUSED,
    GATE.ADMIN_RESTORED_ON_HOLD,
  ]) {
    assert.doesNotMatch(m, /[–—]/);
  }
  assert.equal(SHIPPED.LIVE_QUESTION_LIST_SAVE_ENABLED, true);
});
