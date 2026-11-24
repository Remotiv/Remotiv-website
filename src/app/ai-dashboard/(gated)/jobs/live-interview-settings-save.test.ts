/**
 * #45, #46: the AI Video Interview's mode, length and hiring challenges are
 * saved with the job (createCompanyJob, updateCompanyJob), loaded back for the
 * edit page (liveInterviewInputFromRow) and copied by duplicateCompanyJob,
 * all checked server-side whatever the browser sends.
 *
 *   node --test "src/app/ai-dashboard/(gated)/jobs/live-interview-settings-save.test.ts"
 *
 * The actions are the shipped jobs/actions.ts. Stubbed: the company context
 * and job scope (who is asking), the database (fake-live-db.mjs, which applies
 * filters, inserts and updates), revalidation, and the AI, queue and
 * notification modules the file imports but these paths never call.
 * Synthetic data.
 */
// @ts-nocheck - same reason as the other node:test files.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../../../test-support/node-resolve.mjs", import.meta.url));
register(
  `data:text/javascript,${encodeURIComponent(`
const fail = (what) => "export function " + what + "() { throw new Error('test: " + what + " must not be called'); }";
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
  "@/lib/ai/interview-questions": fail("generateInterviewQuestions"),
  "@/lib/ai/jd-generate": fail("generateJobDescription"),
  "@/lib/ai/jd-split": fail("proposeSplit"),
  "@/lib/ai/scoring-criteria": fail("generateScoringCriteria"),
  "@/lib/ai/screening-questions": fail("generateScreeningQuestions"),
  "@/lib/calendar/availability": "export function parseRules(v) { return Array.isArray(v) ? v : []; }",
  "@/lib/notifications/company": "export async function notifyCompany() {}",
  "@/lib/jobs-queue": "export const JOB_TYPES = {}; export async function enqueue() { return { ok: true }; }",
};
export async function resolve(specifier, context, next) {
  if (specifier in STUBS) return { url: "data:text/javascript," + encodeURIComponent(STUBS[specifier]), shortCircuit: true };
  return next(specifier, context);
}`)}`,
);

const { createCompanyJob, updateCompanyJob, duplicateCompanyJob } = await import("./actions.ts");
const { EMPTY_JOB_INPUT, liveInterviewInputFromRow } = await import("../../lib/job-types.ts");
const { fakeLiveDb } = await import("../../../../test-support/fake-live-db.mjs");

const CO = "c0000000-0000-4000-8000-000000000045";
const OTHER_CO = "c0000000-0000-4000-8000-0000000000ff";

function world(extra = {}) {
  const db = fakeLiveDb({
    jobs: [],
    job_hiring_team: [],
    interview_questions: [],
    interview_sessions: [],
    ...extra,
  });
  // As Postgres does on insert into jobs: an id and the columns' defaults. The
  // raw payload is kept too, to see what the action itself sent.
  db.jobInserts = [];
  const from = db.service.from.bind(db.service);
  db.service.from = (table) => {
    const q = from(table);
    if (table !== "jobs") return q;
    // .single() answers one row, as PostgREST does; the base fake models maybeSingle only.
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
            db.jobInserts.push(structuredClone(args[0]));
            target.insert({ id: crypto.randomUUID(), ...DEFAULTS, ...args[0] }, ...args.slice(1));
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
    user: { id: "u-1" },
    memberId: "m-1",
    memberName: "Test Member",
    role: "owner",
  };
  globalThis.__jobsAllowed = true;
  return db;
}

/** A complete wizard input, as the browser sends it. */
const input = (over = {}) => ({
  ...structuredClone(EMPTY_JOB_INPUT),
  title: "Synthetic role",
  country: "Pakistan",
  city: "Lahore",
  status: "on_hold",
  avatar_interview_enabled: true,
  avatar_interviewer_name: "Sarah",
  ...over,
});

const LIVE = ["live_interview_mode", "live_interview_minutes", "live_hiring_challenges"];
const stored = (db, id) => {
  const row = db.tables.jobs.find((j) => j.id === id);
  return Object.fromEntries(LIVE.map((k) => [k, row?.[k]]));
};

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

/** What Postgres fills in on insert and the fake does not: the columns' defaults. */
const DEFAULTS = {
  deleted_at: null,
  archived_at: null,
  live_interview_mode: "structured",
  live_interview_minutes: 30,
  live_hiring_challenges: null,
};
async function create(over) {
  const r = await quiet(() => createCompanyJob(input(over)));
  assert.equal(r.success, true, r.error);
  return r.data.id;
}

/* ── round trips ───────────────────────────────────────────────── */

