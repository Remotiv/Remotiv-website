/**
 * #46: the review page lists at most 50 answers and says so when there are
 * more; a failed answers read is unavailable, never an empty interview.
 *
 *   node --test src/lib/interviews/review-answers-cap.test.ts
 *
 * loadInterviewSession and ReviewClient run as shipped. The session client
 * is fake-postgrest.mjs with a responder for the reads the loader makes: the
 * session, 60 answers (ordered, limited, with or without an exact count, or
 * failing), and their scores (filtered by `.in("answer_id")`). Every other
 * read answers empty. Synthetic data only.
 */
// @ts-nocheck - same reason as async-score-purge.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../test-support/tsx-load.mjs", import.meta.url));
register(
  `data:text/javascript,${encodeURIComponent(`
const STUBS = {
  "server-only": "",
  "@/lib/supabase/server": "export function createServiceClient() { return globalThis.__capService; }",
  "@/lib/ai/interview-scoring": "export function scoringEnabled() { return false; }",
  "@/app/ai-dashboard/lib/job-scope": [
    "export async function getJobScope() { return { scoped: false }; }",
    "export function isEmptyScope(s) { return s.scoped && s.jobIds.length === 0; }",
    "export function scopeJobIds(s) { return s.scoped ? s.jobIds : null; }",
    "export async function canAccessJob() { return true; }",
  ].join("\\n"),
  "@/app/ai-dashboard/(gated)/applicants/actions": "export async function updateApplicationStage() { return { success: true }; }",
  "../actions": [
    "addInterviewNote", "adjustAnswerScore", "adjustSessionScore", "deleteInterview", "deleteInterviewNote",
    "getAnswerPlaybackUrl", "revertAnswerScore", "revertSessionScore", "scoreInterview", "setInterviewArchived",
    "updateInterviewNote",
  ].map((n) => "export async function " + n + "() { return { ok: true }; }").join("\\n"),
  "next/navigation": "export function useRouter() { return { refresh() {}, push() {} }; }",
  "next/link": "export default function Link({ href, children, ...rest }) { return globalThis.__h('a', { href, ...rest }, children); }",
};
export async function resolve(specifier, context, next) {
  if (specifier in STUBS) return { url: "data:text/javascript," + encodeURIComponent(STUBS[specifier]), shortCircuit: true };
  return next(specifier, context);
}`)}`,
);

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
globalThis.__h = createElement;
const { fakeService } = await import("../../test-support/fake-postgrest.mjs");
const { loadInterviewSession } = await import("./review.ts");
const { answersShownNote, ANSWERS_SHOWN } = await import("./review-types.ts");
const { ReviewClient } = await import(
  "../../app/ai-dashboard/(gated)/interviews/[sessionId]/_review-client.tsx"
);

const CO = "c0000000-0000-4000-8000-000000000001";
const SESSION = "s0000000-0000-4000-8000-000000000001";
const ctx = {
  companyId: CO,
  memberId: "m-1",
  role: "owner",
  memberName: "Owner",
  company: { id: CO, name: "Acme" },
};
const answerId = (p) => `ans-${String(p).padStart(3, "0")}`;

/**
 * `answers`: how many the session holds. `count`: "exact" answers the real
 * count, "none" answers no count. `fail`: the answers read errors.
 */
