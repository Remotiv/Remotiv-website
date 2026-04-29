export type UserRole = "super_admin" | "admin" | "viewer";

export const SUPER_ADMIN_EMAIL = "waleednzm@gmail.com";

export const ROLE_LABELS: Record<UserRole, string> = {
  super_admin: "Super Admin",
  admin: "Admin",
  viewer: "Viewer",
};

export const ROLE_BADGE_STYLES: Record<UserRole, string> = {
  super_admin: "bg-[#7E47FF]/10 text-[#7E47FF]",
  admin: "bg-blue-50 text-blue-600",
  viewer: "bg-gray-100 text-gray-500",
};

/** Add, edit, deactivate, or remove team members — super_admin only */
export function canManageTeam(role: UserRole): boolean {
  return role === "super_admin";
}

/** Delete any record — super_admin only */
export function canDelete(role: UserRole): boolean {
  return role === "super_admin";
}

/** Create or edit records (jobs, status changes, etc.) — not team */
export function canEdit(role: UserRole): boolean {
  return role === "super_admin" || role === "admin";
}
