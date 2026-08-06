"use server";

import { createServiceClient } from "@/lib/supabase/server";
import { getCompanyContext } from "@/app/ai-dashboard/lib/company-guards";
import { canAccessJob } from "@/app/ai-dashboard/lib/job-scope";
import type { CompanyNotification } from "./notification-types";

// NB: a "use server" module may only export async functions — every export is
// compiled into a server action. Shapes live in ./notification-types.ts.

const FEED_LIMIT = 30;

type Row = {
  id: string;
  type: string;
  title: string;
  body: string | null;
  job_id: string | null;
  application_id: string | null;
  href: string | null;
  read_at: string | null;
  created_at: string;
};

/**
 * The viewer's own notifications.
 *
 * Scoped by BOTH company_id and member_id. Either alone would be wrong: the
 * company filter without the member filter hands one member another's feed,
 * and the member filter alone would trust an id that resolves per company.
 *
 * ── Lost access ──────────────────────────────────────────────
 *
 * A notification names a job, and hiring teams change. Someone removed from a
 * job's team still has rows in their feed that quote its title and link to its
 * applicants. Re-checking access at READ time — not at write time — is what
 * keeps that honest: the row is redacted to a neutral line and its link is
 * dropped, so the title of a job they can no longer open never reaches them,
 * and they still see that something happened rather than rows silently
 * vanishing from a count they already read.
 *
 * Checked per distinct job, not per row, so a feed of thirty rows across three
 * jobs costs three lookups.
 */
export async function fetchNotifications(): Promise<{
  items: CompanyNotification[];
  unread: number;
}> {
  const ctx = await getCompanyContext();
  if (!ctx.memberId) return { items: [], unread: 0 };

  const service = createServiceClient();

  const [{ data }, { count }] = await Promise.all([
    service
      .from("notifications_company")
      .select("id, type, title, body, job_id, application_id, href, read_at, created_at")
      .eq("company_id", ctx.companyId)
      .eq("member_id", ctx.memberId)
      .order("created_at", { ascending: false })
      .limit(FEED_LIMIT),
    service
      .from("notifications_company")
      .select("id", { count: "exact", head: true })
      .eq("company_id", ctx.companyId)
      .eq("member_id", ctx.memberId)
      .is("read_at", null),
  ]);

  const rows = (data ?? []) as Row[];

  const jobIds = [...new Set(rows.map((r) => r.job_id).filter(Boolean))] as string[];
  const allowed = new Map<string, boolean>();
  for (const jobId of jobIds) {
    allowed.set(jobId, await canAccessJob(ctx, jobId));
  }

  const items: CompanyNotification[] = rows.map((r) => {
    const lost = r.job_id !== null && allowed.get(r.job_id) === false;
    return {
      id: r.id,
      type: r.type,
      // Redacted, not deleted. "A role you no longer have access to" is true
      // and tells them why, where a blank row would look like a bug.
      title: lost ? "Update on a role you no longer have access to" : r.title,
      body: lost ? "" : (r.body ?? ""),
      href: lost ? null : r.href,
      read: r.read_at !== null,
      createdAt: r.created_at,
    };
  });

  return { items, unread: count ?? 0 };
}

/** Mark one notification read. Own rows only. */
export async function markNotificationRead(id: string): Promise<void> {
  try {
    const ctx = await getCompanyContext();
    if (!ctx.memberId || !id) return;
    await createServiceClient()
      .from("notifications_company")
      .update({ read_at: new Date().toISOString() })
      .eq("id", id)
      .eq("company_id", ctx.companyId)
      .eq("member_id", ctx.memberId)
      .is("read_at", null);
  } catch (err) {
    console.error("[notifications] mark read failed:", err);
  }
}

/**
 * Mark every unread notification read.
 *
 * Filtered on `read_at is null` so it only touches rows that need it — a blanket
 * update would rewrite the timestamp on things read last week.
 */
export async function markAllNotificationsRead(): Promise<void> {
  try {
    const ctx = await getCompanyContext();
    if (!ctx.memberId) return;
    await createServiceClient()
      .from("notifications_company")
      .update({ read_at: new Date().toISOString() })
      .eq("company_id", ctx.companyId)
      .eq("member_id", ctx.memberId)
      .is("read_at", null);
  } catch (err) {
    console.error("[notifications] mark all read failed:", err);
  }
}
