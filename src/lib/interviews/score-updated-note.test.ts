/**
 * #28: a scorecard redone after a transcript finished late says so on the
 * review page, with when it was updated and when it was first written.
 *
 *   node --test src/lib/interviews/score-updated-note.test.ts
 *
 * scoreUpdatedAfterFirst, loadInterviewSession and ReviewClient run as
 * shipped. The session client is fake-postgrest.mjs answering the session, no
 * answers, and one interview_session_scores row whose created_at and
 * scored_at each test chooses. Synthetic data only.
 */
// @ts-nocheck - same reason as async-score-purge.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

register(new URL("../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../test-support/tsx-load.mjs", import.meta.url));
register(
  `data:text/javascript,${encodeURIComponent(`
const STUBS = {
  "server-only": "",
  "@/lib/supabase/server": "export function createServiceClient() { return globalThis.__updService; }",
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
const { scoreUpdatedAfterFirst, SCORE_UPDATED_GAP_MS } = await import("./review-types.ts");
const { fmtWhen, ReviewClient } = await import(
  "../../app/ai-dashboard/(gated)/interviews/[sessionId]/_review-client.tsx"
);

const CO = "c0000000-0000-4000-8000-0000000000d8";
const SESSION = "s0000000-0000-4000-8000-0000000000d8";
const ctx = {
  companyId: CO,
  memberId: "m-1",
  role: "owner",
  memberName: "Owner",
  company: { id: CO, name: "Acme" },
};
const FIRST = "2026-11-10T09:00:00.000Z";
const LATER = "2026-11-12T14:30:00.000Z";

/** One scored session; its scorecard row first written at `createdAt`, last scored at `scoredAt`. */
function world({ createdAt, scoredAt, status = "scored" }) {
  globalThis.__updService = fakeService((table, calls) => {
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
          submitted_at: "2026-11-10T08:00:00.000Z",
          expires_at: null,
          delete_after: "2027-05-01T00:00:00.000Z",
          invited_by_name: null,
          questions_snapshot: [],
          scoring_snapshot: null,
          archived_at: null,
          created_at: "2026-11-09T08:00:00.000Z",
        },
        error: null,
      };
    }
    if (table === "interview_answers") return { data: [], count: 0, error: null };
    if (table === "interview_session_scores") {
      // Only the columns the read selects, as PostgREST answers.
      const cols = calls
        .find((c) => c[0] === "select")[1]
        .split(",")
        .map((c) => c.trim());
      const pick = (row) =>
        Object.fromEntries(cols.filter((c) => c in row).map((c) => [c, row[c]]));
      return {
        data: [
          {
            session_id: SESSION,
            status,
            overall_score: status === "scored" ? 74 : null,
            human_adjusted_score: null,
            human_feedback: null,
            adjusted_by_name: null,
            adjusted_at: null,
            verdict: status === "scored" ? "Strong communicator" : null,
            summary: status === "scored" ? "A synthetic summary." : null,
            confidence: status === "scored" ? "medium" : null,
            criteria: [],
            error: status === "scored" ? null : "Scoring didn't complete.",
            scored_at: scoredAt,
            created_at: createdAt,
          },
        ].map(pick),
        error: null,
      };
    }
    return { data: single ? null : [], error: null };
  });
}

const render = (view) =>
  renderToStaticMarkup(createElement(ReviewClient, { session: view, viewerRole: "owner" }));
const plus = (iso, ms) => new Date(Date.parse(iso) + ms).toISOString();
const noteOf = (html) =>
  html
    .replaceAll("&#x27;", "'")
    .match(/data-score-updated[^>]*>([^<]*)</)?.[1]
    .replace(/\s+/g, " ")
    .trim() ?? null;
const EXPECTED =
  "Re-scored 12 November 2026 at 14:30 UTC, after a transcript finished late. First scorecard written 10 November 2026 at 09:00 UTC.";

// Child mode: render the page once in this process's TZ and print the note.
if (process.env.SCORE_NOTE_PRINT === "1") {
  world({ createdAt: FIRST, scoredAt: LATER });
  process.stdout.write(
    `${JSON.stringify({ note: noteOf(render(await loadInterviewSession(ctx, SESSION))) })}\n`,
  );
  process.exit(0);
}

test("the rule: a scorecard written once is not 'updated'; one redone later is", () => {
  const s = (createdAt, scoredAt, status = "scored") => ({
    status,
    scoredAt,
    firstWrittenAt: createdAt,
  });
  assert.equal(scoreUpdatedAfterFirst(null), null);
  assert.equal(
    scoreUpdatedAfterFirst(s(FIRST, plus(FIRST, -150))),
    null,
    "app clock a little behind",
  );
  assert.equal(
    scoreUpdatedAfterFirst(s(FIRST, plus(FIRST, 3_000))),
    null,
    "one write, seconds apart",
  );
  assert.equal(
    scoreUpdatedAfterFirst(s(FIRST, plus(FIRST, SCORE_UPDATED_GAP_MS))),
    null,
    "at the gap",
  );
  assert.deepEqual(scoreUpdatedAfterFirst(s(FIRST, plus(FIRST, SCORE_UPDATED_GAP_MS + 1))), {
    updatedAt: plus(FIRST, SCORE_UPDATED_GAP_MS + 1),
    firstAt: FIRST,
  });
  assert.deepEqual(scoreUpdatedAfterFirst(s(FIRST, LATER)), { updatedAt: LATER, firstAt: FIRST });
  assert.equal(scoreUpdatedAfterFirst(s(FIRST, LATER, "failed")), null, "only a scored card");
  assert.equal(scoreUpdatedAfterFirst(s(null, LATER)), null, "no first write known");
  assert.equal(scoreUpdatedAfterFirst(s(FIRST, null)), null);
});

