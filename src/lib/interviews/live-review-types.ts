/**
 * What the recruiter review page is sent about an AI Video Interview
 * (lib/interviews/live-review.ts). A plain module, so the client component can
 * import the shapes.
 *
 * NOTE what no shape here can carry: a scoring guide, a follow-up reason, a
 * storage path, transcript segments, a raw provider error, or anything from the
 * CV. They are not filtered out of these shapes; they have no field to land in.
 */

import type { LiveReviewVideo } from "./live-video-timeline";

export type LiveReviewState =
  | "in_progress"
  | "completed"
  | "partial"
  | "ending_unconfirmed"
  | "incomplete";

export type LiveReviewHeader = {
  state: LiveReviewState;
  /** "Completed", "Partial", "Ending not confirmed - needs review", "Incomplete - 3 of 8 answered", "In progress". */
  label: string;
  answered: number;
  total: number;
  skipped: number;
  completionPercent: number;
  /** Only when the score row's status is 'scored'. Null otherwise, never 0 for "none". */
  overall: number | null;
  /** Short of completed, or completed but held: never ranked against a completed interview. */
  partial: boolean;
  /** Why it is not compared with completed interviews, in plain words; null when it is. */
  partialNote: string | null;
  /** Everything a person should look at, in plain words: the ending, then each open question flag. */
  reviewReasons: string[];
  /**
   * "A restart is your decision", plain text, no action (F10 C6f): set only on
   * the company's review, for an owner or admin, of the latest undecided first
   * attempt while a restart can be decided now or soon. Null otherwise,
   * including the super admin's view and whenever the restart state is unknown.
   */
  restartNote: string | null;
  /** The score row's status, or 'not_scored' when there is none. */
  scoreStatus: "not_scored" | "pending" | "scored" | "incomplete" | "failed";
  /** Why there is no overall, when there is none. */
  scoreNote: string | null;
};

export type LiveReviewAttempt = {
  number: number;
  of: number;
  /** False on an earlier attempt: shown for audit only, never as the result. */
  isLatest: boolean;
  latestSessionId: string;
  /** Earlier attempts of this candidate, oldest first, for the audit link. */
  earlierSessionIds: string[];
};

export type LiveTurnState = "text" | "pending" | "failed" | "no_words" | "purged";

export type LiveReviewTurn = {
  id: string;
  sequence: number;
  speaker: "interviewer" | "candidate";
  /** "Sarah", "Sarah · follow-up", "Candidate". */
  label: string;
  text: string | null;
  state: LiveTurnState;
  hasAudio: boolean;
};

export type LiveQuestionStatus =
  | "answered"
  | "skipped"
  | "not_reached"
  | "excluded"
  | "waiting_review"
  | "waiting";

export type LiveReviewFlag = {
  kind: "timing" | "repeat" | "wording" | "style" | "transcription_failed";
  reason: string;
  /** The holding decision, or null while unresolved. */
  resolved: "score" | "exclude" | "retry" | null;
  /** For a failed transcription: the turn it is about. */
  turnId: string | null;
};

export type LiveReviewQuote = {
  text: string;
  /** The candidate turn the quote is in, for the jump to its audio. */
  turnId: string | null;
  startSeconds: number | null;
  /** The quote's moment on the conversation clock, for the jump in the camera video. */
  atMs: number | null;
};

export type LiveReviewQuestion = {
  position: number;
  source: "job" | "cv" | "general_experience";
  sourceLabel: string;
  text: string;
  /** Display only. */
  followUps: number;
  status: LiveQuestionStatus;
  statusLabel: string;
  statusReason: string | null;
  /** Shown only for an answered question that is counted, or a skipped one (0). */
  score: number | null;
  /** Separate from the score, never part of it. */
  confidence: "high" | "medium" | "low" | null;
  rationale: string | null;
  quotes: LiveReviewQuote[];
  flags: LiveReviewFlag[];
  conversation: LiveReviewTurn[];
};

export type LiveReviewView = {
  sessionId: string;
  interviewerName: string;
  attempt: LiveReviewAttempt;
  header: LiveReviewHeader;
  questions: LiveReviewQuestion[];
  /** The candidate's camera video: confirmed pieces, gaps, and whether it is complete. */
  video: LiveReviewVideo;
  /**
   * The restart decision and its link (F10 C5), on the company's own review
   * only. Absent on the platform review and on views built without it.
   */
  restart?: LiveRestartView | null;
};

/** A recorded restart decision. The note is sent only to an owner or admin; null otherwise. */
export type LiveRestartDecision = {
  decision: "restart" | "no_restart";
  byName: string | null;
  byRole: string;
  at: string;
  note: string | null;
};

/** Why a first attempt cannot be decided yet, as migration 053 and live-restart.ts say it. */
export type LiveRestartReason =
  | "not_live"
  | "not_first_attempt"
  | "not_started"
  | "not_ended"
  | "too_soon"
  | "not_final"
  | "not_eligible_outcome"
  | "already_decided";

export type LiveRestartView =
  | {
      kind: "first_attempt";
      eligible: boolean;
      /** Null when eligible. */
      reason: LiveRestartReason | null;
      /** For too_soon: when it can be decided. */
      availableAt: string | null;
      decision: LiveRestartDecision | null;
    }
  | { kind: "earlier_restarted"; decision: LiveRestartDecision | null }
  | {
      kind: "restart_attempt";
      status: string;
      /** The deadline as the database holds it now. */
      deadline: string | null;
      expired: boolean;
      /** The latest record of its link (migration 055). Absent: unconfirmed. */
      link?: LiveRestartLink;
    };

