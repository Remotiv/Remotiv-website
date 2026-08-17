import type { ScreeningAnswerSnapshot } from "@/lib/jobs";

/**
 * Company-facing applicant types.
 *
 * A separate file from job-types.ts on purpose: jobs and applicants are
 * different domains with different lifecycles, and job-types.ts is already
 * imported by the wizard, the jobs list and the jobs actions. Keeping the
 * applicant surface apart stops the jobs bundle growing every time the
 * pipeline model does.
 */

/**
 * Company hiring pipeline, stored in `job_applications.pipeline_stage` and
 * audited in `application_stage_history`.
 *
 * Deliberately distinct from `job_applications.status`, which is Remotiv
 * admin's own triage vocabulary ("new" | "shortlisted" | "not_a_fit" | "maybe")
 * and stays under admin control. Two columns, two owners, no coupling.
 */
export const PIPELINE_STAGES = [
  "applied",
  "screening",
  "shortlisted",
  "interview",
  "offer",
  "hired",
  "rejected",
] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

export const PIPELINE_STAGE_LABELS: Record<PipelineStage, string> = {
  applied: "Applied",
  screening: "Screening",
  shortlisted: "Shortlisted",
  interview: "Interview",
  offer: "Offer",
  hired: "Hired",
  rejected: "Rejected",
};

/** One row of the company Applicants table. */
export type CompanyApplicantRow = {
  id: string;
  first_name: string;
  last_name: string;
  email: string;
  phone: string | null;
  linkedin_url: string | null;
  /** Null once the job has been deleted — `job_title` still resolves. */
  job_id: string | null;
  /** Live jobs.title, falling back to the frozen job_title_snapshot. */
  job_title: string;
  screening_answers: ScreeningAnswerSnapshot[];
  city: string | null;
  country: string | null;
  years_experience: number | null;
  notice_period: string | null;
  availability: string | null;
  created_at: string;
  /** Current hiring-pipeline stage. DB default is 'applied'. */
  pipeline_stage: PipelineStage;
  /** AI scoring summary. Never null — an unscored applicant reads 'pending'. */
  score: ApplicantScore;
  /**
   * Whether a CV exists — NEVER the storage path. The path is a capability:
   * handing it to the browser would let anyone with it mint their own signed
   * URL, bypassing the ownership gate and the signed_url_logs audit. Clients
   * open CVs through /api/cv/company-application/[id] instead.
   */
  has_cv: boolean;
  /**
   * The CV existed and was deleted at the end of its retention, rather than
   * never having been supplied.
   *
   * Two different facts that both leave has_cv false, and they must not share
   * a label: "No CV" on an expired application reads as a broken button, or as
   * an applicant who never sent one. Derived from cv_delete_after having
   * passed with no path left — no new column, same trick the interview drawer
   * uses to tell a purged answer from an unanswered question.
   */
  cv_expired: boolean;
  /**
   * The auto-shortlist flag, computed and stored server-side when a score
   * lands. Never derived here — the list and the Flagged count would disagree.
   */
  shortlist: ApplicantShortlist;
};

export type ApplicantShortlist = {
  /** Null when never flagged, or when a recruiter dismissed it. */
  flaggedAt: string | null;
  /** "CV score 94 met the auto-shortlist threshold of 80." */
  reason: string | null;
};

/**
 * Stages on which "Worth a look" is shown.
 *
 * Applied and Screening only. Past that the recruiter has already acted on this
 * person, and a flag urging them to look at someone they have already
 * shortlisted or interviewed is noise — which is what would make the flag stop
 * meaning anything. Top match is NOT gated this way: it is a statement about
 * the score, not a prompt to do something.
 */
export const WORTH_A_LOOK_STAGES: readonly PipelineStage[] = [
  "applied",
  "screening",
];

/** Does this row wear the "Worth a look" mark right now? */
export function showsWorthALook(row: {
  pipeline_stage: PipelineStage;
  shortlist: ApplicantShortlist;
}): boolean {
  return (
    row.shortlist.flaggedAt !== null &&
    WORTH_A_LOOK_STAGES.includes(row.pipeline_stage)
  );
}

/**
 * AI scoring state, from application_scores.
 *
 * 'pending' also covers "no row yet" — a job is queued but hasn't run. The UI
 * treats pending / failed / skipped identically as "no score", which keeps the
 * existing Pending treatment honest: in all three cases there is no number to
 * show, and inventing one would be worse than saying so.
 */
export const SCORE_STATUSES = ["pending", "scored", "failed", "skipped"] as const;
export type ScoreStatus = (typeof SCORE_STATUSES)[number];

