/**
 * The review page's "Partial" label: shown when a scorecard was scored but some
 * questions were not, and only then. Never while a transcript is still pending,
 * never when every question was scored, and never when none was.
 *
 *   node --test src/lib/interviews/review-partial.test.ts
 *
 * ReviewClient is the shipped component, rendered with react-dom/server. Its
 * server actions, the router and Link are stubbed. Synthetic data only.
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../test-support/tsx-load.mjs", import.meta.url));
register(
  `data:text/javascript,${encodeURIComponent(`
const noop = "async function noop() { return { ok: true }; }";
const STUBS = {
  "server-only": "",
  "../actions": noop + ["addInterviewNote","adjustAnswerScore","adjustSessionScore","deleteInterview","deleteInterviewNote","getAnswerPlaybackUrl","revertAnswerScore","revertSessionScore","scoreInterview","setInterviewArchived","updateInterviewNote"].map((n) => " export const " + n + " = noop;").join(""),
  "@/app/ai-dashboard/(gated)/applicants/actions": noop + " export const updateApplicationStage = noop;",
  "next/navigation": "export function useRouter() { return { refresh() {}, push() {}, replace() {} }; } export function usePathname() { return '/'; } export function useSearchParams() { return new URLSearchParams(); }",
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
const { ReviewClient } = await import(
  "../../app/ai-dashboard/(gated)/interviews/[sessionId]/_review-client.tsx"
);

const answerScore = (status) => ({
  status,
  aiScore: status === "scored" ? 70 : null,
  shownScore: status === "scored" ? 70 : null,
  confidence: status === "scored" ? "high" : null,
  reasoning: null,
  strengths: [],
  concerns: [],
  missing: [],
  adjustment: null,
  error:
    status === "scored"
      ? null
      : "Transcription failed for this answer, so there are no words to assess.",
});

const answer = (position, transcriptState, scoreStatus) => ({
  hasSegments: false,
  score: scoreStatus ? answerScore(scoreStatus) : null,
  id: `e0000000-0000-4000-8000-00000000000${position}`,
  position,
  questionText: `Question ${position}?`,
  competency: null,
  durationSeconds: 60,
  hasVideo: true,
  purged: false,
  transcript: transcriptState === "done" ? "Something real was said." : null,
  transcriptState,
  transcriptError: null,
  recordedAt: "2026-11-01T10:00:00.000Z",
});

const sessionScore = (status, confidence = "high") => ({
  status,
  overall: status === "scored" ? 70 : null,
  humanScore: null,
  verdict: status === "scored" ? "Solid." : null,
  summary: status === "scored" ? "One. Two." : null,
  confidence: status === "scored" ? confidence : null,
  error: status === "scored" ? null : "No answer in this interview could be scored.",
  scoredAt: "2026-11-02T10:00:00.000Z",
  criteria: [],
  adjustment: null,
});

function render({ answers, score, totalQuestions = answers.length }) {
  const session = {
    id: "d0000000-0000-4000-8000-0000000000f8",
    applicationId: null,
    jobId: null,
    candidateName: "Sam Example",
    candidateEmail: "sam@example.test",
    candidateLink: null,
    jobTitle: "Engineer",
    stage: "screening",
    kind: "async",
    status: "submitted",
    answers,
    totalQuestions,
    submittedAt: "2026-11-01T11:00:00.000Z",
    startedAt: "2026-11-01T10:00:00.000Z",
    expiresAt: "2026-11-04T10:00:00.000Z",
    sentAt: "2026-11-01T09:00:00.000Z",
    deleteAfter: null,
    invitedByName: null,
    archivedAt: null,
    score,
    canDelete: false,
    canScore: false,
    purged: false,
    evidenceDeleted: false,
    notes: [],
    viewerMemberId: "m-1",
  };
  return renderToStaticMarkup(createElement(ReviewClient, { session, viewerRole: "owner" }));
}

const partial = (html) => /data-scorecard-partial/.test(html) && />Partial</.test(html);

test("some questions unscored: Partial is shown", () => {
  const html = render({
    answers: [answer(1, "done", "scored"), answer(2, "failed", "skipped")],
    score: sessionScore("scored", "low"),
  });
  assert.ok(partial(html), "a failed transcript");
  assert.match(html, /low confidence/, "the confidence badge stays");

  assert.ok(
    partial(
      render({
        answers: [answer(1, "done", "scored")],
        score: sessionScore("scored"),
        totalQuestions: 2,
      }),
    ),
    "a question never answered",
  );
  assert.ok(
    partial(
      render({
        answers: [answer(1, "done", "scored"), answer(2, "done", "failed")],
        score: sessionScore("scored", "low"),
      }),
    ),
    "scoring that failed",
  );
});

test("every question scored: no Partial", () => {
  const html = render({
    answers: [answer(1, "done", "scored"), answer(2, "done", "scored")],
    score: sessionScore("scored"),
  });
  assert.ok(!partial(html));
  assert.match(html, /high confidence/);
});

test("nothing scored: no Partial, the not-scored strip is unchanged", () => {
  const html = render({
    answers: [answer(1, "failed", "skipped"), answer(2, "failed", "skipped")],
    score: sessionScore("skipped"),
  });
  assert.ok(!partial(html));
  assert.match(html, /Not scored yet/);
});

test("a transcript still pending: no Partial, even beside a stored scorecard", () => {
  const html = render({
    answers: [answer(1, "done", "scored"), answer(2, "pending", null)],
    score: sessionScore("scored"),
  });
  assert.ok(!partial(html));
});

test("no scorecard yet: no Partial and no badge group", () => {
  const html = render({ answers: [answer(1, "done", null)], score: null });
  assert.ok(!partial(html));
  assert.doesNotMatch(html, /confidence</);
});
