import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { AdminFlagsProvider } from "@/app/admin/_components/admin-flags";
import { adminLiveReviewEnabled } from "@/app/admin/lib/feature-flags";
import { isSuperAdminEmail } from "@/app/admin/lib/roles";
import { createClient, createServiceClient } from "@/lib/supabase/server";

// #43: "Page - Remotiv Admin"; a page with no title of its own reads
// "Remotiv Admin". Was "Admin — Remotiv", an em dash in the tab. absolute,
// not default: Next applies the root's "%s - Remotiv" to a default, which
// would read "Remotiv Admin - Remotiv".
export const metadata = {
  title: { absolute: "Remotiv Admin", template: "%s - Remotiv Admin" },
};

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  // src/middleware.ts tags every /admin request with x-pathname so we can
  // exempt the change-password page itself from the must-change-password
  // gate (otherwise we'd redirect-loop).
  const headersList = await headers();
  const pathname = headersList.get("x-pathname") ?? "";
  const onChangePassword = pathname.startsWith("/admin/change-password");

  // Super-admin shortcut bypasses the admin_users membership + status gate.
  // Everyone else must have an admin_users row with status='active' on every
  // request — this is what catches deleted users with stale JWTs and paused
  // team members.
  if (!isSuperAdminEmail(user.email)) {
    const service = createServiceClient();
    const { data: adminRow } = await service
      .from("admin_users")
      .select("role, status, must_change_password")
      .eq("user_id", user.id)
      .maybeSingle();

    const row = adminRow as {
      role?: string;
      status?: string;
      must_change_password?: boolean;
    } | null;

    // #54: never a bare signOut() here. Its default scope is GLOBAL, so a
    // company user who merely opened /login (which sends every signed-in
    // user to /admin) or an admin URL was signed out on every device. A
    // company member is sent to their own dashboard with the session
    // intact; anyone else is signed out on THIS browser only, which is
    // enough to stop /login and /admin bouncing them back and forth.
    if (!row || !row.role) {
      // No admin_users row → either deleted by a super admin, or the auth
      // account was never granted admin access.
      const { data: member } = await service
        .from("company_members")
        .select("id")
        .eq("user_id", user.id)
        .eq("status", "active")
        .limit(1)
        .maybeSingle();
      if (member) redirect("/ai-dashboard");
      await supabase.auth.signOut({ scope: "local" });
      redirect("/login?reason=removed");
    }

    if (row.status && row.status !== "active") {
      // Paused or archived. Sign out this browser and surface the reason on
      // /login; the check above runs on every admin request regardless.
      await supabase.auth.signOut({ scope: "local" });
      redirect(`/login?reason=${row.status}`);
    }

    // First-time login or admin-initiated password reset — force the user
    // through change-password before they can use anything else.
    if (row.must_change_password === true && !onChangePassword) {
      redirect("/admin/change-password?forced=true");
    }
  }

  /*
   * TopNav is rendered by each dashboard component, not here — so the rail it
   * draws is FIXED, and the space it occupies has to be reserved somewhere
   * that wraps every admin page. This is that place.
   *
   * lg: only. Below it the rail becomes a drawer and takes no layout space.
   */
  // Server-decided switches, as plain booleans for the nav (admin-flags.tsx).
  return (
    <main className="min-h-screen bg-remotiv-bg font-sans lg:pl-[236px]">
      <AdminFlagsProvider flags={{ liveReview: adminLiveReviewEnabled() }}>
        {children}
      </AdminFlagsProvider>
    </main>
  );
}
