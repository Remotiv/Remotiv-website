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

// Resolved identity for a logged-in /ai-dashboard user: which company they
// belong to (companyId + the companies row) and their role within it.
export type CompanyContext = {
  user: { id: string; email: string };
  companyId: string;
  company: CompanyRow;
  role: CompanyRole;
  mustChangePassword: boolean;
};
