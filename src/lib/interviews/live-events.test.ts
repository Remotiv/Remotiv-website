/**
 * AVI commit 10: the candidate screen's reports (live_session_events,
 * migration 050) and exactly when a live interview's end (live_ended_at,
 * migration 044) is stamped. fake-live-db.mjs applies 044's set-once trigger
 * and 050's checks, with the database's clock under the test's control.
 *
 *   stamps        the provider's export saved; the backstop (time limit +
 *                 END_GRACE_MS since the start), on a report or from the
 *                 worker's sweep
 *   never stamps  any browser report (RB1, 28 Oct 2026): provider_end_reported,
 *                 end_pressed, tab_closed, connection_lost, provider_error,
 *                 timer_reached, conversation_started, video_saved
 *
 *   node --test src/lib/interviews/live-events.test.ts
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
  "@/lib/supabase/server": "export function createServiceClient() { throw new Error('test: pass a service'); }",
};
export async function resolve(specifier, context, next) {
  if (specifier in STUBS) return { url: "data:text/javascript," + encodeURIComponent(STUBS[specifier]), shortCircuit: true };
  return next(specifier, context);
}`)}`,
);

const { handleLiveEvent, stampOverdueLiveEnds, stampLiveEnded, liveEndDueAt, END_GRACE_MS } =
  await import("./live-events.ts");
const { LIVE_EVENT_KINDS, PROVIDER_END_DETAILS, providerEndDetail } = await import(
  "./live-event-codes.ts"
);
const { saveLiveExport } = await import("./live-ingest.ts");
const { parseExport } = await import("./live-provider/parse-export.ts");
const { createFakeLiveProvider } = await import("./live-provider/fake-provider.ts");
const { snapshotsFor } = await import("./frozen-questions.ts");
const { hashSessionToken } = await import("./tokens.ts");
const { fakeLiveDb } = await import("../../test-support/fake-live-db.mjs");

const CO = "7aad434d-0000-4000-8000-000000000010";
const SESSION = "5b0f2c1e-0000-4000-8000-000000000101";
const TOKEN = "live-events-test-token-0123456789abcdef";
const STARTED = Date.parse("2026-10-26T10:00:00.000Z");
const MIN = 60_000;

/** v1 settings: no question mix needed. A 10-minute limit. */
const SETTINGS = {
  v: 1,
  interviewer_name: "Maya",
  language: "en",
  max_follow_ups_per_base_question: 2,
  max_session_seconds: 600,
  follow_up_rules_version: "follow-up-v1",
  follow_up_rules: { when: "w", scope: "s", never: ["n"] },
};

function liveRow(over = {}) {
  return {
    id: SESSION,
    company_id: CO,
    kind: "live",
    status: "started",
    token_hash: hashSessionToken(TOKEN),
    started_at: new Date(STARTED).toISOString(),
    live_ended_at: null,
    provider: "mock",
    provider_session_id: "mock-1",
    live_settings: SETTINGS,
    ...over,
  };
}

/** A database whose clock the test moves. */
function world(over = {}) {
  const clock = { now: STARTED + MIN };
  const db = fakeLiveDb({ interview_sessions: [liveRow(over)] }, { now: () => clock.now });
  const report = (kind, detail) =>
    handleLiveEvent({ token: TOKEN, kind, detail }, { service: db.service, now: () => clock.now });
  const session = () => db.tables.interview_sessions[0];
  return { db, clock, report, session };
}

const quiet = async (fn) => {
  const log = console.log;
  const err = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
    console.error = err;
  }
};

/* ── what stamps, what never does ─────────────────────────────── */

test("RB1: a browser's provider_end_reported, with any detail, is recorded and never ends the interview", async () => {
  for (const detail of PROVIDER_END_DETAILS) {
    const w = world();
    w.clock.now = STARTED + 5 * MIN;
    const res = await quiet(() => w.report("provider_end_reported", detail));
    assert.deepEqual(res, { status: 200, body: { ok: true } }, detail);
    assert.equal(w.session().live_ended_at, null, `${detail}: no end stamped`);
    assert.deepEqual(
      w.db.tables.live_session_events.map((e) => [e.kind, e.detail, e.created_at]),
      [["provider_end_reported", detail, new Date(STARTED + 5 * MIN).toISOString()]],
    );
  }
  const w = world();
  await quiet(() => w.report("provider_end_reported", "completed"));
  assert.deepEqual(Object.keys(w.db.tables.live_session_events[0]).sort(), [
    "company_id",
    "created_at",
    "detail",
    "id",
    "kind",
    "session_id",
  ]);
});

