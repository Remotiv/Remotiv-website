import { redirect } from "next/navigation";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { SUPER_ADMIN_EMAIL } from "@/app/admin/lib/roles";
import AccountClient from "./account-client";

export const dynamic = "force-dynamic";

export default async function AccountPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    redirect("/signin?next=/account");
  }

  const service = createServiceClient();

  // Determine admin status
  let isAdmin = false;
  if (user.email === SUPER_ADMIN_EMAIL) {
    isAdmin = true;
  } else {
    const { data: adminRow } = await service
      .from("admin_users")
      .select("role")
      .eq("user_id", user.id)
      .single();
    if (adminRow && (adminRow.role === "super_admin" || adminRow.role === "admin")) {
      isAdmin = true;
    }
  }

  // Get subscription data
  type Tier = "free" | "starter" | "pro";
  let tier: Tier = "free";
  let creditsRemaining = 0;
  let creditsLimit = 0;
  let createdAt: string | null = null;

  if (!isAdmin) {
    const { data: subRow } = await service
      .from("subscriptions")
      .select("tier, credits_remaining, created_at")
      .eq("user_id", user.id)
      .single();
    if (subRow && (subRow.tier === "starter" || subRow.tier === "pro")) {
      tier = subRow.tier as Tier;
      creditsRemaining = subRow.credits_remaining ?? 0;
      creditsLimit = subRow.tier === "starter" ? 30 : 300;
      createdAt = subRow.created_at;
    }
  }

  return (
    <AccountClient
      email={user.email ?? ""}
      fullName={(user.user_metadata?.full_name as string | undefined) ?? null}
      tier={isAdmin ? "admin" : tier}
      creditsRemaining={creditsRemaining}
      creditsLimit={creditsLimit}
      subscriptionStartDate={createdAt}
    />
  );
}
