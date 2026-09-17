import "server-only";
import { JOB_INTERVIEWER_NAME_MAX } from "@/app/ai-dashboard/lib/job-types";
import type { createServiceClient } from "@/lib/supabase/server";
import { liveInterviewsAvailableFor } from "./live-availability";
import {
  LIVE_SETTINGS_VERSION,
  type LiveSettings,
  MAX_FOLLOW_UPS_PER_BASE_QUESTION,
  MAX_SESSION_SECONDS,
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
 *   3. The job has an interviewer name.
 *
 * Mirrors how async_interview_enabled gates sendInterviewInvite
 * (applicants/interview-actions.ts):
 *
 *   · Re-read here, server-side, from the live job row. The caller passes an
 *     id and nothing else; whatever the client believes about the toggle or
 *     the name is neither asked for nor believed.
 *   · `=== true`, not `!== false`: the column defaults to FALSE, so an absent
 *     or null value must refuse.
 *   · Scoped to the company as well as the id. The caller is expected to have
 *     checked the application and the hiring team already; this does not rely
 *     on it.
 *
 * The column is still called avatar_interview_enabled. The feature is AI Video
 * Interview and has no avatar in Phase 1, but renaming the column would be a
 * migration with no change in behaviour — see the note in job-types.ts.
 *
 * The wizard and the save action now refuse the toggle without a name, so the
 * name refusal inside buildLiveSettings should be unreachable for any job
 * saved since. It stays: rows written before that rule, or by any future
 * writer that skips the wizard, still meet it here, before a candidate does.
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
    .select("avatar_interview_enabled, avatar_interviewer_name")
    .eq("id", input.jobId)
    .eq("company_id", input.companyId)
    .maybeSingle();
  const row = data as {
    avatar_interview_enabled: boolean | null;
    avatar_interviewer_name: string | null;
  } | null;

  if (!row) return { ok: false, error: "Job not found in your workspace." };
  if (row.avatar_interview_enabled !== true) {
    return {
      ok: false,
      error:
        "AI Video Interviews are switched off for this job. Turn them on under More options in the job's settings, then send again.",
    };
  }
  return buildLiveSettings({ interviewerName: row.avatar_interviewer_name });
}

/**
 * Freeze the settings for one live invite, or refuse and say why.
 *
 * Private to this module. Reach it through gateLiveInterviewInvite above.
 *
 * ── Refusing is the point ────────────────────────────────────
 *
 * Only one field can be missing: the interviewer's name. Everything else is a
 * constant above. `jobs.avatar_interviewer_name` is null whenever the toggle is
 * on and nobody typed a name — reachable today, and the state of every job that
 * has ever enabled it, since the field has never been required.
 *
 * A fallback name would mean the candidate speaks to an interviewer the company
 * never named. Freezing an incomplete snapshot and failing later would be worse:
 * the CANDIDATE would absorb, at join time, a configuration mistake the
 * recruiter could have fixed in the wizard. And "frozen at invite" only means
 * something if the snapshot is complete at invite — filling a gap afterwards
 * means the governing settings were decided after the invite went out.
 *
 * So the check belongs here, at the freeze, where the recruiter is standing.
 * The error text follows sendInterviewInvite's existing refusal for a job with
 * no questions: name the missing thing and where to fix it.
 *
 * ── No longer a dead end ─────────────────────────────────────
 *
 * The wizard and createCompanyJob/updateCompanyJob now refuse to save the
 * toggle on without a name, so a recruiter is told while they are in the form
 * rather than at send time. This refusal remains the last line for rows that
 * never went through that rule.
 */
function buildLiveSettings(input: {
  /** jobs.avatar_interviewer_name, as stored. Null when never set. */
  interviewerName: string | null;
}): BuildLiveSettingsResult {
  const name = (input.interviewerName ?? "").trim().slice(0, JOB_INTERVIEWER_NAME_MAX);
  if (!name) {
    return {
      ok: false,
      error:
        "This job has no interviewer name, so there's nobody for the AI to introduce itself as. Add one under More options in the job's settings, then send again.",
    };
  }

  return {
    ok: true,
    settings: {
      v: LIVE_SETTINGS_VERSION,
      interviewer_name: name,
      language: LIVE_LANGUAGE,
      max_follow_ups_per_base_question: MAX_FOLLOW_UPS_PER_BASE_QUESTION,
      max_session_seconds: MAX_SESSION_SECONDS,
      follow_up_rules_version: FOLLOW_UP_RULES_VERSION,
      follow_up_rules: FOLLOW_UP_RULES,
    },
  };
}
