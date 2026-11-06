/**
 * After a restart, attempt 1's old link (C6 audit items 7 and 8): the candidate
 * sees "This link was replaced" and learns nothing about attempt 2; expiry and
 * the reminder never act on an abandoned session; the live event route refuses
 * it and stores nothing. Ended, expired, cancelled and invalid links, and
 * attempt 2's own link, are unchanged.
 *
 *   node --test src/lib/interviews/restart-old-link.test.ts
 *
 * The candidate page (rendered from its own async component), resolveSessionByToken,
 * TerminalScreen, the event route, handleInterviewExpiry and handleInterviewReminder
 * are the shipped code. The database is fake-live-db.mjs; the two client flows, the
 * stylesheets, the email path and the queue are stubbed below. Synthetic data only.
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
  "@/lib/notifications/company": "export async function notifyCompany(n) { globalThis.__notes.push(n); }",
  "@/lib/jobs-queue": "export const JOB_TYPES = { INTERVIEW_EXPIRY: 'interview_expiry' }; export async function enqueue() { return { ok: true }; }",
  "@/lib/email/candidate/deliver": "export function buildCandidateHtml(b) { return b; } export async function deliverEmail(s, i) { globalThis.__emails.push(i); return { ok: true, logId: 'l', providerId: 'p' }; }",
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
const { default: InterviewPage } = await import("../../app/interview/[token]/page.tsx");
const { POST } = await import("../../app/api/interview/live/event/route.ts");
const { handleInterviewExpiry } = await import("./expiry.ts");
const { handleInterviewReminder } = await import("./reminder.ts");
const { hashSessionToken } = await import("./tokens.ts");
const { fakeLiveDb } = await import("../../test-support/fake-live-db.mjs");

const NOW = Date.now();
const HOUR = 3_600_000;
const iso = (ms) => new Date(ms).toISOString();
const CO = "c0000000-0000-4000-8000-0000000000d1";
const JOB = "b0000000-0000-4000-8000-0000000000d1";
const FIRST = "d0000000-0000-4000-8000-0000000000d1";
const SECOND = "d0000000-0000-4000-8000-0000000000d2";
const OLD_TOKEN = "old-link-synthetic-token-0123456789abcdef";
const NEW_TOKEN = "new-link-synthetic-token-0123456789abcdef";
// Attempt 2's deadline: a date nothing else in the page could print.
const SECOND_DEADLINE = "2031-03-17T09:41:00.000Z";
const REPLACED_TITLE = "This link was replaced";
const REPLACED_BODY =
  "Please use the link in your most recent interview email. If you haven't received one, contact the company that invited you.";

const live = (over = {}) => ({
  id: FIRST,
  company_id: CO,
  application_id: null,
  job_id: JOB,
  kind: "live",
  attempt: 1,
  previous_attempt_id: null,
  status: "invited",
  token_hash: hashSessionToken(OLD_TOKEN),
  allow_rerecord: false,
  consent_at: null,
  consent_version: null,
  submitted_at: null,
  started_at: null,
  expires_at: iso(NOW + 24 * HOUR),
  questions_snapshot: [{ position: 1 }],
  live_ended_at: null,
  provider: null,
  provider_session_id: null,
  live_settings: { v: 1, interviewer_name: "Maya", max_session_seconds: 600 },
  ...over,
});
const called = {
  started_at: iso(NOW - 48 * HOUR),
  provider: "mock",
  provider_session_id: "provider-1",
};
const firstAbandoned = (over = {}) =>
  live({
    ...called,
    status: "abandoned",
    live_ended_at: iso(NOW - 47 * HOUR),
    live_outcome: { outcome: "technical_failure", final: true },
    ...over,
  });
const secondInvited = (over = {}) =>
  live({
    id: SECOND,
    attempt: 2,
    previous_attempt_id: FIRST,
    token_hash: hashSessionToken(NEW_TOKEN),
    expires_at: SECOND_DEADLINE,
    ...over,
  });

function world(sessions) {
  const db = fakeLiveDb({
    interview_sessions: sessions,
    companies: [{ id: CO, name: "Acme Ltd" }],
    jobs: [{ id: JOB, company_id: CO, title: "Test role", allow_rerecord: false }],
  });
  globalThis.__service = db.service;
  globalThis.__notes = [];
  globalThis.__emails = [];
  return db;
}

async function captured(fn) {
  const lines = [];
  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = (...a) => lines.push(a.join(" "));
  try {
    return { result: await fn(), lines };
  } finally {
    Object.assign(console, saved);
  }
}

async function page(token, screen = true) {
  const before = process.env.LIVE_INTERVIEW_SCREEN_ENABLED;
  if (screen) process.env.LIVE_INTERVIEW_SCREEN_ENABLED = "1";
  else delete process.env.LIVE_INTERVIEW_SCREEN_ENABLED;
  try {
    const element = await InterviewPage({ params: Promise.resolve({ token }) });
    return renderToStaticMarkup(element).replaceAll("&#x27;", "'");
  } finally {
    if (before === undefined) delete process.env.LIVE_INTERVIEW_SCREEN_ENABLED;
    else process.env.LIVE_INTERVIEW_SCREEN_ENABLED = before;
  }
}

test("the old link after a restart: the replaced screen, in the approved words", async () => {
  for (const [name, first, screen] of [
    ["inside its own deadline", firstAbandoned(), true],
    ["past its own deadline", firstAbandoned({ expires_at: iso(NOW - HOUR) }), true],
    ["with the live screen switched off", firstAbandoned(), false],
    ["past its deadline, switched off", firstAbandoned({ expires_at: iso(NOW - HOUR) }), false],
  ]) {
    world([first, secondInvited()]);
    const html = await page(OLD_TOKEN, screen);
    assert.match(html, /data-terminal="replaced"/, name);
    assert.ok(html.includes(REPLACED_TITLE), name);
    assert.ok(html.includes(REPLACED_BODY), name);
    assert.doesNotMatch(html, /has ended|data-terminal="ended"|data-flow/, name);
    assert.doesNotMatch(html, /[–—]/, name);
  }
});

test("the old link reveals nothing about attempt 2, and never reads it", async () => {
  const db = world([firstAbandoned(), secondInvited()]);
  const html = await page(OLD_TOKEN);
  for (const secret of [SECOND, NEW_TOKEN, hashSessionToken(NEW_TOKEN), SECOND_DEADLINE, "2031"]) {
    assert.ok(!html.includes(secret), secret);
  }
  assert.doesNotMatch(html, /href=|deadline|expires|hours/i, "no link and no deadline");
  const reads = db.service.queries.filter((q) => q.table === "interview_sessions");
  assert.equal(reads.length, 1, "the one read, by this link's own token");
  assert.deepEqual(
    reads[0].calls.filter((c) => c[0] === "eq"),
    [["eq", "token_hash", hashSessionToken(OLD_TOKEN)]],
  );
});

test("ended, expired, cancelled and invalid links are unchanged", async () => {
  const cases = [
    [
      "ended, never restarted",
      live({ ...called, status: "started", live_ended_at: iso(NOW - HOUR) }),
      /data-terminal="ended"/,
    ],
    ["started, still in the call", live({ ...called, status: "started" }), /data-terminal="ended"/],
    ["expired", live({ status: "expired", expires_at: iso(NOW - HOUR) }), /This link has expired/],
    ["past its deadline", live({ expires_at: iso(NOW - HOUR) }), /This link has expired/],
    ["cancelled", live({ status: "cancelled" }), /This link is no longer active/],
  ];
  for (const [name, row, expected] of cases) {
    world([row]);
    const html = await page(OLD_TOKEN);
    assert.match(html, expected, name);
    assert.ok(!html.includes(REPLACED_TITLE), `${name}: not the replaced screen`);
  }
  world([]);
  assert.ok(!(await page(OLD_TOKEN)).includes(REPLACED_TITLE), "an unknown link");
});

test("attempt 2's own link works normally", async () => {
  world([firstAbandoned(), secondInvited()]);
  assert.match(await page(NEW_TOKEN), /data-flow="LiveInterviewFlow"/);
  world([
    firstAbandoned(),
    secondInvited({ ...called, status: "started", live_ended_at: iso(NOW - HOUR) }),
  ]);
  assert.match(await page(NEW_TOKEN), /data-terminal="ended"/, "and it ends like any other");
});

// ── expiry and the reminder never act on it ─────────────────

/**
 * Past its deadline, with no call fields: only the status can keep the handlers
 * off this row (a real one has also ended, which expiry's call check would catch).
 */
