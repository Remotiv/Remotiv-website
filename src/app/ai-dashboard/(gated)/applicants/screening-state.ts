import type { ScreeningAnswerSnapshot } from "@/lib/jobs";

/**
 * The drawer's screening answers, keyed by the applicant they belong to.
 *
 * Keyed rather than kept as a bare array because the drawer steps between
 * applicants while a read is in flight, and the answers now arrive separately
 * from the row. An array alone cannot say WHOSE answers it holds, so a late
 * response would paint one candidate's screening answers under another
 * candidate's name — and the two are indistinguishable once rendered.
 *
 * Carrying the id makes that unrepresentable instead of merely guarded: the
 * only way to read answers is through selectScreening, which compares the id
 * and reports "loading" on any mismatch.
 *
 * `answers: null` means the read for THIS id failed. The failure is keyed too,
 * so a failure recorded for one applicant cannot render as a failure for the
 * next one.
 */
export type ScreeningState = { id: string; answers: ScreeningAnswerSnapshot[] | null } | null;

export type Screening =
  | { status: "loading" }
  | { status: "failed" }
  | { status: "ready"; answers: ScreeningAnswerSnapshot[] };

export function selectScreening(state: ScreeningState, openId: string | null): Screening {
  if (!openId || !state || state.id !== openId) return { status: "loading" };
  if (state.answers === null) return { status: "failed" };
  return { status: "ready", answers: state.answers };
}

/**
 * Which screening card to draw.
 *
 * "failed" and "empty" are separate on purpose. Rendering an unreadable
 * screening section as "no screening questions" is a claim about the job —
 * that it asked nothing — made on the strength of a network error, and the
 * reader has no way to tell the difference.
 */
export type ScreeningCard = "loading" | "failed" | "empty" | "list";

export function screeningCard(s: Screening): ScreeningCard {
  if (s.status === "loading") return "loading";
  if (s.status === "failed") return "failed";
  return s.answers.length === 0 ? "empty" : "list";
}

/**
 * The number of screening answers the score summary line may quote, or null
 * when it is not known yet.
 *
 * The line sits inside the scored branch, which renders as soon as the
 * scorecard arrives — before, and independently of, the answers. Null keeps
 * that clause out of the sentence rather than letting it state a count of 0,
 * which reads as "we asked nothing" rather than "we have not loaded it".
 */
export function screeningCount(s: Screening): number | null {
  return s.status === "ready" ? s.answers.length : null;
}
