/**
 * #25: ten AI Video Interviews at once, and the eleventh refused cleanly.
 *
 *   node --test src/lib/interviews/live-capacity.test.ts
 *
 * Remotiv has no cap of its own: capacity is the provider's, which answers
 * ProviderBusyError and the start turns that into 503 busy. So the cap here is
 * a TEST-ONLY provider wrapping the real mock (createMockJoinProvider): it
 * counts open sessions and refuses past CAP. startLiveInterview and the
 * question freeze are the shipped code; the database is fake-live-db.mjs. The
 * model is never needed (every question has a rubric) and throws if called.
 * "Run" here means started: the ticket handed out and the row claimed. Ten
 * whole conversations with audio and video is the browser run in
 * docs/LIVE-LOAD-FAIRNESS-PLAN.md. Synthetic data only.
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

const { startLiveInterview, FREEZE_FAILED_KEY, TRY_AGAIN_SHORTLY } = await import(
  "./live-start.ts"
);
const { createMockJoinProvider, ProviderBusyError } = await import("./live-provider/join.ts");
const { hasFrozenMarker, readFrozenQuestionSet } = await import("./frozen-questions.ts");
const { hashSessionToken } = await import("./tokens.ts");
const { jobQuestionMix } = await import("./question-mix.ts");
const { fakeLiveDb } = await import("../../test-support/fake-live-db.mjs");

/** The provider's capacity in this test, and one candidate more than it. */
const CAP = 10;
const CANDIDATES = CAP + 1;

const CO = "7aad434d-0000-4000-8000-000000000025";
const JOB = "2d4a8cde-0000-4000-8000-000000000025";
const T0 = Date.now();
const pad = (n) => String(n).padStart(12, "0");
const sessionId = (n) => `5b0f2c1e-0000-4000-8000-${pad(n)}`;
const appId = (n) => `9c1d2e3f-0000-4000-8000-${pad(n)}`;
const tokenOf = (n) => `live-capacity-token-${pad(n)}-0123456789abcdef`;

const QUESTIONS = [
  "Tell me about a support queue you brought under control.",
  "Tell me about a hard customer conversation you led.",
  "Tell me about a process you changed for the team.",
  "Tell me about a metric you moved and how.",
];

/** A live session exactly as the invite left it: consent saved, its questions not yet frozen for live. */
function invited(n) {
  return {
    id: sessionId(n),
    company_id: CO,
    application_id: appId(n),
    job_id: JOB,
    kind: "live",
    status: "invited",
    attempt: 1,
    previous_attempt_id: null,
    token_hash: hashSessionToken(tokenOf(n)),
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
    live_settings: {
      v: 4,
      interviewer_name: "Sarah",
      language: "en",
      interview_mode: "structured",
      max_follow_ups_per_base_question: 0,
      max_session_seconds: 1800,
      follow_up_rules_version: "follow-up-v1",
      follow_up_rules: { when: "Thin.", scope: "Stay on it.", never: ["Reveal the answer."] },
      question_mix: jobQuestionMix(QUESTIONS.length, 30),
    },
    questions_snapshot: QUESTIONS.map((question, i) => ({
      id: `jq-${i + 1}`,
      position: i + 1,
      question,
      prep_seconds: 30,
      answer_seconds: 120,
      required: true,
    })),
    scoring_snapshot: QUESTIONS.map((_, i) => ({
      position: i + 1,
      question_id: `jq-${i + 1}`,
      competency: "Ownership",
      rubric: `RUBRIC ${i + 1}`,
      weight: 2,
    })),
  };
}

function world(count) {
  const ns = Array.from({ length: count }, (_, i) => i + 1);
  return fakeLiveDb({
    interview_sessions: ns.map(invited),
    job_applications: ns.map((n) => ({
      id: appId(n),
      job_id: JOB,
      company_id_snapshot: CO,
      first_name: `Candidate${n}`,
      last_name: "Example",
      deletion_started_at: null,
      cv_text: "Synthetic CV.",
    })),
    jobs: [{ id: JOB, company_id: CO, title: "Support Lead" }],
    job_question_scoring_guides: [],
  });
}

/**
 * The real mock behind a cap: `cap` sessions may be open at once; one more is
 * refused as the provider refuses it, ProviderBusyError(30). A slot is freed
 * when a session is cancelled or ends. The check and the count are one step
 * (no await between them), so two starts can never share the last slot.
 */
