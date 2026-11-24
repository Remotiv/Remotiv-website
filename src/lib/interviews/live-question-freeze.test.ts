/**
 * Freezing an AI Video Interview's questions (lib/interviews/live-question-freeze.ts)
 * and what the provider is then sent (live-provider/create-session.ts). The
 * database is an in-memory fake that applies eq and is filters, so the
 * conditional freeze behaves as it would in Postgres; the model is a fake
 * client. Every name, CV line and job line is made up.
 *
 * #13 (23 Nov): every job question, in the recruiter's order, 4 to 8 of them,
 * no CV questions. The settings are built with the real jobQuestionMix, so
 * turning CV slots back on in question-mix.ts reaches these sessions.
 *
 *   node --test src/lib/interviews/live-question-freeze.test.ts
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../test-support/node-resolve.mjs", import.meta.url));
// The live consent text is stubbed as final here, so a consent proof can be made for the
// builder. The real text, with its placeholders, is tested in live-consent.test.ts.
register(
  `data:text/javascript,${encodeURIComponent(`
const READY = "export const LIVE_INTERVIEW_CONSENT_VERSION = 'live-v1'; export function liveConsentReady() { return true; } export function liveConsentGiven(r) { return r.consent_at !== null && r.consent_version === 'live-v1'; }";
export async function resolve(specifier, context, next) {
  if (specifier === "@/lib/interviews/live-consent") return { url: "data:text/javascript," + encodeURIComponent(READY), shortCircuit: true };
  return next(specifier, context);
}`)}`,
);
register(
  `data:text/javascript,${encodeURIComponent(`
export async function resolve(specifier, context, next) {
  if (specifier === "server-only") return { url: "data:text/javascript,", shortCircuit: true };
  if (specifier === "@/lib/supabase/server") {
    const stub = "export function createServiceClient() { throw new Error('test: pass a service'); }";
    return { url: "data:text/javascript," + encodeURIComponent(stub), shortCircuit: true };
  }
  return next(specifier, context);
}`)}`,
);

const { prepareLiveQuestions, PrepareLiveQuestionsError } = await import(
  "./live-question-freeze.ts"
);
const { readFrozenQuestionSet } = await import("./frozen-questions.ts");
const { buildCreateSessionInput, CreateSessionInputError } = await import(
  "./live-provider/create-session.ts"
);
const { jobQuestionMix, questionMixFor } = await import("./question-mix.ts");
const { requireLiveConsent } = await import("./live-consent-record.ts");
/** The consent proof for a session whose row carries live-v1. */
const consentFor = (sessionId) =>
  requireLiveConsent(
    fakeService(() => ({
      data: {
        id: sessionId,
        kind: "live",
        consent_at: "2026-10-20T09:00:00.000Z",
        consent_version: "live-v1",
      },
      error: null,
    })),
    sessionId,
  );
const { fakeService } = await import("../../test-support/fake-postgrest.mjs");

const SESSION = "5b0f2c1e-0000-4000-8000-000000000001";
const SESSION_B = "5b0f2c1e-0000-4000-8000-00000000000b";
const CO = "7aad434d-0000-4000-8000-000000000001";
const JOB = "2d4a8cde-0000-4000-8000-000000000002";
const APP = "03e4863f-0000-4000-8000-000000000003";
const APP_B = "03e4863f-0000-4000-8000-00000000000b";

const CV = [
  "Alex Example",
  "Backend Engineer | alex.example@example.com | +92 300 0000000 | linkedin.com/in/alex-example",
  "House 1, Street 1, Lahore",
  "Northwind Logistics - Backend Engineer (2021 - Present): led the move of the order service to",
  "Node.js and TypeScript, and cut report generation from 40 minutes to 4. Mr. Example also",
  "mentored two developers. Contoso Retail - Software Engineer (2019 - 2021): REST APIs on PostgreSQL.",
].join("\n");