test("RB1: no browser report of any kind ends the interview inside the time limit", async () => {
  const detailFor = (kind) =>
    kind === "provider_end_reported" ? "completed" : kind === "provider_error" ? "error" : null;
  assert.equal(LIVE_EVENT_KINDS.length, 8, "every kind is covered below");
  for (const kind of LIVE_EVENT_KINDS) {
    const w = world();
    w.clock.now = STARTED + 9 * MIN; // inside the limit: the backstop is not due
    const res = await quiet(() => w.report(kind, detailFor(kind)));
    assert.equal(res.status, 200, kind);
    assert.equal(w.session().live_ended_at, null, `${kind} must not end the interview`);
    assert.equal(w.db.tables.live_session_events.length, 1, kind);
  }
});

test("RB1: End pressed, then the provider's end as the browser reports it: still open, until the server confirms", async () => {
  const w = world();
  w.clock.now = STARTED + 3 * MIN;
  await quiet(() => w.report("end_pressed"));
  w.clock.now = STARTED + 3 * MIN + 2000;
  await quiet(() => w.report("provider_end_reported", providerEndDetail("candidate_left", false)));
  assert.equal(w.session().live_ended_at, null, "neither report ends it");
  assert.deepEqual(
    w.db.tables.live_session_events.map((e) => [e.kind, e.detail]),
    [
      ["end_pressed", null],
      ["provider_end_reported", "candidate_left"],
    ],
  );
  // The server's own end: here the backstop, with the database's clock.
  w.clock.now = STARTED + 10 * MIN + END_GRACE_MS;
  assert.equal(await quiet(() => stampLiveEnded(w.db.service, SESSION, () => w.clock.now)), true);
  assert.equal(w.session().live_ended_at, new Date(w.clock.now).toISOString());
});

test("an end already stamped is never moved: a later report records its row and keeps the end", async () => {
  const first = new Date(STARTED + 4 * MIN).toISOString();
  const w = world({ live_ended_at: first });
  w.clock.now = STARTED + 6 * MIN;
  const res = await quiet(() => w.report("provider_end_reported", "completed"));
  assert.equal(res.status, 200);
  assert.equal(w.session().live_ended_at, first);
  assert.equal(w.db.tables.live_session_events.length, 1);
  // stampLiveEnded on a stamped row is a no-op, not 044's error.
  assert.equal(await quiet(() => stampLiveEnded(w.db.service, SESSION, () => w.clock.now)), false);
  assert.equal(w.session().live_ended_at, first);
});

/* ── the backstop ─────────────────────────────────────────────── */

test("backstop: the session's own limit plus the grace; due exactly then, not a moment before", () => {
  const due = liveEndDueAt(liveRow());
  assert.equal(due, STARTED + 10 * MIN + END_GRACE_MS);
  assert.equal(END_GRACE_MS, 10 * MIN);
  assert.equal(liveEndDueAt(liveRow({ started_at: null })), null, "never started: never due");
  // Unreadable settings: the global 30-minute ceiling.
  assert.equal(
    quietSync(() => liveEndDueAt(liveRow({ live_settings: {} }))),
    STARTED + 30 * MIN + END_GRACE_MS,
  );
});

function quietSync(fn) {
  const err = console.error;
  console.error = () => {};
  try {
    return fn();
  } finally {
    console.error = err;
  }
}

