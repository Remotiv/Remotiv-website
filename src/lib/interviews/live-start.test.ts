/**
 * AVI commit 10: a live interview's link, consent and start, on the server.
 * The live consent text is stubbed as final here, to test what happens once
 * it is; live-locked.test.ts runs the REAL text, which keeps all of this
 * closed. fake-live-db.mjs applies 019's provider rules and 044's trigger.
 *
 *   node --test src/lib/interviews/live-start.test.ts
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../test-support/node-resolve.mjs", import.meta.url));
register(
  `data:text/javascript,${encodeURIComponent(`
const STUBS = {
  "server-only": "",
  "@/lib/supabase/server": "export function createServiceClient() { return globalThis.__service; }",
  "@/lib/interviews/live-consent": "export const LIVE_INTERVIEW_CONSENT_VERSION = 'live-v1'; export function liveConsentReady() { return true; } export function liveConsentGiven(r) { return r.consent_at !== null && r.consent_version === 'live-v1'; }",
};
export async function resolve(specifier, context, next) {
  if (specifier in STUBS) return { url: "data:text/javascript," + encodeURIComponent(STUBS[specifier]), shortCircuit: true };
  return next(specifier, context);
}`)}`,
);

const { startLiveInterview, agreeToLiveInterview, TRY_AGAIN_SHORTLY } = await import(
  "./live-start.ts"
);
const { createMockJoinProvider, ProviderBusyError } = await import("./live-provider/join.ts");
const { resolveSessionByToken } = await import("./session.ts");
const { liveWelcomeFacts } = await import("./live-screen.ts");
const { fakeService } = await import("../../test-support/fake-postgrest.mjs");
const { snapshotsFor } = await import("./frozen-questions.ts");
const { hashSessionToken } = await import("./tokens.ts");
const { fakeLiveDb } = await import("../../test-support/fake-live-db.mjs");

const CO = "7aad434d-0000-4000-8000-000000000020";
const JOB = "2d4a8cde-0000-4000-8000-0000000000c1";
const APP = "9c1d2e3f-0000-4000-8000-0000000000c1";
const SESSION = "5b0f2c1e-0000-4000-8000-000000000301";
const TOKEN = "live-start-test-token-0123456789abcdef";
const T0 = Date.parse("2026-10-26T10:00:00.000Z");

const SETTINGS = {
  v: 1,
  interviewer_name: "Maya",
  language: "en",
  max_follow_ups_per_base_question: 2,
  max_session_seconds: 1200,
  follow_up_rules_version: "follow-up-v1",
  follow_up_rules: {
    when: "Probe a thin answer.",
    scope: "s",
    never: ["Never reveal a good answer."],
  },
  questions_frozen: {
    at: "2026-10-20T08:50:00.000Z",
    prompt_version: "live-questions-v1",
    policy_version: "question-mix-v1",
    model: "claude-haiku-5-5",
    calls: 1,
    input_tokens: 1,
    output_tokens: 1,
    rewritten: 0,
    replaced: 0,
  },
};
const QUESTIONS = [1, 2, 3].map((n) => ({
  question_id: `q-${n}`,
  position: n,
  text: `Made-up question ${n}?`,
  source: "job",
  competency: "Ownership",
  scoring_guide: `SECRET GUIDE ${n}`,
  weight: 2,
}));

function sessionRow(over = {}) {
  return {
    id: SESSION,
    company_id: CO,
    application_id: APP,
    job_id: JOB,
    kind: "live",
    status: "invited",
    attempt: 1,
    token_hash: hashSessionToken(TOKEN),
    expires_at: new Date(T0 + 3 * 86_400_000).toISOString(),
    consent_at: new Date(T0 - 60_000).toISOString(),
    consent_version: "live-v1",
    started_at: null,
    live_ended_at: null,
    provider: null,
    provider_session_id: null,
    live_outcome: null,
    submitted_at: null,
    allow_rerecord: null,
    live_settings: SETTINGS,
    ...snapshotsFor(QUESTIONS),
    ...over,
  };
}

function world(over = {}) {
  const db = fakeLiveDb({
    interview_sessions: [sessionRow(over)],
    job_applications: [
      {
        id: APP,
        job_id: JOB,
        company_id_snapshot: CO,
        first_name: "Alex",
        last_name: "Example",
        cv_text: "Alex Example, alex@example.com, +44 7000 000000. Built a queue at Initech.",
      },
    ],
  });
  globalThis.__service = db.service;
  return db;
}

async function withEnv(vars, fn) {
  const before = {};
  for (const k of Object.keys(vars)) before[k] = process.env[k];
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}
const ON = { LIVE_INTERVIEW_SCREEN_ENABLED: "1" };

/** Captures every log line, to prove the ticket and the token are never in one. */
async function logged(fn) {
  const lines = [];
  const log = console.log;
  const err = console.error;
  console.log = (...a) => lines.push(a.join(" "));
  console.error = (...a) => lines.push(a.join(" "));
  try {
    return { result: await fn(), lines };
  } finally {
    console.log = log;
    console.error = err;
  }
}

