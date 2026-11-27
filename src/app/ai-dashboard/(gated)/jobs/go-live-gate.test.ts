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
  { status = "on_hold", avatar = true, asyncOn = false, live = 3, async = 2, extra = {} } = {},
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
      async_interview_enabled: asyncOn,
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

/* ── #61: Async Video Interview on needs at least 3 async questions ── */

const M = GATE.GO_LIVE_MESSAGES;
const deleted = { deleted_at: "2026-11-20T10:00:00.000Z" };
const archivedAt = { archived_at: "2026-11-20T10:00:00.000Z" };

test("#61 the async rule: on needs at least 3; off, any count", () => {
  assert.equal(GATE.MIN_ASYNC_QUESTIONS, 3);
  for (const [on, n, ok] of [
    [true, 0, false],
    [true, 2, false],
    [true, 3, true],
    [true, 8, true],
    [true, 9, false],
    [false, 0, true],
    [false, 2, true],
    [false, 9, true],
  ]) {
    assert.equal(GATE.asyncQuestionCountOk(on, n), ok, `${on} ${n}`);
  }
});

test("#61 wizard Publish and Save changes: async on with 0 or 2 refused, 3 and 8 publish; sent list, else stored", async () => {
  const db = world();
  for (const n of [0, 2]) {
    const r = await quiet(() =>
      createCompanyJob(
        jobInput({
          status: "open",
          async_interview_enabled: true,
          interview_questions: qs("Async", n),
        }),
      ),
    );
    assert.deepEqual(r, { success: false, error: M.save.async }, `${n}`);
  }
  assert.equal(db.tables.jobs.length, 0);
  for (const n of [3, 8]) {
    const r = await quiet(() =>
      createCompanyJob(
        jobInput({
          status: "open",
          async_interview_enabled: true,
          interview_questions: qs("Async", n),
        }),
      ),
    );
    assert.equal(r.success, true, `${n}: ${r.error}`);
  }
  // An edit that sends no async list: the stored count decides (2 stored: refused; 3: publishes).
  for (const [storedN, ok] of [
    [2, false],
    [3, true],
  ]) {
    const id = await job(db, { avatar: false, live: 0, async: storedN });
    const { interview_questions: _none, ...noAsync } = jobInput({
      status: "open",
      async_interview_enabled: true,
      avatar_interview_enabled: false,
    });
    const r = await quiet(() => updateCompanyJob(id, noAsync));
    assert.equal(r.success, ok, `${storedN} stored: ${r.error}`);
    if (!ok) assert.equal(r.error, M.save.async);
  }
  // Submitted beats stored: 2 stored, 3 sent, publishes.
  const id = await job(db, { avatar: false, live: 0, async: 2 });
  const sent = await quiet(() =>
    updateCompanyJob(
      id,
      jobInput({
        status: "open",
        async_interview_enabled: true,
        interview_questions: qs("New", 3),
      }),
    ),
  );
  assert.equal(sent.success, true, sent.error);
});

test("#61 drafts always save: async on with 0 questions saves On hold and Closed", async () => {
  world();
  for (const status of ["on_hold", "closed"]) {
    const r = await quiet(() =>
      createCompanyJob(
        jobInput({ status, async_interview_enabled: true, interview_questions: [] }),
      ),
    );
    assert.equal(r.success, true, `${status}: ${r.error}`);
  }
});

test("#61 async off: any count publishes; live questions never count toward async", async () => {
  const db = world();
  const off = await job(db, { avatar: false, asyncOn: false, live: 0, async: 0 });
  assert.equal((await quiet(() => updateCompanyJobStatus(off, "open"))).success, true);
  // 8 live questions (AI Video Interview off) + 2 async with async on: still refused.
  const mixed = await job(db, { avatar: false, asyncOn: true, live: 8, async: 2 });
  assert.deepEqual(await quiet(() => updateCompanyJobStatus(mixed, "open")), {
    success: false,
    error: M.status.async,
  });
});

