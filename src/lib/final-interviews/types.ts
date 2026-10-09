import type { CompanyRole } from "@/app/ai-dashboard/lib/company-roles";
import type { FinalDuration, InterviewType } from "./constants";

/**
 * Shapes shared by the server actions and, in step 3b, the drawer card. Kept
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
};