/** A provider that records what it was given. */
function recordingProvider(join = { mode: "mock", script: "completed", turnDetection: "server" }) {
  const seen = [];
  const cancelled = [];
  return {
    seen,
    cancelled,
    provider: {
      name: "mock",
      async createSession(input) {
        seen.push(structuredClone(input));
        return { providerSessionId: `mock-${seen.length === 1 ? "abc" : seen.length}`, join };
      },
      async cancelSession(id) {
        cancelled.push(id);
      },
    },
  };
}

const start = (db, deps = {}, body = {}) =>
  startLiveInterview({ token: TOKEN, ...body }, { service: db.service, now: () => T0, ...deps });

/* ── the link ─────────────────────────────────────────────────── */

test("the link: off by default a live session is unavailable; on, it is live with its facts and no questions", async () => {
  for (const value of [undefined, "", "0", "true", " 1", "1 "]) {
    await withEnv({ LIVE_INTERVIEW_SCREEN_ENABLED: value }, async () => {
      world();
      const r = await resolveSessionByToken(TOKEN);
      assert.equal(r.session.state, "unavailable", JSON.stringify(value));
      assert.equal(r.session.live, null);
    });
  }
  await withEnv(ON, async () => {
    world();
    const r = await resolveSessionByToken(TOKEN);
    assert.equal(r.session.state, "live");
    assert.deepEqual(r.session.live, { questionCount: 3 });
    assert.deepEqual(r.session.questions, [], "never the questions ahead of the conversation");
    assert.doesNotMatch(JSON.stringify(r.session), /Made-up question|SECRET GUIDE|Probe a thin/);
  });
});

test("the welcome's name and time limit: two JSON fields of live_settings, never the column (the follow-up rules)", async () => {
  const asked = [];
  const service = fakeService((_table, calls) => {
    asked.push(calls.find((c) => c[0] === "select")[1]);
    return { data: { interviewer_name: "  Maya  ", max_session_seconds: 1200 }, error: null };
  });
  assert.deepEqual(await liveWelcomeFacts(SESSION, service), {
    interviewerName: "Maya",
    minutes: 20,
  });
  assert.deepEqual(asked, [
    "interviewer_name:live_settings->>interviewer_name, max_session_seconds:live_settings->max_session_seconds",
  ]);
  const empty = fakeService(() => ({ data: null, error: null }));
  assert.deepEqual(await liveWelcomeFacts(SESSION, empty), {
    interviewerName: "Your interviewer",
    minutes: 30,
  });
});

test("the link: once started or ended it reads ended (no automatic restart); cancelled and expired say so", async () => {
  await withEnv(ON, async () => {
    for (const [over, want] of [
      [{ provider: "mock", provider_session_id: "mock-1", status: "started" }, "ended"],
      [{ live_ended_at: new Date(T0).toISOString() }, "ended"],
      [{ status: "abandoned" }, "ended"],
      [{ status: "submitted" }, "ended"],
      [{ status: "cancelled" }, "cancelled"],
      [{ expires_at: new Date(Date.now() - 1000).toISOString() }, "expired"],
    ]) {
      world(over);
      assert.equal((await resolveSessionByToken(TOKEN)).session.state, want, JSON.stringify(over));
    }
  });
});

test("every async candidate route refuses anything but 'ready', so none accepts a live session", () => {
  for (const route of ["consent", "upload-url", "confirm", "submit", "playback"]) {
    const src = readFileSync(
      new URL(`../../app/api/interview/${route}/route.ts`, import.meta.url),
      "utf8",
    );
    assert.match(src, /resolved\.session\.state !== "ready"/, route);
  }
});

/* ── consent ──────────────────────────────────────────────────── */

