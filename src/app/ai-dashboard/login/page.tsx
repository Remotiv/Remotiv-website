import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { verifyCompanyAccess } from "./actions";
import { CompanyLoginClient } from "./login-client";

export const dynamic = "force-dynamic";
export const metadata = { title: "Sign in — Remotiv AI Interviews" };

export default async function CompanyLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ reason?: string }>;
}) {
  // Bounce to the dashboard only for a user who is genuinely an active company
  // member. Redirecting on the mere presence of a session would ping-pong
  // forever when an admin or talent account is signed in on the same browser:
  // the gated route bounces them back here, and we'd bounce them straight back.
  // A non-company session simply gets the login form so they can sign in with
  // company credentials.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (user) {
    const verified = await verifyCompanyAccess();
    if (verified.ok) redirect("/ai-dashboard");
  }

  const { reason } = await searchParams;
  return <CompanyLoginClient reason={reason ?? null} />;
}