const bareAbandoned = (expiresAt) =>
  live({ status: "abandoned", kind: "async", expires_at: expiresAt, live_settings: null });
const writesTo = (db) =>
  db.service.queries.filter((q) =>
    q.calls.some((c) => ["insert", "update", "upsert", "delete"].includes(c[0])),
  );

test("expiry never acts on an abandoned session: settled, no write, no notice", async () => {
  const db = world([bareAbandoned(iso(NOW - HOUR))]);
  const { lines } = await captured(() =>
    handleInterviewExpiry({ id: "job-1", payload: { sessionId: FIRST } }),
  );
  assert.ok(
    lines.some((l) => l.includes("is already abandoned")),
    lines.join(" | "),
  );
  assert.deepEqual(writesTo(db), [], "nothing written");
  assert.deepEqual(globalThis.__notes, [], "nobody notified");
  assert.equal(db.tables.interview_sessions[0].status, "abandoned");
});

test("the reminder never acts on an abandoned session: finished, no email", async () => {
  // Inside the window, so nothing but the status stops it.
  const db = world([bareAbandoned(iso(NOW + 48 * HOUR))]);
  const { lines } = await captured(() =>
    handleInterviewReminder({ id: "job-2", payload: { sessionId: FIRST } }),
  );
  assert.ok(
    lines.some((l) => l.includes("is abandoned")),
    lines.join(" | "),
  );
  assert.deepEqual(globalThis.__emails, [], "no email");
  assert.deepEqual(writesTo(db), [], "nothing written");
  assert.equal(
    db.service.queries.filter((q) => q.table !== "interview_sessions").length,
    0,
    "stopped at the session read",
  );
});

