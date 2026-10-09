import "server-only";
import type { CompanyRole } from "@/app/ai-dashboard/lib/company-roles";
import { resolveHostEmail } from "@/lib/calendar/bookings";
import type { createServiceClient } from "@/lib/supabase/server";
import { MAX_EXTRA_INTERVIEWERS } from "./constants";
import type { EligibleMember } from "./types";

/**
 * Who may host or sit on a final interview. One source of truth for the two
 * locked rules:
 *
 *   host         an ACTIVE member of this company who is on the job's hiring
 *                team or holds the owner or admin role, AND has an ACTIVE
 *                Google Calendar connection (the event lands on their
 *                calendar, and Meet records to their Drive).
 *   interviewer  the same membership rule, no calendar needed. Added as a
 *                guest on the host's event.
 *
 * Everything is read by company id, so another company's member can never
 * appear, and status is checked here rather than trusted from the picker.
 */

type Service = ReturnType<typeof createServiceClient>;

type MemberRow = {
  id: string;
  name: string | null;
  email: string | null;
  role: string;
};

/** Every member who passes the membership rule, with the calendar flag. */
export async function loadEligibleMembers(
  service: Service,
  companyId: string,
  jobId: string,
): Promise<EligibleMember[]> {
  const [members, team, calendars] = await Promise.all([
    service
      .from("company_members")
      .select("id, name, email, role")
      .eq("company_id", companyId)
      .eq("status", "active"),
    service
      .from("job_hiring_team")
      .select("member_id")
      .eq("company_id", companyId)
      .eq("job_id", jobId),
    service
      .from("calendar_connections")
      .select("member_id")
      .eq("company_id", companyId)
      .eq("status", "active"),
  ]);
  if (members.error) throw new Error("members read failed", { cause: members.error });
  if (team.error) throw new Error("hiring team read failed", { cause: team.error });
  if (calendars.error) throw new Error("calendar read failed", { cause: calendars.error });

  const onTeam = new Set(((team.data ?? []) as { member_id: string }[]).map((r) => r.member_id));
  const connected = new Set(
    ((calendars.data ?? []) as { member_id: string }[]).map((r) => r.member_id),
  );

  const eligible = ((members.data ?? []) as MemberRow[]).filter(
    (m) => m.role === "owner" || m.role === "admin" || onTeam.has(m.id),
  );

  // Names resolved the way the booking emails resolve them: company_members.name
  // is null for every owner, so the fallbacks there are the only reliable ones.
  return Promise.all(
    eligible.map(async (m) => {
      const resolved = m.name?.trim() ? null : await resolveHostEmail(m.id, companyId);
      return {
        memberId: m.id,
        name: m.name?.trim() || resolved?.name?.trim() || resolved?.email || "Team member",
        role: m.role as CompanyRole,
        onHiringTeam: onTeam.has(m.id),
        calendarConnected: connected.has(m.id),
      };
    }),
  );
}

export async function listEligibleHosts(
  service: Service,
  companyId: string,
  jobId: string,
): Promise<EligibleMember[]> {
  return (await loadEligibleMembers(service, companyId, jobId)).filter((m) => m.calendarConnected);
}

export async function listEligibleInterviewers(
  service: Service,
  companyId: string,
  jobId: string,
): Promise<EligibleMember[]> {
  return loadEligibleMembers(service, companyId, jobId);
}

/** May this member host, given the eligible list already loaded? */
export function isEligibleHost(members: EligibleMember[], memberId: string): boolean {
  return members.some((m) => m.memberId === memberId && m.calendarConnected);
}

export type InterviewerPick = { ok: true; memberIds: string[] } | { ok: false; error: string };

/**
 * The extra interviewers, cleaned: duplicates dropped, the host dropped, each
 * one checked against the eligible list, and no more than the maximum.
 */
export function pickInterviewers(
  members: EligibleMember[],
  requested: readonly string[] | null | undefined,
  hostMemberId: string,
): InterviewerPick {
  const eligible = new Set(members.map((m) => m.memberId));
  const memberIds = [...new Set((requested ?? []).map((id) => String(id ?? "").trim()))].filter(
    (id) => id && id !== hostMemberId,
  );
  const unknown = memberIds.find((id) => !eligible.has(id));
  if (unknown) {
    return {
      ok: false,
      error:
        "Every interviewer must be an active member of this job's hiring team, or an owner or admin.",
    };
  }
  if (memberIds.length > MAX_EXTRA_INTERVIEWERS) {
    return {
      ok: false,
      error: `Add at most ${MAX_EXTRA_INTERVIEWERS} interviewers besides the host.`,
    };
  }
  return { ok: true, memberIds };
}
