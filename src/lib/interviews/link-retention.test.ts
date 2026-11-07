/**
 * A candidate link refuses a session that is purged or past delete_after, at the
 * door. Application deletion sets delete_after and then cancels in a second
 * statement, so a half-failed deletion leaves an open-looking session: without
 * this, the link opens and a paid provider session starts, then fails on the
 * first transcript write (RT063, migration 054). A future or absent delete_after
 * changes nothing, and a session already closed keeps the screen that says why.
 *
 *   node --test src/lib/interviews/link-retention.test.ts
 *
 * resolveSessionByToken, startLiveInterview, agreeToLiveInterview, the candidate
 * page and the consent route are the shipped code. The live consent text is stubbed as final, as in
 * live-start.test.ts. The database is fake-live-db.mjs. Synthetic data only.
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../test-support/tsx-load.mjs", import.meta.url));
register(
  `data:text/javascript,${encodeURIComponent(`
const flow = (name) => "export function " + name + "() { return globalThis.__h('div', { 'data-flow': '" + name + "' }); }";
const STUBS = {
  "server-only": "",
  "../interview.css": "",
  "../live-interview.css": "",
  "./_flow": flow("InterviewFlow"),
  "./_live/live-flow": flow("LiveInterviewFlow"),
  "next/server": "export const NextResponse = { json: (b, i) => Response.json(b, i) };",
  "@/lib/supabase/server": "export function createServiceClient() { return globalThis.__service; }",
  "@/app/api/_lib/rate-limit": "export function rateLimitByKey() { return { ok: true }; }",
  "@/lib/interviews/live-consent": "export const LIVE_INTERVIEW_CONSENT_VERSION = 'live-v1'; export function liveConsentScreen() { return null; } export function liveConsentReady() { return true; } export function liveConsentGiven(r) { return r.consent_at !== null && r.consent_version === 'live-v1'; }",
};
export async function resolve(specifier, context, next) {
  if (specifier in STUBS) return { url: "data:text/javascript," + encodeURIComponent(STUBS[specifier]), shortCircuit: true };
  return next(specifier, context);
}`)}`,
);

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
globalThis.__h = createElement;
const { startLiveInterview, agreeToLiveInterview } = await import("./live-start.ts");
const { default: InterviewPage } = await import("../../app/interview/[token]/page.tsx");
const { resolveSessionByToken } = await import("./session.ts");
const { POST: consentPost } = await import("../../app/api/interview/consent/route.ts");
const { snapshotsFor } = await import("./frozen-questions.ts");
const { hashSessionToken } = await import("./tokens.ts");
const { fakeLiveDb } = await import("../../test-support/fake-live-db.mjs");

const CO = "c0000000-0000-4000-8000-0000000000f1";
const JOB = "b0000000-0000-4000-8000-0000000000f1";
const APP = "a0000000-0000-4000-8000-0000000000f1";
const SESSION = "d0000000-0000-4000-8000-0000000000f1";
const TOKEN = "retention-synthetic-token-0123456789abcdef";
const T0 = Date.now();
const HOUR = 3_600_000;
const iso = (ms) => new Date(ms).toISOString();
const SETTINGS = {
  v: 1,
  interviewer_name: "Maya",
  language: "en",
  max_follow_ups_per_base_question: 2,
  max_session_seconds: 1200,
  follow_up_rules_version: "follow-up-v1",
  follow_up_rules: { when: "Probe.", scope: "s", never: ["Never reveal."] },
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
  scoring_guide: `GUIDE ${n}`,
  weight: 2,
}));

/** Each of these closes the link. The middle one is the half-failed deletion. */
const CLOSED = [
  ["purged", { purged_at: iso(T0 - HOUR), delete_after: iso(T0 - HOUR) }],
  ["delete_after in the past, not purged yet", { delete_after: iso(T0 - HOUR) }],
  ["purged, with a future date", { purged_at: iso(T0 - HOUR), delete_after: iso(T0 + HOUR) }],
];
const OPEN = [
  ["delete_after in the future", { delete_after: iso(T0 + 200 * 24 * HOUR) }],
  ["no delete_after", { delete_after: null }],
];