test("save and load: both modes, 30 and 60, challenges set or empty", async () => {
  for (const mode of ["structured", "ai_guided"]) {
    for (const minutes of [30, 60]) {
      for (const [sent, kept] of [
        [
          "  Reduce customer churn in the first 90 days.  ",
          "Reduce customer churn in the first 90 days.",
        ],
        ["", null],
        ["   \n  ", null],
        ["x".repeat(2000), "x".repeat(2000)],
      ]) {
        const db = world();
        const id = await create({
          live_interview_mode: mode,
          live_interview_minutes: minutes,
          live_hiring_challenges: sent,
        });
        const row = stored(db, id);
        assert.deepEqual(row, {
          live_interview_mode: mode,
          live_interview_minutes: minutes,
          live_hiring_challenges: kept,
        });
        // The edit page loads exactly that, and saving it back changes nothing.
        const loaded = liveInterviewInputFromRow(db.tables.jobs[0]);
        assert.deepEqual(loaded, {
          live_interview_mode: mode,
          live_interview_minutes: minutes,
          live_hiring_challenges: kept ?? "",
        });
        const again = await quiet(() => updateCompanyJob(id, input(loaded)));
        assert.equal(again.success, true, again.error);
        assert.deepEqual(stored(db, id), row, "a no-op edit keeps the same values");
      }
    }
  }
});

test("a create that sends none of the three takes the column defaults", async () => {
  const db = world();
  const over = {};
  const body = input(over);
  for (const k of LIVE) delete body[k];
  const r = await quiet(() => createCompanyJob(body));
  assert.equal(r.success, true, r.error);
  for (const k of LIVE) {
    assert.equal(k in db.jobInserts[0], false, `${k} left to the database default`);
  }
  assert.deepEqual(stored(db, r.data.id), {
    live_interview_mode: "structured",
    live_interview_minutes: 30,
    live_hiring_challenges: null,
  });
});

test("an edit leaves alone what the browser did not send", async () => {
  const db = world();
  const id = await create({
    live_interview_mode: "ai_guided",
    live_interview_minutes: 60,
    live_hiring_challenges: "Scale the support team.",
  });
  for (const k of LIVE) {
    const body = input({
      live_interview_mode: "structured",
      live_interview_minutes: 30,
      live_hiring_challenges: "Changed.",
    });
    delete body[k];
    const before = stored(db, id)[k];
    const r = await quiet(() => updateCompanyJob(id, body));
    assert.equal(r.success, true, r.error);
    assert.deepEqual(stored(db, id)[k], before, `${k} unchanged when not sent`);
  }
});

test("switching back to Recruiter-Defined keeps the challenges text, unused", async () => {
  const db = world();
  const id = await create({
    live_interview_mode: "ai_guided",
    live_hiring_challenges: "Cut onboarding time in half.",
  });
  const loaded = liveInterviewInputFromRow(db.tables.jobs[0]);
  const r = await quiet(() =>
    updateCompanyJob(id, input({ ...loaded, live_interview_mode: "structured" })),
  );
  assert.equal(r.success, true, r.error);
  assert.deepEqual(stored(db, id), {
    live_interview_mode: "structured",
    live_interview_minutes: 30,
    live_hiring_challenges: "Cut onboarding time in half.",
  });
});

/* ── refused server-side ───────────────────────────────────────── */

const REFUSALS = [
  [
    { live_interview_mode: "x" },
    "Choose Recruiter-Defined or AI-Guided for the AI Video Interview.",
  ],
  [
    { live_interview_mode: null },
    "Choose Recruiter-Defined or AI-Guided for the AI Video Interview.",
  ],
  [{ live_interview_minutes: 45 }, "Interview length must be 30 or 60 minutes."],
  [{ live_interview_minutes: "60" }, "Interview length must be 30 or 60 minutes."],
  [{ live_interview_minutes: 0 }, "Interview length must be 30 or 60 minutes."],
  [
    { live_hiring_challenges: "x".repeat(2001) },
    "Hiring challenges is too long (2,001 characters). The limit is 2,000.",
  ],
  [{ live_hiring_challenges: 12 }, "Hiring challenges must be text."],
];

test("bad values from the browser are refused on create: nothing is written", async () => {
  for (const [over, error] of REFUSALS) {
    const db = world();
    const r = await quiet(() => createCompanyJob(input(over)));
    assert.deepEqual(r, { success: false, error }, JSON.stringify(over).slice(0, 60));
    assert.equal(db.tables.jobs.length, 0);
  }
});

