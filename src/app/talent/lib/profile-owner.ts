import "server-only";

import { createClient, createServiceClient } from "@/lib/supabase/server";

export type SourceTable = "talent_profiles" | "hire_remote_profiles";

// Thrown error codes (via Error.message):
//   "not_authenticated" — no session / no email on the auth user.
//   "not_owner"          — row is missing, OR the row's email doesn't match
//                          the caller's email. Generic on purpose.
//   "not_approved"       — caller's own row, but approved_at IS NULL
//                          (admin hasn't approved it yet).
//   "not_claimed"        — caller's own row, approved, but user_id is not
//                          yet linked to the auth user.
//
// SECURITY: the email-match check fires BEFORE the approval-state branch,
// so an attacker passing someone else's profileId only ever sees
// "not_owner". If we differentiated before email-match, probing an
// arbitrary profileId would leak whether that profile is approved.
export async function requireProfileOwner(
  profileId: string,
  sourceTable: SourceTable,
): Promise<{ userId: string; email: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !user.email) {
    throw new Error("not_authenticated");
  }

  const service = createServiceClient();
  const { data: row, error } = await service
    .from(sourceTable)
    .select("user_id, approved_at, email")
    .eq("id", profileId)
    .maybeSingle();

  if (error || !row) {
    throw new Error("not_owner");
  }

  const typed = row as {
    user_id: string | null;
    approved_at: string | null;
    email: string | null;
  };

  if (typed.user_id && typed.user_id === user.id) {
    return { userId: user.id, email: user.email };
  }

  const callerEmail = user.email.toLowerCase().trim();
  const rowEmail = typed.email?.toLowerCase().trim() ?? "";
  const isYourEmail = rowEmail.length > 0 && rowEmail === callerEmail;
  if (!isYourEmail) {
    throw new Error("not_owner");
  }

  if (!typed.approved_at) {
    throw new Error("not_approved");
  }
  throw new Error("not_claimed");
}

export async function getProfileOwnerOrNull(
  profileId: string,
  sourceTable: SourceTable,
): Promise<{ userId: string; email: string } | null> {
  try {
    return await requireProfileOwner(profileId, sourceTable);
  } catch {
    return null;
  }
}
