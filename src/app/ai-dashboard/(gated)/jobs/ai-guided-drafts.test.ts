/**
 * AI-Guided question drafting in the job wizard (step 5):
 *
 *   - draftInterviewQuestions (jobs/actions.ts): the job-edit permission, the
 *     rate limit, the five allowed inputs, one plain failure message, and it
 *     writes nothing;
 *   - the review panel's reducer (question-drafts.ts): drafts never reach the
 *     job until "Use these questions", which asks before replacing, and
 *     regenerating never touches the job's questions;
 *   - the save check: a question on an AI Video Interview job that touches a
 *     protected topic is refused, recruiter edits included;
 *   - Recruiter-Defined mode has no draft button;
 *   - a sent invite keeps its frozen questions through drafts, regenerates and
 *     a saved edit.
 *
 *   node --test "src/app/ai-dashboard/(gated)/jobs/ai-guided-drafts.test.ts"
 *
 * The actions and components are the shipped ones. Stubbed: who is asking,
 * the database (fake-live-db.mjs), the model call (draftAiGuidedQuestions,
 * tested on its own in interview-questions-draft.test.ts) and the limiter.
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
  "@/lib/jobs-queue": "export const JOB_TYPES = {}; export async function enqueue() { return { ok: true }; }",
};
export async function resolve(specifier, context, next) {
  if (specifier in STUBS) return { url: "data:text/javascript," + encodeURIComponent(STUBS[specifier]), shortCircuit: true };
  return next(specifier, context);
}`)}`,
);

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { createCompanyJob, updateCompanyJob, draftInterviewQuestions } = await import(
  "./actions.ts"
);
const { EMPTY_JOB_INPUT } = await import("../../lib/job-types.ts");
const { EMPTY_QUESTION_INPUT } = await import("../../../../lib/interviews/types.ts");
const { DRAFT_FAILED, DRAFT_RATE_LIMITED } = await import(
  "../../../../lib/interviews/question-fairness.ts"
);
const { draftsReducer, draftsAsJobQuestions, INITIAL_DRAFTS } = await import(
  "./new/question-drafts.ts"
);
const { LiveInterviewSettings } = await import("./new/_live-interview-settings.tsx");
const { QuestionDraftPanel, DRAFT_BUTTON, USE_DRAFTS, replaceConfirmText } = await import(
  "./new/_question-draft-panel.tsx"
);
const { BLOCKED, ALLOWED } = await import(
  "../../../../test-support/question-fairness-examples.mjs"
);
const { fakeLiveDb } = await import("../../../../test-support/fake-live-db.mjs");

const CO = "c0000000-0000-4000-8000-0000000000d1";

function world() {
  const db = fakeLiveDb({
    jobs: [],
    job_hiring_team: [],
    interview_questions: [],
    interview_sessions: [],
  });
  const from = db.service.from.bind(db.service);
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
    user: { id: "u-draft-1" },
    memberId: "m-1",
    memberName: "Test Member",
    role: "recruiter",
  };
  globalThis.__jobsAllowed = true;
  globalThis.__limited = [];
  globalThis.__limitOk = true;
  globalThis.__drafted = [];
  globalThis.__draftAnswer = (input) => ({
    questions: Array.from({ length: input.count }, (_, i) => ({
      question: `Tell me about synthetic support situation ${i + 1}.`,
      competency: "Ownership",
      rubric: "Names the situation, the action and the result.",
      issue: null,
    })),
    failure: null,
  });
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

const q = (question, rubric = "Names the work and the result.") => ({
  ...EMPTY_QUESTION_INPUT,
  id: `new-${crypto.randomUUID()}`,
  question,
  competency: "Ownership",
  rubric,
});
const SAVED = [
  "Tell me about a support backlog you cleared.",
  "Tell me about coaching a new agent.",
  "Tell me about a complaint you turned around.",
  "Tell me about a process you improved.",
];
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
  live_interview_mode: "ai_guided",
  live_hiring_challenges: "First-response times slipped.",
  interview_questions: SAVED.map((t) => q(t)),
  // With AI Video Interview on, a save needs 4 to 8 live questions (#58 commit 6).
  live_interview_questions: SAVED.map((t) => q(`Live: ${t}`)),
  ...over,
});
/** The job's async list, the one these tests edit (082: the live list is step 6's). */
const savedQuestions = (db, jobId) =>
  db.tables.interview_questions
    .filter((r) => r.job_id === jobId && r.interview_kind === "async")
    .sort((a, b) => a.position - b.position)
    .map((r) => r.question);
