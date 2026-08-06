import "server-only";
import { createServiceClient } from "@/lib/supabase/server";

/**
 * In-app notifications for COMPANY members.
 *
 * ── Deliberately not src/lib/notifications.ts ────────────────
 *
 * That module notifies REMOTIV's own staff: it fans out to `admin_users` with
 * role super_admin/admin plus the SUPER_ADMIN_EMAIL shortcut, and writes to
 * the admin `notifications` table. This one notifies a customer's own people,
 * fans out through `job_hiring_team`, and writes to `notifications_company`.
 *
 * Different tables, different audiences, different recipient rules, and a
 * different failure story — an admin notification nobody reads is an internal
 * inconvenience, a company one leaking to the wrong member is a tenancy bug.
 * Merging them would mean one fan-out function with a mode flag, and the first
 * time someone edited it for one product they would be editing the other's
 * security boundary without noticing. They share no code and no types on
 * purpose; the two live in separate directories so an import of the wrong one
 * looks wrong at the call site.
 *
 * ── Failure contract ─────────────────────────────────────────
 *
 * Nothing in here throws. A notification is a courtesy attached to an action
 * that has already happened; failing the stage change because the bell entry
 * could not be written would be strictly worse than a missing bell entry. Same
 * contract as recordUsage and the candidate-email triggers.
 */

export const COMPANY_NOTIFICATION_TYPES = [
  "score_ready",
  "stage_change",
  "applicant_deleted",
  "job_published",
  "job_closed",
  "job_archived",
  "added_to_job",
  "invite_accepted",
  "member_removed",
  "member_role_changed",
] as const;

export type CompanyNotificationType = (typeof COMPANY_NOTIFICATION_TYPES)[number];

/** Types that are company administration, not hiring work. Owner/admin only. */
const TEAM_ADMIN_TYPES = new Set<CompanyNotificationType>([
  "invite_accepted",
  "member_removed",
  "member_role_changed",
]);

type NotifyInput = {
  companyId: string;
  type: CompanyNotificationType;
  title: string;
  body: string;
  /** Drives the recipient set for job/applicant events. */
  jobId?: string | null;
  applicationId?: string | null;
  /** Where the row navigates to. Must be a route the recipient can open. */
  href?: string | null;
  /**
   * The member who caused it. Excluded from the fan-out — a recruiter who
   * moves a candidate does not need telling that they did.
   */
  actorMemberId?: string | null;
};

type MemberRow = { id: string; role: string };

/**
 * Who hears about this.
 *
 * ── The rule ─────────────────────────────────────────────────
 *
 * Job- and applicant-scoped events go to the people ON THAT JOB'S HIRING TEAM,
 * plus every owner and admin — because those two roles see every job anyway,
 * so a notification about one tells them nothing they could not already read.
 * Never the whole company: a recruiter on two roles must not learn that a
 * candidate on a third was rejected.
 *
 * Team-administration events (invite accepted, member removed, role changed)
 * are not about a job at all and go to owners and admins only. A recruiter
 * does not need to know who joined.
 *
 * An event with no jobId that is not team-administration — nothing produces
 * one today — falls back to owners and admins rather than everyone. The safe
 * direction for an unknown case is fewer recipients, not more.
 */
async function resolveRecipients(
  service: ReturnType<typeof createServiceClient>,
  input: NotifyInput,
): Promise<string[]> {
  const { data: memberRows } = await service
    .from("company_members")
    .select("id, role")
    .eq("company_id", input.companyId)
    .eq("status", "active")
    .limit(1000);

  const members = (memberRows ?? []) as MemberRow[];
  const siteWide = members
    .filter((m) => m.role === "owner" || m.role === "admin")
    .map((m) => m.id);

  if (TEAM_ADMIN_TYPES.has(input.type)) return siteWide;
  if (!input.jobId) return siteWide;

  const { data: teamRows } = await service
    .from("job_hiring_team")
    .select("member_id")
    .eq("company_id", input.companyId)
    .eq("job_id", input.jobId)
    .limit(500);

  const assigned = ((teamRows ?? []) as { member_id: string | null }[])
    .map((r) => r.member_id)
    .filter((id): id is string => Boolean(id));

  // A member who has since left the company must not get a row — their
  // company_members row is no longer active, so intersecting with `members`
  // drops them.
  const active = new Set(members.map((m) => m.id));
  return [...new Set([...siteWide, ...assigned.filter((id) => active.has(id))])];
}

/**
 * Write one notification row per recipient.
 *
 * One row each, not one row with a recipient list, because read state is per
 * person: `read_at` on a shared row would mean the first person to open the
 * bell marked it read for everyone.
 */
export async function notifyCompany(input: NotifyInput): Promise<void> {
  try {
    if (!input.companyId || !input.title) return;
    const service = createServiceClient();

    const recipients = (await resolveRecipients(service, input)).filter(
      (id) => id !== input.actorMemberId,
    );
    if (recipients.length === 0) return;

    const rows = recipients.map((memberId) => ({
      company_id: input.companyId,
      member_id: memberId,
      type: input.type,
      title: input.title,
      body: input.body,
      job_id: input.jobId ?? null,
      application_id: input.applicationId ?? null,
      href: input.href ?? null,
    }));

    // Chunked: a large company with a wide hiring team would otherwise send
    // one very large insert.
    for (let i = 0; i < rows.length; i += 200) {
      const { error } = await service
        .from("notifications_company")
        .insert(rows.slice(i, i + 200));
      if (error) {
        console.error("[notify-company] insert failed:", error.message);
        return;
      }
    }
  } catch (err) {
    console.error("[notify-company] failed (non-fatal):", err);
  }
}

/**
 * Notify exactly one member, bypassing the fan-out.
 *
 * Used by "you were added to a job" — the recipient is the subject of the
 * event, and telling the rest of the team that someone else was added is the
 * kind of noise this system is trying to avoid.
 */
export async function notifyCompanyMember(input: {
  companyId: string;
  memberId: string;
  type: CompanyNotificationType;
  title: string;
  body: string;
  jobId?: string | null;
  href?: string | null;
  actorMemberId?: string | null;
}): Promise<void> {
  try {
    if (!input.companyId || !input.memberId) return;
    // Adding yourself to a job is not news to you.
    if (input.memberId === input.actorMemberId) return;

    const service = createServiceClient();
    const { error } = await service.from("notifications_company").insert({
      company_id: input.companyId,
      member_id: input.memberId,
      type: input.type,
      title: input.title,
      body: input.body,
      job_id: input.jobId ?? null,
      application_id: null,
      href: input.href ?? null,
    });
    if (error) console.error("[notify-company] member insert failed:", error.message);
  } catch (err) {
    console.error("[notify-company] member notify failed (non-fatal):", err);
  }
}