/**
 * What the page may say about a restart's link email, from its latest record
 * (F10-LOG, migration 055): the email provider accepted it, or did not.
 * Neither ever means the candidate received it. A re-issued token with no
 * later record, no record at all, or records that cannot be ordered are
 * unconfirmed.
 */
export type LiveRestartLink =
  | { status: "sent"; at: string }
  | { status: "failed"; at: string }
  | { status: "unconfirmed" };

/** The codes a restart action returns. Never a database message. */
export type LiveRestartCode =
  | "signed_out"
  | "not_found"
  | "role_not_allowed"
  | "not_latest"
  | "not_eligible"
  | "too_soon"
  | "not_final"
  | "not_eligible_outcome"
  | "already_decided"
  | "note_invalid"
  | "past_retention"
  | "expired"
  | "not_invited"
  | "email_failed"
  | "deadline_not_extended"
  | "db_error";

/**
 * The email went out and its quoted deadline stands, but the deadline was not
 * extended after delivery: it may be slightly less than 72 hours after the
 * actual delivery. Never reported as kept.
 */
export type LiveRestartWarning = "not_extended_after_delivery";

/**
 * A link event (reissued, sent or failed) was not recorded. Nothing was undone
 * or held back for it; the page cannot confirm this send later and says so.
 */
export type LiveRestartRecordWarning = "event_not_recorded";

/** What sending (or re-sending) a restart link did. The session is never cancelled. */
export type LiveRestartSend =
  | {
      emailFailed: false;
      deadline: string;
      warning: LiveRestartWarning | null;
      recordWarning?: LiveRestartRecordWarning;
    }
  | {
      emailFailed: true;
      code: "email_failed" | "not_found" | "db_error";
      recordWarning?: LiveRestartRecordWarning;
    };

export type LiveRestartDecideResult =
  | { ok: true; decision: "no_restart" }
  | ({ ok: true; decision: "restart"; restarted: true; restartSessionId: string } & LiveRestartSend)
  | { ok: false; code: LiveRestartCode };

export type LiveRestartResendResult =
  | ({ ok: true; restartSessionId: string } & LiveRestartSend)
  | { ok: false; code: LiveRestartCode };

/** The restart panel the review page shows, from the view, the viewer and who is looking. */
export type LiveRestartPanel =
  | { panel: "none" }
  | { panel: "decide" }
  | { panel: "awaiting_decision" }
  | { panel: "not_yet"; reason: "too_soon" | "not_final" | "not_ended"; availableAt: string | null }
  | { panel: "decided"; decision: LiveRestartDecision }
  | { panel: "earlier_restarted"; decision: LiveRestartDecision | null }
  | { panel: "restart_invited"; deadline: string | null; canResend: boolean }
  | { panel: "restart_sent"; deadline: string | null; sentAt: string; canResend: boolean }
  | { panel: "restart_failed"; deadline: string | null; canResend: boolean }
  | { panel: "restart_expired" };

const NOT_YET = ["too_soon", "not_final", "not_ended"] as const;

/**
 * Which restart panel to show. Pure, so the page and its tests agree. Only an
 * owner or admin (`canAct`) decides or re-sends; everyone else sees status.
 * A Remotiv super admin (`platform`) sees none of it. A first attempt that can
 * never be restarted (completed, partial, never started) shows nothing; a
 * started or finished restart shows nothing beyond the attempt banner. An
 * invited restart shows its database deadline, its link's latest record (the
 * email provider accepted it, or did not; anything else is unconfirmed) and,
 * for an owner or admin, the re-send. That the candidate received it is never
 * claimed.
 */
export function restartPanelFor(
  restart: LiveRestartView | null | undefined,
  viewer: { canAct: boolean; platform: boolean },
): LiveRestartPanel {
  if (!restart || viewer.platform) return { panel: "none" };
  if (restart.kind === "earlier_restarted") {
    return { panel: "earlier_restarted", decision: restart.decision };
  }
  if (restart.kind === "restart_attempt") {
    if (restart.status !== "invited") return { panel: "none" };
    if (restart.expired) return { panel: "restart_expired" };
    const { deadline } = restart;
    const canResend = viewer.canAct;
    if (restart.link?.status === "sent") {
      return { panel: "restart_sent", deadline, sentAt: restart.link.at, canResend };
    }
    if (restart.link?.status === "failed") return { panel: "restart_failed", deadline, canResend };
    return { panel: "restart_invited", deadline, canResend };
  }
  if (restart.decision) return { panel: "decided", decision: restart.decision };
  if (restart.eligible) return viewer.canAct ? { panel: "decide" } : { panel: "awaiting_decision" };
  const reason = NOT_YET.find((r) => r === restart.reason);
  return reason
    ? { panel: "not_yet", reason, availableAt: restart.availableAt }
    : { panel: "none" };
}

export type LiveActionResult = { ok: true } | { ok: false; error: string };
export type LiveAudioResult = { ok: true; url: string } | { ok: false; error: string };

export type LiveRecoveryRequest =
  | { action: "retry_transcription"; sessionId: string; turnId: string; note: string }
  | { action: "resolve_failed_transcription"; sessionId: string; turnId: string; note: string }
  | {
      action:
        | "resolve_needs_check"
        | "resolve_repeat_check"
        | "resolve_wording_check"
        | "resolve_style_check";
      sessionId: string;
      position: number;
      decision: "score" | "exclude";
      note: string;
    };