/** Live settings v3 as the invite freezes them for a job with `n` questions. */
const settingsFor = (n) => ({
  v: 3,
  interviewer_name: "Sarah",
  language: "en",
  max_follow_ups_per_base_question: 2,
  max_session_seconds: 1800,
  follow_up_rules_version: "follow-up-v1",
  follow_up_rules: {
    when: "Only when thin.",
    scope: "Stay on topic.",
    never: ["Reveal the answer."],
  },
  question_mix: jobQuestionMix(n, 30),
});

/** The job's authored questions, in the recruiter's order. Nine, so a job can have too many. */
const AUTHORED = [
  "Tell me about a REST API you designed for heavy traffic.",
  "Tell me about a production incident you owned from start to finish.",
  "Tell me about a time you made a slow service faster.",
  "Tell me about a code review that changed how you work.",
  "Tell me about a technical decision you would make differently now.",
  "Tell me about a time you disagreed with a product decision.",
  "Tell me about a database migration you planned.",
  "Tell me about how you test a change before it ships.",
  "Tell me about a system you would design differently today.",
];
/** Stored out of order, as a snapshot may be, to prove the recruiter's order wins. */
const STORED_ORDER = [3, 1, 9, 5, 2, 8, 4, 7, 6];

/** The invite's two snapshots for the job's first `n` questions. */
function inviteSnapshots(n) {
  const kept = STORED_ORDER.filter((p) => p <= n);
  return {
    questions_snapshot: kept.map((p) => ({
      id: `job-q-${p}`,
      position: p,
      question: AUTHORED[p - 1],
      prep_seconds: 30,
      answer_seconds: 120,
      required: true,
    })),
    scoring_snapshot: kept
      .sort((a, b) => a - b)
      .map((p) => ({
        position: p,
        question_id: `job-q-${p}`,
        competency: p === 2 ? null : "Technical depth",
        rubric: p === 2 ? null : `The recruiter's own rubric for question ${p}.`,
        weight: p === 1 ? 4 : 2,
      })),
  };
}

/** A live session as the invite leaves it for a job with `n` questions: not yet frozen for live. */
function sessionRow(n, overrides = {}) {
  return {
    id: SESSION,
    company_id: CO,
    application_id: APP,
    job_id: JOB,
    kind: "live",
    status: "invited",
    started_at: null,
    live_settings: settingsFor(n),
    ...inviteSnapshots(n),
    ...overrides,
  };
}

function world(n = 6, overrides = {}) {
  return {
    interview_sessions: [sessionRow(n, overrides)],
    jobs: [
      {
        id: JOB,
        company_id: CO,
        title: "Backend Engineer",
        description: "Build and run high-volume APIs for a logistics platform.",
        responsibilities: "Design REST APIs. Own services in production.",
        requirements: "TypeScript, Node.js, PostgreSQL. Experience running services in production.",
      },
    ],
    job_applications: [
      {
        id: APP,
        job_id: JOB,
        company_id_snapshot: CO,
        first_name: "Alex",
        last_name: "Example",
        cv_text: CV,
      },
      {
        id: APP_B,
        job_id: JOB,
        company_id_snapshot: CO,
        first_name: "Sam",
        last_name: "Sample",
        cv_text: CV.replaceAll("Alex", "Sam"),
      },
    ],
    // The job's live question rows. The freeze must never read them.
    interview_questions: AUTHORED.slice(0, n).map((question, i) => ({
      id: `job-q-${i + 1}`,
      job_id: JOB,
      company_id: CO,
      position: i + 1,
      question,
    })),
    job_question_scoring_guides: [],
    writes: 0,
  };
}

/** A second candidate's session on the same job, frozen at their own invite. */
function addCandidateB(state, n = 6) {
  state.interview_sessions.push({
    ...sessionRow(n),
    id: SESSION_B,
    application_id: APP_B,
  });
}

