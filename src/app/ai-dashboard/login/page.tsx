import { redirect } from "next/navigation";
import { resolveCompanyAccess } from "@/app/ai-dashboard/lib/company-guards";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { CompanyLoginClient } from "./login-client";

export const dynamic = "force-dynamic";
export const metadata = { title: "Sign in — Remotiv AI Interviews" };

export default async function CompanyLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ reason?: string }>;
}) {
  // Bounce to the dashboard only for a user the gated route will also admit.
  // Redirecting on the mere presence of a session would ping-pong forever when
  // an admin or talent account is signed in on the same browser: the gated
  // route bounces them back here, and we'd bounce them straight back.
  //
  // resolveCompanyAccess is the SAME function the gated layout admits on, so
  // "login sends them onward" and "the dashboard lets them in" cannot disagree
  // for the same membership and company state. That is the whole invariant.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (user) {
    const access = await resolveCompanyAccess(createServiceClient(), user.id);
    if (access.ok) redirect("/ai-dashboard");
  }

  const { reason } = await searchParams;
  return <CompanyLoginClient reason={reason ?? null} />;
}
