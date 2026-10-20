/**
 * Freezing an AI Video Interview's questions (lib/interviews/live-question-freeze.ts)
 * and what the provider is then sent (live-provider/create-session.ts). The
 * database is an in-memory fake that applies eq and is filters, so the
 * conditional freeze behaves as it would in Postgres; the model is a fake
 * client. Every name, CV line and job line is made up.
 *
 *   node --test src/lib/interviews/live-question-freeze.test.ts
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../test-support/node-resolve.mjs", import.meta.url));
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
const { LiveQuestionsError } = await import("./live-questions.ts");
const { readFrozenQuestionSet } = await import("./frozen-questions.ts");
const { buildCreateSessionInput, CreateSessionInputError } = await import(
  "./live-provider/create-session.ts"
);
const { questionMixFor } = await import("./question-mix.ts");
const { fakeService } = await import("../../test-support/fake-postgrest.mjs");

const SESSION = "5b0f2c1e-0000-4000-8000-000000000001";
const CO = "7aad434d-0000-4000-8000-000000000001";
const JOB = "2d4a8cde-0000-4000-8000-000000000002";
const APP = "03e4863f-0000-4000-8000-000000000003";

const CV = [
  "Alex Example",
  "Backend Engineer | alex.example@example.com | +92 300 0000000 | linkedin.com/in/alex-example",
  "House 1, Street 1, Lahore",
  "Northwind Logistics - Backend Engineer (2021 - Present): led the move of the order service to",
  "Node.js and TypeScript, and cut report generation from 40 minutes to 4. Mr. Example also",
  "mentored two developers. Contoso Retail - Software Engineer (2019 - 2021): REST APIs on PostgreSQL.",
].join("\n");

const LIVE_SETTINGS = {
  v: 2,
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
  question_mix: questionMixFor(30),
};

/**
 * The job's authored questions as the live invite froze them: five, so the
 * first four are the job slots. Stored out of order to prove the job's order wins.
 */
const AUTHORED = [
  "Tell me about a REST API you designed for heavy traffic.",
  "Tell me about a production incident you owned from start to finish.",
  "Tell me about a time you made a slow service faster.",
  "Tell me about a code review that changed how you work.",
  "Tell me about a technical decision you would make differently now.",
];
const INVITE_QUESTIONS = [3, 1, 5, 2, 4].map((p) => ({
  id: `job-q-${p}`,
  position: p,
  question: AUTHORED[p - 1],
  prep_seconds: 30,
  answer_seconds: 120,
  required: true,
}));
const INVITE_SCORING = [1, 2, 3, 4, 5].map((p) => ({
  position: p,
  question_id: `job-q-${p}`,
  competency: p === 2 ? null : "Technical depth",
  rubric: p === 2 ? null : `The recruiter's own rubric for question ${p}.`,
  weight: p === 1 ? 4 : 2,
}));

/** A live session as the invite leaves it: the job's own questions, not yet frozen for live. */
function world(overrides = {}) {
  return {
    interview_sessions: [
      {
        id: SESSION,
        company_id: CO,
        application_id: APP,
        job_id: JOB,
        kind: "live",
        status: "invited",
        started_at: null,
        live_settings: structuredClone(LIVE_SETTINGS),
        questions_snapshot: structuredClone(INVITE_QUESTIONS),
        scoring_snapshot: structuredClone(INVITE_SCORING),
        ...overrides,
      },
    ],
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
    ],
    job_question_scoring_guides: [],
    writes: 0,
  };
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
/** A good reply whose wording carries `variant`, so two calls' sets can be told apart. */
/** A good reply for the 4 CV slots, its wording carrying `variant` so two calls' sets differ. */
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

/* ── freezing ─────────────────────────────────────────────────── */