const drafted = (over = {}) =>
  quiet(() =>
    draftInterviewQuestions({
      title: "Synthetic Support Lead",
      description: "Lead a synthetic support team.",
      requiredSkills: "Ticket triage.",
      seniority: "Senior",
      hiringChallenges: "First-response times slipped.",
      count: 5,
      ...over,
    }),
  );

/* ── the draft action ─────────────────────────────────────────── */

test("draft: the five allowed inputs reach the drafter, nothing else, and nothing is written", async () => {
  const db = world();
  const id = (await quiet(() => createCompanyJob(jobInput()))).data.id;
  const before = JSON.stringify(db.tables);
  const r = await drafted({
    jobId: id,
    cvText: "SYNTH-CV",
    rubric: "SYNTH-RUBRIC",
    candidateName: "SYNTH-NAME",
  });
  assert.equal(r.error, null);
  assert.equal(r.drafts.length, 5);
  assert.deepEqual(globalThis.__drafted, [
    {
      title: "Synthetic Support Lead",
      description: "Lead a synthetic support team.",
      requiredSkills: "Ticket triage.",
      seniority: "Senior",
      hiringChallenges: "First-response times slipped.",
      count: 5,
    },
  ]);
  assert.equal(JSON.stringify(db.tables), before, "no table changed: the drafts are not saved");
  assert.deepEqual(savedQuestions(db, id), SAVED);
});

test("draft: the count the recruiter picked is passed through, 4 to 8", async () => {
  world();
  for (const count of [4, 5, 6, 7, 8]) {
    const r = await drafted({ count });
    assert.equal(r.drafts.length, count);
  }
  assert.deepEqual(
    globalThis.__drafted.map((d) => d.count),
    [4, 5, 6, 7, 8],
  );
});

test("draft: the job-edit permission; a hiring manager or another team's job is refused, no call", async () => {
  world();
  globalThis.__jobsCtx.role = "hiring_manager";
  assert.equal((await drafted()).drafts, null);
  assert.equal(globalThis.__drafted.length, 0);
  world();
  const id = (await quiet(() => createCompanyJob(jobInput()))).data.id;
  globalThis.__jobsAllowed = false;
  assert.deepEqual(await drafted({ jobId: id }), {
    drafts: null,
    error: "That job isn't in your workspace.",
  });
  assert.equal(globalThis.__drafted.length, 0);
});

test("draft: rate limited per recruiter (job-question-draft, 10 in 10 minutes), refused before the model call", async () => {
  world();
  globalThis.__limitOk = false;
  assert.deepEqual(await drafted(), { drafts: null, error: DRAFT_RATE_LIMITED });
  assert.deepEqual(globalThis.__limited, [
    ["job-question-draft:u-draft-1", { max: 10, windowMs: 600_000, group: "security" }],
  ]);
  assert.equal(globalThis.__drafted.length, 0);
});

test("draft: any failure is the one plain message", async () => {
  world();
  for (const failure of [
    "timeout",
    "model_error",
    "not_json",
    "bad_shape",
    "no_key",
    "bad_count",
  ]) {
    globalThis.__draftAnswer = () => ({ questions: null, failure });
    assert.deepEqual(await drafted(), { drafts: null, error: DRAFT_FAILED });
  }
  assert.equal(DRAFT_FAILED, "Couldn't draft questions - please try again.");
});

