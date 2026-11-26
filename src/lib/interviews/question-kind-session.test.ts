/**
 * #58 commits 3+4: the candidate page's fallback (session.ts,
 * loadCandidateQuestions) reads the async list only. An async session invited
 * before questions_snapshot existed has none frozen, so the page reads the
 * job's questions; a job holding both lists (migration 082) must show the
 * candidate the async ones, never the AI Video Interview's.
 *
 *   node --test src/lib/interviews/question-kind-session.test.ts
 *
 * resolveSessionByToken is the shipped code; the database is fake-live-db.mjs,
 * which applies filters. Synthetic data.
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
  "@/lib/supabase/server": "export function createServiceClient() { return globalThis.__service; }",
};
export async function resolve(specifier, context, next) {
  if (specifier in STUBS) return { url: "data:text/javascript," + encodeURIComponent(STUBS[specifier]), shortCircuit: true };
  return next(specifier, context);
}`)}`,
);

const { resolveSessionByToken } = await import("./session.ts");
const { hashSessionToken } = await import("./tokens.ts");
const { fakeLiveDb } = await import("../../test-support/fake-live-db.mjs");

const CO = "c0000000-0000-4000-8000-0000000000a8";
const JOB = "b0000000-0000-4000-8000-0000000000a8";
const APP = "a0000000-0000-4000-8000-0000000000a8";
const TOKEN = "kind-filter-synthetic-token-0123456789abcdef";

const row = (kind, n) => ({
  id: `${kind}-q${n}`,
  job_id: JOB,
  company_id: CO,
  interview_kind: kind,
  position: n,
  question: `${kind === "live" ? "Live" : "Async"} synthetic question ${n}?`,
  prep_seconds: 30,
  answer_seconds: 120,
  required: true,
});

function world() {
  const db = fakeLiveDb({
    interview_sessions: [
      {
        id: "d0000000-0000-4000-8000-0000000000a8",
        company_id: CO,
        application_id: APP,
        job_id: JOB,
        kind: "async",
        status: "invited",
        token_hash: hashSessionToken(TOKEN),
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
        consent_at: null,
        consent_version: null,
        submitted_at: null,
        allow_rerecord: true,
        // Invited before the snapshot column existed: the page reads the job's list.
        questions_snapshot: null,
        live_ended_at: null,
        provider_session_id: null,
        delete_after: null,
        purged_at: null,
      },
    ],
    companies: [{ id: CO, name: "Test Co" }],
    jobs: [{ id: JOB, company_id: CO, title: "Test role", allow_rerecord: true }],
    interview_answers: [],
    interview_questions: [row("async", 1), row("live", 1), row("async", 2), row("live", 2)],
  });
  globalThis.__service = db.service;
  return db;
}

test("an async session with no snapshot shows the job's async questions only, never the live list", async () => {
  world();
  const result = await resolveSessionByToken(TOKEN);
  assert.ok(result, "the link resolves");
  assert.deepEqual(
    result.session.questions.map((q) => [q.id, q.question]),
    [
      ["async-q1", "Async synthetic question 1?"],
      ["async-q2", "Async synthetic question 2?"],
    ],
  );
});
