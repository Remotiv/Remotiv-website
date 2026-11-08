/**
 * The async review page's wording for an interview that is still being
 * transcribed, waiting to be scored, never scored, or not scorable at all, and
 * the scorer's own reason for the last. Each sentence is checked exactly where
 * the page renders it, the sentence it replaced is checked gone, and none of
 * them carries an em or en dash.
 *
 *   node --test src/lib/interviews/review-copy.test.ts
 *
 * ReviewClient is the shipped component, rendered with react-dom/server. Its
 * server actions, the router and Link are stubbed. Synthetic data only.
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

function render({ answers, score, totalQuestions = answers.length, canScore = false }) {
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
    canScore,
    purged: false,
    evidenceDeleted: false,
    notes: [],
    viewerMemberId: "m-1",
  };
  return renderToStaticMarkup(createElement(ReviewClient, { session, viewerRole: "owner" }));
}

const NEW = {
  transcribing: "This answer is being transcribed. This may take a few minutes.",
  waiting: "Scoring starts once all answers are transcribed.",
  canScore: "This interview hasn't been scored yet. Score it now.",
  notScorable: "Not scored",
  noVerdict: "Scored - see the answers below",
  scorerReason: "No answer in this interview could be scored. See the individual answers for why.",
};
const OLD = [
  "Transcription isn't switched on for this workspace",
  "Scoring runs on the transcript, so it starts once transcription is switched on",
  "Scoring was never queued for this interview",
  "Scored \u2014 see the answers below",
];

const page = (over) => {
  const html = render(over).replaceAll("&#x27;", "'");
  for (const old of OLD) assert.ok(!html.includes(old), `still shows: ${old}`);
  return html;
};
test("none of the new sentences carries an em or en dash", () => {
  for (const text of Object.values(NEW)) assert.doesNotMatch(text, /[\u2013\u2014]/, text);
});

test("an answer still being transcribed says so, under the same title", () => {
  const html = page({ answers: [answer(1, "pending", null)], score: null });
  assert.match(html, /Transcript not available yet/);
  assert.ok(html.includes(NEW.transcribing));
});

test("no scorecard and nothing to ask for yet: scoring waits on the transcripts", () => {
  const html = page({ answers: [answer(1, "pending", null)], score: null });
  assert.match(html, /Not scored yet/);
  assert.ok(html.includes(NEW.waiting));
});

test("never scored and scorable: the short sentence, and the button is kept", () => {
  const html = page({ answers: [answer(1, "done", null)], score: null, canScore: true });
  assert.ok(html.includes(NEW.canScore));
  assert.match(html, />Score interview</);
  assert.match(html, /Not scored yet/);
});

test("a skipped scorecard: Not scored, with the stored reason", () => {
  const html = page({
    answers: [answer(1, "failed", "skipped")],
    score: { ...sessionScore("skipped"), error: NEW.scorerReason },
  });
  assert.match(html, />Not scored</);
  assert.doesNotMatch(html, /Not scored yet/);
  assert.ok(html.includes(NEW.scorerReason));
});

test("a scorecard with no verdict: hyphen, not em dash", () => {
  const html = page({
    answers: [answer(1, "done", "scored")],
    score: { ...sessionScore("scored"), verdict: null },
  });
  assert.ok(html.includes(NEW.noVerdict));
});

test("the scorer writes the new reason", () => {
  const scorer = readFileSync(new URL("../ai/interview-scoring.ts", import.meta.url), "utf8");
  assert.ok(scorer.includes(`"${NEW.scorerReason}"`));
  assert.ok(!scorer.includes("No answer in this interview could be scored \u2014"));
});
