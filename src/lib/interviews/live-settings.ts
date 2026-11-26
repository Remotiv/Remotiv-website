import "server-only";
import type { createServiceClient } from "@/lib/supabase/server";
import { liveInterviewsAvailableFor } from "./live-availability";
import { jobQuestionMix, MAX_JOB_QUESTIONS, MIN_JOB_QUESTIONS } from "./question-mix";
import {
  LIVE_INTERVIEWER_NAME,
  LIVE_MODE_FOLLOW_UPS,
  LIVE_SESSION_SECONDS,
  LIVE_SETTINGS_VERSION,
  type LiveInterviewModeSetting,
  type LiveSettings,
} from "./types";

/**
 * The rules a live interview runs under, and the freeze that pins them to one
 * session.
 *
 * ── server-only, and that is not incidental ──────────────────
 *
 * The rules text below says what makes an answer thin enough to probe, and
 * forbids the interviewer from revealing what a good answer contains. That is
 * mark-scheme-adjacent: a candidate who read it would know both the trigger and
 * the thing being withheld. lib/interviews/types.ts is imported by the
 * candidate page and ships in its bundle, so the SHAPE lives there and the
 * WORDS live here. Do not move them.
 *
 * Same instinct as questions_snapshot, which deliberately omits rubric,
 * competency and weight because it is read to build the candidate payload.
 *
 * ── Global constants, not per-job settings ───────────────────
 *
 * "The same rules for every candidate" is a locked decision. If the limit or
 * the rules text were job columns they would be per-job editable, and that
 * guarantee would be a habit of the UI rather than a fact about the system.
 * Only the interviewer's NAME is per-job.
 */

/**
 * Bump on ANY change to the rules text below.
 *
 * Same discipline as PROMPT_VERSION on the scorers: it is what lets a stored
 * session be traced to the exact wording that governed it. The snapshot also
 * stores the text verbatim, because a constant can be edited without anyone
 * bumping its version and then the version alone would be a claim, not a record.
 */
export const FOLLOW_UP_RULES_VERSION = "follow-up-v1";

/**
 * Illustrative until the blocking question is answered.
 *
 * AI-VIDEO-INTERVIEW-PHASE-1.md: what the provider's AI may see when it decides
 * an answer is thin is unresolved, and this wording assumes our proposal — the
 * base question and its criterion, never the rubric. If that is decided the
 * other way, this text changes and FOLLOW_UP_RULES_VERSION bumps with it.
 *
 * The accent line is not boilerplate. Remotiv's scorer is forbidden from
 * treating hesitation, filler or non-native grammar as weakness; nothing binds
 * the provider's trigger unless we say so here, and a trigger that fires more
 * often on non-native speakers hands out extra chances by accent.
 */
export const FOLLOW_UP_RULES: LiveSettings["follow_up_rules"] = {
  when: "Only when the answer is thin: it does not address the base question with specifics.",
  scope: "Stay on the base question's criterion. Never introduce a new topic.",
  never: [
    "Treat hesitation, filler words, accent or non-native grammar as a thin answer.",
    "Reveal what a good answer contains.",
  ],
};

/** The send's refusal for a job with fewer than 4 or more than 8 questions (#19). */
export const LIVE_QUESTION_COUNT_ERROR =
  "This job needs 4 to 8 AI Video Interview questions. Add them on the AI Video Interview step (step 6) of the job's settings, then send again.";

/** The send's refusal for a job whose mode or length is not one the interview allows. */
export const LIVE_SETTINGS_UNREADABLE_ERROR =
  "This job's AI Video Interview mode or length could not be read. Open the job, check them on the AI Video Interview step (step 6), and save it again.";

/** Interviews are conducted in English; the transcriber is pinned to it too. */
const LIVE_LANGUAGE = "en";

export type BuildLiveSettingsResult =
  | { ok: true; settings: LiveSettings }
  | { ok: false; error: string };

/**
 * THE gate on sending an AI Video Interview. The only way to obtain frozen live
 * settings, and so the only way a live session can be created with them.
 *
 * ── The only way through ─────────────────────────────────────
 *
 * sendLiveInterviewInvite (applicants/interview-actions.ts) is the send path,
 * and it gets its frozen settings from here. buildLiveSettings below is
 * deliberately NOT exported, and a live session needs its output. Do not
 * export it to "just build the snapshot" — that is exactly the skip this
 * arrangement exists to prevent.
 *
 * ── In order ─────────────────────────────────────────────────
 *
 *   1. The company is on the AI Video Interview allowlist
 *      (live-availability.ts). Checked before any database read, and here
 *      rather than in the action, so no caller can pass the gate without it.
 *   2. The job's toggle is on.
 *   3. The job has 4 to 8 interview questions (#19, 23 Nov), counted here on
 *      the server, before the send writes, freezes or sends anything. Never
 *      the browser's count.
 *   4. The job's mode and length (24 Nov) are ones the interview allows:
 *      structured or ai_guided, 30 or 60 minutes. Frozen as interview_mode,
 *      max_follow_ups_per_base_question (0 or 2) and max_session_seconds (1800
 *      or 3600). A later edit to the job reaches only a later invite; a restart
 *      copies the original settings and never reads the job.
 *
 * The interviewer is always Sarah (LIVE_INTERVIEWER_NAME, 24 Nov): the job's
 * old avatar_interviewer_name column is not read, so a job saved with another
 * name is sent as Sarah from now on. Sessions already invited keep the name
 * frozen in their live_settings.
 *
 * Mirrors how async_interview_enabled gates sendInterviewInvite
 * (applicants/interview-actions.ts):
 *
 *   · Re-read here, server-side, from the live job row. The caller passes an
 *     id and nothing else; whatever the client believes about the toggle is
 *     neither asked for nor believed.
 *   · `=== true`, not `!== false`: the column defaults to FALSE, so an absent
 *     or null value must refuse.
 *   · Scoped to the company as well as the id. The caller is expected to have
 *     checked the application and the hiring team already; this does not rely
 *     on it.
 *
 * The column is still called avatar_interview_enabled. The feature is AI Video
 * Interview and has no avatar in Phase 1, but renaming the column would be a
 * migration with no change in behaviour — see the note in job-types.ts.

 */