test("draft: a flagged draft comes back with the block message naming it and the topic", async () => {
  world();
  globalThis.__draftAnswer = () => ({
    questions: [
      { question: "Tell me about a backlog.", competency: "Ownership", rubric: "x", issue: null },
      {
        question: "Are you married?",
        competency: "Ownership",
        rubric: "x",
        issue: { topic: "family or marital status", part: "question" },
      },
    ],
    failure: null,
  });
  const r = await drafted({ count: 4 });
  assert.equal(r.drafts[0].blocked, null);
  assert.equal(
    r.drafts[1].blocked,
    'Question 2 ("Are you married?") touches on family or marital status, which can\'t be used to judge a candidate. Please reword it to focus on the job.',
  );
});

/* ── the review panel ─────────────────────────────────────────── */

const DRAFTS = [
  { question: "Tell me about draft one.", competency: "Ownership", rubric: "Guide one." },
  { question: "Tell me about draft two.", competency: "Leadership", rubric: "Guide two." },
  { question: "Tell me about draft three.", competency: "Collaboration", rubric: "Guide three." },
];
const withDrafts = () => draftsReducer(INITIAL_DRAFTS, { t: "result", drafts: DRAFTS });

// Negative control: set `apply` on "result" (auto-use the drafts) and this fails.
test("drafts are not used until Use these questions: edit, reorder, remove, regenerate apply nothing", () => {
  let s = withDrafts();
  assert.equal(s.apply, null, "a fresh draft is not the job's");
  s = draftsReducer(s, { t: "edit", index: 0, patch: { question: "Tell me about edited one." } });
  s = draftsReducer(s, { t: "move", index: 0, delta: 1 });
  s = draftsReducer(s, { t: "remove", index: 2 });
  assert.equal(s.apply, null);
  assert.deepEqual(
    s.drafts.map((d) => d.question),
    ["Tell me about draft two.", "Tell me about edited one."],
  );
  s = draftsReducer(s, { t: "result", drafts: DRAFTS.slice(0, 1) });
  assert.equal(s.apply, null, "regenerate replaces the drafts only");
  assert.deepEqual(
    s.drafts.map((d) => d.question),
    ["Tell me about draft one."],
  );
  s = draftsReducer(s, { t: "use", existingQuestions: 0 });
  assert.deepEqual(
    s.apply.map((d) => d.question),
    ["Tell me about draft one."],
  );
});

test("Use these questions on a job that has questions asks to confirm; only the confirm applies", () => {
  let s = draftsReducer(withDrafts(), { t: "use", existingQuestions: 4 });
  assert.equal(s.confirmingReplace, true);
  assert.equal(s.apply, null, "asked, not replaced");
  s = draftsReducer(s, { t: "cancel_replace" });
  assert.deepEqual([s.confirmingReplace, s.apply], [false, null], "kept the job's questions");
  s = draftsReducer(draftsReducer(s, { t: "use", existingQuestions: 4 }), { t: "confirm_replace" });
  assert.equal(s.apply.length, 3);
  assert.equal(
    replaceConfirmText(4),
    "This job already has 4 interview questions. Replace them with these drafts?",
  );
  assert.equal(
    replaceConfirmText(1),
    "This job already has 1 interview question. Replace it with these drafts?",
  );
  const after = draftsReducer(s, { t: "applied" });
  assert.deepEqual([after.drafts, after.apply], [[], null], "the panel closes once used");
});

test("a blocked draft cannot be used until it is reworded or removed", () => {
  let s = draftsReducer(INITIAL_DRAFTS, {
    t: "result",
    drafts: [...DRAFTS, { question: "What is your current salary?", competency: "", rubric: "" }],
  });
  s = draftsReducer(s, { t: "use", existingQuestions: 0 });
  assert.equal(s.apply, null);
  s = draftsReducer(s, {
    t: "edit",
    index: 3,
    patch: { question: "Tell me about a budget you managed." },
  });
  s = draftsReducer(s, { t: "use", existingQuestions: 0 });
  assert.equal(s.apply.length, 4);
});

