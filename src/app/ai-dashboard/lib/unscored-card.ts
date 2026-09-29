import type { ApplicantScoringFacts, ScoreStatus } from "./applicant-types";

/**
 * What the drawer's score card says when there is no number to show, and
 * which single control - if any - it offers.
 *
 * ── Why this is one function ─────────────────────────────────
 *
 * Three findings shared one root: the card offered "Re-score" in states where
 * a re-score could only reproduce the same result (an unreadable CV, scoring
 * switched off for the job) and said "pending" in states that were not pending
 * at all (a request that never reached the queue, one the queue gave up on).
 * Deciding the copy and the control in one place, from facts rather than from
 * the wording of the last skip reason, is what stops that recurring.
 *
 * ── Precedence, and why ──────────────────────────────────────
 *
 * The order mirrors handleAiCvScore's own skip order where it applies (job
 * gone, then scoring off, then the CV-text floor), with the queue's live
 * states above the CV states because "in progress" is the truer statement
 * while a job is actually waiting - when it runs, the card comes back here and
 * the CV state shows. Terminal queue states sit below the CV states because a
 * dead job with no readable CV should say what to FIX, not what happened.
 *
 * Pure: no server imports, so the test file can enumerate every branch.
 */

export type UnscoredCardControl = "upload" | "rescore" | "job_settings" | null;

export type UnscoredCard = {
  kind:
    | "job_gone"
    | "scoring_off"
    | "in_progress"
    | "retrying"
    | "cv_expired"
    | "no_cv"
    | "unreadable_cv"
    | "ready_to_rescore"
    | "failed"
    | "gave_up"
    | "not_queued";
  heading: string;
  body: string;
  control: UnscoredCardControl;
  /** For job_settings: where the link goes. */
  href?: string;
  /** For job_settings: where inside the page the switch lives. */
  hint?: string;
};

export function unscoredCardState(input: {
  scoreStatus: ScoreStatus | null;
  scoreError: string | null;
  hasCv: boolean;
  cvExpired: boolean;
  facts: ApplicantScoringFacts;
  /** Owner, admin or recruiter: the roles that may re-score, upload and edit jobs. */
  canEdit: boolean;
  jobId: string | null;
}): UnscoredCard {
  const { facts, canEdit } = input;
  const withControl = (card: UnscoredCard): UnscoredCard =>
    canEdit ? card : { ...card, control: null, href: undefined, hint: undefined };

  if (facts.jobScoringEnabled === null) {
    return {
      kind: "job_gone",
      heading: "Nothing to score against",
      body: "The job this application belonged to no longer exists, so a CV score can't be produced.",
      control: null,
    };
  }

  if (facts.jobScoringEnabled === false) {
    return withControl({
      kind: "scoring_off",
      heading: "Scoring off for this job",
      body: canEdit
        ? "AI CV scoring is switched off for this role, so no card is produced. Turn it on in the job's settings and re-score - existing applicants aren't scored automatically."
        : "AI CV scoring is switched off for this role, so no card is produced. An owner, admin or recruiter can turn it on in the job's settings.",
      control: input.jobId ? "job_settings" : null,
      href: input.jobId ? `/ai-dashboard/jobs/${input.jobId}/edit` : undefined,
      hint: input.jobId ? "Under More options → AI CV scoring." : undefined,
    });
  }

  if (facts.queue === "queued" || facts.queue === "running") {
    return {
      kind: "in_progress",
      heading: "Scoring in progress",
      body: "This CV is in the queue and will be scored within a few minutes.",
      control: null,
    };
  }

  if (facts.queue === "retrying") {
    return {
      kind: "retrying",
      heading: "Scoring in progress",
      body: "Scoring hit a temporary problem and is being retried. The card appears here once it goes through.",
      control: null,
    };
  }

  if (input.cvExpired) {
    return {
      kind: "cv_expired",
      heading: "CV no longer held",
      body: "CVs are deleted 24 months after the application, so this one can't be scored or replaced.",
      control: null,
    };
  }

  if (!input.hasCv) {
    return withControl({
      kind: "no_cv",
      heading: "No CV attached",
      body: "There's no CV on this application, so there's nothing to score. Upload one and it will be scored automatically.",
      control: "upload",
    });
  }

  if (!facts.cvReadable) {
    return withControl({
      kind: "unreadable_cv",
      heading: "Couldn't read this CV",
      body: "The file has no readable text - usually a scan or a photo saved as PDF. Re-scoring won't help until there's text to read. Upload a text version and it will be scored automatically.",
      control: "upload",
    });
  }

  if (input.scoreStatus === "skipped") {
    return withControl({
      kind: "ready_to_rescore",
      heading: "Ready to score",
      body: "The card on file was skipped when scoring last ran. What blocked it has since changed, so re-score to produce one.",
      control: "rescore",
    });
  }

  if (input.scoreStatus === "failed") {
    return withControl({
      kind: "failed",
      heading: "Scoring failed",
      body: input.scoreError ?? "Scoring didn't complete. The CV is unaffected.",
      control: "rescore",
    });
  }

  if (facts.queue === "dead") {
    return withControl({
      kind: "gave_up",
      heading: "Scoring didn't complete",
      body: "Scoring was attempted and stopped after several tries. Re-score to try again; if it keeps failing, contact support.",
      control: "rescore",
    });
  }

  return withControl({
    kind: "not_queued",
    heading: "Not queued for scoring",
    body: "This CV was never scored - the request didn't reach the queue. Re-score to send it now.",
    control: "rescore",
  });
}