test("backstop on a report: a closed tab after the limit plus grace ends it; the same report a minute earlier does not", async () => {
  const early = world();
  early.clock.now = STARTED + 10 * MIN + END_GRACE_MS - MIN;
  await quiet(() => early.report("tab_closed"));
  assert.equal(early.session().live_ended_at, null);

  const late = world();
  late.clock.now = STARTED + 10 * MIN + END_GRACE_MS;
  await quiet(() => late.report("tab_closed"));
  assert.equal(late.session().live_ended_at, new Date(late.clock.now).toISOString());
  assert.deepEqual(
    late.db.tables.live_session_events.map((e) => e.kind),
    ["tab_closed"],
    "still recorded as what it was",
  );
});

test("backstop sweep (worker tick): only started live interviews past their own limit plus grace, each once", async () => {
  const clock = { now: STARTED + 10 * MIN + END_GRACE_MS + 1 };
  const row = (id, over) => liveRow({ id, token_hash: `h-${id}`, ...over });
  const db = fakeLiveDb(
    {
      interview_sessions: [
        row("5b0f2c1e-0000-4000-8000-000000000201", {}), // due
        row("5b0f2c1e-0000-4000-8000-000000000202", {
          started_at: new Date(STARTED + 5 * MIN).toISOString(),
        }), // not yet
        row("5b0f2c1e-0000-4000-8000-000000000203", {
          provider_session_id: null,
          provider: null,
          started_at: null,
        }), // never started
        row("5b0f2c1e-0000-4000-8000-000000000204", {
          live_settings: { ...SETTINGS, max_session_seconds: 1800 },
        }), // a longer limit
        row("5b0f2c1e-0000-4000-8000-000000000205", {
          live_ended_at: new Date(STARTED + MIN).toISOString(),
        }), // already ended
      ],
    },
    { now: () => clock.now },
  );
  const ended = (id) => db.tables.interview_sessions.find((s) => s.id === id).live_ended_at;
  assert.equal(await quiet(() => stampOverdueLiveEnds(db.service, () => clock.now)), 1);
  assert.equal(ended("5b0f2c1e-0000-4000-8000-000000000201"), new Date(clock.now).toISOString());
  assert.equal(ended("5b0f2c1e-0000-4000-8000-000000000202"), null);
  assert.equal(ended("5b0f2c1e-0000-4000-8000-000000000203"), null);
  assert.equal(ended("5b0f2c1e-0000-4000-8000-000000000204"), null);
  assert.equal(
    ended("5b0f2c1e-0000-4000-8000-000000000205"),
    new Date(STARTED + MIN).toISOString(),
  );
  // Again: nothing more to do.
  assert.equal(await quiet(() => stampOverdueLiveEnds(db.service, () => clock.now)), 0);
});

