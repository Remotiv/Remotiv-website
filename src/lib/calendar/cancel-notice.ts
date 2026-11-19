import type { NoticeOutcome } from "./notify";

/**
 * What the canceller is told about the candidate's email (#59, QA #104): a
 * cancellation used to report success whatever the email did. `logId` is the
 * email's row, the one a Retry may claim; null when there is nothing to retry
 * (sent, no address, or nothing was recorded).
 */
export type CancelNotice = {
  candidate: "sent" | "failed" | "no_address";
  bookingId: string;
  logId: string | null;
};

export function cancelNotice(n: NoticeOutcome, bookingId: string): CancelNotice {
  const candidate = n.candidate === "skipped_no_address" ? "no_address" : n.candidate;
  return { candidate, bookingId, logId: candidate === "failed" ? n.candidateLogId : null };
}
