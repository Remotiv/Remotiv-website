/**
 * Shapes for the drawer's interview section.
 *
 * A separate module because interview-actions.ts carries "use server" — every
 * export there is compiled into a server action, so a type cannot live in it.
 */

import type { InterviewKind } from "@/lib/interviews/types";

export type InterviewSessionSummary = {
  id: string;
  /** Which option this is — async or AI Video Interview. Labelled in the panel. */
  kind: InterviewKind;
  /** The interview's own score, shown BESIDE the CV score — never merged with
   *  it. They measure different things and a blended number would hide that. */
  score: number | null;
  scoreStatus: string | null;
  /** The model's one-line judgement, shown as the strip's heading. Null until
   *  scored, and null on every session scored before verdicts were written. */
  verdict: string | null;
  /** The paragraph under it. Never trimmed here — a summary cut mid-sentence
   *  reads as a rendering fault rather than as a summary. */
  summary: string | null;
  /** invited | started | submitted | expired | cancelled. Expiry is derived. */
  status: string;
  expiresAt: string;
  submittedAt: string | null;
  startedAt: string | null;
  invitedByName: string | null;
  sentAt: string;
  /** Answers recorded so far, against the job's question count. */
  answered: number;
  total: number;
  /**
   * AI Video Interview only: set once it was restarted or its restart decided
   * (F10). The drawer then offers no send of its own and links to the latest
   * attempt's interview page, where restarts are managed.
   */
  restart?: { latestSessionId: string; restarted: boolean } | null;
  /**
   * AI Video Interview only: the viewer can open its review page (the session's
   * own job is within their hiring team). The drawer links it only when true.
   */
  reviewable?: boolean;
  /**
   * AI Video Interview only: where its restart stands, from its latest attempt
   * (F10 C6e). Null when a restart has nothing to do with it. Never carries the
   * decision's note.
   */
  restartStatus?: LiveRestartStatus | null;
};

export type LiveRestartStatus =
  /** The first attempt can be decided now, or from `availableAt` (an hour after its end). */
  | { kind: "decision_needed"; availableAt: string | null }
  | { kind: "no_restart" }
  | { kind: "restart_sent"; deadline: string }
  | { kind: "restart_expired" }
  | { kind: "restart_in_progress" }
  /** `outcome` is the restart's own final outcome code, when it has one. */
  | { kind: "restart_finished"; outcome: string | null };

/**
 * Everything the drawer's interview section needs in one round trip.
 *
 * `session` alone was not enough once sending became conditional: a job with
 * async interviews switched off has no session AND no way to get one, and the
 * panel has to tell those apart from "nobody has sent one yet".
 */
export type InterviewPanelState = {
  /** The latest session, or null when none has been sent. */
  session: InterviewSessionSummary | null;
  /**
   * The job's async_interview_enabled. False → sendInterviewInvite refuses.
   *
   * Advisory ONLY. It exists so the drawer does not offer an action that will
   * be rejected; the actual gate is re-read server-side inside the send.
   */
  asyncEnabled: boolean;
  /**
   * The job's AI Video Interview toggle (jobs.avatar_interview_enabled).
   * Advisory, like asyncEnabled: the send re-reads it inside the gate.
   */
  liveEnabled: boolean;
  /**
   * Whether this company may send AI Video Interviews at all — the
   * AI_VIDEO_INTERVIEW_COMPANY_IDS allowlist, decided on the server. False in
   * production until launch, and the drawer renders no live send when it is.
   */
  liveAvailable: boolean;
  /** For the "turn it on" link. Null when the application has no job. */
  jobId: string | null;
};