test("#61 both rules failing: one message naming both, on every path", async () => {
  const db = world();
  const both = { avatar: true, asyncOn: true, live: 3, async: 2 };
  const id = await job(db, both);
  assert.deepEqual(await quiet(() => updateCompanyJobStatus(id, "open")), {
    success: false,
    error: M.status.both,
  });
  assert.deepEqual(await quiet(() => admin.updateJobStatus(id, "open")), {
    success: false,
    error: M.admin.both,
  });
  const save = await quiet(() =>
    createCompanyJob(
      jobInput({
        status: "open",
        avatar_interview_enabled: true,
        async_interview_enabled: true,
        live_interview_questions: qs("Live", 3),
        interview_questions: qs("Async", 2),
      }),
    ),
  );
  assert.deepEqual(save, { success: false, error: M.save.both });
  const r = await job(db, { ...both, status: "open", extra: deleted });
  assert.equal((await quiet(() => restoreCompanyJob(r))).warning, M.restore.both);
  const u = await job(db, { ...both, status: "open", extra: archivedAt });
  assert.equal((await quiet(() => setCompanyJobArchived(u, false))).warning, M.unarchive.both);
  const a = await job(db, { ...both, status: "open", extra: deleted });
  assert.equal((await quiet(() => admin.restoreJob(a))).warning, M.adminRestore.both);
});

test("#61 status menu, restore, unarchive: async on with 2 refused / back On hold; 3 allowed", async () => {
  const db = world();
  const two = { avatar: false, asyncOn: true, live: 0, async: 2 };
  const three = { avatar: false, asyncOn: true, live: 0, async: 3 };
  const s2 = await job(db, two);
  assert.deepEqual(await quiet(() => updateCompanyJobStatus(s2, "open")), {
    success: false,
    error: M.status.async,
  });
  const s3 = await job(db, three);
  assert.equal((await quiet(() => updateCompanyJobStatus(s3, "open"))).success, true);
  const r2 = await job(db, { ...two, status: "open", extra: deleted });
  assert.deepEqual(await quiet(() => restoreCompanyJob(r2)), {
    success: true,
    data: undefined,
    warning: M.restore.async,
  });
  assert.equal(stored(db, r2).status, "on_hold");
  const r3 = await job(db, { ...three, status: "open", extra: deleted });
  assert.deepEqual(await quiet(() => restoreCompanyJob(r3)), { success: true, data: undefined });
  assert.equal(stored(db, r3).status, "open");
  const u2 = await job(db, { ...two, status: "open", extra: archivedAt });
  assert.deepEqual(await quiet(() => setCompanyJobArchived(u2, false)), {
    success: true,
    data: undefined,
    warning: M.unarchive.async,
  });
  assert.equal(stored(db, u2).status, "on_hold");
});

test("#61 admin status, edit, restore: async on with 0 refused / back On hold; 8 allowed", async () => {
  const db = world();
  const zero = { avatar: false, asyncOn: true, live: 0, async: 0 };
  const eight = { avatar: false, asyncOn: true, live: 0, async: 8 };
  const z = await job(db, zero);
  assert.deepEqual(await quiet(() => admin.updateJobStatus(z, "open")), {
    success: false,
    error: M.admin.async,
  });
  assert.deepEqual(await quiet(() => admin.updateJob(z, ADMIN_INPUT)), {
    success: false,
    error: M.admin.async,
  });
  const e1 = await job(db, eight);
  assert.equal((await quiet(() => admin.updateJobStatus(e1, "open"))).success, true);
  const e2 = await job(db, eight);
  assert.equal((await quiet(() => admin.updateJob(e2, ADMIN_INPUT))).success, true);
  const r = await job(db, { ...zero, status: "open", extra: deleted });
  assert.deepEqual(await quiet(() => admin.restoreJob(r)), {
    success: true,
    data: undefined,
    warning: M.adminRestore.async,
  });
  assert.equal(stored(db, r).status, "on_hold");
});

