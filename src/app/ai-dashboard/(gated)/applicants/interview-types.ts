/**
 * Shapes for the drawer's interview section.
 *
 * A separate module because interview-actions.ts carries "use server" — every
 * export there is compiled into a server action, so a type cannot live in it.
 */

export type InterviewSessionSummary = {
  id: string;
  /** The interview's own score, shown BESIDE the CV score — never merged with
   *  it. They measure different things and a blended number would hide that. */
  score: number | null;
  scoreStatus: string | null;
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
};

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
  /** For the "turn it on" link. Null when the application has no job. */
  jobId: string | null;
};
