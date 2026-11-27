import type { InterviewKind } from "./types";

/**
 * How many candidates already hold each kind of interview for a job (#20),
 * for the wizard's "questions changed since invites went out" line.
 *
 * Candidates, never session rows: a re-send leaves a cancelled row and a new
 * one, a restart an abandoned attempt and a new one, and each is still one
 * person. A candidate with an open session counts as "has an invitation";
 * one with none open but a submitted one counts as "completed". So the two
 * numbers never count the same person twice.
 *
 *   open        invited, or started. An invited row past expires_at is
 *               expired (the drawer's own rule: nothing may have swept it
 *               yet). A started one is never excluded by expiry: the
 *               candidate is mid-interview.
 *   completed   submitted, for both kinds (a live interview ends submitted).
 *
 * Cancelled, expired and abandoned rows count for nothing. A row with no
 * application id names no candidate and is skipped.
 *
 * Pure. The read lives on the edit page (jobs/[id]/edit/page.tsx).
 */

/** The read's row limit; reaching it means the counts are "at least". */
export const INVITE_COUNT_READ_LIMIT = 2000;

export type InviteCountRow = {
  application_id: string | null;
  kind: string | null;
  status: string | null;
  expires_at: string | null;
};

export type KindInviteCounts = { open: number; completed: number };

export type JobInviteCounts = Readonly<Record<InterviewKind, KindInviteCounts>> & {
  /** The read hit INVITE_COUNT_READ_LIMIT: there may be more. */
  atLeast: boolean;
};

export const NO_INVITE_COUNTS: JobInviteCounts = {
  async: { open: 0, completed: 0 },
  live: { open: 0, completed: 0 },
  atLeast: false,
};

function isOpen(row: InviteCountRow, now: number): boolean {
  if (row.status === "started") return true;
  if (row.status !== "invited") return false;
  const expires = row.expires_at ? Date.parse(row.expires_at) : Number.NaN;
  // An unreadable expiry is not treated as expired: the drawer would still
  // show the invitation as open.
  return !(expires < now);
}

export function inviteCountsOf(
  rows: readonly InviteCountRow[],
  now: number,
  atLeast = rows.length >= INVITE_COUNT_READ_LIMIT,
): JobInviteCounts {
  const counts: JobInviteCounts = {
    async: { open: 0, completed: 0 },
    live: { open: 0, completed: 0 },
    atLeast,
  };
  for (const kind of ["async", "live"] as const) {
    const open = new Set<string>();
    const completed = new Set<string>();
    for (const row of rows) {
      if (row.kind !== kind || !row.application_id) continue;
      if (isOpen(row, now)) open.add(row.application_id);
      else if (row.status === "submitted") completed.add(row.application_id);
    }
    for (const id of open) completed.delete(id);
    counts[kind].open = open.size;
    counts[kind].completed = completed.size;
  }
  return counts;
}
