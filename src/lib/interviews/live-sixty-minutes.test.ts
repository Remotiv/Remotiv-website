/**
 * 24 Nov: an AI Video Interview of 60 minutes really runs to 60, and the
 * follow-up limit frozen with its mode reaches the provider.
 *
 *   node --test src/lib/interviews/live-sixty-minutes.test.ts
 *
 * The time-cap backstop (live-events.ts), the candidate's countdown
 * (live-screen.ts), the mock provider (live-provider/join.ts) and the
 * browser's scripted interview (_live/mock-voxagent.ts) are the shipped code;
 * the database is a fake. Synthetic data.
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
};
export async function resolve(specifier, context, next) {
  if (specifier in STUBS) return { url: "data:text/javascript," + encodeURIComponent(STUBS[specifier]), shortCircuit: true };
  return next(specifier, context);
}`)}`,
);

const { END_GRACE_MS, liveEndDueAt, stampOverdueLiveEnds } = await import("./live-events.ts");
const { liveWelcomeFacts } = await import("./live-screen.ts");
const { createMockJoinProvider } = await import("./live-provider/join.ts");
const { MOCK_SCRIPT_IDS } = await import("./live-provider/types.ts");
const { mockScript } = await import("../../app/interview/[token]/_live/mock-voxagent.ts");
const { MOCK_LINES } = await import("../../app/interview/[token]/_live/mock-lines.ts");
const { fakeService } = await import("../../test-support/fake-postgrest.mjs");

const MIN = 60_000;
const T0 = Date.parse("2026-11-24T10:00:00.000Z");

/** Live settings v4 as the invite freezes them. */
const settings = (seconds, mode = "ai_guided") => ({
  v: 4,
  interviewer_name: "Sarah",
  language: "en",
  interview_mode: mode,
  max_follow_ups_per_base_question: mode === "structured" ? 0 : 2,
  max_session_seconds: seconds,
  follow_up_rules_version: "follow-up-v1",
  follow_up_rules: { when: "Thin.", scope: "Stay on it.", never: ["Reveal the answer."] },
  question_mix: {
    policy_version: "question-mix-v2",
    session_minutes: seconds / 60,
    job_questions: 6,
    cv_questions: 0,
    total: 6,
  },
});
const row = (seconds) => ({
  id: `s-${seconds}`,
  started_at: new Date(T0).toISOString(),
  live_settings: settings(seconds),
});

/* ── the time-cap backstop ─────────────────────────────────────── */

test("backstop: a 60-minute interview is due at 60 minutes plus the grace; 30 unchanged", () => {
  assert.equal(END_GRACE_MS, 10 * MIN);
  assert.equal(liveEndDueAt(row(3600)), T0 + 60 * MIN + END_GRACE_MS);
  assert.equal(liveEndDueAt(row(1800)), T0 + 30 * MIN + END_GRACE_MS);
});

test("backstop sweep: a 60-minute call is not ended at 40 or 59 minutes, only after 60 plus the grace", async () => {
  for (const [atMin, ends] of [
    [40, false],
    [59, false],
    [69, false],
    [71, true],
  ]) {
    const stamps = [];
    const service = fakeService((_table, calls) => {
      if (calls.some((c) => c[0] === "update")) {
        stamps.push(calls.find((c) => c[0] === "update")[1]);
        return { data: [{ id: row(3600).id }], error: null };
      }
      return { data: [row(3600)], error: null };
    });
    const n = await stampOverdueLiveEnds(service, () => T0 + atMin * MIN);
    assert.equal(n, ends ? 1 : 0, `${atMin} min`);
    assert.equal(stamps.length, ends ? 1 : 0, `${atMin} min`);
  }
});

test("backstop sweep: a 30-minute call still ends after 30 plus the grace", async () => {
  for (const [atMin, ends] of [
    [39, false],
    [41, true],
  ]) {
    const service = fakeService((_table, calls) =>
      calls.some((c) => c[0] === "update")
        ? { data: [{ id: row(1800).id }], error: null }
        : { data: [row(1800)], error: null },
    );
    assert.equal(await stampOverdueLiveEnds(service, () => T0 + atMin * MIN), ends ? 1 : 0);
  }
});

/* ── the candidate's countdown ─────────────────────────────────── */

test("countdown: 60 for a 3600 session, 30 for 1800, never more than 60, 30 when unreadable", async () => {
  for (const [stored, minutes] of [
    [3600, 60],
    [1800, 30],
    [7200, 60],
    [null, 30],
    ["3600", 30],
  ]) {
    const service = fakeService(() => ({
      data: { interviewer_name: "Sarah", max_session_seconds: stored },
      error: null,
    }));
    const facts = await liveWelcomeFacts("s-1", service);
    assert.equal(facts.minutes, minutes, JSON.stringify(stored));
  }
});

/* ── the provider and the mock ─────────────────────────────────── */

const providerInput = (limit) => ({
  remotiv_session_id: "s",
  interviewer_name: "Sarah",
  interview_minutes: 60,
  max_follow_ups_per_base_question: limit,
  questions: [{ position: 1, text: "Q?" }],
  candidate_first_name: null,
  cv_text: "",
});

test("mock provider: refuses a follow-up limit outside 0..2, hands 0 or 2 to the scripted interview", async () => {
  for (const bad of [3, -1, 1.5, undefined, "2"]) {
    await assert.rejects(
      createMockJoinProvider("completed").createSession(providerInput(bad)),
      /follow-up limit/,
      String(bad),
    );
  }
  for (const limit of [0, 2]) {
    const { join } = await createMockJoinProvider("completed").createSession(providerInput(limit));
    assert.equal(join.maxFollowUps, limit);
  }
});

/** The most follow-ups any one base question gets in a script. */
function mostFollowUps(steps) {
  let most = 0;
  let current = 0;
  for (const s of steps) {
    if (!("say" in s) || !s.question) continue;
    if (s.say === MOCK_LINES.follow_up) current += 1;
    else current = 0;
    most = Math.max(most, current);
  }
  return most;
}

test("the scripted interview never asks more follow-ups than the limit, in any script", () => {
  for (const id of MOCK_SCRIPT_IDS) {
    for (const limit of [0, 1, 2]) {
      const steps = mockScript(id, "Sarah", limit);
      assert.ok(mostFollowUps(steps) <= limit, `${id} at ${limit}`);
      // Nothing else is lost: every other line is still said, in order.
      const others = (s) => s.filter((x) => !("say" in x) || x.say !== MOCK_LINES.follow_up);
      assert.deepEqual(
        others(steps).filter((x) => "say" in x),
        others(mockScript(id, "Sarah", 2)).filter((x) => "say" in x),
      );
    }
  }
  // Recruiter-Defined: the completed script loses its one follow-up and its listen and think.
  const full = mockScript("completed", "Sarah", 2);
  const structured = mockScript("completed", "Sarah", 0);
  assert.equal(mostFollowUps(full), 1);
  assert.equal(mostFollowUps(structured), 0);
  assert.equal(full.length - structured.length, 3);
});
