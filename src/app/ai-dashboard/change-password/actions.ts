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

  // Resolve the company the same way getCompanyContext does (members first,
  // then the companies.user_id fallback) so a member row that isn't the
  // owner still clears the flag on the right company.
  const service = createServiceClient();
  const { data: memberRow } = await service
    .from("company_members")
    .select("company_id")
    .eq("user_id", user.id)
    .eq("status", "active")
    .maybeSingle();

  const companyId = (memberRow as { company_id: string } | null)?.company_id ?? null;

  const query = service.from("companies").update({ must_change_password: false });
  const { error } = companyId
    ? await query.eq("id", companyId)
    : await query.eq("user_id", user.id);

  if (error) {
    return { ok: false as const, error: error.message };
  }

  return { ok: true as const };
}
