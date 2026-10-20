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
   * A recruiter filed this person by hand; they did not submit an application.
   *
   * How they ARRIVED, which is not where they ARE — pipeline_stage is still
   * 'applied', because a manual add is an application coming through a
   * different door and not a step further along. Two columns, two facts.
   *
   * Derived from source = 'manual_upload' rather than passed raw, so the
   * caveat in the mapper has one place to live. See it before trusting this.
   */
  added_manually: boolean;
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
export const WORTH_A_LOOK_STAGES: readonly PipelineStage[] = ["applied", "screening"];

/** Does this row wear the "Worth a look" mark right now? */
export function showsWorthALook(row: {
  pipeline_stage: PipelineStage;
  shortlist: ApplicantShortlist;
}): boolean {
  return row.shortlist.flaggedAt !== null && WORTH_A_LOOK_STAGES.includes(row.pipeline_stage);
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

/**
 * The exact `error` text handleAiCvScore writes when the company's monthly AI
 * scoring allowance refused a first score. Lives here for the same reason as
 * SCORING_OFF_REASON: the drawer keys its "limit reached" card on this value,
 * never on the wording of a skip.
 */
export const CV_LIMIT_REACHED_REASON = "Not scored - the monthly AI scoring limit was reached.";

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
  /**
   * Is there a number to show and rank by?
   *
   * 'scored' when the AI scored the CV OR a human put a number on it — a
   * recruiter correcting a CV the model skipped has scored it, and the page
   * must not call that unscored. So this is NOT the stored column; it is the
   * question the ring, the sort and the Worth-a-look threshold all ask.
   */
  status: ScoreStatus;
  /**
   * What the AI's own attempt did — the stored `application_scores.status`,
   * never synthesized.
   *
   * Separate from `status` because (B) splits one word into two questions. Only
   * this one may gate the AI's scorecard: the Evidence boxes render all four
   * always, and the empty must-haves box says "this score was written before
   * the job named its must-haves", which is a lie on a CV the model never read.
   */
  ai_status: ScoreStatus;
  /**
   * human_adjusted_score when a human has overridden, otherwise the AI's
   * overall_score. Null unless `status` is 'scored'.
   */
  overall: number | null;
  /**
   * The MODEL's own number — never replaced by the override, and null unless
   * the model's own attempt SUCCEEDED.
   *
   * Carried separately so an adjusted score can be shown next to what the AI
   * actually said. Collapsing the two would destroy the only comparison the
   * calibration data rests on: without the original, an override records that
   * a human disagreed but not by how much or in which direction.
   *
   * Gated on `ai_status`, not `status`. A re-score that FAILED leaves the
   * previous attempt's overall_score in the row; presenting that as "the AI
   * said 80" beside a human's 65 would invite a comparison against a number
   * the model is no longer standing behind.
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
  /**
   * The job stated nothing for this dimension to be judged against, so `score`
   * is the model's invention and was excluded from the overall.
   *
   * Rendered as "not scored" rather than as a number — see the drawer. Absent
   * on every scorecard written before the flag existed, which is correct: those
   * cards DID average the number in, and showing them as if they hadn't would
   * misdescribe the overall sitting next to it.
   */
  unstated?: boolean;
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
export type ScoreMustHaveRow = {
  /** The employer's own wording. */
  item: string;
  status: "evidenced" | "not_found";
  /** Verified CV span. Empty when not_found. */
  quote: string;
};

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
  /**
   * The job's named must-haves AS THIS CARD SAW THEM, one entry each, in the
   * order the employer named them. Empty both for a job that named none and
   * for a card written before the job named any — which is why the job's
   * CURRENT count travels beside it.
   */
  must_haves: ScoreMustHaveRow[];
  /**
   * How many must-haves the job names TODAY — not how many this card judged.
   *
   * The pair is what makes an empty `must_haves` readable. Zero here means the
   * job asks for none and the card is complete; non-zero against an empty
   * `must_haves` means the card predates them and a re-score is what fills it
   * in. Alone, the two cases are the same empty array.
   *
   * Deliberately NOT the same question as `stale`. A job's criteria_version
   * moves for any criteria edit — a reworded requirement, a weight change —
   * so a stale card may already carry every must-have the job names. This
   * counts only the must-haves.
   */
  job_must_have_count: number;
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

/**
 * Ceiling on one team comment, matching the CHECK in migration 023. Generous
 * enough for a paragraph of reasoning and short of an essay — the thread is a
 * conversation, and the scorecard is where long-form assessment belongs.
 */
export const COMMENT_MAX = 5_000;

/**
 * One row of application_team_comments — the hiring team's thread, NOT
 * application_comments, which is Remotiv's own internal note table.
 *
 * `body` is null exactly when `deletedAt` is set. A deleted comment that still
 * has replies keeps its row so the replies have something to hang from, but it
 * keeps none of its words; see the migration for why the text goes rather than
 * a flag going on.
 */
export type ApplicantComment = {
  id: string;
  /** Null for a root. Roots are the only thing repliable — one level, no more. */
  parentId: string | null;
  /**
   * company_members.id of the author, or null once that member is deleted.
   * Compared against the viewer's own to decide whether Edit and Delete show.
   */
  authorMemberId: string | null;
  /** Snapshotted at write time, so it survives the member row. */
  authorName: string;
  /** Null only for a tombstone. */
  body: string | null;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/** An applicant plus their audit trail, for the detail drawer. */
/**
 * Where an unscored applicant's scoring request stands in the queue, read
 * from background_jobs for the drawer only. Never "failed": the queue writes
 * a retry back as `queued` with `attempts` incremented and `run_after` in the
 * future, and gives up as `dead` - so those are the states that exist.
 *
 *   queued    a job is waiting for its first run
 *   retrying  a job is waiting again after at least one failed attempt
 *   running   a worker holds it right now
 *   dead      every attempt failed; nothing will run without a new request
 *   null      no live or dead job for this application
 */
export type ScoreQueueState = "queued" | "retrying" | "running" | "dead" | null;

/**
 * The facts the drawer's unscored card branches on. STRUCTURAL - none of them
 * is read from the skip reason's wording, so the scorer's copy can change
 * without a card silently falling into the wrong branch.
 */
export type ApplicantScoringFacts = {
  /** The job's AI CV scoring switch as the scorer reads it. Null: the job is gone. */
  jobScoringEnabled: boolean | null;
  /** cv_text is at least MIN_CV_TEXT_CHARS long - the scorer's own floor. */
  cvReadable: boolean;
  queue: ScoreQueueState;
};

export type CompanyApplicantDetail = {
  applicant: CompanyApplicantRow;
  /**
   * Drawer-only, and deliberately NOT on CompanyApplicantRow.
   *
   * Measured at 63.5% of the list payload — 1,578 B of the 2,485 B an average
   * row cost — for a jsonb only the drawer and the CSV ever read. Keeping it off
   * the row type is what stops it being transferred for every applicant on the
   * page to serve the one that is open.
   */
  screening_answers: ScreeningAnswerSnapshot[];
  history: StageHistoryRow[];
  /** Full scorecard for the drawer. Null when never scored. */
  scoreDetail: ApplicantScoreDetail | null;
  scoring: ApplicantScoringFacts;
  /**
   * The team's comment thread, roots and replies together in one flat list
   * ordered oldest-first. The pane nests them; the server does not, because a
   * flat list is what every mutation returns and two shapes would drift.
   */
  comments: ApplicantComment[];
};

/**
 * How many candidates "Review top N" shows, and the most "Top match" chips the
 * list will ever draw.
 *
 * One constant for both because they are now one query. The chips used to be
 * capped client-side over the whole loaded population; the server returns this
 * many scored rows best-first, and the chips are the high-scoring prefix of
 * exactly that list — so the two cannot disagree about who is in the top N.
 */
export const TOP_SCORED_LIMIT = 10;

/**
 * The score a "Top match" chip asserts.
 *
 * A chip marks a GENUINE top match, not merely first place: ranking first in a
 * weak field is not an achievement, and before this rule a candidate scoring 12
 * wore the same lime chip as one scoring 94. When nobody clears the bar NO chip
 * appears, which is the honest outcome.
 *
 * Compared against the same number the server ORDERS by — `effective_score`,
 * i.e. `human_adjusted_score ?? overall_score` — so the chips are a true prefix
 * of the ranking rather than a second opinion about it.
 */
export const TOP_MATCH_MIN_SCORE = 90;

/**
 * The list's sort options.
 *
 * Shared rather than declared in the client because the SERVER now applies the
 * order. A second copy of the union is how the two ends end up disagreeing
 * about what "best" means, and the disagreement would show as rows in the wrong
 * order rather than as a type error.
 */
export type ApplicantSort = "best" | "newest";

/**
 * Rows per page. The server pages, so this is the window it RETURNS — not a
 * client-side slice of a larger array it already holds.
 *
 * It lives here, and `CSV_EXPORT_MAX` derives from it, because the export
 * covers the current page and the server read refuses more ids than the cap.
 * Three independent 20s — the query's range, the client's slice and the export
 * cap — would drift the first time one of them changed, and a page larger than
 * the cap exports nothing at all with nothing in the type system noticing.
 */
export const APPLICANT_PAGE_SIZE = 20;

/** Filters accepted by fetchCompanyApplicants. Every one is applied server-side. */
export type CompanyApplicantQuery = {
  /** Restrict to one job. Must belong to the caller's company. */
  jobId?: string;
  /** Case-insensitive match across name and email. */
  search?: string;
  /** The stage tab. Omitted means every stage. */
  stage?: PipelineStage;
  flaggedOnly?: boolean;
  /** Defaults to "best". */
  sort?: ApplicantSort;
  /** 1-based. Out-of-range pages return no rows, not an error. */
  page?: number;
};

/**
 * One page of applicants plus the size of the population it was drawn from.
 *
 * `total` is the FILTERED total, and it arrives in the same response's
 * `content-range` — so it costs no extra request and cannot disagree with the
 * rows it describes, which two reads at two moments could.
 *
 * `null` means no count came back, which is NOT zero. The page renders an em
 * dash and keeps its rows: a count that failed must not read as "none".
 */
export type CompanyApplicantPage = {
  rows: CompanyApplicantRow[];
  total: number | null;
};

/**
 * Every population figure the Applicants page states, counted server-side.
 *
 * ── Why these are not derived from the rows ──────────────────
 *
 * They used to be: the page loaded every applicant and took `.length` of
 * filtered arrays. That is exactly right while the array IS the population and
 * silently wrong the moment it is a page of it — and each number would go
 * wrong independently, so there would be no single symptom to notice.
 *
 * `total` is NOT fetched. It is the sum of the seven stage counts, because
 * `pipeline_stage` is NOT NULL with a CHECK over exactly these seven values,
 * so the seven partition the table and the sum is exact. Fetching it
 * separately would make the funnel's percentages a ratio of two numbers read
 * at two different moments, which can print 101%.
 *
 * Every field is nullable, and null means UNREADABLE, never zero. A genuine
 * zero is 0. The page renders null as an em dash: a count that fails must not
 * be indistinguishable from an answer of none.
 */
export type ApplicantCounts = {
  /** Per-stage population. Keys are exactly PIPELINE_STAGES. */
  stages: Record<PipelineStage, number | null>;
  /**
   * The sum of `stages`, or null if ANY stage is null.
   *
   * Never a partial sum. Six readable stages out of seven would produce a
   * plausible total that is quietly short by one stage's worth of people.
   */
  total: number | null;
  /** Applied within the last seven days. */
  newThisWeek: number | null;
  /**
   * Jobs with at least one application in the filtered population.
   *
   * Preserves today's definition exactly: `status` and `archived_at` are
   * ignored, so a closed role with applicants still counts. Whether this
   * should mean live roles only is a product question, not this change.
   */
  openRoles: number | null;
  /**
   * Everyone the viewer may see, with NO tab, job, flag or search applied.
   *
   * The one number here that ignores the filters, and it exists to keep one
   * sentence honest. The empty state used to pick its copy off the loaded
   * array: empty meant "No applicants yet". That was sound while the array was
   * the whole population and becomes a lie the moment it is a page of it — a
   * recruiter whose stage tab happens to be empty would be told their company
   * has no applicants at all while thousands sit one tab away.
   *
   * So "No applicants yet" is now a claim about THIS number, and an empty page
   * with a non-zero grandTotal says "Nothing in this view" instead. It ignores
   * `jobId` as well as the rest: a role nobody has applied to yet still sits in
   * a company with applicants, and the "yet" copy talks about the company.
   */
  grandTotal: number | null;
};

/**
 * A job a candidate can be added to, for the Add candidate form's select.
 *
 * Deliberately NOT derived from the applicant rows the way the list's job
 * FILTER is. That set only holds jobs someone has already applied to, so the
 * job you are adding a FIRST candidate to — the whole point of the feature —
 * would be the one job missing from it.
 */
export type AssignableJob = {
  id: string;
  title: string;
};

/**
 * Who is already on this role under the email a recruiter just typed.
 *
 * Carried alongside the refusal rather than baked into its message, for two
 * reasons: the date has to be formatted in the reader's timezone like every
 * other date on the page, and the form offers to open the person — a refusal
 * that names someone without a way to reach them is a dead end.
 */
export type AddApplicantDuplicate = {
  applicationId: string;
  /** The name on the EXISTING row, which may be spelled differently. */
  name: string;
  appliedAt: string | null;
};