function world({ answers = 60, count = "exact", fail = false } = {}) {
  const all = Array.from({ length: answers }, (_, i) => ({
    id: answerId(i + 1),
    position: i + 1,
    question_text: `Question ${i + 1}`,
    video_path: null,
    duration_seconds: 30,
    transcript: null,
    transcript_segments: null,
    transcript_status: "pending",
    transcript_error: null,
    recorded_at: null,
  }));
  const service = fakeService((table, calls) => {
    const single = calls.some((c) => c[0] === "maybeSingle" || c[0] === "single");
    if (table === "interview_sessions" && single) {
      return {
        data: {
          id: SESSION,
          application_id: null,
          job_id: null,
          kind: "async",
          status: "submitted",
          started_at: null,
          submitted_at: "2026-11-01T00:00:00.000Z",
          expires_at: null,
          delete_after: null,
          invited_by_name: null,
          questions_snapshot: [],
          scoring_snapshot: null,
          archived_at: null,
          created_at: "2026-10-30T00:00:00.000Z",
        },
        error: null,
      };
    }
    if (table === "interview_answers") {
      if (fail) return { data: null, count: null, error: { code: "57014", message: "timeout" } };
      const limit = calls.find((c) => c[0] === "limit")?.[1] ?? all.length;
      const asc = calls.some((c) => c[0] === "order" && c[1] === "position");
      const rows = (asc ? all : [...all].reverse()).slice(0, limit);
      const wantsCount = calls.find((c) => c[0] === "select")?.[2]?.count === "exact";
      return {
        data: rows,
        count: wantsCount && count === "exact" ? all.length : null,
        error: null,
      };
    }
    if (table === "interview_answer_scores") {
      const ids =
        calls.find((c) => c[0] === "in" && c[1] === "answer_id")?.[2] ?? all.map((a) => a.id);
      const limit = calls.find((c) => c[0] === "limit")?.[1] ?? ids.length;
      return {
        data: ids.slice(0, limit).map((id) => ({
          answer_id: id,
          status: "scored",
          score: 70,
          human_adjusted_score: null,
          human_feedback: null,
          adjusted_by_name: null,
          adjusted_at: null,
          confidence: "high",
          reasoning: null,
          strengths: [],
          concerns: [],
          missing: [],
          error: null,
        })),
        error: null,
      };
    }
    return { data: single ? null : [], error: null };
  });
  globalThis.__capService = service;
  return service;
}

const render = (view) =>
  renderToStaticMarkup(createElement(ReviewClient, { session: view, viewerRole: "owner" }));

test("the note: exact total above what is shown, the first-50 wording without one, nothing otherwise", () => {
  assert.equal(ANSWERS_SHOWN, 50);
  assert.equal(answersShownNote(50, 60), "Showing 50 of 60 answers");
  assert.equal(answersShownNote(50, null), "Showing the first 50 answers");
  assert.equal(answersShownNote(50, 50), null, "all of them shown");
  assert.equal(answersShownNote(6, 6), null);
  assert.equal(answersShownNote(6, null), null, "fewer than the cap: the whole list");
  for (const s of [answersShownNote(50, 60), answersShownNote(50, null)]) {
    assert.ok(!/[–—]/.test(s), "no en or em dash");
  }
});

// Negative control: drop `{ count: "exact" }` and answersTotal is null, so "of 60" never appears.
test("60 answers: the first 50 in question order, the exact total, and the page says Showing 50 of 60", async () => {
  world({ answers: 60 });
  const view = await loadInterviewSession(ctx, SESSION);
  assert.equal(view.answers.length, 50);
  assert.deepEqual(
    view.answers.map((a) => a.position),
    Array.from({ length: 50 }, (_, i) => i + 1),
  );
  assert.equal(view.answersTotal, 60);
  assert.match(render(view), /Showing 50 of 60 answers/);
});

test("no count came back: the page says Showing the first 50 answers, never a made-up total", async () => {
  world({ answers: 60, count: "none" });
  const view = await loadInterviewSession(ctx, SESSION);
  assert.equal(view.answersTotal, null);
  const html = render(view);
  assert.match(html, /Showing the first 50 answers/);
  assert.doesNotMatch(html, /Showing 50 of/);
});

test("a normal interview (6 answers) shows no note", async () => {
  world({ answers: 6 });
  const view = await loadInterviewSession(ctx, SESSION);
  assert.equal(view.answersTotal, 6);
  assert.doesNotMatch(render(view), /Showing /);
});

// Negative control: put back `.limit(50)` without the answer filter and a score can belong to an answer not shown.
test("scores are read for exactly the answers shown", async () => {
  const service = world({ answers: 60 });
  const view = await loadInterviewSession(ctx, SESSION);
  const read = service.queries.find((q) => q.table === "interview_answer_scores");
  assert.deepEqual(
    read.calls.find((c) => c[0] === "in" && c[1] === "answer_id")?.[2],
    view.answers.map((a) => a.id),
  );
  assert.ok(!read.calls.some((c) => c[0] === "limit"), "no separate cap on the scores read");
  assert.ok(
    view.answers.every((a) => a.score !== null),
    "every shown answer has its score",
  );
});

// Negative control: ignore the answers read's error and this resolves with an interview that has no answers.
test("a failed answers read is unavailable, not an interview with no answers", async () => {
  world({ fail: true });
  await assert.rejects(loadInterviewSession(ctx, SESSION), /answers read failed/);
});
