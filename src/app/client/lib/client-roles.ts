import type { ClientRow } from "@/app/client/actions";

// Per-company client roles. Mirrors the admin role model (src/app/admin/lib/
// roles.ts) but scoped to a single client company via client_members.
export type ClientRole = "owner" | "admin" | "recruiter" | "hiring_manager";

/** Add, remove, or change roles of company members. */
export function canManageTeam(role: ClientRole): boolean {
  return role === "owner" || role === "admin";
}

/** Create/manage the company's jobs. */
export function canCreateJobs(role: ClientRole): boolean {
  return role === "owner" || role === "admin" || role === "recruiter";
}

/** Manage the company's plan / billing. */
export function canManageBilling(role: ClientRole): boolean {
  return role === "owner";
}

export const CLIENT_ROLE_LABELS: Record<ClientRole, string> = {
  owner: "Owner",
  admin: "Admin",
  recruiter: "Recruiter",
  hiring_manager: "Hiring Manager",
};

// Resolved identity for a logged-in client-portal user: which company they
// belong to (companyId + the clients row) and their role within it.
export type ClientContext = {
  user: { id: string; email: string };
  companyId: string;
  company: ClientRow;
  role: ClientRole;
  mustChangePassword: boolean;
};