test("used drafts become ordinary job questions with the chosen count's answer time", () => {
  const s = draftsReducer(withDrafts(), { t: "use", existingQuestions: 0 });
  const rows = draftsAsJobQuestions(s.apply, 120);
  assert.deepEqual(
    rows.map((r) => [r.question, r.competency, r.rubric, r.answerSeconds]),
    DRAFTS.map((d) => [d.question, d.competency, d.rubric, "120"]),
  );
  assert.ok(rows.every((r) => r.id.startsWith("new-")));
});

/* ── where the button is ──────────────────────────────────────── */

function settings(mode, panelProps = {}) {
  return renderToStaticMarkup(
    createElement(LiveInterviewSettings, {
      enabled: true,
      mode,
      minutes: 30,
      challenges: "",
      onModeChange() {},
      onMinutesChange() {},
      onChallengesChange() {},
      draftPanel: createElement(QuestionDraftPanel, {
        state: INITIAL_DRAFTS,
        dispatch() {},
        ready: true,
        existingQuestions: 0,
        onDraft() {},
        ...panelProps,
      }),
    }),
  );
}

test("AI-Guided shows Draft questions with AI under the challenges box; Recruiter-Defined has none", () => {
  const guided = settings("ai_guided");
  assert.ok(guided.includes(DRAFT_BUTTON));
  assert.ok(guided.indexOf("data-question-drafts") > guided.indexOf("<textarea"), "under the box");
  const defined = settings("structured");
  assert.ok(!defined.includes(DRAFT_BUTTON));
  assert.ok(!defined.includes("data-question-drafts"));
});

test("the panel: drafts apart from the job list, private guide, confirm text, blocked line", () => {
  const panel = (state, existing = 0) =>
    renderToStaticMarkup(
      createElement(QuestionDraftPanel, {
        state,
        dispatch() {},
        ready: true,
        existingQuestions: existing,
        onDraft() {},
      }),
    );
  const shown = panel(withDrafts());
  assert.ok(shown.includes("Draft questions - review before using"));
  assert.ok(shown.includes(USE_DRAFTS));
  assert.ok(shown.includes("Regenerate"));
  assert.ok(shown.includes("never shown to Sarah or candidates"));
  const confirm = panel(draftsReducer(withDrafts(), { t: "use", existingQuestions: 4 }), 4);
  assert.ok(
    confirm.includes("This job already has 4 interview questions. Replace them with these drafts?"),
  );
  const blocked = panel(
    draftsReducer(INITIAL_DRAFTS, {
      t: "result",
      drafts: [{ question: "Are you pregnant?", competency: "", rubric: "" }],
    }),
  );
  assert.ok(blocked.includes("data-draft-blocked"));
  assert.ok(blocked.includes("touches on pregnancy"));
  assert.doesNotMatch(shown + confirm + blocked, /[–—]/, "hyphens only");
});

/* ── the save check ───────────────────────────────────────────── */