test("#61 a failed read fails closed with the generic message; every message is hyphens only", async () => {
  const db = world();
  const id = await job(db, { avatar: false, asyncOn: true, live: 0, async: 8 });
  db.failNext("interview_questions", "select");
  assert.deepEqual(await quiet(() => updateCompanyJobStatus(id, "open")), {
    success: false,
    error: "Couldn't check this job's interview questions - please try again.",
  });
  for (const path of Object.values(M)) {
    for (const m of Object.values(path)) assert.doesNotMatch(m, /[–—]/);
  }
});

/* ── #61 fixes: a half-failed Publish goes On hold; max 8 at go-live ── */

const LIST = await import("../../../../lib/interviews/live-question-list.ts");

/** Extra rows of one kind straight into the table: stored before the 8 limit existed. */
function addRows(db, jobId, kind, n) {
  const at = db.tables.interview_questions.filter(
    (x) => x.job_id === jobId && x.interview_kind === kind,
  ).length;
  for (let i = 1; i <= n; i += 1) {
    db.tables.interview_questions.push({
      id: crypto.randomUUID(),
      job_id: jobId,
      company_id: CO,
      interview_kind: kind,
      position: at + i,
      question: `Extra ${kind} question ${i}?`,
    });
  }
}

/**
 * Every write to jobs, in order: insert or update, the status it writes, and
 * how many questions were stored at that moment. With `failOnHold`, the edit
 * fallback's own write (status On hold, nothing else) fails.
 */
