/**
 * #63: every date on the interview review page renders the same on the UTC
 * server and in any browser zone until hydration, so React never throws a
 * hydration mismatch. After hydration the reader's own zone and a live clock.
 *
 *   node --test src/lib/interviews/review-dates-hydration.test.ts
 *
 * loadInterviewSession and ReviewClient run as shipped. Each zone renders in
 * its own process (TZ is read at process start), and the parent compares the
 * whole server-rendered page. The dates sit just before midnight UTC, where a
 * local date is a different day in Karachi (UTC+5) and Los Angeles (UTC-8).
 * Synthetic data only.
 */
// @ts-nocheck - same reason as async-score-purge.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { register } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

register(new URL("../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../test-support/tsx-load.mjs", import.meta.url));
register(
  `data:text/javascript,${encodeURIComponent(`
const STUBS = {
  "server-only": "",
  "@/lib/supabase/server": "export function createServiceClient() { return globalThis.__datesService; }",
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
const { fmtDate, noteWhen, ReviewClient } = await import(
  "../../app/ai-dashboard/(gated)/interviews/[sessionId]/_review-client.tsx"
);

const CO = "c0000000-0000-4000-8000-0000000000e3";
const SESSION = "s0000000-0000-4000-8000-0000000000e3";
const ctx = {
  companyId: CO,
  memberId: "m-1",
  role: "owner",
  memberName: "Owner",
  company: { id: CO, name: "Acme" },
};
// All within an hour of midnight UTC.
const SUBMITTED = "2026-11-10T23:40:00.000Z";
const ADJUSTED = "2026-11-11T23:30:00.000Z";
const DELETE_AFTER = "2027-05-09T23:50:00.000Z";
const SENT = "2026-11-09T23:20:00.000Z";
const EXPIRES = "2031-01-04T23:45:00.000Z";
const NOTE_AT = "2026-11-12T23:55:00.000Z";

/** status "submitted": header, retention line, adjusted scorecard and a note. "invited": nothing recorded yet. */
function world(status) {
  globalThis.__datesService = fakeService((table, calls) => {
    const single = calls.some((c) => c[0] === "maybeSingle" || c[0] === "single");
    if (table === "interview_sessions" && single) {
      return {
        data: {
          id: SESSION,
          application_id: null,
          job_id: null,
          kind: "async",
          status,
          started_at: null,
          submitted_at: status === "submitted" ? SUBMITTED : null,
          expires_at: EXPIRES,
          delete_after: DELETE_AFTER,
          invited_by_name: null,
          questions_snapshot: [],
          scoring_snapshot: null,
          archived_at: null,
          created_at: SENT,
        },
        error: null,
      };
    }
    if (table === "interview_answers") {
      if (status !== "submitted") return { data: [], count: 0, error: null };
      return {
        data: [
          {
            id: "ans-1",
            position: 1,
            question_text: "Question 1",
            video_path: `${SESSION}/q1.webm`,
            duration_seconds: 30,
            transcript: "A synthetic answer.",
            transcript_segments: null,
            transcript_status: "done",
            transcript_error: null,
            recorded_at: SUBMITTED,
          },
        ],
        count: 1,
        error: null,
      };
    }
    if (table === "interview_session_scores" && status === "submitted") {
      return {
        data: [
          {
            session_id: SESSION,
            status: "scored",
            overall_score: 70,
            human_adjusted_score: 80,
            human_feedback: null,
            adjusted_by_name: "A reviewer",
            adjusted_at: ADJUSTED,
            verdict: "Solid",
            summary: "A synthetic summary.",
            confidence: "high",
            criteria: [],
            error: null,
            scored_at: SUBMITTED,
            created_at: SUBMITTED,
          },
        ],
        error: null,
      };
    }
    if (table === "interview_notes") {
      return {
        data: [
          {
            id: "n-1",
            body: "Synthetic note.",
            author_name: "A teammate",
            member_id: "m-2",
            created_at: NOTE_AT,
            updated_at: null,
          },
        ],
        error: null,
      };
    }
    return { data: single ? null : [], error: null };
  });
}

const page = async (status) => {
  world(status);
  const view = await loadInterviewSession(ctx, SESSION);
  return renderToStaticMarkup(createElement(ReviewClient, { session: view, viewerRole: "owner" }));
};

// Child mode: render both pages in this process's TZ and print them.
if (process.env.REVIEW_DATES_PRINT === "1") {
  process.stdout.write(
    `${JSON.stringify({ submitted: await page("submitted"), invited: await page("invited") })}\n`,
  );
  process.exit(0);
}

const ZONES = ["UTC", "Asia/Karachi", "America/Los_Angeles"];
const renders = () =>
  ZONES.map((TZ) => {
    const out = execFileSync(process.execPath, [fileURLToPath(import.meta.url)], {
      env: { ...process.env, TZ, REVIEW_DATES_PRINT: "1" },
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
    return [TZ, JSON.parse(out.trim().split("\n").at(-1))];
  });

// Negative control: put back the old fmtDate / noteWhen (local date, Date.now())
// and the Karachi and Los Angeles pages differ from the UTC one.
test("the whole review page renders identically in UTC, Karachi and Los Angeles before hydration", () => {
  const all = renders();
  const [, utc] = all[0];
  for (const [TZ, r] of all) {
    assert.equal(r.submitted, utc.submitted, `${TZ}: submitted page`);
    assert.equal(r.invited, utc.invited, `${TZ}: invited page`);
  }
  // The dates are really on the page, in UTC.
  assert.match(utc.submitted, /Submitted 10 November 2026/);
  assert.match(utc.submitted, /Recordings are deleted automatically on 9 May 2027/);
  assert.match(utc.submitted, /11 November 2026/, "the adjustment date");
  assert.match(utc.submitted, /12 Nov, 23:55 UTC/, "the note, as an exact UTC stamp");
  assert.match(utc.invited, /Invited 9 November 2026 · due 4 January 2031/);
  assert.match(utc.invited, /link is open until 4 January 2031/);
});

test("after hydration: the reader's own date, and the note's live relative time", () => {
  const own = (iso) =>
    new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
  assert.equal(fmtDate(SUBMITTED, false), "10 November 2026");
  assert.equal(fmtDate(SUBMITTED, true), own(SUBMITTED));
  assert.equal(noteWhen(NOTE_AT, false), "12 Nov, 23:55 UTC");
  assert.equal(noteWhen(new Date(Date.now() - 5 * 60_000).toISOString(), true), "5m ago");
  assert.equal(noteWhen(new Date().toISOString(), true), "just now");
});
