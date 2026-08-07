/**
 * Shapes for the drawer's interview section.
 *
 * A separate module because interview-actions.ts carries "use server" — every
 * export there is compiled into a server action, so a type cannot live in it.
 */

export type InterviewSessionSummary = {
  id: string;
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
