"use server";

import { revalidatePath } from "next/cache";
import { createClient, createServiceClient } from "@/lib/supabase/server";

export type TalentNotification = {
  id: string;
  event_type: string;
  title: string;
  message: string;
  link: string | null;
  metadata: Record<string, unknown>;
  read_at: string | null;
  created_at: string;
};

export async function fetchTalentNotifications(limit = 20): Promise<{
  notifications: TalentNotification[];
  unreadCount: number;
}> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { notifications: [], unreadCount: 0 };

  const service = createServiceClient();

  // Two independent reads in parallel — one round-trip per 30s poll.
  const [notifRes, countRes] = await Promise.all([
    service
      .from("notifications")
      .select(
        "id, event_type, title, message, link, metadata, read_at, created_at",
      )
      .eq("recipient_user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(limit),
    service
      .from("notifications")
      .select("*", { count: "exact", head: true })
      .eq("recipient_user_id", user.id)
      .is("read_at", null),
  ]);

  if (notifRes.error) {
    console.error("[talent notifications] read failed:", notifRes.error);
  }
  if (countRes.error) {
    console.error("[talent notifications] unread count failed:", countRes.error);
  }

  return {
    notifications: (notifRes.data ?? []) as TalentNotification[],
    unreadCount: countRes.count ?? 0,
  };
}

export async function markTalentNotificationRead(
  notificationId: string,
): Promise<void> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return;

  const service = createServiceClient();
  await service
    .from("notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("id", notificationId)
    .eq("recipient_user_id", user.id);

  revalidatePath("/talent/dashboard");
}

export async function markAllTalentNotificationsRead(): Promise<void> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return;

  const service = createServiceClient();
  await service
    .from("notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("recipient_user_id", user.id)
    .is("read_at", null);

  revalidatePath("/talent/dashboard");
}
