/**
 * #17: the live interview start proves entitlement from the candidate's token
 * alone, then freezes the questions once (prepareLiveQuestions) from the
 * session's own invitation snapshot, then claims the session, and only then
 * asks the provider: one provider session, with only the frozen questions.
 *
 *   node --test src/lib/interviews/live-start-freeze.test.ts
 *
 * startLiveInterview, prepareLiveQuestions and the review view are the
 * shipped code; the database is fake-live-db.mjs, the provider records what
 * it is sent, and the model is never needed (every question has a rubric).
 * Synthetic data.
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../test-support/node-resolve.mjs", import.meta.url));
register(
  `data:text/javascript,${encodeURIComponent(`
const STUBS = {
  "server-only": "export {};",
  "@/lib/supabase/server": "export function createServiceClient() { throw new Error('test: pass a service'); }",
  "@/lib/interviews/live-consent": "export const LIVE_INTERVIEW_CONSENT_VERSION = 'live-v1'; export function liveConsentReady() { return true; } export function liveConsentGiven(r) { return r.consent_at !== null && r.consent_version === 'live-v1'; }",
};
export async function resolve(specifier, context, next) {
  if (specifier in STUBS) return { url: "data:text/javascript," + encodeURIComponent(STUBS[specifier]), shortCircuit: true };
  return next(specifier, context);
}`)}`,
);

const {
  startLiveInterview,
  FREEZE_FAILED_KEY,
  CLAIM_STALE_MS,
  REJOIN_WINDOW_MS,
  TRY_AGAIN_SHORTLY,
} = await import("./live-start.ts");
const { freezeFailureReason } = await import("./live-review.ts");
const { hashSessionToken } = await import("./tokens.ts");
const { jobQuestionMix } = await import("./question-mix.ts");
const { fakeLiveDb } = await import("../../test-support/fake-live-db.mjs");
const { FAIRNESS_RULES } = await import("../ai/fairness.ts");
const LIVE = "../../app/interview/[token]/_live";
const { startAnswerFrom } = await import(`${LIVE}/live-server.ts`);
const { liveReducer, INITIAL } = await import(`${LIVE}/machine.ts`);
const { BUSY, BLOCKED } = await import(`${LIVE}/copy.ts`);

const CO = "7aad434d-0000-4000-8000-000000000017";
const OTHER_CO = "7aad434d-0000-4000-8000-0000000000ff";
const JOB = "2d4a8cde-0000-4000-8000-000000000017";
const APP = "9c1d2e3f-0000-4000-8000-000000000017";
const SESSION = "5b0f2c1e-0000-4000-8000-000000000017";
const TOKEN = "live-start-freeze-token-0123456789abcdef";
const T0 = Date.parse("2026-11-25T10:00:00.000Z");

const QUESTIONS = [
  "Tell me about a support queue you brought under control.",
  "Tell me about a hard customer conversation you led.",
  "Tell me about a process you changed for the team.",
  "Tell me about a metric you moved and how.",
  "Tell me about a time you trained someone new.",
  "Tell me about a mistake you owned.",
];

/** Live settings v4 as the invite freezes them for a job with `n` questions. */
const settings = (n, mode = "structured", seconds = 1800) => ({
  v: 4,
  interviewer_name: "Sarah",
  language: "en",
  interview_mode: mode,
  max_follow_ups_per_base_question: mode === "structured" ? 0 : 2,
  max_session_seconds: seconds,
  follow_up_rules_version: "follow-up-v1",
  follow_up_rules: { when: "Thin.", scope: "Stay on it.", never: ["Reveal the answer."] },
  question_mix: jobQuestionMix(n, seconds / 60),
});

