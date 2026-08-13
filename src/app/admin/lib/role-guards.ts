import { createClient, createServiceClient } from "@/lib/supabase/server";
import { isSuperAdminEmail, type UserRole } from "./roles";

/**
 * Shared auth gates for admin server actions.
 *
 * IMPORTANT: Next.js layouts protect *page* navigation, but server actions
 * are reachable as plain POST endpoints regardless of layout. Every admin
 * mutation must funnel through one of these helpers — without that, any
 * authenticated Supabase user could invoke them directly.
 *
 * The same pattern lives inline in src/app/admin/clients/actions.ts and
 * src/app/admin/client-batches/actions.ts; this file is the canonical
 * version and should be used by all new actions.
 */

export type AdminContext = {
  user: { id: string; email: string };
  role: UserRole;
  /**
   * True for newly-invited admins or anyone whose password was reset by a
   * super admin — admin/layout.tsx redirects them to /admin/change-password
   * until they pick their own. Super-admins always read false.
   */
  mustChangePassword: boolean;
};

/**
 * Resolve the current admin context. Throws if not authenticated or if
 * the user has no active admin_users row. The hardcoded super-admin
 * shortcut bypasses the admin_users lookup so a missing row can never
 * lock out the owner account.
 */
export async function getAdminContext(): Promise<AdminContext> {
  const auth = await createClient();
  const {
    data: { user },
  } = await auth.auth.getUser();

  if (!user || !user.email) {
    throw new Error("Not authenticated");
  }

  if (isSuperAdminEmail(user.email)) {
    return {
      user: { id: user.id, email: user.email },
      role: "super_admin",
      mustChangePassword: false,
    };
  }

  const supabase = createServiceClient();
  const { data: adminRow } = await supabase
    .from("admin_users")
    .select("role, status, must_change_password")
    .eq("user_id", user.id)
    .maybeSingle();

  const row = adminRow as {
    role: string | null;
    status: string | null;
    must_change_password: boolean | null;
  } | null;
  if (!row || !row.role) {
    throw new Error("Forbidden: not an admin");
  }
  if (row.status && row.status !== "active") {
    throw new Error("Forbidden: admin account is not active");
  }

  return {
    user: { id: user.id, email: user.email },
    role: row.role as UserRole,
    mustChangePassword: row.must_change_password === true,
  };
}

/** Allow super_admin or admin. Throws otherwise. */
export async function requireAdmin(): Promise<AdminContext> {
  const ctx = await getAdminContext();
  if (ctx.role !== "super_admin" && ctx.role !== "admin") {
    throw new Error("Forbidden: admin role required");
  }
  return ctx;
}

/** Allow super_admin only. Throws otherwise. */
export async function requireSuperAdmin(): Promise<AdminContext> {
  const ctx = await getAdminContext();
  if (ctx.role !== "super_admin") {
    throw new Error("Forbidden: super_admin role required");
  }
  return ctx;
}
