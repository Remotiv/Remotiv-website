import "server-only";
import { allowanceResetDate } from "@/lib/plans-usage-types";
import type { createServiceClient } from "@/lib/supabase/server";

/**
 * The async interview allowance, from the application's side.
 *
 * consume_allowance and release_allowance (migration 037) are the authority.
 * sendInterviewInvite reserves one interview_sent credit before it creates a
 * session or sends an email, and gives that same credit back if anything fails
 * before the email provider accepts the invitation. Once the provider has
 * accepted, the credit is spent and nothing releases it.
 *
 * Rules the database applies:
 *   - an internal company is unlimited;
 *   - a company with no plan is unlimited;
 *   - a plan with no async interview limit is unlimited;
 *   - otherwise every invitation sent counts, re-sends included, against
 *     usage_events of type interview_sent since the start of the calendar
 *     month in Asia/Karachi.
 *
 * Reminders never come here: they are queued by the send and delivered by
 * their own job, which spends nothing. Live AI invites are not capped.
 */

type Service = ReturnType<typeof createServiceClient>;

export const INTERVIEW_SENT_METRIC = "interview_sent";

/** What a recruiter is told when the month's invitations are used up. */
export function interviewLimitMessage(now: Date): string {
  return `This company has used all its async interview invitations for this month. The limit resets on ${allowanceResetDate(now)} or can be raised by Remotiv.`;
}

/** What a recruiter is told when the allowance gave no decision. Nothing was reserved. */
export const INTERVIEW_ALLOWANCE_UNAVAILABLE =
  "The interview couldn't be sent because its monthly allowance couldn't be checked. Nothing was sent. Try again in a moment.";

type ConsumeRow = {
  allowed: boolean;
  unlimited: boolean | null;
  reason: string | null;
  used: number | null;
  allowance: number | null;
  usage_id: string | null;
  period_start: string | null;
};

export type InterviewReservation =
  | { allowed: true; usageId: string; unlimited: boolean; reason: string }
  | { allowed: false; used: number; allowance: number | null };

/**
 * Reserve one interview_sent credit, referenced by the session it will pay for,
 * or learn there is none.
 *
 * Throws when the database gave no decision. No decision means no invitation:
 * nothing was reserved, so nothing needs releasing.
 */
export async function consumeInterviewAllowance(
  service: Service,
  companyId: string,
  sessionId: string,
): Promise<InterviewReservation> {
  const { data, error } = await service.rpc("consume_allowance", {
    p_company: companyId,
    p_metric: INTERVIEW_SENT_METRIC,
    p_ref: sessionId,
  });
  if (error) {
    console.error("[interview-allowance] consume_allowance failed:", error);
    throw new Error("interview invite: the allowance could not be checked");
  }
  const row = (Array.isArray(data) ? data[0] : data) as ConsumeRow | null | undefined;
  if (!row || typeof row.allowed !== "boolean") {
    throw new Error("interview invite: the allowance returned no decision");
  }
  if (!row.allowed) {
    return { allowed: false, used: row.used ?? 0, allowance: row.allowance };
  }
  if (typeof row.usage_id !== "string" || row.usage_id === "") {
    throw new Error("interview invite: the allowance granted a credit without an id");
  }
  return {
    allowed: true,
    usageId: row.usage_id,
    unlimited: row.unlimited === true,
    reason: row.reason ?? "",
  };
}

/**
 * Give a reserved credit back. Never throws: it runs while another failure is
 * being reported, and must not replace it. A failed release leaves the credit
 * counted - the company is charged one invitation too many, never one too few -
 * and says so in the log.
 */
export async function releaseInterviewAllowance(service: Service, usageId: string): Promise<void> {
  try {
    const { data, error } = await service.rpc("release_allowance", { p_usage_id: usageId });
    if (error) {
      console.error("[interview-allowance] release_allowance failed; the credit stays counted:", {
        usageId,
        error,
      });
    } else if (data !== true) {
      console.warn("[interview-allowance] release_allowance removed no row", { usageId });
    }
  } catch (err) {
    console.error("[interview-allowance] release_allowance threw; the credit stays counted:", {
      usageId,
      err,
    });
  }
}