function world(over = {}) {
  const db = fakeLiveDb({
    interview_sessions: [
      {
        id: SESSION,
        company_id: CO,
        application_id: APP,
        job_id: JOB,
        kind: "live",
        status: "invited",
        attempt: 1,
        token_hash: hashSessionToken(TOKEN),
        expires_at: iso(T0 + 3 * 24 * HOUR),
        consent_at: iso(T0 - 60_000),
        consent_version: "live-v1",
        started_at: null,
        live_ended_at: null,
        provider: null,
        provider_session_id: null,
        live_outcome: null,
        submitted_at: null,
        allow_rerecord: null,
        delete_after: iso(T0 + 200 * 24 * HOUR),
        purged_at: null,
        live_settings: SETTINGS,
        ...snapshotsFor(QUESTIONS),
        ...over,
      },
    ],
    companies: [{ id: CO, name: "Acme Ltd" }],
    jobs: [{ id: JOB, company_id: CO, title: "Test role", allow_rerecord: false }],
    interview_answers: [],
    job_applications: [
      {
        id: APP,
        job_id: JOB,
        company_id_snapshot: CO,
        first_name: "Alex",
        last_name: "Example",
        cv_text: "Alex Example. Built a queue at Initech.",
      },
    ],
  });
  globalThis.__service = db.service;
  return db;
}

async function run(screen, fn) {
  const before = process.env.LIVE_INTERVIEW_SCREEN_ENABLED;
  if (screen) process.env.LIVE_INTERVIEW_SCREEN_ENABLED = "1";
  else delete process.env.LIVE_INTERVIEW_SCREEN_ENABLED;
  const lines = [];
  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = (...a) => lines.push(a.join(" "));
  try {
    return { result: await fn(), lines };
  } finally {
    Object.assign(console, saved);
    if (before === undefined) delete process.env.LIVE_INTERVIEW_SCREEN_ENABLED;
    else process.env.LIVE_INTERVIEW_SCREEN_ENABLED = before;
  }
}

const stateOf = async (over, screen) => {
  world(over);
  const { result } = await run(screen, () => resolveSessionByToken(TOKEN));
  return result.session.state;
};

function recordingProvider() {
  const seen = [];
  return {
    seen,
    provider: {
      name: "mock",
      async createSession(input) {
        seen.push(input);
        return { providerSessionId: "mock-1", join: { mode: "mock" } };
      },
      async cancelSession() {},
    },
  };
}

const start = (db, provider) =>
  run(true, () =>
    startLiveInterview({ token: TOKEN }, { service: db.service, now: () => T0, provider }),
  );
const agree = (db) =>
  run(true, () =>
    agreeToLiveInterview({ token: TOKEN, agreed: true }, { service: db.service, now: () => T0 }),
  );

/* ── the link ─────────────────────────────────────────────────── */

test("link: a purged or past-retention session is refused, on every kind and switch position", async () => {
  for (const [name, over] of CLOSED) {
    for (const status of ["invited", "started"]) {
      const row = { ...over, status };
      assert.equal(await stateOf({ ...row, kind: "async" }, false), "cancelled", `${name}, async`);
      assert.equal(await stateOf(row, false), "cancelled", `${name}, live, screen off`);
      assert.equal(await stateOf(row, true), "cancelled", `${name}, live, screen on`);
    }
  }
});

test("link: a future or absent delete_after changes nothing, and never warns", async () => {
  for (const [name, over] of OPEN) {
    assert.equal(await stateOf({ ...over, kind: "async" }, false), "ready", `${name}, async`);
    assert.equal(await stateOf(over, false), "unavailable", `${name}, live, screen off`);
    assert.equal(await stateOf(over, true), "live", `${name}, live, screen on`);
    world(over);
    const { lines } = await run(true, () => resolveSessionByToken(TOKEN));
    assert.deepEqual(lines, [], name);
  }
});

test("link: a session already closed keeps the screen that says why, and does not warn", async () => {
  const past = { delete_after: iso(T0 - HOUR), purged_at: iso(T0 - HOUR) };
  const cases = [
    [{ status: "submitted", kind: "async" }, "submitted"],
    [{ status: "cancelled", kind: "async" }, "cancelled"],
    [{ status: "expired", kind: "async" }, "expired"],
    [{ status: "invited", kind: "async", expires_at: iso(T0 - HOUR) }, "expired"],
  ];
  for (const [over, expected] of cases) {
    world({ ...past, ...over });
    const { result, lines } = await run(false, () => resolveSessionByToken(TOKEN));
    assert.equal(result.session.state, expected, JSON.stringify(over));
    assert.deepEqual(lines, [], JSON.stringify(over));
  }
});

