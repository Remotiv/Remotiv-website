/**
 * Shapes shared between the interview reader, its server actions and the
 * client components.
 *
 * A plain module, not the "use server" file: every export there is compiled
 * into a server action, so a type or a constant declared alongside them is a
 * build error. Same split as applicants/interview-types.ts.
 *
 * NOTE what is absent: `video_path`. No shape here can carry one, which is
 * what stops a path reaching the client by accident rather than by review.
 */

import type { InterviewKind } from "./types";

/**
 * `unknown`: a stored status this page does not recognise (#47). Shown as
 * "Needs check", never as invited: no deadline or invite wording applies.
 */
export type InterviewStatus =
  | "invited"
  | "started"
  | "submitted"
  | "expired"
  | "cancelled"
  | "unknown";

export type TranscriptState =
  | "pending"
  | "done"
  | "failed"
  | "skipped"
  /** status said done but the text is empty — treated as its own failure. */
  | "empty";

/**
 * Why a row may have no candidate name.
 *
 * `unlinked` and `deleted` are NOT the same thing and must not share a label:
 * an unlinked session was created without an application (a seeded or manual
 * invite), while a deleted one had an applicant whose record has since been
 * removed. Rendering "Candidate" for both implies we mislaid a name we never
 * had.
 *
 * `unavailable` is the third: there is an applicant, but reading their name
 * failed. It must not fall through to `deleted`, which would state something
 * untrue about the record.
 */
export type CandidateLink = "linked" | "unlinked" | "deleted" | "unavailable";

export type InterviewRow = {
  id: string;
  applicationId: string | null;
  jobId: string | null;
  candidateName: string;
  candidateEmail: string;
  candidateLink: CandidateLink;
  jobTitle: string;
  /** async or live. Shown on every row so the two options are never confused. */
  kind: InterviewKind;
  status: InterviewStatus;
  /**
   * How many answers are recorded, and whether their media is gone.
   *
   * NULL means the answer read FAILED — not that nothing is recorded. The two
   * were indistinguishable while this was `answered: number`: a failed read
   * produced `0`, so a candidate who had answered all five questions rendered
   * as "0/5" and the row stopped being a link, which told a reviewer the
   * recordings were not there.
   *
   * `purged` travels inside rather than beside, because it is derived from the
   * same read: it means rows exist that no longer hold a path, which is a claim
   * only a successful read can make.
   */
  progress: { answered: number; purged: boolean } | null;
  /**
   * How many questions were asked. Null only when NEITHER source could say.
   *
   * Separate from `progress` because it has a second source: the session's own
   * questions_snapshot. A failed answer read leaves the denominator known for
   * every session that carries one, and throwing that away would be a second
   * unknown invented by the first.
   */
  totalQuestions: number | null;
  submittedAt: string | null;
  startedAt: string | null;
  expiresAt: string | null;
  sentAt: string;
  invitedByName: string | null;
  /** Null when nothing has scored this interview yet, or the read failed. */
  score: InterviewScore | null;
  /**
   * True when the score read FAILED, so a null `score` means "unknown", not
   * "not scored". Rendered as "Score unavailable", never as "Not scored".
   */
  scoreUnavailable: boolean;
  /**
   * Set when the interview has been archived out of the working list.
   *
   * A TIMESTAMP, not a status value, for the same reason job archiving is:
   * restoring has to put the row back exactly as it was, and nothing has to
   * remember what "as it was" meant. It is orthogonal to `status` — an
   * archived interview is still submitted, or still expired.
   */
  archivedAt: string | null;
};

export type InterviewListResult = {
  /**
   * The filter every figure below was read for, echoed back by the server.
   *
   * ── Why the result has to carry its own filter ───────────────
   *
   * The chips, their badges and the empty-state copy used to render from the
   * client's own `tab` / `jobId` / `query` state, which changes the instant
   * someone clicks. The result they describe arrives a round trip later. So
   * between the click and the response the page highlighted Expired, counted
   * All, and listed All's rows — three surfaces in one strip disagreeing about
   * which filter they meant.
   *
   * It gets worse when a read fails and the previous numbers are kept: a banner
   * saying "these are from your last load" sits above chips claiming a filter
   * those numbers never belonged to, which is a second wrong statement stacked
   * on the first.
   *
   * Labelling from here makes the strip self-consistent by construction — the
   * highlighted chip, the badges and the rows all come out of one response.
   * The reader's INTENT stays in the client, because that is what the next
   * request is built from and what the text box and the job select must show;
   * it is only the labels on the numbers that come from here.
   */
  applied: {
    status: InterviewTab;
    jobId: string | null;
    query: string;
  };
  rows: InterviewRow[];
  total: number;
  page: number;
  pageSize: number;
  counts: {
    all: number;
    submitted: number;
    started: number;
    invited: number;
    expired: number;
    /**
     * Superseded invites. Charted because `all` counts them: while this had no
     * chip, `all` read 26 against four chips totalling 25 and nothing on the
     * page accounted for the 1.
     */
    cancelled: number;
    /** A stored status this page does not recognise (#47). Its own chip, hidden at 0. */
    unknown: number;
    /** Archived rows, excluded from every other count above. */
    archived: number;
  };
  jobs: { id: string; title: string }[];
  sentThisWeek: number;
  openRoles: number;
};

