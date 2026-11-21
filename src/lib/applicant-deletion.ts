import type { createServiceClient } from "@/lib/supabase/server";

/**
 * The applicant delete's database steps and its marker (#16, migration 071).
 *
 *   closeApplicationForDeletion   one transaction: the applicant is marked
 *                                 (deletion_started_at, never cleared), every
 *                                 link is closed, queued jobs and messages fail
 *   recordCalendarFailure         Google, while connected, did not confirm an
 *                                 event was removed: kept on the row, and the
 *                                 one thing that offers "Delete anyway"
 *   finishApplicationDeletion     one transaction: sessions, bells, the row,
 *                                 and the calendar cleanups' activation
 *   deletionStartedFor            the marker, read immediately before a
 *                                 provider call (email and WhatsApp)
 *
 * No "server-only" import, so the decisions run under bare node:test; every
 * caller passes in a service-role client it built itself.
 */

type Service = ReturnType<typeof createServiceClient>;

/** 071's SQLSTATE: the guard refused something new for an applicant being deleted. */
export const DELETION_IN_PROGRESS = "RD071";

/** What a message log row says when a send was refused for this reason. */
export const NOT_SENT_DELETING = "Not sent: this applicant is being deleted.";

/** PostgreSQL's undefined_column: the code runs before 071 is applied. */
const UNDEFINED_COLUMN = "42703";

export type CloseResult =
  | { outcome: "closed"; first: boolean; sessionIds: string[]; finalBookingIds: string[] }
  | { outcome: "not_found" }
  | { outcome: "error"; code: string };

export async function closeApplicationForDeletion(
  service: Service,
  companyId: string,
  applicationId: string,
): Promise<CloseResult> {
  const { data, error } = await service.rpc("close_application_for_deletion", {
    p_company_id: companyId,
    p_application_id: applicationId,
  });
  if (error) return { outcome: "error", code: error.code ?? "error" };
  const out = (data ?? {}) as {
    outcome?: string;
    first?: boolean;
    session_ids?: string[];
    final_booking_ids?: string[];
  };
  if (out.outcome === "not_found") return { outcome: "not_found" };
  if (out.outcome !== "closed") return { outcome: "error", code: "contract" };
  return {
    outcome: "closed",
    first: out.first === true,
    sessionIds: Array.isArray(out.session_ids) ? out.session_ids : [],
    finalBookingIds: Array.isArray(out.final_booking_ids) ? out.final_booking_ids : [],
  };
}

export type FinishResult =
  | { outcome: "deleted" }
  | { outcome: "not_found" | "not_closed" }
  | { outcome: "error"; code: string };

export async function finishApplicationDeletion(
  service: Service,
  companyId: string,
  applicationId: string,
  hrefs: string[],
): Promise<FinishResult> {
  const { data, error } = await service.rpc("finish_application_deletion", {
    p_company_id: companyId,
    p_application_id: applicationId,
    p_hrefs: hrefs,
  });
  if (error) return { outcome: "error", code: error.code ?? "error" };
  const outcome = (data as { outcome?: string } | null)?.outcome;
  if (outcome === "deleted" || outcome === "not_found" || outcome === "not_closed") {
    return { outcome };
  }
  return { outcome: "error", code: "contract" };
}

/**
 * Google, while connected, did not confirm an event was removed: recorded on
 * the row, once (the first failure's time stays). Durable on purpose: it is
 * what deleteApplicationAnyway requires, so "Delete anyway" can only follow a
 * failure that really happened. False when the write did not land; the caller
 * then says the delete is blocked and offers nothing more.
 */
export async function recordCalendarFailure(
  service: Service,
  companyId: string,
  applicationId: string,
): Promise<boolean> {
  const { data, error } = await service
    .from("job_applications")
    .update({ deletion_calendar_failed_at: new Date().toISOString() })
    .eq("id", applicationId)
    .eq("company_id_snapshot", companyId)
    .not("deletion_started_at", "is", null)
    .is("deletion_calendar_failed_at", null)
    .select("id");
  if (error) {
    console.error(`[applicant-deletion] calendar failure not recorded: ${error.code ?? "error"}`);
    return false;
  }
  if (Array.isArray(data) && data.length === 1) return true;
  // Already recorded by an earlier attempt: still true.
  const { data: row } = await service
    .from("job_applications")
    .select("id, deletion_calendar_failed_at")
    .eq("id", applicationId)
    .eq("company_id_snapshot", companyId)
    .maybeSingle();
  return !!(row as { deletion_calendar_failed_at: string | null } | null)
    ?.deletion_calendar_failed_at;
}