/** A live session exactly as the invite left it: the job's questions, not yet frozen for live. */
function invited(over = {}, n = QUESTIONS.length) {
  // Stored out of order, as a snapshot may be: the recruiter's order must win.
  const order = [3, 1, 6, 2, 5, 4].filter((p) => p <= n);
  return {
    id: SESSION,
    company_id: CO,
    application_id: APP,
    job_id: JOB,
    kind: "live",
    status: "invited",
    attempt: 1,
    previous_attempt_id: null,
    token_hash: hashSessionToken(TOKEN),
    expires_at: new Date(T0 + 3 * 86_400_000).toISOString(),
    consent_at: new Date(T0 - 60_000).toISOString(),
    consent_version: "live-v1",
    started_at: null,
    live_ended_at: null,
    provider: null,
    provider_session_id: null,
    live_outcome: null,
    delete_after: null,
    purged_at: null,
    live_settings: settings(n),
    questions_snapshot: order.map((p) => ({
      id: `jq-${p}`,
      position: p,
      question: QUESTIONS[p - 1],
      prep_seconds: 30,
      answer_seconds: 120,
      required: true,
    })),
    scoring_snapshot: order.map((p) => ({
      position: p,
      question_id: `jq-${p}`,
      competency: "Ownership",
      rubric: `SECRET RUBRIC ${p}`,
      weight: 2,
    })),
    ...over,
  };
}

function world(sessions = [invited()], appOver = {}) {
  return fakeLiveDb({
    interview_sessions: sessions,
    job_applications: [
      {
        id: APP,
        job_id: JOB,
        company_id_snapshot: CO,
        first_name: "Alex",
        last_name: "Example",
        deletion_started_at: null,
        cv_text: "Alex Example, alex@example.com. CV TEXT MUST NOT TRAVEL.",
        ...appOver,
      },
    ],
    jobs: [
      {
        id: JOB,
        company_id: CO,
        title: "Support Lead",
        description: "Lead support.",
        responsibilities: "Run the queue.",
        requirements: "Three years.",
        live_hiring_challenges: "CONFIDENTIAL CHALLENGES",
      },
    ],
    // The job's live question rows: a recruiter can change them after the invite.
    interview_questions: QUESTIONS.map((q, i) => ({
      id: `jq-${i + 1}`,
      job_id: JOB,
      company_id: CO,
      position: i + 1,
      question: q,
    })),
    job_question_scoring_guides: [],
  });
}

function recordingProvider() {
  const seen = [];
  const cancelled = [];
  const rejoined = [];
  const joins = new Map();
  return {
    seen,
    cancelled,
    rejoined,
    provider: {
      name: "mock",
      async createSession(input) {
        seen.push(structuredClone(input));
        await new Promise((r) => setImmediate(r));
        const id = `mock-${seen.length}`;
        const join = {
          mode: "mock",
          script: "completed",
          turnDetection: "server",
          maxFollowUps: 2,
          n: seen.length,
        };
        joins.set(id, join);
        return { providerSessionId: id, join };
      },
      async cancelSession(id) {
        cancelled.push(id);
      },
      async rejoinSession(id) {
        rejoined.push(id);
        return joins.get(id);
      },
    },
  };
}

/** A model client that must never be called: every question here has a rubric. */
const noModel = {
  messages: {
    create() {
      throw new Error("test: the model was called");
    },
  },
};

const ENV = { LIVE_INTERVIEW_SCREEN_ENABLED: "1", AI_VIDEO_INTERVIEW_COMPANY_IDS: CO };

