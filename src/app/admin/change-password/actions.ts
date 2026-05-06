"use server";

import { createClient, createServiceClient } from "@/lib/supabase/server";
import { SUPER_ADMIN_EMAIL } from "@/app/admin/lib/roles";

/**
 * Clear the `must_change_password` flag on the current admin's
 * admin_users row after they've successfully updated their password.
 * Super-admin doesn't have an admin_users row, so this is a no-op for them.
 */
export async function clearMustChangePassword(): Promise<{ success: boolean }> {
  const auth = await createClient();
  const {
    data: { user },
  } = await auth.auth.getUser();
  if (!user) return { success: false };
  if (user.email === SUPER_ADMIN_EMAIL) return { success: true };

  const service = createServiceClient();
  await service
    .from("admin_users")
    .update({ must_change_password: false })
    .eq("user_id", user.id);

  return { success: true };
}
