import { createServiceClient } from "@/lib/supabase/server";
import { OverviewDashboard } from "./_components/overview-dashboard";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function AdminOverviewPage() {
  const [supabase, serviceSupabase] = await Promise.all([
    createClient(),
    Promise.resolve(createServiceClient()),
  ]);

  const [
    { data: { user } },
    { count: totalApplications },
    { count: totalContacts },
    { count: totalBookings },
    { count: pendingReview },
  ] = await Promise.all([
    supabase.auth.getUser(),
    serviceSupabase.from("profiles").select("*", { count: "exact", head: true }),
    serviceSupabase.from("contact_submissions").select("*", { count: "exact", head: true }),
    serviceSupabase.from("bookings").select("*", { count: "exact", head: true }),
    serviceSupabase.from("profiles").select("*", { count: "exact", head: true }).eq("status", "pending"),
  ]);

  return (
    <OverviewDashboard
      email={user?.email ?? ""}
      stats={{
        totalApplications: totalApplications ?? 0,
        totalContacts: totalContacts ?? 0,
        totalBookings: totalBookings ?? 0,
        pendingReview: pendingReview ?? 0,
      }}
    />
  );
}
