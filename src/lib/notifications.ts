import { createServiceClient } from "@/lib/supabase/server";
import { isSuperAdminEmail } from "@/app/admin/lib/roles";

export type NotificationEvent =
  | "client_decision"
  | "client_note"
  | "stage_change"
  | "candidate_added"
  | "new_inquiry"
  | "profile_claimed"
  | "profile_approved"
  | "profile_rejected";

export type NotificationInput = {
  event_type: NotificationEvent;
  title: string;
  message: string;
  link?: string;
  metadata?: Record<string, unknown>;
};

/**
 * Fan-out a notification to every active super_admin / admin (plus the
 * super-admin email, in case they're registered via the email shortcut
 * rather than the admin_users table).
 *
 * Call it inside after() from next/server, never as a bare un-awaited
 * promise: on Vercel a floating promise can be frozen with the function once
 * the response is sent, and the notification is lost. after() runs this once
 * the response has gone and keeps the invocation alive with waitUntil.
 *
 * It never throws. A failure here MUST NOT bubble up and make the underlying
 * mutation look unsuccessful, which is why every failure is logged instead:
 * the admin lookup, a fan-out with no recipients, and the insert itself.
 * Supabase returns write errors as { error } rather than throwing, so the
 * insert's result has to be checked or a failed write disappears silently.
 */
export async function notifyAllAdmins(input: NotificationInput): Promise<void> {
  try {
    const supabase = createServiceClient();

    // 1. Active admins from admin_users.
    const { data: adminRows, error: adminError } = await supabase
      .from("admin_users")
      .select("user_id")
      .eq("status", "active")
      .in("role", ["super_admin", "admin"]);
    if (adminError) {
      console.error(
        `[notifications] admin_users lookup failed for ${input.event_type} "${input.title}":`,
        adminError,
      );
    }

    const recipientIds = new Set<string>();
    for (const row of (adminRows ?? []) as Array<{ user_id: string | null }>) {
      if (row.user_id) recipientIds.add(row.user_id);
    }

    // 2. Super-admin email shortcut. The codebase allows waleednzm@gmail.com
    //    to bypass admin_users, so we look them up directly via auth.admin.
    try {
      const { data } = await supabase.auth.admin.listUsers({ perPage: 200 });
      const superAdminUser = data?.users?.find(
        (u) => isSuperAdminEmail(u.email),
      );
      if (superAdminUser?.id) recipientIds.add(superAdminUser.id);
    } catch {
      // listUsers can fail if the service role key isn't admin-scoped;
      // ignore and continue with whatever we already have.
    }

    if (recipientIds.size === 0) {
      console.error(
        `[notifications] No admin recipients found; ${input.event_type} "${input.title}" was not delivered.`,
      );
      return;
    }

    const rows = Array.from(recipientIds).map((uid) => ({
      recipient_user_id: uid,
      event_type: input.event_type,
      title: input.title,
      message: input.message,
      link: input.link ?? null,
      metadata: input.metadata ?? {},
    }));

    const { error: insertError } = await supabase.from("notifications").insert(rows);
    if (insertError) {
      console.error(
        `[notifications] Insert failed for ${input.event_type} "${input.title}" to ${rows.length} recipient(s):`,
        insertError,
      );
    }
  } catch (e) {
    console.error(`[notifications] Failed to send ${input.event_type} "${input.title}":`, e);
  }
}