export async function gateLiveInterviewInvite(
  service: ReturnType<typeof createServiceClient>,
  input: { jobId: string; companyId: string },
): Promise<BuildLiveSettingsResult> {
  if (!liveInterviewsAvailableFor(input.companyId)) {
    return { ok: false, error: "AI Video Interviews aren't available yet." };
  }

  const { data } = await service
    .from("jobs")
    .select("avatar_interview_enabled, live_interview_mode, live_interview_minutes")
    .eq("id", input.jobId)
    .eq("company_id", input.companyId)
    .maybeSingle();
  const row = data as {
    avatar_interview_enabled: boolean | null;
    live_interview_mode: unknown;
    live_interview_minutes: unknown;
  } | null;

  if (!row) return { ok: false, error: "Job not found in your workspace." };
  if (row.avatar_interview_enabled !== true) {
    return {
      ok: false,
      error:
        "AI Video Interviews are switched off for this job. Turn them on in the AI Video Interview step (step 6) of the job's settings, then send again.",
    };
  }

  // How many questions the job has, for the mix (23 Nov, #13): every one is
  // asked. Read the way the invite reads its questions_snapshot. A job saved
  // between the two reads can make them differ; the freeze compares them and
  // refuses a mismatch (live-question-freeze.ts), so neither is trusted alone.
  // The AI Video Interview's own list only (082): the async questions are
  // never asked live and never counted here.
  const { data: questions, error: questionsErr } = await service
    .from("interview_questions")
    .select("id")
    .eq("job_id", input.jobId)
    .eq("company_id", input.companyId)
    .eq("interview_kind", "live")
    .limit(50);
  if (questionsErr) return { ok: false, error: "Couldn't send - please try again." };

  // The job's mode and length (migration 074), frozen now, from the allowed
  // set only. The columns' checks make anything else unstorable; a value that
  // is not one of them anyway is refused rather than guessed.
  const mode = row.live_interview_mode;
  const seconds =
    typeof row.live_interview_minutes === "number" ? row.live_interview_minutes * 60 : NaN;
  if (
    (mode !== "structured" && mode !== "ai_guided") ||
    !(LIVE_SESSION_SECONDS as readonly number[]).includes(seconds)
  ) {
    return { ok: false, error: LIVE_SETTINGS_UNREADABLE_ERROR };
  }
  const jobQuestionCount = (questions ?? []).length;
  if (jobQuestionCount < MIN_JOB_QUESTIONS || jobQuestionCount > MAX_JOB_QUESTIONS) {
    return { ok: false, error: LIVE_QUESTION_COUNT_ERROR };
  }

  return { ok: true, settings: buildLiveSettings({ jobQuestionCount, mode, seconds }) };
}

/**
 * Freeze the settings for one live invite. Private to this module: reach it
 * through gateLiveInterviewInvite above, which has already refused everything
 * that can be wrong. Every field is a constant except the question count.
 */
function buildLiveSettings(input: {
  jobQuestionCount: number;
  mode: LiveInterviewModeSetting;
  /** 1800 or 3600: the gate has checked. */
  seconds: number;
}): LiveSettings {
  return {
    v: LIVE_SETTINGS_VERSION,
    interviewer_name: LIVE_INTERVIEWER_NAME,
    language: LIVE_LANGUAGE,
    // Recruiter-Defined asks the questions as written: no follow-ups.
    // AI-Guided may follow up twice on each (decided 24 Nov).
    interview_mode: input.mode,
    max_follow_ups_per_base_question: LIVE_MODE_FOLLOW_UPS[input.mode],
    // A maximum, not a target: the interview ends when its questions do.
    max_session_seconds: input.seconds,
    follow_up_rules_version: FOLLOW_UP_RULES_VERSION,
    follow_up_rules: FOLLOW_UP_RULES,
    // The policy's mix, copied now so a later policy change never reaches
    // an interview already sent: every job question, no CV questions
    // (question-mix.ts). The gate has refused a count outside 4..8; the
    // freeze checks it again against the invite's own snapshot.
    question_mix: jobQuestionMix(input.jobQuestionCount, input.seconds / 60),
  };
}
