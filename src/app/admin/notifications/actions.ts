"use server";

import { revalidatePath } from "next/cache";
import { createClient, createServiceClient } from "@/lib/supabase/server";

export type AdminNotification = {
  id: string;
  event_type: string;
  title: string;
  message: string;
  link: string | null;
  metadata: Record<string, unknown>;
  read_at: string | null;
  created_at: string;
};

export async function fetchNotifications(limit = 20): Promise<{
  notifications: AdminNotification[];
  unreadCount: number;
}> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { notifications: [], unreadCount: 0 };

  const service = createServiceClient();

  const { data: notifications } = await service
    .from("notifications")
    .select("id, event_type, title, message, link, metadata, read_at, created_at")
    .eq("recipient_user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(limit);

  const { count: unreadCount } = await service
    .from("notifications")
    .select("*", { count: "exact", head: true })
    .eq("recipient_user_id", user.id)
    .is("read_at", null);

  return {
    notifications: (notifications ?? []) as AdminNotification[],
    unreadCount: unreadCount ?? 0,
  };
}

export async function markNotificationAsRead(notificationId: string): Promise<void> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return;

  const service = createServiceClient();
  await service
    .from("notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("id", notificationId)
    .eq("recipient_user_id", user.id);

  revalidatePath("/admin");
}

export async function markAllAsRead(): Promise<void> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return;

  const service = createServiceClient();
  await service
    .from("notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("recipient_user_id", user.id)
    .is("read_at", null);

  revalidatePath("/admin");
}