test("bad values from the browser are refused on edit: the job is unchanged", async () => {
  for (const [over, error] of REFUSALS) {
    const db = world();
    const id = await create({ live_interview_mode: "ai_guided", live_hiring_challenges: "Keep." });
    const before = structuredClone(db.tables.jobs);
    const r = await quiet(() => updateCompanyJob(id, input(over)));
    assert.deepEqual(r, { success: false, error }, JSON.stringify(over).slice(0, 60));
    assert.deepEqual(db.tables.jobs, before);
  }
});

test("2000 characters counts as the database does: code points, not UTF-16 units", async () => {
  const db = world();
  // 2000 emoji: 4000 UTF-16 units, 2000 characters by char_length.
  const id = await create({ live_hiring_challenges: "\u{1F680}".repeat(2000) });
  assert.equal(Array.from(stored(db, id).live_hiring_challenges).length, 2000);
});

test("only someone who can edit the job can change them", async () => {
  const db = world();
  const id = await create({ live_interview_minutes: 30 });
  const before = structuredClone(db.tables.jobs);
  globalThis.__jobsCtx.role = "viewer";
  await assert.rejects(quiet(() => updateCompanyJob(id, input({ live_interview_minutes: 60 }))));
  globalThis.__jobsCtx.role = "recruiter";
  globalThis.__jobsAllowed = false;
  const r = await quiet(() => updateCompanyJob(id, input({ live_interview_minutes: 60 })));
  assert.equal(r.success, false);
  globalThis.__jobsCtx.companyId = OTHER_CO;
  globalThis.__jobsAllowed = true;
  const r2 = await quiet(() => updateCompanyJob(id, input({ live_interview_minutes: 60 })));
  assert.equal(r2.success, false, "another company cannot edit it");
  assert.deepEqual(db.tables.jobs, before);
});

/* ── duplicate ─────────────────────────────────────────────────── */

test("duplicate copies mode, length and challenges, within the same company only", async () => {
  const db = world();
  const id = await create({
    live_interview_mode: "ai_guided",
    live_interview_minutes: 60,
    live_hiring_challenges: "Own the billing migration.",
  });
  const r = await quiet(() => duplicateCompanyJob(id));
  assert.equal(r.success, true, r.error);
  // The copy's own insert carries the three, not the database's defaults.
  const copied = db.jobInserts.at(-1);
  assert.deepEqual(Object.fromEntries(LIVE.map((k) => [k, copied[k]])), stored(db, id));
  assert.deepEqual(stored(db, r.data.id), stored(db, id));
  assert.equal(db.tables.jobs.find((j) => j.id === r.data.id).company_id, CO);

  // Another company's job: refused, nothing copied.
  globalThis.__jobsCtx.companyId = OTHER_CO;
  globalThis.__jobsCtx.company = { id: OTHER_CO, name: "Other Co" };
  const count = db.tables.jobs.length;
  const refused = await quiet(() => duplicateCompanyJob(id));
  assert.deepEqual(refused, { success: false, error: "Job not found in your workspace." });
  assert.equal(db.tables.jobs.length, count);
});

/* ── existing invitations ──────────────────────────────────────── */

test("editing mode, length or challenges never changes an invitation already sent", async () => {
  const db = world();
  const id = await create({ live_interview_mode: "structured", live_interview_minutes: 30 });
  db.tables.interview_sessions.push({
    id: "s0000000-0000-4000-8000-000000000045",
    company_id: CO,
    job_id: id,
    kind: "live",
    status: "invited",
    live_settings: {
      v: 3,
      interviewer_name: "Sarah",
      max_session_seconds: 1800,
      max_follow_ups_per_base_question: 2,
      question_mix: { policy_version: "question-mix-v2", job_questions: 4 },
    },
    questions_snapshot: [1, 2, 3, 4].map((p) => ({ id: `q${p}`, position: p, question: `Q${p}?` })),
    scoring_snapshot: [],
  });
  const before = JSON.stringify(db.tables.interview_sessions);
  for (const over of [
    { live_interview_mode: "ai_guided" },
    { live_interview_minutes: 60 },
    { live_hiring_challenges: "New challenges after the invite." },
  ]) {
    const r = await quiet(() =>
      updateCompanyJob(id, input({ ...liveInterviewInputFromRow(db.tables.jobs[0]), ...over })),
    );
    assert.equal(r.success, true, r.error);
  }
  assert.deepEqual(stored(db, id), {
    live_interview_mode: "ai_guided",
    live_interview_minutes: 60,
    live_hiring_challenges: "New challenges after the invite.",
  });
  assert.equal(JSON.stringify(db.tables.interview_sessions), before, "byte-equal");
});