function recordJobWrites(db, { failOnHold = false } = {}) {
  const writes = [];
  const from = db.service.from;
  db.service.from = (table) => {
    const q = from(table);
    if (table !== "jobs") return q;
    return new Proxy(q, {
      get(target, prop) {
        if (prop === "insert" || prop === "update") {
          return (...args) => {
            for (const row of Array.isArray(args[0]) ? args[0] : [args[0]]) {
              writes.push({
                op: prop,
                status: row.status,
                questions: db.tables.interview_questions.length,
              });
              const onlyOnHold = Object.keys(row).join() === "status" && row.status === "on_hold";
              if (failOnHold && prop === "update" && onlyOnHold) db.failNext("jobs", "update");
            }
            return target[prop](...args);
          };
        }
        const v = target[prop];
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
  };
  return writes;
}

/** Log lines, captured. */
async function logged(fn) {
  const lines = [];
  const saved = { error: console.error, warn: console.warn, log: console.log };
  console.error = console.warn = console.log = (...a) => lines.push(a.join(" "));
  try {
    return { result: await fn(), lines };
  } finally {
    Object.assign(console, saved);
  }
}

test("publish last: a new Publish whose questions fail stays On hold, never Published at any point", async () => {
  const db = world();
  const writes = recordJobWrites(db);
  db.failNext("replace_interview_questions", "rpc");
  const r = await quiet(() => createCompanyJob(jobInput({ status: "open" })));
  assert.equal(r.success, true, "the role saved");
  assert.equal(
    r.warning,
    "The role saved as On hold, but its interview questions were not saved. Open the job to add them, then publish.",
  );
  assert.equal(r.warning, LIST.PUBLISHED_QUESTIONS_NOT_SAVED);
  assert.deepEqual(
    writes,
    [{ op: "insert", status: "on_hold", questions: 0 }],
    "one write, On hold",
  );
  assert.equal(stored(db, r.data.id).status, "on_hold");
  assert.equal(db.tables.interview_questions.length, 0);
});

test("publish last: the final Published update fails - On hold with its questions, the message, one log line", async () => {
  const db = world();
  const writes = recordJobWrites(db);
  db.failNext("jobs", "update");
  const { result: r, lines } = await logged(() => createCompanyJob(jobInput({ status: "open" })));
  assert.equal(r.success, true);
  assert.equal(
    r.warning,
    "The role saved as On hold with its interview questions, but it could not be published. Open the job and publish it again.",
  );
  assert.equal(r.warning, LIST.NEW_JOB_NOT_PUBLISHED);
  assert.equal(stored(db, r.data.id).status, "on_hold");
  assert.equal(db.tables.interview_questions.length, 4, "its questions are saved");
  assert.deepEqual(
    writes.map((w) => w.status),
    ["on_hold", "open"],
  );
  assert.ok(
    lines.includes(`[jobs] new job not published: job ${r.data.id} (XX000)`),
    lines.join("\n"),
  );
  assert.ok(!lines.join("\n").includes("synthetic question"), "no question text logged");
});

test("publish last: success - created On hold, questions saved, then ONE update to Published", async () => {
  for (const over of [
    {},
    { avatar_interview_enabled: true, live_interview_questions: qs("Live", 4) },
    { async_interview_enabled: true, interview_questions: qs("Async", 3) },
  ]) {
    const db = world();
    const writes = recordJobWrites(db);
    const r = await quiet(() => createCompanyJob(jobInput({ status: "open", ...over })));
    assert.equal(r.success, true, r.error);
    assert.equal(r.warning, undefined);
    assert.equal(stored(db, r.data.id).status, "open");
    const n = db.tables.interview_questions.length;
    assert.ok(n >= 3);
    assert.deepEqual(writes, [
      { op: "insert", status: "on_hold", questions: 0 },
      { op: "update", status: "open", questions: n },
    ]);
  }
  // Drafts are written once, as saved: no publish step.
  for (const status of ["on_hold", "closed"]) {
    const db = world();
    const writes = recordJobWrites(db);
    const r = await quiet(() => createCompanyJob(jobInput({ status })));
    assert.deepEqual(writes, [{ op: "insert", status, questions: 0 }]);
    assert.equal(stored(db, r.data.id).status, status);
  }
});

test("Save changes on a Published job whose questions fail: now On hold, previous questions kept", async () => {
  const db = world();
  const id = await job(db, { status: "open", avatar: false, live: 0, async: 2 });
  const before = structuredClone(db.tables.interview_questions);
  db.failNext("replace_interview_questions", "rpc");
  const r = await quiet(() =>
    updateCompanyJob(id, jobInput({ status: "open", interview_questions: qs("New", 4) })),
  );
  assert.equal(r.success, true);
  assert.equal(
    r.warning,
    "The role saved, but its interview questions were not updated. Your previous questions are kept, and the job is now On hold.",
  );
  assert.equal(stored(db, id).status, "on_hold");
  assert.deepEqual(db.tables.interview_questions, before, "previous questions kept");
});

test("drafts whose questions fail: unchanged messages, status as saved", async () => {
  const db = world();
  db.failNext("replace_interview_questions", "rpc");
  const made = await quiet(() => createCompanyJob(jobInput({ status: "on_hold" })));
  assert.equal(made.warning, LIST.QUESTIONS_NOT_SAVED);
  assert.equal(stored(db, made.data.id).status, "on_hold");
  const closed = await job(db, { status: "closed", avatar: false, live: 0 });
  db.failNext("replace_interview_questions", "rpc");
  const edit = await quiet(() => updateCompanyJob(closed, jobInput({ status: "closed" })));
  assert.equal(edit.warning, LIST.QUESTIONS_NOT_UPDATED);
  assert.equal(stored(db, closed).status, "closed");
});

test("Save changes on a Published job: questions fail AND going On hold fails - one log line with the job id and both codes", async () => {
  const db = world();
  const id = await job(db, { status: "open", avatar: false, live: 0, async: 2 });
  recordJobWrites(db, { failOnHold: true });
  db.failNext("replace_interview_questions", "rpc");
  const { result: r, lines } = await logged(() =>
    updateCompanyJob(id, jobInput({ status: "open" })),
  );
  assert.equal(r.warning, LIST.QUESTIONS_NOT_UPDATED, "the plain failure, not 'now On hold'");
  assert.equal(stored(db, id).status, "open", "still Published: the update failed");
  assert.ok(
    lines.includes(
      `[jobs] published job left without its questions: job ${id} (questions XX000, on hold XX000)`,
    ),
    lines.join("\n"),
  );
  assert.ok(!lines.join("\n").includes("synthetic question"), "no question text logged");
});

test("max 8 at go-live: 9 stored async questions (async on) refused / back On hold on every path", async () => {
  const db = world();
  const nine = async (extra = {}) => {
    const id = await job(db, { avatar: false, asyncOn: true, live: 0, async: 8, ...extra });
    addRows(db, id, "async", 1);
    return id;
  };
  assert.deepEqual(await quiet(async () => updateCompanyJobStatus(await nine(), "open")), {
    success: false,
    error: M.status.async,
  });
  assert.deepEqual(await quiet(async () => admin.updateJobStatus(await nine(), "open")), {
    success: false,
    error: M.admin.async,
  });
  assert.deepEqual(await quiet(async () => admin.updateJob(await nine(), ADMIN_INPUT)), {
    success: false,
    error: M.admin.async,
  });
  const r = await nine({ status: "open", extra: deleted });
  assert.equal((await quiet(() => restoreCompanyJob(r))).warning, M.restore.async);
  assert.equal(stored(db, r).status, "on_hold");
  const u = await nine({ status: "open", extra: archivedAt });
  assert.equal((await quiet(() => setCompanyJobArchived(u, false))).warning, M.unarchive.async);
  const a = await nine({ status: "open", extra: deleted });
  assert.equal((await quiet(() => admin.restoreJob(a))).warning, M.adminRestore.async);
  // 8 stored passes.
  const eight = await job(db, { avatar: false, asyncOn: true, live: 0, async: 8 });
  assert.equal((await quiet(() => updateCompanyJobStatus(eight, "open"))).success, true);
});

test("max 8 at go-live: 9 stored live questions (AI Video Interview on) refused / back On hold on every path", async () => {
  const db = world();
  const nine = async (extra = {}) => {
    const id = await job(db, { avatar: true, live: 8, async: 0, ...extra });
    addRows(db, id, "live", 1);
    return id;
  };
  assert.deepEqual(await quiet(async () => updateCompanyJobStatus(await nine(), "open")), {
    success: false,
    error: M.status.live,
  });
  assert.deepEqual(await quiet(async () => admin.updateJobStatus(await nine(), "open")), {
    success: false,
    error: M.admin.live,
  });
  assert.deepEqual(await quiet(async () => admin.updateJob(await nine(), ADMIN_INPUT)), {
    success: false,
    error: M.admin.live,
  });
  const r = await nine({ status: "open", extra: deleted });
  assert.equal((await quiet(() => restoreCompanyJob(r))).warning, M.restore.live);
  const u = await nine({ status: "open", extra: archivedAt });
  assert.equal((await quiet(() => setCompanyJobArchived(u, false))).warning, M.unarchive.live);
  const a = await nine({ status: "open", extra: deleted });
  assert.equal((await quiet(() => admin.restoreJob(a))).warning, M.adminRestore.live);
  // An interview that is off is never sent: 9 stored with it off does not block.
  const off = await job(db, { avatar: false, asyncOn: false, live: 8, async: 0 });
  addRows(db, off, "live", 1);
  assert.equal((await quiet(() => updateCompanyJobStatus(off, "open"))).success, true);
});

test("Published, questions fail, and the caller may not act on the job: left as it was, logged with the job id", async () => {
  const db = world();
  const id = await job(db, { status: "open", avatar: false, live: 0, async: 2 });
  db.failNext("replace_interview_questions", "rpc");
  // Allowed for the edit's own checks, then not for the On hold write (the scope check).
  let calls = 0;
  Object.defineProperty(globalThis, "__jobsAllowed", {
    configurable: true,
    get: () => {
      calls += 1;
      return calls === 1;
    },
  });
  const lines = [];
  const saved = { error: console.error, warn: console.warn, log: console.log };
  console.error = console.warn = console.log = (...a) => lines.push(a.join(" "));
  const r = await updateCompanyJob(id, jobInput({ status: "open" })).finally(() => {
    Object.assign(console, saved);
    delete globalThis.__jobsAllowed;
    globalThis.__jobsAllowed = true;
  });
  assert.equal(r.warning, LIST.QUESTIONS_NOT_UPDATED);
  assert.ok(
    lines.includes(
      `[jobs] published job left without its questions: job ${id} (questions XX000, on hold not_allowed)`,
    ),
    lines.join("\n"),
  );
});
