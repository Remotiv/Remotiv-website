import { createClient as createAuthClient, createServiceClient } from "@/lib/supabase/server";
import { CompanyAccessDenied, CompanyProfileError, resolveCompanyAccess } from "./company-access";
import type { CompanyContext, CompanyRole, CompanyRow } from "./company-roles";

export type {
  CompanyAccess,
  CompanyAccessDeniedReason,
  ResolvedMembership,
} from "./company-access";
// Re-exported so the eligibility rule has ONE import path for callers, even
// though it lives in its own module to stay testable.
export {
  CompanyAccessDenied,
  CompanyLookupError,
  CompanyProfileError,
  loginRedirectFor,
  resolveCompanyAccess,
  resolveMembership,
} from "./company-access";

const COMPANY_COLUMNS =
  "id, name, slug, contact_name, contact_email, website, logo_path, industry, description, status, user_id, must_change_password, created_at";

/**
 * Resolve the logged-in user to their company + role for /ai-dashboard.
 *
 * Eligibility lives in resolveCompanyAccess and is shared verbatim with the
 * login page. This function adds only the company profile the shell renders.
 *
 * Throws CompanyAccessDenied when the gate refuses — callers redirect on that.
 * Throws CompanyProfileError when access was granted but the profile would not
 * load; that is not a redirect, because login would allow what this refused.
 */
export async function getCompanyContext(): Promise<CompanyContext> {
  const auth = await createAuthClient();
  const {
    data: { user },
  } = await auth.auth.getUser();
  if (!user) throw new CompanyAccessDenied({ ok: false, reason: "unauthenticated" });

  const service = createServiceClient();

  const access = await resolveCompanyAccess(service, user.id);
  if (!access.ok) throw new CompanyAccessDenied(access);

  const { companyId, role, memberName, memberId } = access;

  // Access is settled from here down. This select asks for thirteen columns
  // where eligibility asked for one, so it can still fail where the gate
  // succeeded — but it can no longer turn that into a redirect.
  const { data: companyRow, error: companyError } = await service
    .from("companies")
    .select(COMPANY_COLUMNS)
    .eq("id", companyId)
    .maybeSingle();
  if (companyError) {
    throw new CompanyProfileError(`Could not load company: ${companyError.message}`, {
      cause: companyError,
    });
  }
  const row = companyRow as CompanyRow | null;
  // The row was there when eligibility read its status a moment ago. Losing it
  // between the two reads is a race, not a verdict on the account.
  if (!row) throw new CompanyProfileError(`Company ${companyId} vanished mid-request`);

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
export async function requireCompanyRole(...allowed: CompanyRole[]): Promise<CompanyContext> {
  const ctx = await getCompanyContext();
  if (!allowed.includes(ctx.role)) {
    throw new Error("Forbidden: insufficient company role");
  }
  return ctx;
}
