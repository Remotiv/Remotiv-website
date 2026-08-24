"use server";

import { resolveMembership } from "@/app/ai-dashboard/lib/company-guards";
import { createClient, createServiceClient } from "@/lib/supabase/server";

export async function clearMustChangePassword() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { ok: false as const, error: "Not authenticated" };
  }

  // Resolve the company exactly as getCompanyContext does — same function, so a
  // member row that isn't the owner still clears the flag on the right company.
  const service = createServiceClient();

  let companyId: string | null;
  try {
    companyId = (await resolveMembership(service, user.id)).companyId;
  } catch (err) {
    return {
      ok: false as const,
      error: err instanceof Error ? err.message : "Could not resolve your company.",
    };
  }

  /*
   * Scoped to ONE company id, always.
   *
   * The fallback branch here used to be `.eq("user_id", user.id)` — a write
   * with no company filter, which cleared must_change_password on EVERY company
   * that user owns. It was reachable exactly when the member lookup returned
   * nothing, which included the two-membership case that returned nothing
   * spuriously. resolveMembership already applies the companies.user_id
   * fallback and returns a single id, so there is no longer a branch that
   * writes by user.
   */
  if (!companyId) {
    return { ok: false as const, error: "Not a company account" };
  }

  const { error } = await service
    .from("companies")
    .update({ must_change_password: false })
    .eq("id", companyId);

  if (error) {
    return { ok: false as const, error: error.message };
  }

  return { ok: true as const };
}