// ── the live event route ────────────────────────────────────

const post = (token, kind = "tab_closed") =>
  captured(async () => {
    const res = await POST(
      new Request("http://localhost/api/interview/live/event", {
        method: "POST",
        body: JSON.stringify({ token, kind }),
      }),
    );
    return { status: res.status, body: await res.json() };
  });

test("a live event on an abandoned session is refused and nothing is stored", async () => {
  for (const [name, first] of [
    ["ended", firstAbandoned()],
    // Overdue with no end: the handler's backstop would stamp this one.
    ["overdue, no end", firstAbandoned({ live_ended_at: null })],
  ]) {
    const db = world([first, secondInvited()]);
    const { result, lines } = await post(OLD_TOKEN);
    assert.deepEqual(
      result,
      { status: 409, body: { code: "link_replaced", error: "This link was replaced." } },
      name,
    );
    assert.deepEqual(db.tables.live_session_events, [], `${name}: nothing stored`);
    assert.equal(db.tables.interview_sessions[0].live_ended_at, first.live_ended_at, name);
    assert.deepEqual(writesTo(db), [], `${name}: nothing written`);
    const text = JSON.stringify(result) + lines.join(" ");
    for (const secret of [SECOND, OLD_TOKEN, SECOND_DEADLINE]) assert.ok(!text.includes(secret));
  }
});

test("a live event on any other session is handled as before", async () => {
  const restart = world([firstAbandoned(), secondInvited({ ...called, status: "started" })]);
  const ok = await post(NEW_TOKEN);
  assert.deepEqual(ok.result, { status: 200, body: { ok: true } }, "attempt 2");
  assert.deepEqual(
    restart.tables.live_session_events.map((e) => [e.session_id, e.kind]),
    [[SECOND, "tab_closed"]],
  );
  world([live({ ...called, status: "started" })]);
  assert.equal((await post(OLD_TOKEN)).result.status, 200, "a call never restarted");
  world([live()]);
  assert.equal((await post(OLD_TOKEN)).result.body.code, "not_started");
  world([]);
  assert.equal((await post(OLD_TOKEN)).result.body.code, "not_found");
  assert.equal((await post("short")).result.body.code, "not_found", "a malformed token");
  world([live({ ...called, status: "started" })]);
  assert.equal((await post(OLD_TOKEN, "not_a_kind")).result.body.code, "bad_event");
});

test("if the status cannot be read, nothing is stored and the screen may retry", async () => {
  const db = world([firstAbandoned()]);
  db.failNext("interview_sessions", "select");
  const { result, lines } = await post(OLD_TOKEN);
  assert.equal(result.status, 502);
  assert.equal(result.body.code, "not_recorded");
  assert.deepEqual(db.tables.live_session_events, []);
  assert.ok(!`${JSON.stringify(result)}${lines.join(" ")}`.includes("fault"), "no database text");
});
