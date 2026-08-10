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

export type InterviewStatus =
  | "invited"
  | "started"
  | "submitted"
  | "expired"
  | "cancelled";

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
 */
export type CandidateLink = "linked" | "unlinked" | "deleted";

export type InterviewRow = {
  id: string;
  applicationId: string | null;
  jobId: string | null;
  candidateName: string;
  candidateEmail: string;
  candidateLink: CandidateLink;
  jobTitle: string;
  status: InterviewStatus;
  answered: number;
  totalQuestions: number;
  /** Submitted, but every recording has passed its six-month retention. */
  purged: boolean;
  submittedAt: string | null;
  startedAt: string | null;
  expiresAt: string | null;
  sentAt: string;
  invitedByName: string | null;
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
    /** Archived rows, excluded from every other count above. */
    archived: number;
  };
  jobs: { id: string; title: string }[];
  sentThisWeek: number;
  openRoles: number;
};

export type InterviewAnswerView = {
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
 * NOT the same set as InterviewStatus: `cancelled` has no tab (a superseded
 * invite is noise in a reviewer's list) and `archived` is not a status at all
 * — it cuts across every status.
 */
export type InterviewTab =
  | "all"
  | "submitted"
  | "started"
  | "invited"
  | "expired"
  | "archived";

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
  status: InterviewStatus;
  answers: InterviewAnswerView[];
  totalQuestions: number;
  submittedAt: string | null;
  startedAt: string | null;
  expiresAt: string | null;
  sentAt: string;
  deleteAfter: string | null;
  invitedByName: string | null;
  archivedAt: string | null;
  /** Owner, admin, or a member of this job's hiring team. */
  canDelete: boolean;
  purged: boolean;
  notes: InterviewNote[];
  /** The viewer, so a note can offer edit/delete on their own rows only. */
  viewerMemberId: string;
};

export const INTERVIEW_STATUS_LABELS: Record<InterviewStatus, string> = {
  invited: "Not started",
  started: "In progress",
  submitted: "Submitted",
  expired: "Expired",
  cancelled: "Cancelled",
};
