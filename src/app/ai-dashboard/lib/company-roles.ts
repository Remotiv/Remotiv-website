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
  /** Free-text-ish; constrained to COMPANY_INDUSTRIES by the settings form. */
  industry: string | null;
  description: string | null;
  status: CompanyStatus;
  user_id: string | null;
  must_change_password: boolean;
  created_at: string;
};

/**
 * Industry options for the company profile.
 *
 * A short, closed list on purpose: it is shown publicly beside the company name
 * and feeds the AI recruiter as context, so free text would produce a hundred
 * spellings of "Software" and make the value useless for both. "Other" is
 * always last and is the escape hatch rather than a catch-all default.
 */
export const COMPANY_INDUSTRIES = [
  "Recruitment & staffing",
  "Software",
  "Finance",
  "Healthcare",
  "E-commerce",
  "Education",
  "Marketing & advertising",
  "Manufacturing",
  "Real estate",
  "Other",
] as const;
export type CompanyIndustry = (typeof COMPANY_INDUSTRIES)[number];

/** Same ceiling as a job description — see JOB_TEXT_MAX. */
export const COMPANY_DESCRIPTION_MAX = 10_000;

/**
 * Cap for `team_size` and `location` — the two public-profile facts.
 *
 * Short on purpose. Each renders as a single `dd` in a ~276px rail cell on the
 * careers page: "40–60 people" is 12 characters and "Dubai · Remote" is 14.
 * Anything approaching a sentence wraps to three lines and unbalances the rail,
 * and a limit that permits a paragraph invites one.
 *
 * Here rather than in the settings action because that module is "use server"
 * and may only export async functions — the same reason
 * COMPANY_DESCRIPTION_MAX lives beside it.
 */
export const COMPANY_FACT_MAX = 60;

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
  /** Pending invites only — who sent it. Null on real member rows. */
  invited_by_name: string | null;
  /** Pending invites only — when it was sent. Null on real member rows. */
  invited_at: string | null;
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
  /**
   * The viewer's OWN display name from their company_members row — not the
   * company's contact_name, which belongs to the owner. Falls back to
   * contact_name (owner path) then the email local-part.
   */
  memberName: string;
  /**
   * company_members.id for the viewer. Never null: an active membership is what
   * grants access, so holding a context and having a member row are the same
   * fact. It was nullable only for the companies.user_id fallback, which no
   * longer resolves anyone.
   *
   * job_hiring_team.member_id points at this, so it is what per-job scoping
   * resolves through — never user_id, which the hiring-team table does not
   * carry.
   */
  memberId: string;
  mustChangePassword: boolean;
};

/**
 * Roles whose visibility is limited to the jobs they are assigned to.
 *
 * Owner and admin are site-wide by definition and never appear here — they see
 * every job without an assignment, which is what makes them able to fix a
 * mis-assigned team in the first place.
 */
export function isJobScopedRole(role: CompanyRole): boolean {
  return role === "recruiter" || role === "hiring_manager";
}

/** Who may add and remove members on a job's hiring team. */
export function canManageHiringTeam(role: CompanyRole): boolean {
  return role === "owner" || role === "admin" || role === "recruiter";
}

/** Per-job relationship labels. NOT what grants access — presence does. */
export const TEAM_ROLES = [
  "hiring_manager",
  "recruiter",
  "coordinator",
  "sourcer",
] as const;
export type JobTeamRole = (typeof TEAM_ROLES)[number];

export const TEAM_ROLE_LABELS: Record<JobTeamRole, string> = {
  hiring_manager: "Hiring manager",
  recruiter: "Recruiter",
  coordinator: "Coordinator",
  sourcer: "Sourcer",
};