test("consent: saved as live-v1 only for an open live session with the switch on", async () => {
  await withEnv(ON, async () => {
    const db = world({ consent_at: null, consent_version: null });
    const agree = (body) =>
      agreeToLiveInterview({ token: TOKEN, ...body }, { service: db.service, now: () => T0 });
    assert.equal((await agree({ agreed: false })).body.code, "declined");
    assert.equal(db.tables.interview_sessions[0].consent_at, null);
    assert.deepEqual(await agree({ agreed: true }), { status: 200, body: { ok: true } });
    assert.equal(db.tables.interview_sessions[0].consent_version, "live-v1");
  });
  await withEnv({ LIVE_INTERVIEW_SCREEN_ENABLED: undefined }, async () => {
    const db = world({ consent_at: null, consent_version: null });
    const res = await agreeToLiveInterview({ token: TOKEN, agreed: true }, { service: db.service });
    assert.equal(res.body.code, "not_open");
    assert.equal(db.tables.interview_sessions[0].consent_at, null, "nothing written");
  });
  await withEnv(ON, async () => {
    const db = world({
      consent_at: null,
      consent_version: null,
      provider: "mock",
      provider_session_id: "mock-1",
    });
    const res = await agreeToLiveInterview({ token: TOKEN, agreed: true }, { service: db.service });
    assert.equal(res.body.code, "not_open", "already started");
  });
});

/* ── start ────────────────────────────────────────────────────── */

test("start: the browser gets the join ticket and nothing else; the row is claimed once", async () => {
  await withEnv(ON, async () => {
    const db = world();
    const p = recordingProvider();
    const { result, lines } = await logged(() => start(db, { provider: p.provider }));
    assert.deepEqual(result, {
      status: 200,
      body: { join: { mode: "mock", script: "completed", turnDetection: "server" } },
    });
    const row = db.tables.interview_sessions[0];
    assert.deepEqual(
      [row.provider, row.provider_session_id, row.status, row.started_at],
      ["mock", "mock-abc", "started", new Date(T0).toISOString()],
    );
    assert.equal(row.live_ended_at, null, "starting never ends it");
    // Nothing secret in the answer or the log.
    const out = JSON.stringify(result) + lines.join("\n");
    assert.doesNotMatch(
      out,
      /mock-abc|SECRET GUIDE|Made-up question|alex@example|live-start-test-token/,
    );
  });
});

test("start: the provider gets position and text only, the CV cleaned of contact details and the name", async () => {
  await withEnv(ON, async () => {
    const db = world();
    const p = recordingProvider();
    await logged(() => start(db, { provider: p.provider }));
    const input = p.seen[0];
    assert.deepEqual(Object.keys(input).sort(), [
      "candidate_first_name",
      "cv_text",
      "interview_minutes",
      "interviewer_name",
      "questions",
      "remotiv_session_id",
    ]);
    assert.deepEqual(input.questions, [
      { position: 1, text: "Made-up question 1?" },
      { position: 2, text: "Made-up question 2?" },
      { position: 3, text: "Made-up question 3?" },
    ]);
    assert.equal(input.interview_minutes, 20);
    assert.doesNotMatch(input.cv_text, /alex@example|7000 000000|Example/);
    assert.doesNotMatch(JSON.stringify(input), /SECRET GUIDE|Ownership|Probe a thin/);
  });
});

test("start: never twice. A second start, from another tab or a reload, is refused and changes nothing", async () => {
  await withEnv(ON, async () => {
    const db = world();
    const p = recordingProvider();
    await logged(() => start(db, { provider: p.provider }));
    const second = await logged(() => start(db, { provider: p.provider }));
    assert.deepEqual([second.result.status, second.result.body.code], [409, "already_started"]);
    assert.equal(p.seen.length, 1, "no second provider session");
    assert.equal(db.tables.interview_sessions[0].provider_session_id, "mock-abc");
  });
});

test("start: two at once (two tabs, a double click) start one conversation; the other is refused", async () => {
  await withEnv(ON, async () => {
    const db = world();
    const p = recordingProvider();
    const { result } = await logged(() =>
      Promise.all([start(db, { provider: p.provider }), start(db, { provider: p.provider })]),
    );
    assert.deepEqual(result.map((r) => r.status).sort(), [200, 409]);
    assert.equal(result.find((r) => r.status === 409).body.code, "already_started");
    assert.equal(db.tables.interview_sessions[0].provider_session_id, "mock-abc");
    assert.deepEqual(p.cancelled, ["mock-2"], "the losing provider session is given back");
  });
});

test("start: busy is 503 'Please try again shortly' and nothing is used up; it can start once a slot is free", async () => {
  await withEnv(ON, async () => {
    const db = world();
    const busy = await logged(() => start(db, { provider: createMockJoinProvider("busy") }));
    assert.deepEqual(busy.result, {
      status: 503,
      body: { code: "busy", error: TRY_AGAIN_SHORTLY, retryAfterSeconds: 30 },
    });
    const row = db.tables.interview_sessions[0];
    assert.deepEqual(
      [row.provider, row.provider_session_id, row.status, row.started_at],
      [null, null, "invited", null],
    );
    const later = await logged(() => start(db, { provider: createMockJoinProvider("completed") }));
    assert.equal(later.result.status, 200);
    assert.ok(ProviderBusyError);
  });
});