test("prepare writes once and freezes: text in the candidate snapshot, the rest in the private one", async () => {
  const state = world();
  const ai = client([replyFor("A")]);
  const { set, generated } = await quiet(() => prepareLiveQuestions(SESSION, deps(state, ai)));
  assert.equal(generated, true);
  assert.equal(state.writes, 1);
  assert.equal(set.questions.length, 8);
  assert.deepEqual(
    set.questions.map((q) => q.source),
    ["job", "job", "job", "job", "cv", "cv", "cv", "cv"],
  );
  // The job slots are the job's own first four, word for word, in the job's order.
  assert.deepEqual(
    set.questions.slice(0, 4).map((q) => [q.position, q.text, q.question_id]),
    [1, 2, 3, 4].map((p) => [p, AUTHORED[p - 1], `job-q-${p}`]),
  );
  // With the recruiter's own marking; where they left the rubric empty, the job's guide.
  assert.deepEqual(
    set.questions.slice(0, 4).map((q) => [q.competency, q.scoring_guide, q.guide_source, q.weight]),
    [
      ["Technical depth", "The recruiter's own rubric for question 1.", "recruiter", 4],
      [null, `Strong answer: ${JOB_GUIDE.strong} Weak answer: ${JOB_GUIDE.weak}`, "ai", 2],
      ["Technical depth", "The recruiter's own rubric for question 3.", "recruiter", 2],
      ["Technical depth", "The recruiter's own rubric for question 4.", "recruiter", 2],
    ],
  );
  assert.ok(set.questions.slice(4).every((q) => q.guide_source === "ai"));
  // Written once, for the job, and never sent anything about the candidate.
  assert.equal(ai.guideRequests.length, 1);
  assert.equal(state.job_question_scoring_guides.length, 1);
  assert.deepEqual(
    [state.job_question_scoring_guides[0].job_id, state.job_question_scoring_guides[0].source],
    [JOB, "ai"],
  );
  assert.doesNotMatch(JSON.stringify(ai.guideRequests), /Alex|Example|Northwind|example\.com/);
  assert.ok(!set.questions.some((q) => q.text === AUTHORED[4]), "the fifth is not asked");
  const row = state.interview_sessions[0];
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
  assert.ok(!JSON.stringify(row.questions_snapshot).includes("Strong answer"));
  for (const s of row.scoring_snapshot.filter((x) => x.source !== "job")) {
    assert.match(s.rubric, /^Strong answer: /);
    assert.ok(s.competency);
    assert.equal(s.weight, null);
  }
  assert.deepEqual(
    row.scoring_snapshot.map((s) => s.source),
    ["job", "job", "job", "job", "cv", "cv", "cv", "cv"],
  );
  const marker = row.live_settings.questions_frozen;
  assert.deepEqual(marker, {
    at: "2026-10-19T09:00:00.000Z",
    prompt_version: "live-questions-v1",
    policy_version: "question-mix-v1",
    model: "claude-haiku-5-5",
    calls: 1,
    input_tokens: 1200,
    output_tokens: 700,
    rewritten: 0,
    replaced: 0,
  });
  // Everything frozen at invite is untouched beside the marker.
  const { questions_frozen, ...rest } = row.live_settings;
  assert.deepEqual(rest, LIVE_SETTINGS);
});

test("two candidates for the same job: the same job questions word for word, different CV questions", async () => {
  const SESSION_B = "5b0f2c1e-0000-4000-8000-00000000000b";
  const APP_B = "03e4863f-0000-4000-8000-00000000000b";
  const state = world();
  state.interview_sessions.push({
    ...structuredClone(state.interview_sessions[0]),
    id: SESSION_B,
    application_id: APP_B,
  });
  state.job_applications.push({
    id: APP_B,
    job_id: JOB,
    company_id_snapshot: CO,
    first_name: "Sam",
    last_name: "Sample",
    cv_text:
      "Data Engineer at Fabrikam (2020 - Present): built the billing warehouse on PostgreSQL and the nightly import jobs that load it, and ran the move from cron scripts to a scheduler. Before that, analyst at Tailspin Toys (2017 - 2020) working on sales reporting for three regions.",
  });
  const ai = client("per-call");
  const a = await quiet(() => prepareLiveQuestions(SESSION, deps(state, ai)));
  const b = await quiet(() => prepareLiveQuestions(SESSION_B, deps(state, ai)));
  const job = (set) =>
    set.questions.filter((q) => q.source === "job").map((q) => [q.position, q.text]);
  const cv = (set) => set.questions.filter((q) => q.source !== "job").map((q) => q.text);
  assert.deepEqual(job(a.set), job(b.set), "identical job questions, text and order");
  assert.deepEqual(
    job(a.set).map(([, t]) => t),
    AUTHORED.slice(0, 4),
  );
  assert.notDeepEqual(cv(a.set), cv(b.set), "each candidate's CV questions are their own");
  // The job's guide for the question with no rubric: written once, frozen the same into both.
  const guideOf = (set) => set.questions.find((q) => q.position === 2).scoring_guide;
  assert.equal(ai.guideRequests.length, 1, "one generation for the job, not one per candidate");
  assert.equal(guideOf(a.set), guideOf(b.set));
  assert.equal(state.job_question_scoring_guides.length, 1);
  for (const req of ai.requests) {
    for (const q of AUTHORED.slice(0, 4))
      assert.ok(req.messages[0].content.includes(q), "shown to avoid overlap");
  }
});

test("fewer authored questions than job slots: refused before any model call, nothing frozen", async () => {
  for (const n of [0, 1, 3]) {
    const state = world({
      questions_snapshot: INVITE_QUESTIONS.filter((q) => q.position <= n),
      scoring_snapshot: INVITE_SCORING.filter((q) => q.position <= n),
    });
    const ai = client([replyFor("A")]);
    await assert.rejects(
      quiet(() => prepareLiveQuestions(SESSION, deps(state, ai))),
      (err) => err instanceof PrepareLiveQuestionsError && err.code === "not_enough_job_questions",
      `${n} questions`,
    );
    assert.equal(ai.requests.length, 0, "the model never fills a job slot");
    assert.equal(state.writes, 0);
  }
});