test("link: the warning carries the session id only, and the page data carries no retention field", async () => {
  world({ delete_after: "2020-01-01T00:00:00.000Z", kind: "async" });
  const { result, lines } = await run(false, () => resolveSessionByToken(TOKEN));
  assert.deepEqual(lines, [`[interview-session] session ${SESSION}: past retention, refused`]);
  assert.doesNotMatch(JSON.stringify(result.session), /2020-01-01|delete_after|purged_at/);
});

test("page: a half-failed deletion shows the closed screen; an old restarted link still says replaced", async () => {
  const html = async (over) => {
    world({ delete_after: iso(T0 - HOUR), ...over });
    const { result } = await run(true, async () =>
      renderToStaticMarkup(await InterviewPage({ params: Promise.resolve({ token: TOKEN }) })),
    );
    return result;
  };
  const closed = await html({ status: "invited" });
  assert.match(closed, /This link is no longer active/);
  assert.doesNotMatch(closed, /data-flow=/);
  assert.match(await html({ status: "abandoned" }), /This link was replaced/);
});

test("link: an async candidate route refuses it, and nothing is written", async () => {
  const db = world({ kind: "async", consent_at: null, delete_after: iso(T0 - HOUR) });
  const { result: res } = await run(false, () =>
    consentPost(
      new Request("http://test.local/api/interview/consent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: TOKEN }),
      }),
    ),
  );
  assert.equal(res.status, 409);
  assert.equal(db.tables.interview_sessions[0].consent_at, null);
});

/* ── start ────────────────────────────────────────────────────── */

test("start: refused before the provider is called, and nothing is written", async () => {
  for (const [name, over] of CLOSED) {
    const db = world(over);
    const before = structuredClone(db.tables.interview_sessions[0]);
    const p = recordingProvider();
    const { result, lines } = await start(db, p.provider);
    assert.deepEqual(result.status, 409, name);
    assert.equal(result.body.code, "not_open", name);
    assert.equal(p.seen.length, 0, `${name}: the provider was never called`);
    assert.deepEqual(db.tables.interview_sessions[0], before, `${name}: nothing written`);
    assert.deepEqual(lines, [`[live-start] session ${SESSION}: past retention, refused`], name);
  }
});

test("start: delete_after exactly now is refused, one millisecond later is not", async () => {
  const refused = recordingProvider();
  await start(world({ delete_after: iso(T0) }), refused.provider);
  assert.equal(refused.seen.length, 0);
  const allowed = recordingProvider();
  const { result } = await start(world({ delete_after: iso(T0 + 1) }), allowed.provider);
  assert.equal(result.status, 200);
  assert.equal(allowed.seen.length, 1);
});

test("start: a future or absent delete_after starts as it always did", async () => {
  for (const [name, over] of OPEN) {
    const db = world(over);
    const p = recordingProvider();
    const { result } = await start(db, p.provider);
    assert.equal(result.status, 200, name);
    assert.equal(p.seen.length, 1, name);
    assert.equal(db.tables.interview_sessions[0].status, "started", name);
  }
});

/* ── consent ──────────────────────────────────────────────────── */

test("consent: refused, and nothing is saved", async () => {
  for (const [name, over] of CLOSED) {
    const db = world({ ...over, consent_at: null, consent_version: null });
    const { result, lines } = await agree(db);
    assert.equal(result.body.code, "not_open", name);
    assert.equal(db.tables.interview_sessions[0].consent_at, null, name);
    assert.deepEqual(lines, [`[live-start] session ${SESSION}: past retention, refused`], name);
  }
});

test("consent: a future or absent delete_after saves as it always did", async () => {
  for (const [name, over] of OPEN) {
    const db = world({ ...over, consent_at: null, consent_version: null });
    const { result } = await agree(db);
    assert.deepEqual(result, { status: 200, body: { ok: true } }, name);
    assert.equal(db.tables.interview_sessions[0].consent_version, "live-v1", name);
  }
});
