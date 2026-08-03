import { createServiceClient } from "@/lib/supabase/server";
import { getCompanyContext } from "@/app/ai-dashboard/lib/company-guards";
import { SettingsClient } from "./_settings-client";
import { COMPANY_LOGO_BUCKET } from "./constants";

export const dynamic = "force-dynamic";
export const metadata = { title: "Settings — Remotiv AI Interviews" };

export default async function SettingsPage() {
  const ctx = await getCompanyContext();
  const service = createServiceClient();

  // Hero stats + the live-job count behind the rename warning. All three are
  // REAL counts scoped to this company — the handoff is explicit that the
  // "updates the name on all N live job posts" sentence must be true, and a
  // hardcoded number would be worse than no sentence.
  const [publishedJobs, applicants, seats] = await Promise.all([
    service
      .from("jobs")
      .select("id", { count: "exact", head: true })
      .eq("company_id", ctx.companyId)
      .eq("status", "open"),
    service
      .from("job_applications")
      .select("id", { count: "exact", head: true })
      .eq("company_id_snapshot", ctx.companyId),
    service
      .from("company_members")
      .select("id", { count: "exact", head: true })
      .eq("company_id", ctx.companyId)
      .eq("status", "active"),
  ]);

  const logoUrl = ctx.company.logo_path
    ? service.storage.from(COMPANY_LOGO_BUCKET).getPublicUrl(ctx.company.logo_path)
        .data.publicUrl
    : null;

  return (
    <SettingsClient
      role={ctx.role}
      company={{
        name: ctx.company.name,
        slug: ctx.company.slug,
        contact_name: ctx.company.contact_name ?? "",
        website: ctx.company.website ?? "",
        industry: ctx.company.industry ?? "",
        description: ctx.company.description ?? "",
        logoUrl,
      }}
      account={{ email: ctx.user.email }}
      stats={{
        liveRoles: publishedJobs.count ?? 0,
        applicants: applicants.count ?? 0,
        seatsUsed: seats.count ?? 0,
      }}
    />
  );
}