test("start: any other provider failure is the same sentence, nothing stored", async () => {
  await withEnv(ON, async () => {
    const db = world();
    const failing = {
      name: "mock",
      createSession: async () => {
        throw new Error("boom");
      },
      cancelSession: async () => {},
    };
    const { result } = await logged(() => start(db, { provider: failing }));
    assert.deepEqual(
      [result.status, result.body.code, result.body.error],
      [503, "unavailable", TRY_AGAIN_SHORTLY],
    );
    assert.equal(db.tables.interview_sessions[0].provider_session_id, null);
  });
});

test("start: refused without saved live-v1 consent, with the switch off, in production (no mock), closed or expired", async () => {
  const cases = [
    [ON, { consent_at: null, consent_version: null }, {}, 403, "consent_required"],
    [ON, { consent_version: "v2" }, {}, 403, "consent_required"],
    [{ LIVE_INTERVIEW_SCREEN_ENABLED: undefined }, {}, {}, 409, "not_open"],
    [ON, {}, { mode: null }, 503, "unavailable"],
    [ON, { status: "cancelled" }, {}, 409, "not_open"],
    [ON, { expires_at: new Date(T0 - 1).toISOString() }, {}, 409, "not_open"],
    [ON, { kind: "async", live_settings: null, provider: null }, {}, 404, "not_found"],
  ];
  for (const [env, over, deps, status, code] of cases) {
    await withEnv(env, async () => {
      const db = world(over);
      const p = recordingProvider();
      const { result } = await logged(() => start(db, { provider: p.provider, ...deps }));
      assert.deepEqual([result.status, result.body.code], [status, code], JSON.stringify(over));
      assert.equal(p.seen.length, 0, `${code}: the provider is never called`);
      assert.equal(db.tables.interview_sessions[0].provider_session_id ?? null, null);
    });
  }
});

test("production: the mock is refused by default (liveProviderMode), the ticket never handed out", async () => {
  await withEnv({ ...ON, NODE_ENV: "production" }, async () => {
    const db = world();
    const { result } = await logged(() => start(db));
    assert.deepEqual([result.status, result.body.code], [503, "unavailable"]);
    assert.equal(db.tables.interview_sessions[0].provider_session_id, null);
  });
  await withEnv({ ...ON, NODE_ENV: "development" }, async () => {
    const db = world();
    const { result } = await logged(() => start(db, {}, { mockScript: "interruption" }));
    assert.deepEqual(result.body.join, {
      mode: "mock",
      script: "interruption",
      turnDetection: "server",
    });
  });
});

test("the mock provider refuses any input key outside CreateSessionInput (the rubric cannot slip through)", async () => {
  const p = createMockJoinProvider("completed");
  await assert.rejects(
    p.createSession({
      remotiv_session_id: "s",
      interviewer_name: "M",
      interview_minutes: 1,
      questions: [{ position: 1, text: "Q", scoring_guide: "x" }],
      candidate_first_name: null,
      cv_text: "",
    }),
    /unexpected question key scoring_guide/,
  );
  await assert.rejects(
    p.createSession({
      remotiv_session_id: "s",
      interviewer_name: "M",
      interview_minutes: 1,
      questions: [],
      candidate_first_name: null,
      cv_text: "",
      rubric: "x",
    }),
    /unexpected input key rubric/,
  );
});

test("routes: each live route is a thin wrapper with a rate limit; the key never appears in candidate code", () => {
  const route = (name) =>
    readFileSync(new URL(`../../app/api/interview/live/${name}/route.ts`, import.meta.url), "utf8");
  assert.match(route("start"), /rateLimitByKey\(`live-start:/);
  assert.match(
    route("start"),
    /startLiveInterview\(body, \{ service: createServiceClient\(\) \}\)/,
  );
  assert.match(route("consent"), /agreeToLiveInterview\(body/);
  assert.match(route("event"), /handleLiveEvent\(body/);
  assert.match(route("event"), /await request\.text\(\)/, "sendBeacon's text/plain body is read");
  const client = [
    "live-flow.tsx",
    "live-server.ts",
    "transport.ts",
    "mock-voxagent.ts",
    "screens.tsx",
  ].map((f) =>
    readFileSync(new URL(`../../app/interview/[token]/_live/${f}`, import.meta.url), "utf8"),
  );
  for (const src of client) {
    assert.doesNotMatch(src, /VOXAGENT_|API_KEY|process\.env/);
  }
});
