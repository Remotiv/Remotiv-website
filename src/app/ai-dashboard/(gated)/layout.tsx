import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { AiShell } from "../_components/ai-shell";
import { getCompanyContext } from "../lib/company-guards";
import type { CompanyContext } from "../lib/company-roles";

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
  // rendering an empty workspace. This is the ONLY resolution in the tree;
  // the shell reads company/role/user straight off this ctx.
  let ctx: CompanyContext;
  try {
    ctx = await getCompanyContext();
  } catch {
    redirect("/ai-dashboard/login?reason=unauthorized");
  }

  if (ctx.mustChangePassword) {
    redirect("/ai-dashboard/change-password?forced=true");
  }

  return (
    <AiShell
      companyName={ctx.company.name}
      role={ctx.role}
      userName={ctx.company.contact_name ?? ""}
      userEmail={ctx.user.email}
    >
      {children}
    </AiShell>
  );
}