test("the worker tick runs the sweep, non-fatally, before claiming jobs", () => {
  const src = readFileSync(new URL("../../app/api/jobs/worker/route.ts", import.meta.url), "utf8");
  const sweep = src.indexOf("await stampOverdueLiveEnds(createServiceClient())");
  assert.ok(sweep > 0, "the sweep is called");
  assert.ok(sweep < src.indexOf("await claimJobs("), "before claiming");
  assert.match(src.slice(sweep - 200, sweep + 200), /try \{[\s\S]*\} catch \(err\) \{/);
});

/* ── refusals ─────────────────────────────────────────────────── */

test("refused: an unknown kind or detail (the old provider_complete name included), a bad token, an async session, a live session that never started", async () => {
  const w = world();
  const run = (body) =>
    quiet(() => handleLiveEvent(body, { service: w.db.service, now: () => w.clock.now }));
  assert.equal((await run({ token: TOKEN, kind: "completed" })).body.code, "bad_event");
  assert.equal(
    (await run({ token: TOKEN, kind: "provider_end_reported", detail: "done" })).body.code,
    "bad_event",
  );
  assert.equal(
    (await run({ token: TOKEN, kind: "provider_complete", detail: "completed" })).body.code,
    "bad_event",
    "the old name is no longer a code",
  );
  assert.equal(
    (await run({ token: TOKEN, kind: "tab_closed", detail: "x" })).body.code,
    "bad_event",
  );
  assert.equal((await run({ token: "x".repeat(40), kind: "tab_closed" })).status, 404);
  assert.equal(w.db.tables.live_session_events.length, 0);

  const notStarted = world({ provider_session_id: null, provider: null, started_at: null });
  const res = await quiet(() => notStarted.report("tab_closed"));
  assert.deepEqual([res.status, res.body.code], [409, "not_started"]);

  const asyncSession = world({
    kind: "async",
    provider: null,
    provider_session_id: null,
    live_settings: null,
  });
  assert.equal((await quiet(() => asyncSession.report("tab_closed"))).status, 404);
});

test("not recorded (050 not applied, or a failed write): 502, and nothing is stamped either", async () => {
  const w = world();
  w.db.failNext("live_session_events", "insert");
  const res = await quiet(() => w.report("provider_end_reported", "completed"));
  assert.deepEqual([res.status, res.body.code], [502, "not_recorded"]);
  assert.equal(w.session().live_ended_at, null);
});

test("the provider's end_reason as a code: completed needs graceful too (F15), anything unknown is other", () => {
  assert.equal(providerEndDetail("completed", true), "completed");
  assert.equal(providerEndDetail("completed", false), "completed_not_graceful");
  assert.equal(providerEndDetail("completed", null), "completed_not_graceful");
  assert.equal(providerEndDetail("candidate_left", false), "candidate_left");
  assert.equal(providerEndDetail("timed_out", false), "timed_out");
  assert.equal(providerEndDetail("Something new", true), "other");
  assert.equal(providerEndDetail(null, null), "other");
});

/* ── the export arriving ──────────────────────────────────────── */

test("the provider's export saved stamps the end once (even after a forged end report); a second save leaves it", async () => {
  const sample = JSON.parse(
    readFileSync(
      new URL("./live-provider/__fixtures__/sample-export-interruption.json", import.meta.url),
      "utf8",
    ),
  );
  const questions = sample.questions.slice(0, 8).map((q, i) => ({
    question_id: `q-${i + 1}`,
    position: i + 1,
    text: q.text,
    source: "job",
    competency: "Ownership",
    scoring_guide: "Strong answer: specific. Weak answer: general.",
    weight: null,
  }));
  const row = liveRow({
    attempt: 1,
    provider_session_id: sample.session_id,
    live_outcome: null,
    live_settings: {
      ...SETTINGS,
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
    },
    ...snapshotsFor(questions),
  });
  const clock = { now: STARTED + 7 * MIN };
  const db = fakeLiveDb({ interview_sessions: [row] }, { now: () => clock.now });
  const provider = createFakeLiveProvider(sample, {});
  const { providerSessionId } = await provider.createSession({
    remotiv_session_id: SESSION,
    interviewer_name: "Maya",
    interview_minutes: 10,
    questions: [{ position: 1, text: "Q" }],
    candidate_first_name: "Alex",
    cv_text: "",
  });
  const parsed = {
    ...parseExport(provider.exportOf(providerSessionId)),
    provider_session_id: sample.session_id,
  };
  const save = () =>
    quiet(() =>
      saveLiveExport(SESSION, parsed, {
        service: db.service,
        fetchAudio: (name) => provider.fetchAudio(providerSessionId, name),
        now: () => clock.now,
      }),
    );
  // RB1: a forged "it ended" report first changes nothing, and does not get in the export's way.
  clock.now = STARTED + 2 * MIN;
  const forged = await quiet(() =>
    handleLiveEvent(
      { token: TOKEN, kind: "provider_end_reported", detail: "completed" },
      { service: db.service, now: () => clock.now },
    ),
  );
  assert.equal(forged.status, 200);
  assert.equal(db.tables.interview_sessions[0].live_ended_at, null);
  clock.now = STARTED + 7 * MIN;
  const first = await save();
  assert.equal(first.saved, true);
  assert.equal(
    db.tables.interview_sessions[0].live_ended_at,
    new Date(STARTED + 7 * MIN).toISOString(),
  );
  clock.now = STARTED + 9 * MIN;
  const again = await save();
  assert.equal(again.saved, false);
  assert.equal(
    db.tables.interview_sessions[0].live_ended_at,
    new Date(STARTED + 7 * MIN).toISOString(),
  );
  // The outcome is the export's: the end stamp changes nothing in it (D2/D10).
  assert.equal(first.outcome.outcome, "ending_unconfirmed");
});
