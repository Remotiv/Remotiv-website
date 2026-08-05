import {
  createClient as createAuthClient,
  createServiceClient,
} from "@/lib/supabase/server";
import type { CompanyContext, CompanyRole, CompanyRow } from "./company-roles";

const COMPANY_COLUMNS =
  "id, name, slug, contact_name, contact_email, website, logo_path, industry, description, status, user_id, must_change_password, created_at";

/**
 * Resolve the logged-in user to their company + role for /ai-dashboard.
 *
 * Resolution order:
 *   1. company_members (active) — the multi-user source of truth. Provisioning
 *      always writes an owner row here, so this is the normal path.
 *   2. FALLBACK: companies.user_id — covers a company whose member row was
 *      lost or predates provisioning; role is synthesized as "owner".
 *   3. Neither → throw "Not a company account".
 *
 * Throws on: no session, no company, or a non-active company. Deliberately
 * separate from the /client portal's getClientContext — the two products never
 * share tenant resolution.
 */
export async function getCompanyContext(): Promise<CompanyContext> {
  const auth = await createAuthClient();
  const {
    data: { user },
  } = await auth.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  const service = createServiceClient();

  let companyId: string | null = null;
  let role: CompanyRole = "owner";
  let memberName: string | null = null;
  let memberId: string | null = null;

  // 1. company_members (multi-user teams).
  const { data: memberRow } = await service
    .from("company_members")
    .select("id, company_id, role, name")
    .eq("user_id", user.id)
    .eq("status", "active")
    .maybeSingle();
  const member = memberRow as {
    id: string;
    company_id: string;
    role: CompanyRole;
    name: string | null;
  } | null;
  if (member) {
    companyId = member.company_id;
    role = member.role;
    memberName = member.name;
    memberId = member.id;
  } else {
    // 2. Fallback: company resolved directly by companies.user_id.
    const { data: fallbackRow } = await service
      .from("companies")
      .select("id")
      .eq("user_id", user.id)
      .maybeSingle();
    const fallback = fallbackRow as { id: string } | null;
    if (fallback) {
      companyId = fallback.id;
      role = "owner";
    }
  }

  // 3. Neither path resolved a company.
  if (!companyId) throw new Error("Not a company account");

  const { data: companyRow } = await service
    .from("companies")
    .select(COMPANY_COLUMNS)
    .eq("id", companyId)
    .maybeSingle();
  const row = companyRow as CompanyRow | null;
  if (!row) throw new Error("Not a company account");
  if (row.status !== "active") throw new Error(`Company status: ${row.status}`);

  const company: CompanyRow = {
    id: row.id,
    name: row.name,
    slug: row.slug,
    contact_name: row.contact_name,
    contact_email: row.contact_email,
    website: row.website,
    logo_path: row.logo_path,
    industry: row.industry,
    description: row.description,
    status: row.status,
    user_id: row.user_id,
    must_change_password: row.must_change_password === true,
    created_at: row.created_at,
  };

  const email = user.email ?? "";

  return {
    user: { id: user.id, email },
    companyId,
    company,
    role,
    // Identity resolves from whoever OWNS the edit, matching fetchTeamMembers:
    //
    //   owner          -> companies.contact_name FIRST. An admin edits it in
    //                     /admin/companies; nothing in the company product
    //                     edits an owner's name. company_members.name is a
    //                     copy written once at provisioning and updated by
    //                     nothing, so letting it win showed a stale name in
    //                     the topbar and sidebar long after the admin edit.
    //   invited member -> company_members.name FIRST. They set it themselves
    //                     at accept time and have no companies row; the
    //                     company's contact_name is somebody else's name.
    //
    // Both then fall back to the other source, then the email local-part. The
    // owner-by-companies.user_id fallback path has no member row and `role`
    // stays "owner", so it lands on contact_name — correct on that path too.
    memberName:
      (role === "owner"
        ? company.contact_name?.trim() || memberName?.trim()
        : memberName?.trim() || company.contact_name?.trim()) ||
      email.split("@")[0] ||
      "",
    memberId,
    mustChangePassword: row.must_change_password === true,
  };
}

/** Guard: resolve the company context and require one of `allowed` roles. */
export async function requireCompanyRole(
  ...allowed: CompanyRole[]
): Promise<CompanyContext> {
  const ctx = await getCompanyContext();
  if (!allowed.includes(ctx.role)) {
    throw new Error("Forbidden: insufficient company role");
  }
  return ctx;
}