/**
 * The marker, read IMMEDIATELY before a provider call (#16). The claim
 * functions already refuse an applicant being deleted (071's guard), but a
 * message claimed before the Close and sent after it got past the claim; this
 * read is what stops it.
 *
 *   "clear"     not being deleted: send
 *   "deleting"  being deleted: do not send
 *   "unknown"   the read failed: do not send now (the caller fails or retries)
 *
 * Before 071 is applied the column does not exist, so nothing can be marked:
 * undefined_column reads as "clear". The limit, for the record: a message the
 * provider has already accepted cannot be recalled by anything here.
 */
export async function deletionStartedFor(
  service: Service,
  input: { applicationId: string; companyId: string },
): Promise<"clear" | "deleting" | "unknown"> {
  const { data, error } = await service
    .from("job_applications")
    .select("id, deletion_started_at")
    .eq("id", input.applicationId)
    .eq("company_id_snapshot", input.companyId)
    .maybeSingle();
  if (error) {
    if (error.code === UNDEFINED_COLUMN) return "clear";
    console.error(`[applicant-deletion] marker read failed: ${error.code ?? "error"}`);
    return "unknown";
  }
  // No row: the applicant is gone, which the senders already handle as
  // deleted. Being deleted is the marker.
  if (!data) return "deleting";
  return (data as { deletion_started_at: string | null }).deletion_started_at
    ? "deleting"
    : "clear";
}

/** The pending deletions a list can show, by applicant id. */
export type PendingDeletion = { id: string; calendarFailed: boolean };

/** #16: what an action refuses with while the applicant's delete is pending. */
export const BEING_DELETED = "This applicant is being deleted, so they can't be changed.";
/** #16: the marker could not be read: refused, never assumed clear. */
export const DELETION_UNCHECKED = "We couldn't check this applicant just now. Try again.";

/**
 * #16: the server-side refusal every applicant-changing action runs, after its
 * own company and job checks and before any write: an applicant whose delete
 * has started cannot be changed (stage, scores, comments, CV, invites,
 * bookings, final interviews, messages, interview notes and scores). The
 * sentence to return, or null to go ahead. A failed read refuses. No
 * application (an interview sent before invites required one): nothing to
 * check.
 */
export async function refuseIfBeingDeleted(
  service: Service,
  input: { applicationId: string | null; companyId: string },
): Promise<string | null> {
  if (!input.applicationId) return null;
  const { data, error } = await service
    .from("job_applications")
    .select("id, deletion_started_at")
    .eq("id", input.applicationId)
    .eq("company_id_snapshot", input.companyId)
    .maybeSingle();
  if (error) {
    // Before 071 nothing can be marked; any other failure refuses.
    if (error.code === UNDEFINED_COLUMN) return null;
    console.error(`[applicant-deletion] marker read failed: ${error.code ?? "error"}`);
    return DELETION_UNCHECKED;
  }
  // No row on this company: not this check's to answer. Unlike a sender, an
  // action whose applicant is gone (an interview reading "Applicant deleted")
  // keeps its own rules; only a set marker refuses here.
  return (data as { deletion_started_at: string | null } | null)?.deletion_started_at
    ? BEING_DELETED
    : null;
}

/**
 * The same, for an action that names an interview session: its applicant, read
 * on this company. A session not found is the caller's own "not found" to say;
 * here it refuses nothing.
 */
export async function refuseIfSessionApplicantBeingDeleted(
  service: Service,
  input: { sessionId: string; companyId: string },
): Promise<string | null> {
  const { data, error } = await service
    .from("interview_sessions")
    .select("application_id")
    .eq("id", input.sessionId)
    .eq("company_id", input.companyId)
    .maybeSingle();
  if (error) return DELETION_UNCHECKED;
  const applicationId = (data as { application_id: string | null } | null)?.application_id ?? null;
  return refuseIfBeingDeleted(service, { applicationId, companyId: input.companyId });
}
