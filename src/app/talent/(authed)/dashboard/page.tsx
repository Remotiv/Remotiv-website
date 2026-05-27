import { redirect } from "next/navigation";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { DashboardClient, type DashboardProfile } from "./_dashboard-client";

export const dynamic = "force-dynamic";

export default async function TalentDashboardPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !user.email) {
    redirect("/talent/login?reason=unauthorized");
  }

  const service = createServiceClient();
  const normalisedEmail = user.email.toLowerCase();

  const [{ data: talentRow }, { data: remoteRow }] = await Promise.all([
    service
      .from("talent_profiles")
      .select("id, first_name, last_name, email, claimed_at")
      .eq("email", normalisedEmail)
      .maybeSingle(),
    service
      .from("hire_remote_profiles")
      .select("id, first_name, last_name, email, claimed_at")
      .eq("email", normalisedEmail)
      .maybeSingle(),
  ]);

  const profiles: DashboardProfile[] = [];
  if (talentRow) {
    const r = talentRow as {
      id: string;
      first_name: string | null;
      last_name: string | null;
      email: string;
      claimed_at: string | null;
    };
    profiles.push({
      id: r.id,
      sourceTable: "talent_profiles",
      poolLabel: "Pakistan Talent",
      firstName: r.first_name ?? "",
      lastName: r.last_name ?? "",
      email: r.email,
      claimedAt: r.claimed_at,
    });
  }
  if (remoteRow) {
    const r = remoteRow as {
      id: string;
      first_name: string | null;
      last_name: string | null;
      email: string;
      claimed_at: string | null;
    };
    profiles.push({
      id: r.id,
      sourceTable: "hire_remote_profiles",
      poolLabel: "Remote Ready",
      firstName: r.first_name ?? "",
      lastName: r.last_name ?? "",
      email: r.email,
      claimedAt: r.claimed_at,
    });
  }

  return <DashboardClient email={user.email} profiles={profiles} />;
}