/**
 * The exact `error` text handleAiCvScore writes when a job has AI CV scoring
 * turned off, so the client can tell that skip apart from the CV-text ones and
 * say "Scoring off" instead of "No CV text".
 *
 * It lives HERE rather than in lib/ai/cv-scoring.ts because that module pulls
 * in @/lib/supabase/server → next/headers, which a "use client" component may
 * not import at any depth. This file is types-only and is already imported by
 * both sides, so it's the one place the string can be shared rather than
 * duplicated as a literal on each side of the boundary.
 *
 * Changing this string orphans every row already written with the old one —
 * those fall back to the generic "Not scored" label rather than breaking.
 */
export const SCORING_OFF_REASON = "AI CV scoring is turned off for this job.";

export type ScoreConfidence = "high" | "medium" | "low";

/**
 * Ceiling on a human's calibration note.
 *
 * Generous on purpose — the note is the only place anyone explains WHY the
 * model was wrong, which is the part a calibration readout can't reconstruct
 * from two numbers. Long enough for a real paragraph, short enough that it
 * can't be used to stash a CV in the scores table.
 */
export const SCORE_FEEDBACK_MAX = 1_000;

/** Summary attached to every applicant row. Null when never scored. */
export type ApplicantScore = {
  status: ScoreStatus;
  /**
   * human_adjusted_score when a human has overridden, otherwise the AI's
   * overall_score. Null unless status is 'scored'.
   */
  overall: number | null;
  /**
   * The MODEL's own number, always — never replaced by the override.
   *
   * Carried separately so an adjusted score can be shown next to what the AI
   * actually said. Collapsing the two would destroy the only comparison the
   * calibration data rests on: without the original, an override records that
   * a human disagreed but not by how much or in which direction.
   */
  ai_overall: number | null;
  /** True when `overall` came from a human override rather than the model. */
  adjusted: boolean;
  confidence: ScoreConfidence | null;
  /** Why the score is missing, for failed/skipped. */
  error: string | null;
};

export type ScoreDimensionRow = {
  dimension: string;
  score: number;
  reasoning: string;
  /** CV span supporting this dimension. Empty when none was verifiable. */
  quote?: string;
};

/**
 * A strength and its proof, in one object.
 *
 * v1 scorecards stored strengths as bare strings alongside a parallel
 * `evidence` array, and the UI paired them by position — which is how a real
 * quote ended up under an unrelated strength. Reading normalises the old shape
 * to this one so historic rows still render, just without quotes.
 */
export type ScoreStrengthRow = {
  point: string;
  quote: string;
};

export type ScoreEvidenceRow = {
  claim: string;
  quote: string;
};

/** The full breakdown, loaded only for the drawer. */
export type ApplicantScoreDetail = ApplicantScore & {
  /**
   * One-line headline. Empty string for v1-v3 scorecards, which predate it —
   * the UI omits the line entirely rather than inventing one.
   */
  verdict: string;
  dimensions: ScoreDimensionRow[];
  evidence: ScoreEvidenceRow[];
  strengths: ScoreStrengthRow[];
  missing_requirements: string[];
  concerns: string[];
  summary: string | null;
  /** Deterministic screening result, 0-100. Null when the job asked nothing. */
  screening_score: number | null;
  ai_model: string | null;
  scored_at: string | null;
  /**
   * True when the job's scoring criteria have been edited since this card was
   * produced — i.e. application_scores.job_criteria_version is behind
   * jobs.criteria_version.
   *
   * Until updateCompanyJob started incrementing that column it was frozen at 1
   * for every job, so a scorecard judged against last month's requirements was
   * indistinguishable from one judged against today's. This is the flag that
   * makes the difference visible, and the drawer puts the re-score action
   * beside it.
   */
  stale: boolean;
  /** The reviewer's note on why the model was off. Null when not adjusted. */
  human_feedback: string | null;
  /** Identity cache of whoever adjusted — frozen history, not a live lookup. */
  adjusted_by_name: string | null;
  adjusted_at: string | null;
};

/**
 * One row of application_stage_history. The seeded initial entry has a null
 * `from_stage` and renders as just "Applied" rather than an arrow.
 */
export type StageHistoryRow = {
  id: string;
  from_stage: PipelineStage | null;
  to_stage: PipelineStage;
  changed_by_name: string | null;
  note: string | null;
  created_at: string;
};

/** An applicant plus their audit trail, for the detail drawer. */
export type CompanyApplicantDetail = {
  applicant: CompanyApplicantRow;
  history: StageHistoryRow[];
  /** Full scorecard for the drawer. Null when never scored. */
  scoreDetail: ApplicantScoreDetail | null;
};

/** Filters accepted by fetchCompanyApplicants. */
export type CompanyApplicantQuery = {
  /** Restrict to one job. Must belong to the caller's company. */
  jobId?: string;
  /** Case-insensitive match across name and email. */
  search?: string;
};
