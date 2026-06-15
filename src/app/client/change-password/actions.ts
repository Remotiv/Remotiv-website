"use server";

import { createClient, createServiceClient } from "@/lib/supabase/server";

export async function clearMustChangePassword() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { ok: false as const, error: "Not authenticated" };
  }

  const service = createServiceClient();
  const { error } = await service
    .from("clients")
    .update({ must_change_password: false })
    .eq("user_id", user.id);

  if (error) {
    return { ok: false as const, error: error.message };
  }

  return { ok: true as const };
}