export type InterviewAnswerView = {
  /** Null on rows transcribed before segments were stored — no seek buttons. */
  hasSegments: boolean;
  score: AnswerScoreView | null;
  id: string;
  position: number;
  questionText: string;
  competency: string | null;
  durationSeconds: number | null;
  hasVideo: boolean;
  purged: boolean;
  transcript: string | null;
  transcriptState: TranscriptState;
  transcriptError: string | null;
  recordedAt: string | null;
};

/**
 * The list's tab vocabulary.
 *
 * Every InterviewStatus now has a tab, plus two that are not statuses: `all`,
 * and `archived`, which cuts across every status rather than being one.
 *
 * `cancelled` used to be omitted on the grounds that a superseded invite is
 * noise in a reviewer's list. That was the wrong trade: `all` counts cancelled
 * rows, so leaving it off meant the chips totalled less than the figure beside
 * them with nothing on the page to explain the difference. A chip that hides
 * itself at zero costs a reviewer nothing and makes the set add up.
 */
export type InterviewTab =
  | "all"
  | "submitted"
  | "started"
  | "invited"
  | "expired"
  | "cancelled"
  | "unknown"
  | "archived";

export type ScoreStatus =
  | "pending"
  | "scored"
  | "failed"
  | "skipped"
  /** The question carries no rubric, so there was nothing to score against. */
  | "norubric";

/** One claim with the span that supports it, and where to hear it. */
export type ScoredEvidence = {
  claim: string;
  quote: string;
  /** Seconds into the recording, or null when the quote could not be located. */
  startSeconds: number | null;
};

/** A reviewer's correction, kept ALONGSIDE the AI's number, never replacing it. */
export type ScoreAdjustment = {
  by: string;
  at: string;
  feedback: string | null;
  /** The AI's original — the comparison is the point. */
  aiScore: number | null;
};

export type AnswerScoreView = {
  status: ScoreStatus;
  /** The AI's number. Survives an adjustment. */
  aiScore: number | null;
  /** What the UI should display — the human's if there is one. */
  shownScore: number | null;
  confidence: string | null;
  reasoning: string | null;
  strengths: ScoredEvidence[];
  concerns: ScoredEvidence[];
  missing: string[];
  adjustment: ScoreAdjustment | null;
  error: string | null;
};

/**
 * A session's AI score, as the UI reads it.
 *
 * `status` is never inferred from a null score — a scorecard that failed and
 * one that was skipped are different facts and render differently, and an
 * absent row (nothing has run) is a third.
 */
export type InterviewScore = {
  status: ScoreStatus;
  /** The AI's number, or null unless status is "scored". */
  overall: number | null;
  /** A reviewer's correction, which always wins in the UI when present. */
  humanScore: number | null;
  verdict: string | null;
  summary: string | null;
  confidence: string | null;
  error: string | null;
  scoredAt: string | null;
  /** When this session's scorecard row was first written (its created_at). */
  firstWrittenAt: string | null;
  adjustment: ScoreAdjustment | null;
  /**
   * The job's behavioural criteria, one entry each, in the order the employer
   * named them. EMPTY for a job that named none AND for a session scored under
   * an older prompt version — the two are indistinguishable here and the UI
   * treats them the same: it renders nothing. There is no distinction worth
   * inventing, since both mean "there is nothing to show".
   */
  criteria: SessionCriterion[];
};

export type SessionCriterion = {
  /** The employer's own wording. */
  item: string;
  status: "evidenced" | "not_found";
  /** Verified transcript span. Empty when not_found. */
  quote: string;
  /**
   * Where the quote sits in the recording, and in which answer.
   *
   * Null when it could not be placed: the quote is verified against the JOINED
   * transcripts, so it is not owned by one answer up front — see
   * placeCriterionQuote for how it is resolved, and for when it cannot be.
   */
  answerId: string | null;
  startSeconds: number | null;
};

