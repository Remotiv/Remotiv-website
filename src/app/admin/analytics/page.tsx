import { redirect } from "next/navigation";
import { isSuperAdminEmail, type UserRole } from "@/app/admin/lib/roles";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { PlatformAnalyticsClient } from "./_analytics-client";
import { fetchPlatformAnalytics } from "./actions";

export const dynamic = "force-dynamic";

export const metadata = { title: "Platform analytics — Remotiv" };

/**
 * Platform analytics — cross-company, and therefore super-admin only.
 *
 * ── Enforced twice, on purpose ───────────────────────────────
 *
 * Here, so a non-super-admin who types the URL is redirected rather than shown
 * a page that then fails; and again inside `fetchPlatformAnalytics`, which
 * calls `requireSuperAdmin()` before it reads anything. The second gate is the
 * one that actually matters: a "use server" export is reachable as a plain
 * POST endpoint no matter what this component decides, so a page-level check
 * alone would leave the data one fetch away from any authenticated admin.
 *
 * Hiding the nav item is not part of the enforcement and never was — it only
 * stops the route being advertised.
 */
export default async function PlatformAnalyticsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const userEmail = user?.email ?? "";
  const userId = user?.id ?? "";

  let resolvedRole: UserRole = "viewer";
  if (isSuperAdminEmail(userEmail)) {
    resolvedRole = "super_admin";
  } else {
    const service = createServiceClient();
    const { data: roleRow } = await service
      .from("admin_users")
      .select("role")
      .eq("user_id", userId)
      .maybeSingle();
    if (roleRow?.role) resolvedRole = roleRow.role as UserRole;
  }

  if (resolvedRole !== "super_admin") redirect("/admin");

  // 30 days is the default because the cost half is the half that changes.
  // Calibration ignores this and reads all time regardless — see actions.ts.
  const initial = await fetchPlatformAnalytics("30d");

  return <PlatformAnalyticsClient email={userEmail} userRole={resolvedRole} initial={initial} />;
}
