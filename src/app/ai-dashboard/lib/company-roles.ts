// Per-company roles for the AI Video Interviews product. Deliberately parallel
// to — and never shared with — the /client batch-review portal's role model:
// the two products resolve tenants through different tables (company_members
// vs client_members) and must not import each other's helpers.
export type CompanyRole = "owner" | "admin" | "recruiter" | "hiring_manager";

/** Add, remove, or change roles of company members. */
export function canManageTeam(role: CompanyRole): boolean {
  return role === "owner" || role === "admin";
}

/** Create/manage the company's jobs and interviews. */
export function canCreateJobs(role: CompanyRole): boolean {
  return role === "owner" || role === "admin" || role === "recruiter";
}

/** Manage the company's plan / billing. */
export function canManageBilling(role: CompanyRole): boolean {
  return role === "owner";
}

export const COMPANY_ROLE_LABELS: Record<CompanyRole, string> = {
  owner: "Owner",
  admin: "Admin",
  recruiter: "Recruiter",
  hiring_manager: "Hiring Manager",
};

export type CompanyStatus = "active" | "paused" | "archived";

export type CompanyRow = {
  id: string;
  name: string;
  slug: string | null;
  contact_name: string | null;
  contact_email: string;
  website: string | null;
  logo_path: string | null;
  status: CompanyStatus;
  user_id: string | null;
  must_change_password: boolean;
  created_at: string;
};

export type CompanyMemberStatus = "active" | "invited" | "removed";

// One row of the Team table. Lives here rather than in team/actions.ts because
// a "use server" module may only export async functions.
export type TeamMemberRow = {
  id: string;
  user_id: string | null;
  name: string;
  email: string;
  role: CompanyRole;
  status: CompanyMemberStatus;
  /** auth.users.last_sign_in_at — null when never signed in or lookup failed. */
  last_sign_in_at: string | null;
  /** True for the row belonging to the viewer. */
  is_self: boolean;
  /** True for the company's owner row — never editable or removable. */
  is_owner: boolean;
};

/** What each role can reach, shown in the Team table's ACCESS column. */
export const COMPANY_ROLE_ACCESS: Record<CompanyRole, string> = {
  owner: "Full access",
  admin: "Billing · Jobs · Team",
  recruiter: "Jobs · Applicants",
  hiring_manager: "Assigned jobs only",
};

// Resolved identity for a logged-in /ai-dashboard user: which company they
// belong to (companyId + the companies row) and their role within it.
export type CompanyContext = {
  user: { id: string; email: string };
  companyId: string;
  company: CompanyRow;
  role: CompanyRole;
  mustChangePassword: boolean;
};