function cappedProvider(cap) {
  const mock = createMockJoinProvider("completed");
  const open = new Set();
  const created = [];
  const cancelled = [];
  const refused = [];
  return {
    open,
    created,
    cancelled,
    refused,
    /** The interview finished on the provider's side: its slot is free again. */
    end: (providerSessionId) => open.delete(providerSessionId),
    provider: {
      name: mock.name,
      async createSession(input) {
        const made = await mock.createSession(input);
        if (open.size >= cap) {
          refused.push(input.remotiv_session_id);
          throw new ProviderBusyError(30);
        }
        open.add(made.providerSessionId);
        created.push({ sessionId: input.remotiv_session_id, ...made });
        return made;
      },
      async cancelSession(providerSessionId) {
        cancelled.push(providerSessionId);
        open.delete(providerSessionId);
        await mock.cancelSession(providerSessionId);
      },
      rejoinSession: (id, maxFollowUps) => mock.rejoinSession(id, maxFollowUps),
    },
  };
}

/** A model client that counts and refuses: every question has a rubric, so it is never needed. */
function noModel() {
  const client = {
    calls: 0,
    messages: {
      create() {
        client.calls += 1;
        throw new Error("test: the model was called");
      },
    },
  };
  return client;
}

const ENV = { LIVE_INTERVIEW_SCREEN_ENABLED: "1", AI_VIDEO_INTERVIEW_COMPANY_IDS: CO };

