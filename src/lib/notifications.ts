import { createServiceClient } from "@/lib/supabase/server";
import { SUPER_ADMIN_EMAIL } from "@/app/admin/lib/roles";

export type NotificationEvent =
  | "client_decision"
  | "client_note"
  | "stage_change"
  | "candidate_added"
  | "new_inquiry"
  | "profile_claimed";

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
 * Intentionally fire-and-forget: notifications are nice-to-have. A failure
 * here MUST NOT bubble up and prevent the underlying mutation from
 * appearing successful. Errors are logged server-side.
 */
export async function notifyAllAdmins(input: NotificationInput): Promise<void> {
  try {
    const supabase = createServiceClient();

    // 1. Active admins from admin_users.
    const { data: adminRows } = await supabase
      .from("admin_users")
      .select("user_id")
      .eq("status", "active")
      .in("role", ["super_admin", "admin"]);

    const recipientIds = new Set<string>();
    for (const row of (adminRows ?? []) as Array<{ user_id: string | null }>) {
      if (row.user_id) recipientIds.add(row.user_id);
    }

    // 2. Super-admin email shortcut. The codebase allows waleednzm@gmail.com
    //    to bypass admin_users, so we look them up directly via auth.admin.
    try {
      const { data } = await supabase.auth.admin.listUsers({ perPage: 200 });
      const superAdminUser = data?.users?.find(
        (u) => u.email?.toLowerCase() === SUPER_ADMIN_EMAIL.toLowerCase(),
      );
      if (superAdminUser?.id) recipientIds.add(superAdminUser.id);
    } catch {
      // listUsers can fail if the service role key isn't admin-scoped;
      // ignore and continue with whatever we already have.
    }

    if (recipientIds.size === 0) return;

    const rows = Array.from(recipientIds).map((uid) => ({
      recipient_user_id: uid,
      event_type: input.event_type,
      title: input.title,
      message: input.message,
      link: input.link ?? null,
      metadata: input.metadata ?? {},
    }));

    await supabase.from("notifications").insert(rows);
  } catch (e) {
    console.error("[notifications] Failed to send:", e);
  }
}
