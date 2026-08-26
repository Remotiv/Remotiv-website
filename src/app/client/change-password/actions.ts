"use server";

import { resolveClientMembership } from "@/app/client/lib/client-guards";
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

  /*
   * Scoped to ONE client id, always.
   *
   * This was `.update(...).eq("user_id", user.id)` — a write with no client
   * filter, which cleared must_change_password on EVERY client row that user
   * owns. clients.user_id has no unique index (only clients_email_key), so
   * "every" is not hypothetical. It also never consulted client_members at all,
   * so an invited member's gate could never be cleared on the right client.
   *
   * resolveClientMembership applies the member lookup and the legacy
   * clients.user_id fallback and returns a single id, so there is no longer a
   * branch that writes by user. Same fix as the company portal's
   * clearMustChangePassword.
   */
  let companyId: string | null;
  try {
    companyId = (await resolveClientMembership(service, user.id)).companyId;
  } catch (err) {
    return {
      ok: false as const,
      error: err instanceof Error ? err.message : "Could not resolve your client account.",
    };
  }

  if (!companyId) {
    return { ok: false as const, error: "Not a client account" };
  }

  const { error } = await service
    .from("clients")
    .update({ must_change_password: false })
    .eq("id", companyId);

  if (error) {
    return { ok: false as const, error: error.message };
  }

  return { ok: true as const };
}
