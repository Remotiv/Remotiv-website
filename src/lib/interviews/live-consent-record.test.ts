/**
 * Live interview consent on the server (lib/interviews/live-consent-record.ts):
 * saved before anything starts, and required, as saved, before a provider
 * session can be built (live-provider/create-session.ts). The consent text is
 * stubbed as final here so recording can be exercised; the real text, which
 * still has placeholders and so refuses every recording, is tested in
 * live-consent.test.ts. The database is fake-live-db.mjs.
 *
 *   node --test src/lib/interviews/live-consent-record.test.ts
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../test-support/node-resolve.mjs", import.meta.url));
register(
  `data:text/javascript,${encodeURIComponent(`
const READY = "export const LIVE_INTERVIEW_CONSENT_VERSION = 'live-v1'; export function liveConsentReady() { return true; } export function liveConsentGiven(r) { return r.consent_at !== null && r.consent_version === 'live-v1'; }";
export async function resolve(specifier, context, next) {
  if (specifier === "server-only") return { url: "data:text/javascript,", shortCircuit: true };
  if (specifier === "@/lib/interviews/live-consent") return { url: "data:text/javascript," + encodeURIComponent(READY), shortCircuit: true };
  return next(specifier, context);
}`)}`,
);

const { recordLiveConsent, requireLiveConsent, isLiveConsentProof } = await import(
  "./live-consent-record.ts"
);
const { buildCreateSessionInput } = await import("./live-provider/create-session.ts");
const { readFrozenQuestionSet, snapshotsFor } = await import("./frozen-questions.ts");
const { fakeLiveDb } = await import("../../test-support/fake-live-db.mjs");

const SESSION = "5b0f2c1e-0000-4000-8000-0000000000fa";
const CO = "7aad434d-0000-4000-8000-000000000001";
const T0 = Date.parse("2026-10-20T09:00:00.000Z");

function session(over = {}) {
  return {
    id: SESSION,
    company_id: CO,
    kind: "live",
    status: "invited",
    consent_at: null,
    consent_version: null,
    live_settings: {
      questions_frozen: {
        at: "2026-10-16T05:40:00.000Z",
        prompt_version: "live-questions-v1",
        policy_version: "question-mix-v1",
        model: "m",
        calls: 1,
        input_tokens: 1,
        output_tokens: 1,
        rewritten: 0,
        replaced: 0,
      },
    },
    ...snapshotsFor([
      {
        question_id: "q-1",
        position: 1,
        text: "Tell me about a migration you led.",
        source: "job",
        competency: "Ownership",
        scoring_guide: "Strong: specific. Weak: general.",
        weight: null,
      },
    ]),
    ...over,
  };
}

/** What starting the interview does: require the saved consent, then build the provider input. */
async function start(db) {
  const row = db.tables.interview_sessions[0];
  const consent = await requireLiveConsent(db.service, SESSION);
  return buildCreateSessionInput({
    remotivSessionId: SESSION,
    interviewerName: "Sarah",
    interviewMinutes: 30,
    questions: readFrozenQuestionSet(row),
    candidateFirstName: "Alex",
    candidateLastName: "Example",
    cvText: "",
    consent,
  });
}

test("agreed: consent saved with live-v1 and read back; then the interview can start", async () => {
  const db = fakeLiveDb({ interview_sessions: [session()] });
  assert.deepEqual(await recordLiveConsent(db.service, SESSION, { agreed: true }, () => T0), {
    ok: true,
  });
  const row = db.tables.interview_sessions[0];
  assert.deepEqual([row.consent_at, row.consent_version], [new Date(T0).toISOString(), "live-v1"]);
  const input = await start(db);
  assert.equal(input.remotiv_session_id, SESSION);
  // Agreeing again keeps the first moment.
  assert.deepEqual(
    await recordLiveConsent(db.service, SESSION, { agreed: true }, () => T0 + 60_000),
    { ok: true },
  );
  assert.equal(db.tables.interview_sessions[0].consent_at, new Date(T0).toISOString());
});

test("declined: nothing is written, and the interview does not start", async () => {
  const db = fakeLiveDb({ interview_sessions: [session()] });
  for (const agreed of [false, undefined, "yes"]) {
    assert.deepEqual(await recordLiveConsent(db.service, SESSION, { agreed }), {
      ok: false,
      reason: "declined",
    });
  }
  assert.equal(db.tables.interview_sessions[0].consent_at, null);
  await assert.rejects(start(db), (e) => e.code === "no_consent");
});

test("saving fails: reported as a failure, and the interview does not start", async () => {
  const db = fakeLiveDb({ interview_sessions: [session()] });
  db.failNext("interview_sessions", "update");
  assert.deepEqual(await recordLiveConsent(db.service, SESSION, { agreed: true }), {
    ok: false,
    reason: "save_failed",
  });
  assert.equal(db.tables.interview_sessions[0].consent_at, null);
  await assert.rejects(start(db), (e) => e.code === "no_consent");

  // A read that fails after the write is a failure too: success only when the stored row says so.
  const db2 = fakeLiveDb({ interview_sessions: [session()] });
  let reads = 0;
  const service = {
    ...db2.service,
    from(table) {
      const q = db2.service.from(table);
      if (table !== "interview_sessions") return q;
      return new Proxy(q, {
        get(target, prop) {
          if (prop === "select") {
            reads += 1;
            if (reads === 2) {
              return () => ({
                eq: () => ({ maybeSingle: async () => ({ data: null, error: { code: "XX000" } }) }),
              });
            }
          }
          return target[prop];
        },
      });
    },
  };
  assert.deepEqual(await recordLiveConsent(service, SESSION, { agreed: true }), {
    ok: false,
    reason: "save_failed",
  });
});

test("the wrong consent is not consent: an async version, an async session, a missing session", async () => {
  const v2 = fakeLiveDb({
    interview_sessions: [
      session({ consent_at: "2026-10-19T09:00:00.000Z", consent_version: "v2" }),
    ],
  });
  await assert.rejects(start(v2), (e) => e.code === "no_consent");
  assert.deepEqual(await recordLiveConsent(v2.service, SESSION, { agreed: true }), {
    ok: false,
    reason: "save_failed",
  });
  const asyncSession = fakeLiveDb({ interview_sessions: [session({ kind: "async" })] });
  assert.deepEqual(await recordLiveConsent(asyncSession.service, SESSION, { agreed: true }), {
    ok: false,
    reason: "not_live",
  });
  assert.equal(asyncSession.tables.interview_sessions[0].consent_at, null);
  const none = fakeLiveDb({ interview_sessions: [] });
  assert.deepEqual(await recordLiveConsent(none.service, SESSION, { agreed: true }), {
    ok: false,
    reason: "not_found",
  });
});

test("only requireLiveConsent makes a proof; the builder takes nothing else", async () => {
  const db = fakeLiveDb({
    interview_sessions: [
      session({ consent_at: "2026-10-20T09:00:00.000Z", consent_version: "live-v1" }),
    ],
  });
  const proof = await requireLiveConsent(db.service, SESSION);
  assert.equal(isLiveConsentProof(proof), true);
  assert.equal(isLiveConsentProof({ ...proof }), false, "a copy is not a proof");
  assert.ok(Object.isFrozen(proof));
});
