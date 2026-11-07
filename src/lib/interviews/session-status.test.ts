/**
 * resolveSessionByToken fails closed on a status it does not know: the
 * interview is refused, whatever the session's kind, deadline or progress and
 * whether or not the live screen is on. The six real statuses keep their states.
 *
 *   node --test src/lib/interviews/session-status.test.ts
 *
 * resolveSessionByToken, the candidate page and the consent route are the
 * shipped code. The database is fake-live-db.mjs. Synthetic data only.
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
  "next/server": "export const NextResponse = { json: (b, i) => Response.json(b, i) };",
  "../interview.css": "",
  "../live-interview.css": "",
  "./_flow": flow("InterviewFlow"),
  "./_live/live-flow": flow("LiveInterviewFlow"),
  "@/lib/supabase/server": "export const createServiceClient = () => globalThis.__service;",
  "@/lib/interviews/live-consent": "export function liveConsentScreen() { return null; } export const LIVE_INTERVIEW_CONSENT_VERSION = 'live-v1';",
  "@/app/api/_lib/rate-limit": "export function rateLimitByKey() { return { ok: true }; }",
};
export async function resolve(specifier, context, next) {
  if (specifier in STUBS) return { url: "data:text/javascript," + encodeURIComponent(STUBS[specifier]), shortCircuit: true };
  return next(specifier, context);
}`)}`,
);

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
globalThis.__h = createElement;
const { resolveSessionByToken } = await import("./session.ts");
const { hashSessionToken } = await import("./tokens.ts");
const { default: InterviewPage } = await import("../../app/interview/[token]/page.tsx");
const { POST: consentPost } = await import("../../app/api/interview/consent/route.ts");
const { fakeLiveDb } = await import("../../test-support/fake-live-db.mjs");

const NOW = Date.now();
const HOUR = 3_600_000;
const iso = (ms) => new Date(ms).toISOString();
const CO = "c0000000-0000-4000-8000-0000000000e1";
const JOB = "b0000000-0000-4000-8000-0000000000e1";
const SESSION = "d0000000-0000-4000-8000-0000000000e1";
const TOKEN = "status-synthetic-token-0123456789abcdef";
const UNKNOWN = ["paused", "", "READY", "Invited", " invited"];

function world(over = {}) {
  const db = fakeLiveDb({
    interview_sessions: [
      {
        id: SESSION,
        company_id: CO,
        application_id: null,
        job_id: JOB,
        kind: "async",
        status: "invited",
        token_hash: hashSessionToken(TOKEN),
        allow_rerecord: false,
        consent_at: null,
        consent_version: null,
        submitted_at: null,
        started_at: null,
        expires_at: iso(NOW + HOUR),
        questions_snapshot: [
          {
            id: "q1",
            position: 1,
            question: "Q",
            prep_seconds: 10,
            answer_seconds: 60,
            required: true,
          },
        ],
        live_ended_at: null,
        provider: null,
        provider_session_id: null,
        ...over,
      },
    ],
    companies: [{ id: CO, name: "Acme Ltd" }],
    jobs: [{ id: JOB, company_id: CO, title: "Test role", allow_rerecord: false }],
    interview_answers: [],
  });
  globalThis.__service = db.service;
  return db;
}

async function withScreen(on, fn) {
  const before = process.env.LIVE_INTERVIEW_SCREEN_ENABLED;
  if (on) process.env.LIVE_INTERVIEW_SCREEN_ENABLED = "1";
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
  const { result } = await withScreen(screen, () => resolveSessionByToken(TOKEN));
  return result.session.state;
};

test("an unknown status is refused, for every kind, deadline, progress and switch position", async () => {
  for (const status of UNKNOWN) {
    for (const kind of ["async", "live"]) {
      for (const screen of [false, true]) {
        for (const expires_at of [iso(NOW + HOUR), iso(NOW - HOUR)]) {
          for (const provider_session_id of [null, "provider-1"]) {
            const over = { status, kind, expires_at, provider_session_id };
            assert.equal(
              await stateOf(over, screen),
              "unavailable",
              JSON.stringify({ ...over, screen }),
            );
          }
        }
      }
    }
  }
});

test("the candidate page shows the existing closed screen and neither flow", async () => {
  for (const kind of ["async", "live"]) {
    world({ status: "paused", kind });
    const { result: html } = await withScreen(true, async () =>
      renderToStaticMarkup(await InterviewPage({ params: Promise.resolve({ token: TOKEN }) })),
    );
    assert.match(html, /isn&#x27;t open yet/, kind);
    assert.doesNotMatch(html, /data-flow=/, `${kind}: no recorder and no live screen`);
  }
});

test("a candidate route refuses it, and nothing is written", async () => {
  const db = world({ status: "paused" });
  const { result: res } = await withScreen(false, () =>
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

test("the warning carries the session id only: no token, no hash, no stored text", async () => {
  world({ status: "paused-RAW-STATUS-TEXT" });
  const { lines } = await withScreen(false, () => resolveSessionByToken(TOKEN));
  assert.deepEqual(lines, [`[interview-session] session ${SESSION}: unrecognised status, refused`]);
});

test("the six real statuses keep their states, and never warn", async () => {
  // [status, async, live with the screen off, live with the screen on], not yet started.
  const open = [
    ["invited", "ready", "unavailable", "live"],
    ["started", "ready", "unavailable", "live"],
    ["submitted", "submitted", "unavailable", "ended"],
    ["expired", "expired", "expired", "expired"],
    ["cancelled", "cancelled", "cancelled", "cancelled"],
    ["abandoned", null, "unavailable", "ended"],
  ];
  const past = [
    ["invited", "expired", "expired", "expired"],
    ["started", "expired", "expired", "expired"],
    ["submitted", "submitted", "unavailable", "ended"],
    ["expired", "expired", "expired", "expired"],
    ["cancelled", "cancelled", "cancelled", "cancelled"],
    ["abandoned", null, "expired", "expired"],
  ];
  for (const [table, expires_at] of [
    [open, iso(NOW + HOUR)],
    [past, iso(NOW - HOUR)],
  ]) {
    for (const [status, asyncState, liveOff, liveOn] of table) {
      const name = `${status}, ${expires_at}`;
      // Migration 020 forbids an abandoned async session, so null skips it.
      if (asyncState) assert.equal(await stateOf({ status, expires_at }, false), asyncState, name);
      const live = { status, expires_at, kind: "live" };
      assert.equal(await stateOf(live, false), liveOff, `${name}, screen off`);
      assert.equal(await stateOf(live, true), liveOn, `${name}, screen on`);

      world(live);
      const { lines } = await withScreen(true, () => resolveSessionByToken(TOKEN));
      assert.deepEqual(lines, [], `${name}: no warning`);
    }
  }
});