// Negative control: drop created_at from fetchSessionScores' select and the
// note never appears, because the first write is unknown.
test("the review page says when the score was updated and when it was first written", async () => {
  world({ createdAt: FIRST, scoredAt: LATER });
  const view = await loadInterviewSession(ctx, SESSION);
  assert.equal(view.score.firstWrittenAt, FIRST);
  assert.equal(view.score.scoredAt, LATER);
  const html = render(view);
  assert.equal(noteOf(html), EXPECTED, "server render: UTC, labelled");
  assert.doesNotMatch(html, /[–—]/);
});

// Negative control: put back the old fmtWhen (toLocaleString with no timeZone)
// and the three renders disagree, which is the hydration error.
test("the text before hydration is the same in every server and browser time zone", () => {
  const notes = ["UTC", "Asia/Karachi", "America/Los_Angeles"].map((TZ) => {
    const out = execFileSync(process.execPath, [fileURLToPath(import.meta.url)], {
      env: { ...process.env, TZ, SCORE_NOTE_PRINT: "1" },
      encoding: "utf8",
    });
    return [TZ, JSON.parse(out.trim().split("\n").at(-1)).note];
  });
  for (const [TZ, note] of notes) assert.equal(note, EXPECTED, TZ);
});

test("after hydration the reader's own zone is used, with no UTC label", () => {
  assert.equal(fmtWhen(LATER, false), "12 November 2026 at 14:30 UTC");
  const local = fmtWhen(LATER, true);
  assert.doesNotMatch(local, /UTC/);
  assert.equal(
    local,
    new Date(LATER).toLocaleString("en-GB", {
      day: "numeric",
      month: "long",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }),
  );
});

test("a scorecard written once shows no note", async () => {
  world({ createdAt: FIRST, scoredAt: plus(FIRST, 2_000) });
  const html = render(await loadInterviewSession(ctx, SESSION));
  assert.doesNotMatch(html, /data-score-updated|Re-scored/);
});

// Negative control: put the threshold back to 5 minutes and this note is hidden.
test("re-scored 2 minutes after the first write: the note appears", async () => {
  world({ createdAt: FIRST, scoredAt: plus(FIRST, 2 * 60_000) });
  assert.equal(
    noteOf(render(await loadInterviewSession(ctx, SESSION))),
    "Re-scored 10 November 2026 at 09:02 UTC, after a transcript finished late. First scorecard written 10 November 2026 at 09:00 UTC.",
  );
});

test("the threshold is one minute: 59 seconds is one write, 61 seconds is a re-score", () => {
  assert.equal(SCORE_UPDATED_GAP_MS, 60_000);
  const s = (gapMs) => ({ status: "scored", scoredAt: plus(FIRST, gapMs), firstWrittenAt: FIRST });
  assert.equal(scoreUpdatedAfterFirst(s(59_000)), null);
  assert.deepEqual(scoreUpdatedAfterFirst(s(61_000)), {
    updatedAt: plus(FIRST, 61_000),
    firstAt: FIRST,
  });
});

/**
 * Scoring off when the interview was submitted: the first row written is
 * `skipped`. Scoring is turned on and a late transcript re-scores it. Only the
 * current status is stored, so the note must not claim the first write was a
 * score.
 */
// Negative control: put back "First scored" and the second half fails.
test("a scorecard first written as skipped: no note while skipped, then accurate wording", async () => {
  world({ createdAt: FIRST, scoredAt: null, status: "skipped" });
  assert.equal(noteOf(render(await loadInterviewSession(ctx, SESSION))), null, "still skipped");

  world({ createdAt: FIRST, scoredAt: LATER });
  const html = render(await loadInterviewSession(ctx, SESSION));
  assert.equal(noteOf(html), EXPECTED);
  assert.doesNotMatch(html, /First scored/);
  const src = readFileSync(
    new URL(
      "../../app/ai-dashboard/(gated)/interviews/[sessionId]/_review-client.tsx",
      import.meta.url,
    ),
    "utf8",
  );
  assert.doesNotMatch(src, /First scored/);
});

test("a failed scorecard shows no note, whatever its timestamps", async () => {
  world({ createdAt: FIRST, scoredAt: LATER, status: "failed" });
  const html = render(await loadInterviewSession(ctx, SESSION));
  assert.doesNotMatch(html, /Re-scored/);
});

test("only the scoring rollup writes a session's scored_at (the rule's premise)", () => {
  const scoring = readFileSync(new URL("../ai/interview-scoring.ts", import.meta.url), "utf8");
  // One write for the session rollup (status "scored") and one for an answer row.
  assert.equal((scoring.match(/scored_at: new Date\(\)\.toISOString\(\)/g) ?? []).length, 2);
  const actions = readFileSync(
    new URL("../../app/ai-dashboard/(gated)/interviews/actions.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(actions, /scored_at/, "a reviewer's adjustment never moves it");
});
