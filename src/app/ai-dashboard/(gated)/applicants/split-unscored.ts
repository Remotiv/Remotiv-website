import type {
  ApplicantScoreDetail,
  ApplicantScoringFacts,
  CompanyApplicantRow,
} from "@/app/ai-dashboard/lib/applicant-types";
import { type UnscoredCard, unscoredCardState } from "@/app/ai-dashboard/lib/unscored-card";

/**
 * The Split panel's unscored block (Applicants_Split_v9.md section 2,
 * "Unscored"): what the panel says at the top of its body when there is no
 * number to show.
 *
 * The state is the drawer's own: unscoredCardState, from the same facts, read
 * by the panel's existing detail read (no extra request). Only the words for
 * two states are v9's - in progress (dashed, "Scoring this CV") and an
 * unreadable CV (solid, "No readable CV text"). Every other state keeps the
 * drawer's exact heading and body, solid. The controls (Re-score, upload, job
 * settings) stay in the drawer, one click away behind Details.
 *
 * Pure, so split-unscored.test.ts can walk every branch.
 */

export type SplitUnscoredBlock = { heading: string; body: string; dashed: boolean };

/**
 * Null: no block - the applicant has a number, or the read failed (the panel
 * never guesses a state it could not read). "loading": the read for this
 * applicant has not landed yet.
 */
export type SplitUnscored = SplitUnscoredBlock | "loading" | null;

/** The panel's detail read for one applicant, as the client keeps it. */
export type SplitScoringRead = {
  id: string;
  ok: boolean;
  scoreDetail: ApplicantScoreDetail | null;
  scoring: ApplicantScoringFacts | null;
};

const SCORING_THIS_CV: SplitUnscoredBlock = {
  heading: "Scoring this CV",
  body: "The CV is still being scored. Nothing is shown until the score is ready - a number is never guessed.",
  dashed: true,
};

const NO_READABLE_TEXT: SplitUnscoredBlock = {
  heading: "No readable CV text",
  body: "We couldn't read text from this CV, so it wasn't scored. A number is never guessed.",
  dashed: false,
};

export function splitUnscoredCopy(card: UnscoredCard): SplitUnscoredBlock {
  if (card.kind === "in_progress" || card.kind === "retrying") return SCORING_THIS_CV;
  if (card.kind === "unreadable_cv") return NO_READABLE_TEXT;
  return { heading: card.heading, body: card.body, dashed: false };
}

export function splitUnscored(input: {
  row: CompanyApplicantRow;
  read: SplitScoringRead | null;
  /** The re-score roles, as the drawer passes them: they decide two bodies' wording. */
  canEdit: boolean;
  now?: Date;
}): SplitUnscored {
  const { row, canEdit, now } = input;
  const read = input.read?.id === row.id ? input.read : null;
  // The same score the identity row's ring shows: the detail read wins once it lands.
  const header = read?.scoreDetail ?? row.score;
  if (header.status === "scored" && header.overall != null) return null;
  if (!read) return "loading";
  if (!read.ok || !read.scoring) return null;
  return splitUnscoredCopy(
    unscoredCardState({
      scoreStatus: read.scoreDetail?.status ?? null,
      scoreError: read.scoreDetail?.error ?? null,
      hasCv: row.has_cv,
      cvExpired: row.cv_expired,
      facts: read.scoring,
      canEdit,
      jobId: row.job_id,
      now,
    }),
  );
}
