/**
 * AVI commit 10, decision 4 (26 Oct 2026): real live interviews stay closed
 * until the consent wording is final. This runs the REAL live consent text,
 * which still has placeholders ([CONFIRM: ...]): with the screen switched on,
 * consent is refused and nothing is written, and the start is refused before
 * any provider is called. live-start.test.ts stubs the text as final to test
 * the rest.
 *
 *   node --test src/lib/interviews/live-locked.test.ts
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
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

const { agreeToLiveInterview, startLiveInterview } = await import("./live-start.ts");
const { liveConsentReady, liveConsentScreen } = await import("./live-consent.ts");
const { hashSessionToken } = await import("./tokens.ts");
const { fakeLiveDb } = await import("../../test-support/fake-live-db.mjs");

const TOKEN = "live-locked-test-token-0123456789abcdef";
const row = (over = {}) => ({
  id: "5b0f2c1e-0000-4000-8000-000000000401",
  company_id: "7aad434d-0000-4000-8000-000000000040",
  kind: "live",
  status: "invited",
  token_hash: hashSessionToken(TOKEN),
  expires_at: new Date(Date.now() + 86_400_000).toISOString(),
  consent_at: null,
  consent_version: null,
  provider: null,
  provider_session_id: null,
  live_ended_at: null,
  ...over,
});

test("the real live consent text is not final, so the live screen has no consent to show", () => {
  assert.equal(liveConsentReady(), false);
  assert.equal(liveConsentScreen("Acme Ltd"), null);
});

test("switched on, consent is refused as locked and nothing is written", async () => {
  process.env.LIVE_INTERVIEW_SCREEN_ENABLED = "1";
  try {
    const db = fakeLiveDb({ interview_sessions: [row()] });
    const res = await agreeToLiveInterview({ token: TOKEN, agreed: true }, { service: db.service });
    assert.deepEqual([res.status, res.body.code], [409, "consent_locked"]);
    assert.equal(db.tables.interview_sessions[0].consent_at, null);
  } finally {
    delete process.env.LIVE_INTERVIEW_SCREEN_ENABLED;
  }
});

test("switched on, even a row that somehow carries live-v1 cannot start: no provider call, nothing stored", async () => {
  process.env.LIVE_INTERVIEW_SCREEN_ENABLED = "1";
  try {
    const db = fakeLiveDb({
      interview_sessions: [
        row({ consent_at: new Date().toISOString(), consent_version: "live-v1" }),
      ],
    });
    let called = 0;
    const provider = {
      name: "mock",
      createSession: async () => {
        called += 1;
        return {};
      },
      cancelSession: async () => {},
    };
    const res = await startLiveInterview({ token: TOKEN }, { service: db.service, provider });
    assert.deepEqual([res.status, res.body.code], [409, "consent_locked"]);
    assert.equal(called, 0);
    assert.equal(db.tables.interview_sessions[0].provider_session_id, null);
  } finally {
    delete process.env.LIVE_INTERVIEW_SCREEN_ENABLED;
  }
});