// Negative control: drop the firstFairnessBlock check in buildPatch and this fails.
test("save: a recruiter edit touching a protected topic is refused, naming the question and topic", async () => {
  const db = world();
  const id = (await quiet(() => createCompanyJob(jobInput()))).data.id;
  for (const [topic, [text]] of Object.entries(BLOCKED)) {
    const edited = SAVED.map((t) => q(t));
    edited[2] = q(text);
    const r = await quiet(() => updateCompanyJob(id, jobInput({ interview_questions: edited })));
    assert.equal(r.success, false, text);
    assert.equal(
      r.error,
      `Question 3 ("${text}") touches on ${topic}, which can't be used to judge a candidate. Please reword it to focus on the job.`,
    );
  }
  const guide = SAVED.map((t) => q(t));
  guide[0] = q(SAVED[0], "Prefer a candidate who is married.");
  const r = await quiet(() => updateCompanyJob(id, jobInput({ interview_questions: guide })));
  assert.match(r.error, /^Question 1's scoring guide .* touches on family or marital status/);
  const thirdPerson = SAVED.map((t) => q(t));
  thirdPerson[1] = q(SAVED[1], "Prefer candidates who do not have children.");
  const r3 = await quiet(() =>
    updateCompanyJob(id, jobInput({ interview_questions: thirdPerson })),
  );
  assert.match(r3.error, /^Question 2's scoring guide .* touches on family or marital status/);
  assert.deepEqual(savedQuestions(db, id), SAVED, "nothing was written");
  const created = await quiet(() =>
    createCompanyJob(jobInput({ interview_questions: [q("Are you married?")] })),
  );
  assert.equal(created.success, false, "a new job too");
});

test("save: the false-positive examples save; the check applies with AI Video Interview off too (#58 commit 5)", async () => {
  const db = world();
  const id = (await quiet(() => createCompanyJob(jobInput()))).data.id;
  for (let i = 0; i < ALLOWED.length; i += 4) {
    const batch = ALLOWED.slice(i, i + 4);
    const r = await quiet(() =>
      updateCompanyJob(id, jobInput({ interview_questions: batch.map((t) => q(t)) })),
    );
    assert.equal(r.success, true, `${batch.join(" | ")}: ${r.error}`);
    assert.deepEqual(savedQuestions(db, id), batch);
  }
  const before = savedQuestions(db, id);
  const off = await quiet(() =>
    updateCompanyJob(
      id,
      jobInput({ avatar_interview_enabled: false, interview_questions: [q("Are you married?")] }),
    ),
  );
  // Both lists are checked always now: an async-only job is refused too.
  assert.equal(off.success, false, "an async-only job is checked too");
  assert.match(
    off.error,
    /^Question 1 \("Are you married\?"\) touches on family or marital status/,
  );
  assert.deepEqual(savedQuestions(db, id), before, "nothing was written");
});

/* ── a sent invite keeps its frozen questions ─────────────────── */

test("a sent invite keeps its frozen questions through drafts, regenerates and a saved edit", async () => {
  const db = world();
  const id = (await quiet(() => createCompanyJob(jobInput()))).data.id;
  // An invite already sent: its questions frozen from the job's saved ones.
  const frozen = savedQuestions(db, id).map((text, i) => ({
    id: `job-q-${i + 1}`,
    position: i + 1,
    text,
  }));
  db.tables.interview_sessions.push({
    id: "5b0f2c1e-0000-4000-8000-0000000000d1",
    company_id: CO,
    job_id: id,
    kind: "live",
    status: "invited",
    questions_snapshot: structuredClone(frozen),
    live_settings: { v: 4 },
  });
  const snapshot = () => db.tables.interview_sessions[0].questions_snapshot;

  await drafted({ jobId: id });
  await drafted({ jobId: id, count: 8 });
  assert.deepEqual(snapshot(), frozen, "drafting and regenerating");
  assert.deepEqual(savedQuestions(db, id), SAVED, "the job's questions untouched by drafts");

  const used = draftsReducer(
    draftsReducer(INITIAL_DRAFTS, { t: "result", drafts: DRAFTS.concat(DRAFTS[0]) }),
    { t: "use", existingQuestions: 0 },
  );
  const r = await quiet(() =>
    updateCompanyJob(id, jobInput({ interview_questions: draftsAsJobQuestions(used.apply, 120) })),
  );
  assert.equal(r.success, true, r.error);
  assert.equal(savedQuestions(db, id)[0], "Tell me about draft one.", "the job now has the drafts");
  assert.deepEqual(snapshot(), frozen, "the sent invite's questions never change");
});