/** A fake service over `state` that applies eq/is filters, json paths included, and counts landed updates. */
function service(state) {
  return fakeService((table, calls) => {
    const rows = state[table] ?? [];
    const get = (row, col) => {
      if (!col.includes("->")) return row[col] ?? null;
      const [c, k] = col.split("->");
      return row[c]?.[k] ?? null;
    };
    const filters = calls.filter((c) => c[0] === "eq" || c[0] === "is");
    const match = (row) =>
      filters.every(([op, col, val]) =>
        op === "eq" ? get(row, col) === val : get(row, col) === val,
      );
    const upsert = calls.find((c) => c[0] === "upsert");
    if (upsert) {
      // The job guide: one per job and wording, "on conflict do nothing".
      const r = upsert[1];
      const taken = rows.some(
        (x) => x.job_id === r.job_id && x.question_sha256 === r.question_sha256,
      );
      if (!taken) rows.push(structuredClone(r));
      return { data: taken ? [] : [structuredClone(r)], error: null };
    }
    const hit = rows.filter(match);
    const update = calls.find((c) => c[0] === "update");
    if (update) {
      for (const r of hit) Object.assign(r, structuredClone(update[1]));
      state.writes += hit.length;
      return { data: structuredClone(hit), error: null };
    }
    const single = calls.some((c) => c[0] === "maybeSingle");
    return { data: structuredClone(single ? (hit[0] ?? null) : hit), error: null };
  });
}

const guide = {
  strong: "Describes a specific piece of work, the candidate's own decisions and the result.",
  weak: "Stays general with no example of their own.",
};
/** A good reply for 4 CV slots: only reached if CV slots are switched back on. */
const CV_TOPICS = [
  "the order service move to Node.js",
  "the report generation speed-up",
  "mentoring two developers",
  "the REST APIs on PostgreSQL",
];
const replyFor = (variant) => ({
  questions: [1, 2, 3, 4].map((slot) => ({
    slot,
    source: "cv",
    question: `Walk me through ${CV_TOPICS[slot - 1]} at Northwind (draft ${variant}).`,
    competency: "Ownership",
    ...guide,
  })),
});

/** The job guide writer's reply (live-guides.ts), for a job question with no rubric. */
const JOB_GUIDE = {
  strong:
    "Names the incident, what the candidate did first, the fix they shipped and what changed after.",
  weak: "Describes the team's response without the candidate's own part, or gives no outcome.",
};
const isGuideCall = (request) =>
  typeof request.system === "string" &&
  request.system.startsWith("You write the private scoring guide");

function client(replies) {
  const requests = [];
  const guideRequests = [];
  let i = 0;
  return {
    requests,
    guideRequests,
    messages: {
      async create(request) {
        if (isGuideCall(request)) {
          guideRequests.push(request);
          return {
            content: [{ type: "text", text: JSON.stringify(JOB_GUIDE) }],
            stop_reason: "end_turn",
            usage: { input_tokens: 300, output_tokens: 80 },
          };
        }
        requests.push(request);
        await new Promise((r) => setImmediate(r));
        const r =
          replies === "per-call"
            ? replyFor(String.fromCharCode(65 + i))
            : replies[Math.min(i, replies.length - 1)];
        i += 1;
        if (r instanceof Error) throw r;
        return {
          content: [{ type: "text", text: typeof r === "string" ? r : JSON.stringify(r) }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1200, output_tokens: 700 },
        };
      },
    },
  };
}

