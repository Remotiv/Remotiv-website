import "server-only";
import { JOB_INTERVIEWER_NAME_MAX } from "@/app/ai-dashboard/lib/job-types";
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
 * Freeze the settings for one live invite, or refuse and say why.
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
 * ── TODO, not built yet ──────────────────────────────────────
 *
 * The wizard should make the interviewer name REQUIRED while the live toggle is
 * on. Until it does, this refusal is a dead end discovered at send time: the
 * recruiter is told to go back and fill in a field the form let them skip.
 * Deliberately not built with this change — see the Phase 1 scope.
 */
export function buildLiveSettings(input: {
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
