import { createServiceClient } from "@/lib/supabase/server";
import { getCompanyContext } from "@/app/ai-dashboard/lib/company-guards";
import { seedRejectionDefault } from "@/lib/email/candidate/triggers";
import { fetchCalendarConnections } from "./calendar-actions";
import { fetchWorkingHours } from "./hours-actions";
import { fetchTemplateRows } from "./template-actions";
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

  // Read through the same helper jobs/new seeds from, so the switch shown here
  // and the value a new job actually inherits can never disagree.
  const sendRejectionDefault = await seedRejectionDefault(ctx.companyId);
  const templateRows = await fetchTemplateRows();

  // Per MEMBER, not per company — a recruiter connects their own calendar, and
  // this reads only the non-secret view columns (no token is fetched at all).
  const calendarConnections = await fetchCalendarConnections();
  const workingHours = await fetchWorkingHours();

  // Read directly rather than widening COMPANY_COLUMNS: the shared company
  // guard runs on every /ai-dashboard request and this column is only ever
  // needed here and in the dispatcher.
  const { data: replyRow } = await service
    .from("companies")
    .select("candidate_reply_email, team_size, location")
    .eq("id", ctx.companyId)
    .maybeSingle();
  // team_size and location ride along on the SAME query for the same reason the
  // comment above gives for candidate_reply_email: they are needed here to edit
  // them and on the public careers page to render them, and nowhere in the
  // dashboard chrome — so they stay off COMPANY_COLUMNS, which the guard reads
  // on every /ai-dashboard request.
  const profileRow = replyRow as {
    candidate_reply_email: string | null;
    team_size: string | null;
    location: string | null;
  } | null;
  const candidateReplyEmail = profileRow?.candidate_reply_email ?? "";

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
        candidate_reply_email: candidateReplyEmail,
        website: ctx.company.website ?? "",
        industry: ctx.company.industry ?? "",
        description: ctx.company.description ?? "",
        team_size: profileRow?.team_size ?? "",
        location: profileRow?.location ?? "",
        logoUrl,
      }}
      account={{ email: ctx.user.email }}
      sendRejectionDefault={sendRejectionDefault}
      templateRows={templateRows}
      calendarConnections={calendarConnections}
      workingHours={workingHours}
      stats={{
        liveRoles: publishedJobs.count ?? 0,
        applicants: applicants.count ?? 0,
        seatsUsed: seats.count ?? 0,
      }}
    />
  );
}