let ids = 0;
const deps = (state, ai) => ({
  service: service(state),
  client: ai,
  now: () => Date.parse("2026-10-19T09:00:00.000Z"),
  newId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`,
});

async function quiet(fn) {
  const orig = { log: console.log, error: console.error };
  console.log = console.error = () => {};
  try {
    return await fn();
  } finally {
    Object.assign(console, orig);
  }
}

/* ── freezing every job question ──────────────────────────────── */

const NO_WRITER_MARKER = {
  at: "2026-10-19T09:00:00.000Z",
  prompt_version: "none",
  policy_version: "question-mix-v2",
  model: "none",
  calls: 0,
  input_tokens: 0,
  output_tokens: 0,
  rewritten: 0,
  replaced: 0,
};

test("4, 6 and 8 questions: every one frozen, word for word, in the recruiter's order", async () => {
  for (const n of [4, 6, 8]) {
    const state = world(n);
    const ai = client([replyFor("A")]);
    const { set, generated } = await quiet(() => prepareLiveQuestions(SESSION, deps(state, ai)));
    assert.equal(generated, true, `${n}`);
    assert.equal(state.writes, 1, `${n}`);
    assert.deepEqual(
      set.questions.map((q) => [q.position, q.text, q.question_id, q.source]),
      AUTHORED.slice(0, n).map((text, i) => [i + 1, text, `job-q-${i + 1}`, "job"]),
      `${n} questions`,
    );
    const row = state.interview_sessions[0];
    assert.deepEqual(
      row.questions_snapshot.map((q) => [q.position, q.question]),
      AUTHORED.slice(0, n).map((text, i) => [i + 1, text]),
    );
    for (const q of row.questions_snapshot) {
      assert.deepEqual(Object.keys(q).sort(), [
        "answer_seconds",
        "id",
        "position",
        "prep_seconds",
        "question",
        "required",
      ]);
    }
    assert.ok(row.scoring_snapshot.every((s) => s.source === "job"));
    assert.deepEqual(row.live_settings.questions_frozen, NO_WRITER_MARKER);
    // Everything frozen at invite is untouched beside the marker.
    const { questions_frozen, ...rest } = row.live_settings;
    assert.deepEqual(rest, settingsFor(n));
  }
});

test("each job question keeps the recruiter's marking; one with no rubric gets the job's guide", async () => {
  const state = world(4);
  const ai = client([replyFor("A")]);
  const { set } = await quiet(() => prepareLiveQuestions(SESSION, deps(state, ai)));
  assert.deepEqual(
    set.questions.map((q) => [q.competency, q.scoring_guide, q.guide_source, q.weight]),
    [
      ["Technical depth", "The recruiter's own rubric for question 1.", "recruiter", 4],
      [null, `Strong answer: ${JOB_GUIDE.strong} Weak answer: ${JOB_GUIDE.weak}`, "ai", 2],
      ["Technical depth", "The recruiter's own rubric for question 3.", "recruiter", 2],
      ["Technical depth", "The recruiter's own rubric for question 4.", "recruiter", 2],
    ],
  );
  assert.equal(ai.guideRequests.length, 1);
  assert.equal(state.job_question_scoring_guides.length, 1);
  assert.doesNotMatch(JSON.stringify(ai.guideRequests), /Alex|Example|Northwind|example\.com/);
});

test("3 or 9 questions (and 0, 1): refused with the reason, no model call, nothing written", async () => {
  for (const [n, code] of [
    // A mix of 0 questions is not a readable mix (types.ts), so 0 stops one step earlier.
    [0, "no_question_mix"],
    [1, "too_few_job_questions"],
    [3, "too_few_job_questions"],
    [9, "too_many_job_questions"],
  ]) {
    const state = world(n);
    const before = structuredClone(state.interview_sessions[0]);
    const ai = client([replyFor("A")]);
    const d = deps(state, ai);
    await assert.rejects(
      quiet(() => prepareLiveQuestions(SESSION, d)),
      (err) => err instanceof PrepareLiveQuestionsError && err.code === code,
      `${n} questions`,
    );
    assert.equal(ai.requests.length + ai.guideRequests.length, 0, `${n}: no model call`);
    assert.equal(state.writes, 0, `${n}`);
    assert.deepEqual(state.interview_sessions[0], before, `${n}: never cut or padded`);
    assert.ok(!d.service.queries.some((q) => q.calls.some((c) => c[0] === "update")));
  }
});

test("a count that differs from the mix frozen at invite is refused, nothing written", async () => {
  // The job was saved between the invite's count and its snapshot.
  const state = world(6, { live_settings: settingsFor(5) });
  const ai = client([replyFor("A")]);
  await assert.rejects(
    quiet(() => prepareLiveQuestions(SESSION, deps(state, ai))),
    (err) => err instanceof PrepareLiveQuestionsError && err.code === "job_question_count_mismatch",
  );
  assert.equal(state.writes, 0);
  assert.equal(ai.guideRequests.length, 0);
});

test("no CV: the application is never read and the question writer is never called", async () => {
  const state = world(8);
  const ai = client([replyFor("A")]);
  const d = deps(state, ai);
  const { set } = await quiet(() => prepareLiveQuestions(SESSION, d));
  assert.equal(set.questions.length, 8);
  assert.ok(
    set.questions.every((q) => q.source === "job"),
    "no CV or general question",
  );
  assert.equal(ai.requests.length, 0, "the question writer is never called");
  const tables = d.service.queries.map((q) => q.table);
  assert.ok(!tables.includes("job_applications"), `tables read: ${tables.join(", ")}`);
  for (const q of d.service.queries) {
    for (const c of q.calls.filter((x) => x[0] === "select")) {
      assert.doesNotMatch(String(c[1] ?? ""), /cv_text|cv_path|last_name/, q.table);
    }
  }
  assert.doesNotMatch(JSON.stringify(ai.guideRequests), /Alex|Example|Northwind|example\.com/);
});

test("two candidates on the same job: identical frozen text and order", async () => {
  const state = world(6);
  addCandidateB(state, 6);
  // Candidate B's invite stored its snapshot in another order.
  state.interview_sessions[1].questions_snapshot.reverse();
  const ai = client([replyFor("A")]);
  const a = await quiet(() => prepareLiveQuestions(SESSION, deps(state, ai)));
  const b = await quiet(() => prepareLiveQuestions(SESSION_B, deps(state, ai)));
  const asked = (set) => set.questions.map((q) => [q.position, q.question_id, q.text]);
  assert.deepEqual(asked(a.set), asked(b.set));
  assert.deepEqual(
    asked(a.set).map(([, , t]) => t),
    AUTHORED.slice(0, 6),
  );
  // The job's guide for the question with no rubric: written once, frozen the same into both.
  const guideOf = (set) => set.questions.find((q) => q.question_id === "job-q-2").scoring_guide;
  assert.equal(ai.guideRequests.length, 1, "one generation for the job, not one per candidate");
  assert.equal(guideOf(a.set), guideOf(b.set));
  assert.equal(ai.requests.length, 0);
});

test("duplicate positions: the order is still fixed, by question id, whatever order was stored", async () => {
  const dupes = [
    { id: "job-q-c", position: 2, question: AUTHORED[2] },
    { id: "job-q-a", position: 1, question: AUTHORED[0] },
    { id: "job-q-e", position: 3, question: AUTHORED[4] },
    { id: "job-q-b", position: 2, question: AUTHORED[1] },
    { id: "job-q-d", position: 2, question: AUTHORED[3] },
  ];
  const scoring = dupes.map((q) => ({
    position: q.position,
    question_id: q.id,
    competency: "Technical depth",
    rubric: `Rubric for ${q.id}.`,
    weight: 2,
  }));
  const orders = [dupes, [...dupes].reverse(), [dupes[3], dupes[0], dupes[4], dupes[1], dupes[2]]];
  const results = [];
  for (const order of orders) {
    const state = world(5, {
      questions_snapshot: structuredClone(order),
      scoring_snapshot: structuredClone(scoring),
    });
    const { set } = await quiet(() =>
      prepareLiveQuestions(SESSION, deps(state, client([replyFor("A")]))),
    );
    results.push(set.questions.map((q) => [q.position, q.question_id, q.text, q.scoring_guide]));
  }
  assert.deepEqual(results[0], [
    [1, "job-q-a", AUTHORED[0], "Rubric for job-q-a."],
    [2, "job-q-b", AUTHORED[1], "Rubric for job-q-b."],
    [3, "job-q-c", AUTHORED[2], "Rubric for job-q-c."],
    [4, "job-q-d", AUTHORED[3], "Rubric for job-q-d."],
    [5, "job-q-e", AUTHORED[4], "Rubric for job-q-e."],
  ]);
  assert.deepEqual(results[1], results[0]);
  assert.deepEqual(results[2], results[0]);
});

test("a recruiter's edit after freezing never reaches a frozen snapshot", async () => {
  const state = world(6);
  const ai = client([replyFor("A")]);
  const d = deps(state, ai);
  const first = await quiet(() => prepareLiveQuestions(SESSION, d));
  const frozenRow = structuredClone(state.interview_sessions[0]);
  // The recruiter rewrites, reorders and adds questions on the job.
  state.interview_questions = [
    {
      id: "job-q-new",
      job_id: JOB,
      company_id: CO,
      position: 1,
      question: "Brand new first question?",
    },
    ...state.interview_questions.map((q) => ({
      ...q,
      position: q.position + 1,
      question: `${q.question} (edited)`,
    })),
  ];
  // A new candidate is invited under the new version.
  addCandidateB(state, 7);
  const edited = state.interview_questions.slice(0, 7);
  state.interview_sessions[1].questions_snapshot = edited.map((q) => ({
    id: q.id,
    position: q.position,
    question: q.question,
    prep_seconds: 30,
    answer_seconds: 120,
    required: true,
  }));
  state.interview_sessions[1].scoring_snapshot = edited.map((q) => ({
    position: q.position,
    question_id: q.id,
    competency: "Technical depth",
    rubric: "A rubric.",
    weight: 2,
  }));
  const again = await quiet(() => prepareLiveQuestions(SESSION, d));
  const b = await quiet(() => prepareLiveQuestions(SESSION_B, d));
  assert.equal(again.generated, false);
  assert.deepEqual(
    again.set,
    first.set,
    "the first candidate keeps the questions they were invited with",
  );
  assert.deepEqual(state.interview_sessions[0], frozenRow, "the stored row is unchanged");
  assert.equal(
    b.set.questions[0].text,
    "Brand new first question?",
    "the new invite has the new version",
  );
  assert.equal(b.set.questions.length, 7);
  assert.equal(state.writes, 2, "one freeze each, none over another");
  assert.ok(
    !d.service.queries.some((q) => q.table === "interview_questions"),
    "the job's live question rows are never read",
  );
});

test("idempotent: a second call returns the same frozen set and writes nothing", async () => {
  const state = world(6);
  const ai = client([replyFor("A")]);
  const first = await quiet(() => prepareLiveQuestions(SESSION, deps(state, ai)));
  const d = deps(state, ai);
  const second = await quiet(() => prepareLiveQuestions(SESSION, d));
  assert.equal(second.generated, false);
  assert.deepEqual(second.set, first.set);
  assert.equal(state.writes, 1);
  assert.ok(
    !d.service.queries.some((q) => q.calls.some((c) => c[0] === "update")),
    "the second call issues no update at all",
  );
  assert.equal(ai.guideRequests.length, 1, "no second guide");
});

test("two calls at once: one freeze lands, and both return the set that landed", async () => {
  const state = world(6);
  const ai = client([replyFor("A")]);
  const [a, b] = await quiet(() =>
    Promise.all([
      prepareLiveQuestions(SESSION, deps(state, ai)),
      prepareLiveQuestions(SESSION, deps(state, ai)),
    ]),
  );
  assert.equal(state.writes, 1, "only one freeze landed");
  assert.deepEqual(a.set, b.set);
  assert.deepEqual([a.generated, b.generated].sort(), [false, true]);
  const stored = readFrozenQuestionSet(state.interview_sessions[0]);
  assert.deepEqual(a.set, stored);
});

test("after the interview starts: never written; a set frozen before is still returned", async () => {
  for (const started of [
    { status: "started" },
    { started_at: "2026-10-19T09:30:00.000Z" },
    { status: "submitted" },
  ]) {
    const state = world(6, started);
    const before = structuredClone(state.interview_sessions[0]);
    const ai = client([replyFor("A")]);
    await assert.rejects(
      quiet(() => prepareLiveQuestions(SESSION, deps(state, ai))),
      (err) => err instanceof PrepareLiveQuestionsError && err.code === "already_started",
    );
    assert.equal(ai.requests.length + ai.guideRequests.length, 0);
    assert.deepEqual(state.interview_sessions[0], before);
  }
  const state = world(6);
  const first = await quiet(() =>
    prepareLiveQuestions(SESSION, deps(state, client([replyFor("A")]))),
  );
  state.interview_sessions[0].status = "started";
  state.interview_sessions[0].started_at = "2026-10-19T09:30:00.000Z";
  const ai = client([replyFor("B")]);
  const again = await quiet(() => prepareLiveQuestions(SESSION, deps(state, ai)));
  assert.deepEqual(again.set, first.set);
  assert.equal(ai.requests.length + ai.guideRequests.length, 0);
});

test("refused before any model call: async, v1, the old table split, unreadable marker or question, missing session", async () => {
  const v2TableSplit = { ...settingsFor(4), v: 2, question_mix: questionMixFor(30) };
  for (const [overrides, code] of [
    [{ kind: "async" }, "not_live"],
    [{ live_settings: { ...settingsFor(6), v: 1, question_mix: undefined } }, "no_question_mix"],
    // Invited before 23 Nov as 4 job + 4 CV: keeps that meaning, never re-read as all-job.
    [{ live_settings: v2TableSplit }, "question_mix_superseded"],
    [{ live_settings: { ...settingsFor(6), questions_frozen: { at: "x" } } }, "frozen_unreadable"],
    [
      {
        questions_snapshot: inviteSnapshots(6).questions_snapshot.map((q, i) =>
          i === 2 ? { ...q, question: "  " } : q,
        ),
      },
      "job_question_unreadable",
    ],
  ]) {
    const state = world(6, overrides);
    const ai = client([replyFor("A")]);
    await assert.rejects(
      quiet(() => prepareLiveQuestions(SESSION, deps(state, ai))),
      (err) => err instanceof PrepareLiveQuestionsError && err.code === code,
      code,
    );
    assert.equal(ai.requests.length + ai.guideRequests.length, 0, code);
    assert.equal(state.writes, 0, code);
  }
  await assert.rejects(
    quiet(() => prepareLiveQuestions("nope", deps(world(), client([replyFor("A")])))),
    (err) => err instanceof PrepareLiveQuestionsError && err.code === "session_not_found",
  );
});

/* ── what the provider is sent ────────────────────────────────── */

test("the provider gets the frozen text and position only: no guide, source or competency, no name", async () => {
  const state = world(6);
  const { set } = await quiet(() =>
    prepareLiveQuestions(SESSION, deps(state, client([replyFor("A")]))),
  );
  const input = buildCreateSessionInput({
    remotivSessionId: SESSION,
    interviewerName: "Sarah",
    interviewMinutes: 30,
    maxFollowUps: 2,
    questions: set,
    candidateFirstName: "Alex",
    candidateLastName: "Example",
    cvText: CV,
    consent: await consentFor(SESSION),
  });
  assert.deepEqual(
    input.questions,
    set.questions.map((q) => ({ position: q.position, text: q.text })),
  );
  const json = JSON.stringify(input);
  for (const leak of [
    "Strong answer",
    "scoring_guide",
    "source",
    "competency",
    "Technical depth",
    "rubric",
  ]) {
    assert.ok(!json.includes(leak), leak);
  }
  for (const leak of ["Alex Example", "Example", "alex.example@", "+92 300", "linkedin.com"]) {
    assert.ok(!input.cv_text.includes(leak), leak);
  }
  assert.equal(input.candidate_first_name, "Alex");
});

test("the provider builder refuses questions that were not read frozen from this session", async () => {
  const state = world(6);
  const { set } = await quiet(() =>
    prepareLiveQuestions(SESSION, deps(state, client([replyFor("A")]))),
  );
  const base = {
    remotivSessionId: SESSION,
    interviewerName: "Sarah",
    interviewMinutes: 30,
    maxFollowUps: 2,
    candidateFirstName: "Alex",
    candidateLastName: "Example",
    cvText: CV,
    consent: await consentFor(SESSION),
  };
  for (const questions of [
    set.questions.map((q) => ({ position: q.position, text: q.text })),
    structuredClone(set),
    { ...set },
  ]) {
    assert.throws(() => buildCreateSessionInput({ ...base, questions }), CreateSessionInputError);
  }
  assert.throws(
    () => buildCreateSessionInput({ ...base, remotivSessionId: "another-session", questions: set }),
    /another session/,
  );
  assert.throws(
    () => {
      set.questions[0].text = "edited";
    },
    TypeError,
    "the frozen set itself cannot be edited",
  );
});
