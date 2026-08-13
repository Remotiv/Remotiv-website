export type UserRole = "super_admin" | "admin" | "viewer";

/**
 * The super-admin bypass, resolved from the environment.
 *
 * ── Why it is not a constant any more ────────────────────────
 *
 * It used to be a string literal in this file, which put the address of the
 * single highest-privilege account into the repo, into every clone, into every
 * diff, and into any transcript that quoted the file. None of those are places
 * you can revoke something from.
 *
 * ── Why it is NOT prefixed NEXT_PUBLIC_ ──────────────────────
 *
 * `NEXT_PUBLIC_` is what makes Next inline a value into the browser bundle.
 * This module is imported by fourteen client components (for ROLE_LABELS and
 * the badge styles), so a public prefix here would ship the super-admin
 * address to every visitor of an admin page — which is the exact leak this
 * change exists to close.
 *
 * The plain name is what makes that impossible: in a client bundle
 * `process.env.SUPER_ADMIN_EMAIL` resolves to undefined, so the list is empty
 * and `isSuperAdminEmail` returns false. Client-side the answer is always
 * "no", which is both the safe answer and the honest one — a browser cannot
 * be trusted to decide this and should never have the value to decide it with.
 *
 * ── Read at call time, deliberately ──────────────────────────
 *
 * Not hoisted into a module-level const. A module-level read is evaluated once
 * at import, which freezes it before the environment is necessarily populated
 * and would put the value in the module's closure — the thing a bundler is
 * most likely to serialise.
 *
 * ── Comma-separated ──────────────────────────────────────────
 *
 * One address is a list of one, so a single value behaves exactly as before.
 * The split exists so a second founder or a break-glass account can be added
 * without another code change.
 */
function superAdminEmails(): string[] {
  const raw = process.env.SUPER_ADMIN_EMAIL;
  if (typeof raw !== "string") return [];
  return raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Does this email hold the super-admin bypass?
 *
 * FAILS CLOSED. An unset, empty or whitespace-only SUPER_ADMIN_EMAIL yields an
 * empty list and every call returns false — nobody is promoted by accident,
 * and a missing variable can never be mistaken for a wildcard.
 *
 * Failing closed does NOT lock out real administrators: every call site treats
 * a false here as "fall through to the admin_users lookup", so anyone holding
 * an active row with a role keeps exactly the access that row grants. The only
 * account affected by an unset variable is one that relied solely on the
 * hardcoded literal and has no row of its own — which is precisely the
 * implicit privilege this change is removing.
 *
 * Comparison is trimmed and lowercased on both sides, so an address differing
 * only in case still matches.
 */
export function isSuperAdminEmail(email: string | null | undefined): boolean {
  const candidate = (email ?? "").trim().toLowerCase();
  if (!candidate) return false;
  return superAdminEmails().includes(candidate);
}

export const ROLE_LABELS: Record<UserRole, string> = {
  super_admin: "Super Admin",
  admin: "Admin",
  viewer: "Viewer",
};

export const ROLE_BADGE_STYLES: Record<UserRole, string> = {
  super_admin: "bg-remotiv-purple/10 text-remotiv-purple",
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