async function run(fn, env = ENV) {
  const before = {};
  for (const k of Object.keys(ENV)) before[k] = process.env[k];
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const saved = {};
  for (const m of ["log", "warn", "error"]) {
    saved[m] = console[m];
    console[m] = () => {};
  }
  try {
    return await fn();
  } finally {
    Object.assign(console, saved);
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

let ids = 0;
const start = (db, p, token = TOKEN, extra = {}) =>
  startLiveInterview(
    { token },
    {
      service: db.service,
      now: () => T0,
      mode: "mock",
      provider: p.provider,
      questionsClient: noModel,
      newId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`,
      ...extra,
    },
  );

/**
 * How many freeze writes were sent: prepareLiveQuestions' conditional update
 * (marker still null, not started). The claim writes carry the whole settings
 * too, so the marker in the payload alone would count them.
 */
const freezes = (db) =>
  db.service.queries.filter(
    (q) =>
      q.table === "interview_sessions" &&
      q.calls.some((c) => c[0] === "update" && c[1]?.live_settings?.questions_frozen) &&
      q.calls.some((c) => c[0] === "is" && c[1] === "started_at"),
  ).length;

/**
 * How many freezes LANDED on a session row: the fake applies an update with
 * Object.assign on the stored row, so a setter sees every write that matched,
 * and counts the ones that moved the row from no marker to a marker.
 */
function watchLanded(row) {
  let value = row.live_settings;
  let landed = 0;
  Object.defineProperty(row, "live_settings", {
    enumerable: true,
    configurable: true,
    get: () => value,
    set(next) {
      if (!value?.questions_frozen && next?.questions_frozen) landed += 1;
      value = next;
    },
  });
  return () => landed;
}

/* ── a valid token ─────────────────────────────────────────────── */

test("a valid token: frozen once, the provider gets exactly the frozen questions in order", async () => {
  const db = world();
  const p = recordingProvider();
  const r = await run(() => start(db, p));
  assert.equal(r.status, 200);
  assert.equal(freezes(db), 1);
  assert.equal(p.seen.length, 1);
  assert.deepEqual(
    p.seen[0].questions,
    QUESTIONS.map((text, i) => ({ position: i + 1, text })),
  );
  assert.deepEqual(
    [
      p.seen[0].interview_minutes,
      p.seen[0].max_follow_ups_per_base_question,
      p.seen[0].candidate_first_name,
      p.seen[0].cv_text,
    ],
    [30, 0, "Alex", ""],
  );
  const row = db.tables.interview_sessions[0];
  assert.ok(row.live_settings.questions_frozen, "the set is frozen on the session");
  assert.equal(row.status, "started");
});

test("the provider payload never carries the snapshot, rubric, guides, hiring challenges or CV", async () => {
  const db = world();
  const p = recordingProvider();
  await run(() => start(db, p));
  assert.deepEqual(Object.keys(p.seen[0]).sort(), [
    "candidate_first_name",
    "cv_text",
    "interview_minutes",
    "interviewer_name",
    "max_follow_ups_per_base_question",
    "questions",
    "remotiv_session_id",
  ]);
  const json = JSON.stringify(p.seen[0]);
  for (const leak of [
    "SECRET RUBRIC",
    "rubric",
    "scoring_guide",
    "competency",
    "weight",
    "prep_seconds",
    "answer_seconds",
    "required",
    "CONFIDENTIAL CHALLENGES",
    "challenges",
    "CV TEXT",
    "alex@example.com",
    "Example",
  ]) {
    assert.ok(!json.includes(leak), leak);
  }
  for (const q of p.seen[0].questions)
    assert.deepEqual(Object.keys(q).sort(), ["position", "text"]);
});

test("a second start after a busy provider reuses the frozen set: never frozen again", async () => {
  const db = world();
  const busy = {
    seen: [],
    provider: {
      name: "mock",
      async createSession(input) {
        busy.seen.push(input);
        const { ProviderBusyError } = await import("./live-provider/join.ts");
        throw new ProviderBusyError(30);
      },
      async cancelSession() {},
    },
  };
  const first = await run(() => start(db, busy));
  assert.equal(first.status, 503);
  assert.equal(freezes(db), 1);
  const p = recordingProvider();
  const second = await run(() => start(db, p));
  assert.equal(second.status, 200);
  assert.equal(freezes(db), 1, "the same frozen set, not a second freeze");
  assert.deepEqual(p.seen[0].questions, busy.seen[0].questions);
});

test("the job's questions edited after the invite: the start freezes the ORIGINAL ones", async () => {
  const db = world();
  db.tables.interview_questions = [
    { id: "jq-new", job_id: JOB, company_id: CO, position: 1, question: "A brand new question?" },
    ...db.tables.interview_questions.map((q) => ({
      ...q,
      position: q.position + 1,
      question: `${q.question} (edited)`,
    })),
  ];
  const p = recordingProvider();
  await run(() => start(db, p));
  assert.deepEqual(
    p.seen[0].questions.map((q) => q.text),
    QUESTIONS,
  );
  assert.ok(
    !db.service.queries.some((q) => q.table === "interview_questions"),
    "the job's live question rows are never read",
  );
});

/* ── refused before any freeze or provider call ────────────────── */

const REFUSALS = [
  ["a wrong token", () => world(), "wrong-token-0123456789abcdefghij", ENV, "not_found"],
  [
    "an expired link",
    () => world([invited({ expires_at: new Date(T0 - 1).toISOString() })]),
    TOKEN,
    ENV,
    "not_open",
  ],
  ["a cancelled link", () => world([invited({ status: "cancelled" })]), TOKEN, ENV, "not_open"],
  [
    "a session past retention",
    () => world([invited({ delete_after: new Date(T0 - 1).toISOString() })]),
    TOKEN,
    ENV,
    "not_open",
  ],
  [
    "an application being deleted",
    () => world([invited()], { deletion_started_at: new Date(T0 - 1).toISOString() }),
    TOKEN,
    ENV,
    "not_open",
  ],
  [
    "a deleted application",
    () => world([invited()], { id: "someone-else" }),
    TOKEN,
    ENV,
    "not_ready",
  ],
  [
    "another company's session (not on the allowlist)",
    () => world([invited({ company_id: OTHER_CO })]),
    TOKEN,
    ENV,
    "not_open",
  ],
  [
    "an async session",
    () => world([invited({ kind: "async", live_settings: null })]),
    TOKEN,
    ENV,
    "not_found",
  ],
  [
    "no saved consent",
    () => world([invited({ consent_at: null, consent_version: null })]),
    TOKEN,
    ENV,
    "consent_required",
  ],
  [
    "the live screen switched off",
    () => world(),
    TOKEN,
    { ...ENV, LIVE_INTERVIEW_SCREEN_ENABLED: undefined },
    "not_open",
  ],
  [
    "the company taken off the allowlist",
    () => world(),
    TOKEN,
    { ...ENV, AI_VIDEO_INTERVIEW_COMPANY_IDS: OTHER_CO },
    "not_open",
  ],
];

for (const [label, make, token, env, code] of REFUSALS) {
  test(`refused before any freeze or provider call: ${label}`, async () => {
    const db = make();
    const before = structuredClone(db.tables.interview_sessions);
    const p = recordingProvider();
    const r = await run(() => start(db, p, token), env);
    assert.equal(r.body.code, code, label);
    assert.equal(p.seen.length, 0, "no provider call");
    assert.equal(freezes(db), 0, "nothing frozen");
    assert.deepEqual(db.tables.interview_sessions, before, "nothing written");
    assert.ok(!db.service.queries.some((q) => q.table === "jobs"), "the freeze never ran");
  });
}

/* ── the freeze refuses ────────────────────────────────────────── */

const FREEZE_REFUSALS = [
  ["too few questions", () => invited({}, 3), "too_few_job_questions"],
  [
    "a count unlike the invite's",
    () => invited({ live_settings: settings(5) }),
    "job_question_count_mismatch",
  ],
  [
    "an old 4 + 4 snapshot",
    () =>
      invited({
        live_settings: {
          ...settings(6),
          v: 2,
          interview_mode: undefined,
          question_mix: {
            policy_version: "question-mix-v1",
            session_minutes: 30,
            job_questions: 4,
            cv_questions: 4,
            total: 8,
          },
        },
      }),
    "question_mix_superseded",
  ],
];

for (const [label, rowOf, code] of FREEZE_REFUSALS) {
  test(`the freeze refuses (${label}): 'not ready' for the candidate, no provider call, the code kept for the recruiter`, async () => {
    const db = world([rowOf()]);
    const p = recordingProvider();
    const r = await run(() => start(db, p));
    assert.deepEqual(r, {
      status: 409,
      body: { code: "not_ready", error: "This interview isn't ready yet." },
    });
    assert.ok(!JSON.stringify(r).includes(code), "no raw reason shown to the candidate");
    assert.equal(p.seen.length, 0);
    const row = db.tables.interview_sessions[0];
    assert.equal(row.live_settings[FREEZE_FAILED_KEY].code, code);
    assert.equal(row.live_settings.questions_frozen, undefined);
    assert.equal(row.live_settings.start_claim, undefined, "the claim is given back");
    assert.deepEqual([row.status, row.provider_session_id], ["invited", null]);
    // What the recruiter's review page shows.
    assert.match(freezeFailureReason(code), new RegExp(`reason: ${code}\\)`));
  });
}

/* ── at once ───────────────────────────────────────────────────── */

test("concurrent starts: one freeze, ONE provider session, and the allowance never touched", async () => {
  const db = world();
  const rpcs = [];
  db.service.rpc = async (name) => {
    rpcs.push(name);
    return { data: null, error: null };
  };
  const landed = watchLanded(db.tables.interview_sessions[0]);
  const p = recordingProvider();
  const results = await run(() => Promise.all([start(db, p), start(db, p), start(db, p)]));
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 503, 503]);
  // Only the claim holder prepares: one freeze write sent, and it lands.
  assert.equal(freezes(db), 1, "one freeze write sent");
  assert.equal(landed(), 1, "one freeze landed");
  assert.equal(p.seen.length, 1, "one provider session created");
  assert.deepEqual(p.cancelled, []);
  assert.deepEqual(rpcs, [], "the allowance was used once, at invite, never at start");
  const row = db.tables.interview_sessions[0];
  assert.equal(row.provider_session_id, "mock-1");
});

/* ── restart attempt 2 ─────────────────────────────────────────── */

test("restart attempt 2 starts with its own copied questions, mode, length and follow-up limit, never the job's", async () => {
  // Attempt 1, AI-Guided and 60 minutes, frozen and started.
  const db = world([invited({ live_settings: settings(6, "ai_guided", 3600) })]);
  const p1 = recordingProvider();
  assert.equal((await run(() => start(db, p1))).status, 200);
  const one = db.tables.interview_sessions[0];

  // The restart SQL (055) copies live_settings and both snapshots into attempt 2.
  const TOKEN2 = "live-start-freeze-token-attempt-2-abcdef";
  db.tables.interview_sessions.push({
    ...structuredClone(invited()),
    id: "5b0f2c1e-0000-4000-8000-0000000000a2",
    token_hash: hashSessionToken(TOKEN2),
    attempt: 2,
    previous_attempt_id: one.id,
    live_settings: structuredClone(one.live_settings),
    questions_snapshot: structuredClone(one.questions_snapshot),
    scoring_snapshot: structuredClone(one.scoring_snapshot),
  });
  // Since then the recruiter changed the job's questions.
  db.tables.interview_questions = [
    { id: "x", job_id: JOB, company_id: CO, position: 1, question: "Changed?" },
  ];
  const before = freezes(db);
  const jobReads = db.service.queries.filter((q) => q.table === "jobs").length;

  const p2 = recordingProvider();
  const r = await run(() => start(db, p2, TOKEN2));
  assert.equal(r.status, 200);
  assert.deepEqual(p2.seen[0].questions, p1.seen[0].questions, "the copied questions");
  assert.deepEqual(
    [p2.seen[0].interview_minutes, p2.seen[0].max_follow_ups_per_base_question],
    [60, 2],
    "the copied length and follow-up limit",
  );
  assert.equal(freezes(db), before, "never frozen again");
  assert.equal(
    db.service.queries.filter((q) => q.table === "jobs").length,
    jobReads,
    "the job is never read",
  );
});

/* ── claim first, and a claim never sticks ─────────────────────── */

/** A model client that writes a scoring guide and counts its calls. */
function guideModel() {
  const calls = [];
  return {
    calls,
    messages: {
      async create(request) {
        calls.push(request);
        await new Promise((r) => setTimeout(r, 5));
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                strong: "Names one specific queue, the candidate's own first steps and the result.",
                weak: "Describes what the team did without their own part, or gives no outcome.",
              }),
            },
          ],
          stop_reason: "end_turn",
          usage: { input_tokens: 300, output_tokens: 80 },
        };
      },
    },
  };
}

/** Question 1 has no rubric: its scoring guide is written by the model at freeze. */
const needsGuide = () => {
  const row = invited();
  row.scoring_snapshot = row.scoring_snapshot.map((s) =>
    s.position === 1 ? { ...s, rubric: null } : s,
  );
  return row;
};

test("concurrent starts: the claim comes first, so the losers make ZERO model calls and send no freeze", async () => {
  const db = world([needsGuide()]);
  const model = guideModel();
  const p = recordingProvider();
  const results = await run(() =>
    Promise.all([1, 2, 3].map(() => start(db, p, TOKEN, { questionsClient: model }))),
  );
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 503, 503]);
  for (const r of results.filter((x) => x.status === 503)) {
    assert.deepEqual(r.body, { code: "busy", error: TRY_AGAIN_SHORTLY, retryAfterSeconds: 5 });
  }
  assert.equal(model.calls.length, 1, "one guide written, by the claim holder only");
  assert.equal(freezes(db), 1, "one freeze write sent");
  assert.equal(p.seen.length, 1, "one provider session");
});

const STALE = (ms) => `${SESSION}|${T0 - ms}|00000000-0000-4000-8000-00000000dead`;

test("a claim left by a start that died: refused while fresh, taken over past CLAIM_STALE_MS, ONE provider session", async () => {
  assert.equal(CLAIM_STALE_MS, 120_000);
  const fresh = world([invited({ live_settings: { ...settings(6), start_claim: STALE(60_000) } })]);
  const p1 = recordingProvider();
  const r1 = await run(() => start(fresh, p1));
  assert.deepEqual([r1.status, r1.body.code, p1.seen.length], [503, "busy", 0]);

  const stale = world([
    invited({ live_settings: { ...settings(6), start_claim: STALE(CLAIM_STALE_MS + 1) } }),
  ]);
  const p2 = recordingProvider();
  const r2 = await run(() => start(stale, p2));
  assert.equal(r2.status, 200, "the candidate's next press starts");
  assert.equal(p2.seen.length, 1, "exactly one provider session");
  assert.equal(stale.tables.interview_sessions[0].provider_session_id, "mock-1");
});

test("the provider fails: the claim is released at once, 'try again shortly', and the retry starts", async () => {
  const db = world();
  const broken = {
    seen: [],
    provider: {
      name: "mock",
      async createSession(input) {
        broken.seen.push(input);
        throw new Error("provider down");
      },
      async cancelSession() {},
    },
  };
  const r1 = await run(() => start(db, broken));
  assert.deepEqual(r1, { status: 503, body: { code: "unavailable", error: TRY_AGAIN_SHORTLY } });
  const row = db.tables.interview_sessions[0];
  assert.equal(row.live_settings.start_claim, undefined, "claim released");
  assert.ok(row.live_settings.questions_frozen, "the frozen set is kept");
  const p = recordingProvider();
  const r2 = await run(() => start(db, p));
  assert.equal(r2.status, 200, "retried at the same moment, not after two minutes");
  assert.equal(p.seen.length, 1);
});

test("the provider times out: the claim is released, and a session it creates late is cancelled", async () => {
  const db = world();
  const cancelled = [];
  const slow = {
    name: "mock",
    async createSession() {
      await new Promise((r) => setTimeout(r, 40));
      return { providerSessionId: "mock-late", join: { mode: "mock" } };
    },
    async cancelSession(id) {
      cancelled.push(id);
    },
  };
  const r = await run(() => start(db, { provider: slow }, TOKEN, { providerTimeoutMs: 5 }));
  assert.deepEqual(r, { status: 503, body: { code: "unavailable", error: TRY_AGAIN_SHORTLY } });
  assert.equal(db.tables.interview_sessions[0].live_settings.start_claim, undefined);
  await new Promise((r2) => setTimeout(r2, 60));
  assert.deepEqual(cancelled, ["mock-late"], "never joined, so given back");
  assert.equal(db.tables.interview_sessions[0].provider_session_id, null);
});

test("preparation ran long: the provider is not asked on a claim about to go stale", async () => {
  const db = world();
  const p = recordingProvider();
  let t = T0;
  // Each clock read moves 40 seconds on: by the provider step, the claim is
  // more than 75 seconds old (120 less 30 for the provider and 15 for the write).
  const r = await run(() =>
    start(db, p, TOKEN, {
      now: () => {
        t += 40_000;
        return t;
      },
    }),
  );
  assert.deepEqual([r.status, r.body.code, p.seen.length], [503, "busy", 0]);
  assert.equal(db.tables.interview_sessions[0].live_settings.start_claim, undefined);
});

test("a retry after a successful start joins the SAME provider session, never a new one", async () => {
  const db = world();
  const p = recordingProvider();
  const first = await run(() => start(db, p));
  assert.equal(first.status, 200);
  const again = await run(() => start(db, p, TOKEN, { now: () => T0 + 10_000 }));
  assert.equal(again.status, 200);
  assert.deepEqual(again.body.join, first.body.join, "the same join details");
  assert.deepEqual(p.rejoined, ["mock-1"]);
  assert.equal(p.seen.length, 1, "no second provider session");
  // Past the window, the link is spent, as before.
  const late = await run(() => start(db, p, TOKEN, { now: () => T0 + REJOIN_WINDOW_MS }));
  assert.equal(late.body.code, "already_started");
  assert.equal(p.seen.length, 1);
});

test("the rejoin window is 15 seconds: a reload after a dropped connection is NOT a way back in", async () => {
  assert.equal(REJOIN_WINDOW_MS, 15_000);
  const db = world();
  const p = recordingProvider();
  assert.equal((await run(() => start(db, p))).status, 200);
  // Dropped 16 seconds in, the candidate reloads and presses Start: the attempt is over (F10).
  const reload = await run(() => start(db, p, TOKEN, { now: () => T0 + 16_000 }));
  assert.equal(reload.body.code, "already_started");
  assert.equal(screenFor(reload), "blocked:already_started");
  assert.deepEqual(p.rejoined, [], "never joined again");
  assert.equal(p.seen.length, 1, "and never a new provider session");
});

/* ── an old claim never touches a newer one ────────────────────── */

const NEWER = `${SESSION}|${T0 + 1}|00000000-0000-4000-8000-0000000000b2`;

test("releasing an old claim never clears or overwrites a newer claim", async () => {
  const db = world();
  const row = db.tables.interview_sessions[0];
  // Start A holds the claim; while its provider call hangs, the claim is taken
  // over by start B (as after CLAIM_STALE_MS). Then A's provider fails.
  const a = {
    provider: {
      name: "mock",
      async createSession() {
        row.live_settings = { ...row.live_settings, start_claim: NEWER };
        throw new Error("provider down");
      },
      async cancelSession() {},
    },
  };
  const r = await run(() => start(db, a));
  assert.equal(r.body.code, "unavailable");
  assert.equal(row.live_settings.start_claim, NEWER, "B's claim is still there, untouched");
  assert.ok(row.live_settings.questions_frozen, "and the frozen set with it");
});

test("taking over an expired claim lands once: two takeovers at once never overwrite each other", async () => {
  const db = world([
    invited({ live_settings: { ...settings(6), start_claim: STALE(CLAIM_STALE_MS + 1) } }),
  ]);
  const p = recordingProvider();
  const results = await run(() => Promise.all([start(db, p), start(db, p)]));
  assert.deepEqual(results.map((x) => x.status).sort(), [200, 503]);
  assert.equal(p.seen.length, 1, "one provider session");
  assert.deepEqual(p.cancelled, [], "no takeover was overwritten after it created a session");
});

test("the default (mock) provider: a double click gets the same join details", async () => {
  const db = world();
  const deps = { provider: undefined };
  const first = await run(() => start(db, { provider: deps.provider }));
  const again = await run(() =>
    start(db, { provider: deps.provider }, TOKEN, { now: () => T0 + 1_000 }),
  );
  assert.equal(first.status, 200);
  assert.deepEqual(again, first);
});

/* ── what the candidate sees ───────────────────────────────────── */

const screenFor = (result) => {
  const s = liveReducer(
    { ...INITIAL, screen: "connecting", starting: true },
    { t: "start_result", answer: startAnswerFrom(result) },
  );
  return s.screen === "blocked" ? `blocked:${s.blocked}` : s.screen;
};

test("the candidate's screens: a concurrent start is 'try again shortly', a freeze refusal 'isn't open yet'", async () => {
  const db = world();
  const p = recordingProvider();
  const results = await run(() => Promise.all([start(db, p), start(db, p)]));
  const loser = results.find((r) => r.status === 503);
  assert.equal(screenFor(loser), "busy");
  assert.equal(BUSY.heading, "Please try again shortly");
  assert.equal(BUSY.button, "Try again");

  const refused = await run(() => start(world([invited({}, 3)]), recordingProvider()));
  assert.equal(refused.body.code, "not_ready");
  assert.equal(screenFor(refused), "blocked:locked");
  assert.equal(BLOCKED.locked.heading, "This interview isn't open yet");
  assert.doesNotMatch(BLOCKED.locked.body("Acme"), /too_few|reason|question/i);
});

/* ── #71: the fairness rules are Remotiv's scorer's, never the interviewer's ── */

test("VoxAgent (Sarah) never receives the fairness rules or any rubric: payload and source", async () => {
  const { readFileSync, readdirSync } = await import("node:fs");
  // A question with no rubric gets a written guide at freeze: that guide must not travel either.
  const db = world([needsGuide()]);
  const model = guideModel();
  const p = recordingProvider();
  const r = await run(() => start(db, p, TOKEN, { questionsClient: model }));
  assert.equal(r.status, 200);
  const sent = JSON.stringify(p.seen);
  for (const line of FAIRNESS_RULES.split("\n")) {
    assert.ok(!sent.includes(line), `fairness text: ${line.slice(0, 40)}`);
  }
  assert.ok(!/FAIRNESS|job-related evidence/i.test(sent));
  const frozen = db.tables.interview_sessions[0].live_settings.questions_frozen;
  assert.ok(frozen, "frozen with guides");
  const written = db.tables.job_question_scoring_guides.map((x) => x.guide);
  assert.equal(written.length, 1, "a guide was written, so the check below is not empty");
  const rubrics = db.tables.interview_sessions[0].scoring_snapshot.map((x) => x.rubric);
  for (const g of [...rubrics, ...written].filter(Boolean)) {
    assert.ok(!sent.includes(g), "no rubric or scoring guide");
  }
  // And nothing on the provider path can reach them: no import of the
  // fairness rules or the scoring prompt.
  const dir = new URL("./live-provider/", import.meta.url);
  const files = [
    new URL("./live-start.ts", import.meta.url),
    ...readdirSync(dir)
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
      .map((f) => new URL(f, dir)),
  ];
  for (const f of files) {
    assert.doesNotMatch(
      readFileSync(f, "utf8"),
      /ai\/fairness|live-interview-scoring|FAIRNESS_RULES/,
      f.pathname.split("/").pop(),
    );
  }
});