export type InterviewNote = {
  id: string;
  body: string;
  /** Snapshotted at write time — who said it THEN, not who they are now. */
  authorName: string;
  /** company_members.id, so the UI can offer edit/delete on your own only. */
  memberId: string;
  createdAt: string;
  updatedAt: string | null;
};

export type InterviewSessionDetail = {
  id: string;
  applicationId: string | null;
  jobId: string | null;
  candidateName: string;
  candidateEmail: string;
  candidateLink: CandidateLink;
  jobTitle: string;
  stage: string;
  kind: InterviewKind;
  status: InterviewStatus;
  answers: InterviewAnswerView[];
  /**
   * How many answers the session has in all: an exact count, or null when the
   * read returned none. `answers` holds at most ANSWERS_SHOWN of them (#46).
   */
  answersTotal: number | null;
  totalQuestions: number;
  submittedAt: string | null;
  startedAt: string | null;
  expiresAt: string | null;
  sentAt: string;
  deleteAfter: string | null;
  invitedByName: string | null;
  archivedAt: string | null;
  score: InterviewScore | null;
  /** Owner, admin, or a member of this job's hiring team. */
  canDelete: boolean;
  /**
   * "Score interview" may be offered: async, submitted, scoring on for the
   * deployment, no scorecard row of any status, no transcript pending, no job
   * live. Derived server-side by scorecardRecoveryEligibility.
   */
  canScore: boolean;
  purged: boolean;
  /**
   * Past delete_after: the AI's explanations, summary and quotes were deleted
   * (async-score-purge.ts) and are not sent. Scores, the verdict and the
   * reviewers' notes remain.
   */
  evidenceDeleted: boolean;
  notes: InterviewNote[];
  /** The viewer, so a note can offer edit/delete on their own rows only. */
  viewerMemberId: string;
};

/** The review page lists at most this many answers, in question order (#46). */
export const ANSWERS_SHOWN = 50;

/**
 * The line under the answer list when it is not the whole session, or null.
 *
 * "Showing 50 of N answers" only with an EXACT total above what is shown.
 * Without a total, a full list cannot be told from a cut one, so it says only
 * "Showing the first 50 answers".
 */
/**
 * Further apart than any one scoring run's two clocks: see scoreUpdatedAfterFirst.
 *
 * On a first write the two timestamps differ only by the app and database
 * clocks, seconds at most. A re-score needs at least a transcribe run and a
 * scoring run, two worker ticks of about a minute each, so a minute separates
 * the two cases. Five minutes (the first value) could hide a re-score an admin
 * set off quickly, such as "Retry all" just after fixing a missing API key.
 */
export const SCORE_UPDATED_GAP_MS = 60_000;

/**
 * Was this scorecard rewritten after it was first written, and when (#28)?
 *
 * Only the scoring rollup writes `scored_at`, and on a first write it lands
 * within seconds of the row's `created_at`. A later rewrite of an existing
 * scorecard needs a new scoring request, and with a row present the only
 * askers left are the transcribe handler and the recovery sweep, both fired by
 * a transcript settling: a replay, or a late recovery. So a gap means a
 * transcript finished after the first scorecard and the score was redone with
 * it. Null for anything else, including a scorecard written once.
 *
 * `firstAt` is when the row was first WRITTEN, not first scored: that first
 * row may have been `skipped` (scoring was off, say) and only this run scored
 * it. The status it had is not stored, so the copy names the write.
 */
export function scoreUpdatedAfterFirst(
  score: Pick<InterviewScore, "status" | "scoredAt" | "firstWrittenAt"> | null,
): { updatedAt: string; firstAt: string } | null {
  if (score?.status !== "scored" || !score.scoredAt || !score.firstWrittenAt) return null;
  const updated = Date.parse(score.scoredAt);
  const first = Date.parse(score.firstWrittenAt);
  if (!Number.isFinite(updated) || !Number.isFinite(first)) return null;
  if (updated - first <= SCORE_UPDATED_GAP_MS) return null;
  return { updatedAt: score.scoredAt, firstAt: score.firstWrittenAt };
}

export function answersShownNote(shown: number, total: number | null): string | null {
  if (total !== null) return total > shown ? `Showing ${shown} of ${total} answers` : null;
  return shown >= ANSWERS_SHOWN ? `Showing the first ${shown} answers` : null;
}

export const INTERVIEW_STATUS_LABELS: Record<InterviewStatus, string> = {
  invited: "Not started",
  started: "In progress",
  submitted: "Submitted",
  expired: "Expired",
  cancelled: "Cancelled",
  unknown: "Needs check",
};