async function run(fn) {
  const before = {};
  for (const [k, v] of Object.entries(ENV)) {
    before[k] = process.env[k];
    process.env[k] = v;
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
const start = (db, capped, model, n) =>
  startLiveInterview(
    { token: tokenOf(n) },
    {
      service: db.service,
      now: () => T0,
      mode: "mock",
      provider: capped.provider,
      questionsClient: model,
      newId: () => `00000000-0000-4000-8000-${pad(++ids)}`,
    },
  );

const rowOf = (db, n) => db.tables.interview_sessions.find((r) => r.id === sessionId(n));

/** Everything a started call writes, for one session: none of it may exist for a refused one. */
function tracesOf(db, n) {
  const id = sessionId(n);
  return {
    interview_turns: db.tables.interview_turns.filter((r) => r.session_id === id).length,
    live_video_pieces: db.tables.live_video_pieces.filter((r) => r.session_id === id).length,
    live_session_events: db.tables.live_session_events.filter((r) => r.session_id === id).length,
    live_interview_scores: db.tables.live_interview_scores.filter((r) => r.session_id === id)
      .length,
    background_jobs: db.tables.background_jobs.filter((r) =>
      JSON.stringify(r.payload ?? {}).includes(id),
    ).length,
  };
}
const NO_TRACES = {
  interview_turns: 0,
  live_video_pieces: 0,
  live_session_events: 0,
  live_interview_scores: 0,
  background_jobs: 0,
};

const BUSY = {
  status: 503,
  body: { code: "busy", error: TRY_AGAIN_SHORTLY, retryAfterSeconds: 30 },
};

/**
 * CANDIDATES invited sessions with their questions frozen, made the way the
 * product makes them: each start is tried once while the provider is full,
 * which freezes the set and starts nothing (the second test pins that).
 */
async function frozenWorld(model) {
  const db = world(CANDIDATES);
  const full = cappedProvider(0);
  for (let n = 1; n <= CANDIDATES; n++) {
    assert.deepEqual(await start(db, full, model, n), BUSY, `set-up: session ${n}`);
    assert.ok(hasFrozenMarker(rowOf(db, n).live_settings), `set-up: session ${n} frozen`);
    assert.equal(rowOf(db, n).status, "invited");
  }
  assert.equal(full.created.length, 0);
  return db;
}

test(`${CANDIDATES} start at once against a provider with ${CAP} slots: ${CAP} start, one is refused and nothing of it is left`, async () => {
  await run(async () => {
    const model = noModel();
    const db = await frozenWorld(model);
    const capped = cappedProvider(CAP);
    const before = new Map(
      Array.from({ length: CANDIDATES }, (_, i) => [i + 1, structuredClone(rowOf(db, i + 1))]),
    );

    const results = await Promise.all(
      Array.from({ length: CANDIDATES }, (_, i) => start(db, capped, model, i + 1)),
    );

    // Ten tickets, one plain refusal.
    const started = results.flatMap((r, i) => (r.status === 200 ? [i + 1] : []));
    const turnedAway = results.flatMap((r, i) => (r.status === 200 ? [] : [i + 1]));
    assert.equal(started.length, CAP, `statuses: ${results.map((r) => r.status).join(",")}`);
    assert.equal(turnedAway.length, 1);
    const eleventh = turnedAway[0];
    assert.deepEqual(results[eleventh - 1], BUSY);
    for (const n of started) {
      const { join } = results[n - 1].body;
      assert.deepEqual(Object.keys(results[n - 1].body), ["join"], "the ticket and nothing else");
      assert.equal(join.mode, "mock");
    }

    // The provider: exactly ten sessions, none created only to be given back.
    assert.equal(capped.created.length, CAP);
    assert.deepEqual(capped.cancelled, []);
    assert.deepEqual(capped.refused, [sessionId(eleventh)]);
    assert.equal(capped.open.size, CAP);
    for (const n of started) {
      const row = rowOf(db, n);
      const made = capped.created.find((c) => c.sessionId === sessionId(n));
      assert.deepEqual(
        [row.status, row.provider, row.provider_session_id],
        ["started", "mock", made.providerSessionId],
        `session ${n}`,
      );
      assert.equal(typeof row.started_at, "string");
    }
    assert.equal(new Set(capped.created.map((c) => c.providerSessionId)).size, CAP);

    // The refused one: the whole row as it was, and no trace anywhere else.
    const clean = (label) => {
      const row = rowOf(db, eleventh);
      assert.deepEqual(row, before.get(eleventh), `${label}: the row is untouched`);
      assert.deepEqual(
        [row.status, row.provider, row.provider_session_id, row.started_at],
        ["invited", null, null, null],
        label,
      );
      assert.equal("start_claim" in row.live_settings, false, `${label}: no claim left`);
      assert.equal(
        FREEZE_FAILED_KEY in row.live_settings,
        false,
        `${label}: no freeze-failed mark`,
      );
      assert.deepEqual(tracesOf(db, eleventh), NO_TRACES, label);
    };
    clean("refused");
    assert.equal(model.calls, 0, "no model call");

    // Trying again while every slot is taken: the same answer, the same clean row.
    assert.deepEqual(await start(db, capped, model, eleventh), BUSY);
    clean("refused again");
    assert.equal(capped.created.length, CAP);
    assert.equal(capped.open.size, CAP);

    // One interview ends: its slot is free, and the eleventh starts.
    capped.end(capped.created[0].providerSessionId);
    const later = await start(db, capped, model, eleventh);
    assert.equal(later.status, 200);
    assert.equal(later.body.join.mode, "mock");
    assert.equal(capped.created.length, CANDIDATES);
    assert.deepEqual(capped.cancelled, []);
    const row = rowOf(db, eleventh);
    assert.deepEqual(
      [row.status, row.provider, row.provider_session_id],
      ["started", "mock", capped.created.at(-1).providerSessionId],
    );
    assert.equal(model.calls, 0, "still no model call");
    // Nothing a start writes besides its own session row.
    for (let n = 1; n <= CANDIDATES; n++) assert.deepEqual(tracesOf(db, n), NO_TRACES);
  });
});

test("a session not yet frozen, refused at capacity: it keeps its frozen question set and its consent, and nothing else changes (by design)", async () => {
  await run(async () => {
    const model = noModel();
    const db = world(1);
    const before = structuredClone(rowOf(db, 1));
    assert.equal(hasFrozenMarker(before.live_settings), false, "not frozen before");
    const capped = cappedProvider(0);

    assert.deepEqual(await start(db, capped, model, 1), BUSY);
    const row = rowOf(db, 1);

    // Kept: the set the freeze wrote before the provider was asked, and the consent.
    assert.ok(hasFrozenMarker(row.live_settings), "the questions were frozen");
    const frozen = readFrozenQuestionSet(row);
    assert.deepEqual(
      frozen.questions.map((q) => [q.position, q.text, q.scoring_guide, q.guide_source]),
      QUESTIONS.map((text, i) => [i + 1, text, `RUBRIC ${i + 1}`, "recruiter"]),
    );
    assert.deepEqual(
      [row.consent_at, row.consent_version],
      [before.consent_at, before.consent_version],
    );

    // Everything else is as the invite left it: only the freeze's own three columns moved.
    const { questions_frozen: _marker, ...settings } = row.live_settings;
    assert.deepEqual(settings, before.live_settings, "no claim, no freeze-failed mark");
    const untouched = ({ live_settings, questions_snapshot, scoring_snapshot, ...rest }) => rest;
    assert.deepEqual(untouched(row), untouched(before));
    assert.deepEqual(
      [row.status, row.provider, row.provider_session_id, row.started_at],
      ["invited", null, null, null],
    );
    assert.deepEqual(tracesOf(db, 1), NO_TRACES);
    assert.equal(capped.created.length, 0);
    assert.equal(model.calls, 0, "a rubric on every question: the freeze needed no model");

    // A slot frees: the start uses the SAME frozen set, never a second freeze.
    const afterRefusal = structuredClone(row);
    const open = cappedProvider(1);
    const input = [];
    const createSession = open.provider.createSession;
    open.provider.createSession = async (i) => {
      input.push(structuredClone(i));
      return createSession(i);
    };
    assert.equal((await start(db, open, model, 1)).status, 200);
    assert.deepEqual(
      input[0].questions,
      QUESTIONS.map((text, i) => ({ position: i + 1, text })),
    );
    assert.deepEqual(readFrozenQuestionSet(rowOf(db, 1)), readFrozenQuestionSet(afterRefusal));
    assert.equal(model.calls, 0);
  });
});
