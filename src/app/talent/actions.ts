"use server";

import { revalidatePath } from "next/cache";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { notifyAllAdmins } from "@/lib/notifications";
import { sendEmail } from "@/lib/email/send";
import {
  claimSuccessSubject,
  renderClaimSuccessEmail,
} from "@/lib/email/templates/claim-success";

type SourceTable = "talent_profiles" | "hire_remote_profiles";

const BASE_URL =
  process.env.NEXT_PUBLIC_SITE_URL ??
  "https://remotiv.work";

// Email collision: this email must not already belong to an admin or client
// in auth.users. Mirrors the inline check in /api/claim/{verify,initiate}.
async function emailHasAdminOrClientCollision(
  service: ReturnType<typeof createServiceClient>,
  email: string,
): Promise<boolean> {
  const normalised = email.toLowerCase();
  try {
    const { data } = await service.auth.admin.listUsers({ perPage: 200 });
    const match = data?.users?.find(
      (u) => u.email?.toLowerCase() === normalised,
    );
    if (!match?.id) return false;

    const { data: adminRow } = await service
      .from("admin_users")
      .select("id")
      .eq("user_id", match.id)
      .maybeSingle();
    if (adminRow) return true;

    const { data: clientRow } = await service
      .from("clients")
      .select("id")
      .eq("user_id", match.id)
      .maybeSingle();
    if (clientRow) return true;

    return false;
  } catch (e) {
    console.error("[claimProfile] collision check failed:", e);
    return false;
  }
}

export async function claimProfile(
  profileId: string,
  sourceTable: SourceTable,
): Promise<{ success: boolean; error?: string }> {
  if (sourceTable !== "talent_profiles" && sourceTable !== "hire_remote_profiles") {
    return { success: false, error: "Invalid source table" };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !user.email) {
    return { success: false, error: "Not authenticated" };
  }

  const service = createServiceClient();

  if (await emailHasAdminOrClientCollision(service, user.email)) {
    return {
      success: false,
      error: "This email is already registered as a client or admin",
    };
  }

  const { data: profileRow, error: fetchErr } = await service
    .from(sourceTable)
    .select("id, email, first_name, claimed_at, user_id")
    .eq("id", profileId)
    .maybeSingle();

  if (fetchErr || !profileRow) {
    return { success: false, error: "Profile not found" };
  }

  const profile = profileRow as {
    id: string;
    email: string | null;
    first_name: string | null;
    claimed_at: string | null;
    user_id: string | null;
  };

  if ((profile.email ?? "").toLowerCase() !== user.email.toLowerCase()) {
    return { success: false, error: "Email mismatch" };
  }
  if (profile.claimed_at) {
    return { success: false, error: "Already claimed" };
  }

  // claim_method: 'admin_invite' if an opened token exists for this candidate
  // (admin pre-created an invite + the user clicked it), else 'self_service'
  // (the user came in via the OTP form on /talent/login).
  const { data: openedTokenRow } = await service
    .from("talent_claim_tokens")
    .select("id")
    .eq("candidate_id", profileId)
    .eq("source_table", sourceTable)
    .eq("status", "opened")
    .maybeSingle();
  const claimMethod = openedTokenRow ? "admin_invite" : "self_service";

  const nowIso = new Date().toISOString();
  const patch: Record<string, unknown> = {
    user_id: user.id,
    claimed_at: nowIso,
    claim_method: claimMethod,
    email_verified_at: nowIso,
  };
  if (sourceTable === "hire_remote_profiles") {
    patch.email_verified = true;
  }

  // Idempotent guard: only stamp if still unclaimed. If a parallel claim won
  // the race, the .is("claimed_at", null) predicate filters us out and the
  // returned array is empty — we short-circuit before firing notifications,
  // email, or marking a token, all of which belong to the winner.
  const { data: updatedRows, error: updateErr } = await service
    .from(sourceTable)
    .update(patch)
    .eq("id", profileId)
    .is("claimed_at", null)
    .select("id");

  if (updateErr) {
    console.error("[claimProfile] update failed:", updateErr);
    return { success: false, error: "Failed to claim profile" };
  }

  if (!updatedRows || updatedRows.length === 0) {
    // Race loser: another session already claimed this profile between our
    // claimed_at-null read above and the UPDATE here. Do NOT mark a token,
    // fire admin notification, or send a success email — those side effects
    // belong to the winner.
    return {
      success: false,
      error: "This profile has already been claimed by another account.",
    };
  }

  // Mark any open token as claimed. Idempotent — if nothing's open, no-op.
  await service
    .from("talent_claim_tokens")
    .update({ status: "claimed", claimed_at: nowIso })
    .eq("candidate_id", profileId)
    .eq("source_table", sourceTable)
    .in("status", ["pending", "opened"]);

  notifyAllAdmins({
    event_type: "profile_claimed",
    title: "Profile claimed",
    message: `${profile.email ?? user.email} claimed their ${
      sourceTable === "talent_profiles" ? "Pakistan Talent" : "Remote Ready"
    } profile`,
    link:
      sourceTable === "talent_profiles"
        ? `/admin/talent?id=${profileId}`
        : `/admin/remote-talent?id=${profileId}`,
    metadata: { profile_id: profileId, source_table: sourceTable },
  }).catch((err) => {
    console.error("[claimProfile] notify error", err);
  });

  sendEmail({
    to: user.email,
    subject: claimSuccessSubject,
    html: renderClaimSuccessEmail({
      candidateName: profile.first_name?.trim() || user.email,
      dashboardUrl: `${BASE_URL}/talent/dashboard`,
    }),
  }).catch((err) => {
    console.error("[claimProfile] email error", err);
  });

  revalidatePath("/talent/dashboard");
  if (sourceTable === "talent_profiles") {
    revalidatePath("/browse-talent");
  } else {
    revalidatePath("/find-freelancers");
  }

  return { success: true };
}
