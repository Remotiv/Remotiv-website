import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCompanyContext } from "../lib/company-guards";

export default async function GatedCompanyLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/ai-dashboard/login");
  }

  // Resolve company + role (company_members → companies.user_id fallback).
  // A non-company session throws — bounce it back to login rather than
  // rendering an empty workspace.
  let mustChangePassword = false;
  try {
    mustChangePassword = (await getCompanyContext()).mustChangePassword;
  } catch {
    redirect("/ai-dashboard/login?reason=unauthorized");
  }

  if (mustChangePassword) {
    redirect("/ai-dashboard/change-password?forced=true");
  }

  return <>{children}</>;
}
