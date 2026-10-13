import type { CompanyRole } from "@/app/ai-dashboard/lib/company-roles";
import type {
  FinalDuration,
  FinalEvaluationBasis,
  FinalOutcomeStatus,
  FinalRecommendation,
  InterviewType,
} from "./constants";

/**
 * Shapes shared by the server actions and the drawer card. Kept
 * out of the "use server" module, which may only export async functions.
 */

/** A member who may take part in a final round, as the picker shows them. */
export type EligibleMember = {
  memberId: string;
  name: string;
  role: CompanyRole;
  /** On this job's hiring team. Owner and admin are eligible without it. */
  onHiringTeam: boolean;
  /** An active Google Calendar connection, which only the HOST needs. */
  calendarConnected: boolean;
};

export type FinalInterviewOptions = {
  /** Every eligible member, with the calendar flag; only connected ones may host. */
  hosts: EligibleMember[];
  interviewers: EligibleMember[];
  types: { value: InterviewType; label: string | null }[];
  durations: readonly FinalDuration[];
  defaultDuration: FinalDuration;
  maxExtraInterviewers: number;
};

export type ScheduleFinalInterviewInput = {
  applicationId: string;
  interviewType: string;
  customLabel?: string | null;
  hostMemberId: string;
  interviewerMemberIds?: string[];
  durationMinutes?: number;
};

/**
 * Where one final interview stands, derived from its row and its latest
 * booking. `not_sent` means no link has ever gone out for it.
 */
export type FinalInterviewBookingState =
  | "not_sent"
  | "invited"
  | "expired"
  | "booked"
  | "booking_cancelled";

/**
 * What the Final interviews card says about one interview's recording
 * (recording step 5). Derived on the server from the live bot row of the
 * interview's current booking and the interview's ready recording, if any.
 *
 *   none          no bot row: recording is off, or never scheduled. The card
 *                 shows nothing new.
 *   scheduled     the recorder will join at joinAt
 *   waiting       in the Google Meet waiting room
 *   in_call       in the call, not recording yet
 *   recording     recording has started
 *   saving        the call ended, or the import is copying it
 *   ready         a recording can be watched (recordingId)
 *   not_recorded  the recorder failed or could not be scheduled (reason)
 *   save_failed   the import failed
 *   deleted       saved, then deleted by the retention purge
 *   gone          saved, but its recording row is missing or not ready: an
 *                 inconsistency, said plainly rather than hidden
 *   unavailable   the recording facts could not be read; never shown as none
 */
export type FinalRecordingState =
  | "none"
  | "scheduled"
  | "waiting"
  | "in_call"
  | "recording"
  | "saving"
  | "ready"
  | "not_recorded"
  | "save_failed"
  | "deleted"
  | "gone"
  | "unavailable";

export type FinalRecordingSummary = {
  state: FinalRecordingState;
  /** scheduled: when the recorder joins. */
  joinAt: string | null;
  /** not_recorded: the same reason line the host's email gives, if there is one. */
  reason: string | null;
  /** ready: the recording to ask playback for. Never a storage path or a URL. */
  recordingId: string | null;
  /** ready: when it was recorded (its booking's start) or uploaded. */
  recordedAt: string | null;
  /** ready: made by the recorder, or uploaded by a person. */
  origin: "recorder" | "upload" | null;
  /** ready: it came from an earlier booking than the interview's current one. */
  fromEarlierBooking: boolean;
};

export type FinalInterviewView = {
  id: string;
  interviewType: InterviewType;
  label: string;
  status: "active" | "completed" | "no_show" | "cancelled";
  host: { memberId: string; name: string };
  interviewers: { memberId: string; name: string }[];
  createdByName: string | null;
  createdAt: string;
  cancelledAt: string | null;
  completedAt: string | null;
  /** The booked call's scheduled start has passed. Evaluations and the outcome wait for it. */
  started: boolean;
  /** The viewer may add a new evaluation now. After a no-show only an existing one can be edited. */
  canEvaluate: boolean;
  /** The viewer may mark this interview completed or no-show, or undo that, now. */
  canSetOutcome: boolean;
  booking: {
    state: FinalInterviewBookingState;
    durationMinutes: number;
    expiresAt: string | null;
    scheduledStart: string | null;
    scheduledEnd: string | null;
    hostTimezone: string | null;
    candidateTimezone: string | null;
    meetingUrl: string | null;
    canCancel: boolean;
    cancelledBy: string | null;
    cancelReason: string | null;
  };
  recording: FinalRecordingSummary;
};

/** One person's evaluation, as the card shows it. */
export type FinalEvaluationView = {
  memberId: string;
  name: string;
  isYou: boolean;
  rating: number;
  recommendation: FinalRecommendation;
  basis: FinalEvaluationBasis;
  notes: string | null;
  submittedAt: string;
  updatedAt: string;
  /** updated_at is later than submitted_at. */
  edited: boolean;
};

/**
 * What one interview's evaluations look like to the viewer. Blind until they
 * submit: before that, `evaluations` is empty and only the count is known.
 */
export type FinalEvaluationsView = {
  canEvaluate: boolean;
  submittedCount: number;
  own: FinalEvaluationView | null;
  /** Everyone's, the viewer's included, newest submission first. Empty until `own` exists. */
  evaluations: FinalEvaluationView[];
};

export type SubmitFinalEvaluationInput = {
  finalInterviewId: string;
  rating: number;
  recommendation: string;
  basis: string;
  notes?: string | null;
};

export type SetFinalOutcomeInput = {
  finalInterviewId: string;
  status: FinalOutcomeStatus;
};