test("no name, surname, email, phone, link or address reaches the question writer", async () => {
  const state = world();
  const ai = client([replyFor("A")]);
  await quiet(() => prepareLiveQuestions(SESSION, deps(state, ai)));
  const sent = JSON.stringify(ai.requests);
  for (const leak of [
    "Alex Example",
    "Example",
    "alex.example@",
    "+92 300",
    "linkedin.com",
    "House 1",
  ]) {
    assert.ok(!sent.includes(leak), leak);
  }
  assert.ok(sent.includes("[candidate]") && sent.includes("[email]") && sent.includes("[address]"));
  assert.ok(sent.includes("led the move of the order service"), "the CV itself is sent");
});

test("idempotent: a second call returns the same frozen set and writes nothing", async () => {
  const state = world();
  const ai = client("per-call");
  const first = await quiet(() => prepareLiveQuestions(SESSION, deps(state, ai)));
  const second = await quiet(() => prepareLiveQuestions(SESSION, deps(state, ai)));
  assert.equal(second.generated, false);
  assert.deepEqual(second.set, first.set);
  assert.equal(ai.requests.length, 1, "no second generation");
  assert.equal(state.writes, 1);
});

test("two calls at once: one freeze lands, and both return the set that landed", async () => {
  const state = world();
  const ai = client("per-call");
  const [a, b] = await quiet(() =>
    Promise.all([
      prepareLiveQuestions(SESSION, deps(state, ai)),
      prepareLiveQuestions(SESSION, deps(state, ai)),
    ]),
  );
  assert.equal(ai.requests.length, 2, "both wrote questions");
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
    const state = world(started);
    const before = structuredClone(state.interview_sessions[0]);
    const ai = client([replyFor("A")]);
    await assert.rejects(
      quiet(() => prepareLiveQuestions(SESSION, deps(state, ai))),
      (err) => err instanceof PrepareLiveQuestionsError && err.code === "already_started",
    );
    assert.equal(ai.requests.length, 0);
    assert.deepEqual(state.interview_sessions[0], before);
  }
  const state = world();
  const first = await quiet(() =>
    prepareLiveQuestions(SESSION, deps(state, client([replyFor("A")]))),
  );
  state.interview_sessions[0].status = "started";
  state.interview_sessions[0].started_at = "2026-10-19T09:30:00.000Z";
  const ai = client([replyFor("B")]);
  const again = await quiet(() => prepareLiveQuestions(SESSION, deps(state, ai)));
  assert.deepEqual(again.set, first.set);
  assert.equal(ai.requests.length, 0);
});

test("bad model output twice: a typed error, and nothing is frozen", async () => {
  const state = world();
  const before = structuredClone(state.interview_sessions[0]);
  const ai = client(["not json", { questions: [] }]);
  await assert.rejects(
    quiet(() => prepareLiveQuestions(SESSION, deps(state, ai))),
    (err) => err instanceof LiveQuestionsError && err.code === "bad_output",
  );
  assert.equal(ai.requests.length, 2);
  assert.equal(state.writes, 0);
  assert.deepEqual(state.interview_sessions[0], before);
});

test("refused before any model call: async, v1 settings, an unreadable marker, a missing session", async () => {
  for (const [overrides, code] of [
    [{ kind: "async" }, "not_live"],
    [{ live_settings: { ...LIVE_SETTINGS, v: 1, question_mix: undefined } }, "no_question_mix"],
    [{ live_settings: { ...LIVE_SETTINGS, questions_frozen: { at: "x" } } }, "frozen_unreadable"],
  ]) {
    const state = world(overrides);
    const ai = client([replyFor("A")]);
    await assert.rejects(
      quiet(() => prepareLiveQuestions(SESSION, deps(state, ai))),
      (err) => err instanceof PrepareLiveQuestionsError && err.code === code,
      code,
    );
    assert.equal(ai.requests.length, 0, code);
    assert.equal(state.writes, 0, code);
  }
  await assert.rejects(
    quiet(() => prepareLiveQuestions("nope", deps(world(), client([replyFor("A")])))),
    (err) => err instanceof PrepareLiveQuestionsError && err.code === "session_not_found",
  );
});

/* ── what the provider is sent ────────────────────────────────── */

test("the provider gets the frozen text and position only: no guide, source or competency, no name", async () => {
  const state = world();
  const { set } = await quiet(() =>
    prepareLiveQuestions(SESSION, deps(state, client([replyFor("A")]))),
  );
  const input = buildCreateSessionInput({
    remotivSessionId: SESSION,
    interviewerName: "Sarah",
    interviewMinutes: 30,
    questions: set,
    candidateFirstName: "Alex",
    candidateLastName: "Example",
    cvText: CV,
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
  const state = world();
  const { set } = await quiet(() =>
    prepareLiveQuestions(SESSION, deps(state, client([replyFor("A")]))),
  );
  const base = {
    remotivSessionId: SESSION,
    interviewerName: "Sarah",
    interviewMinutes: 30,
    candidateFirstName: "Alex",
    candidateLastName: "Example",
    cvText: CV,
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
