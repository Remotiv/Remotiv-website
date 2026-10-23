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
  /** For an unconfirmed ending: the restart is the reviewer's decision. Plain text, no action. */
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
  kind: "timing" | "repeat" | "style" | "transcription_failed";
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
};

export type LiveActionResult = { ok: true } | { ok: false; error: string };
export type LiveAudioResult = { ok: true; url: string } | { ok: false; error: string };

export type LiveRecoveryRequest =
  | { action: "retry_transcription"; sessionId: string; turnId: string; note: string }
  | { action: "resolve_failed_transcription"; sessionId: string; turnId: string; note: string }
  | {
      action: "resolve_needs_check" | "resolve_repeat_check" | "resolve_style_check";
      sessionId: string;
      position: number;
      decision: "score" | "exclude";
      note: string;
    };
