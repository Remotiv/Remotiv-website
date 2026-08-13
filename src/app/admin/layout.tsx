import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { isSuperAdminEmail } from "@/app/admin/lib/roles";

export const metadata = { title: "Admin — Remotiv" };

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
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

    if (!row || !row.role) {
      // No admin_users row → either deleted by a super admin, or the auth
      // account was never granted admin access. Either way, force-logout.
      await supabase.auth.signOut();
      redirect("/login?reason=removed");
    }

    if (row.status && row.status !== "active") {
      // Paused or archived. Force-logout and surface the reason on /login.
      await supabase.auth.signOut();
      redirect(`/login?reason=${row.status}`);
    }

    // First-time login or admin-initiated password reset — force the user
    // through change-password before they can use anything else.
    if (row.must_change_password === true && !onChangePassword) {
      redirect("/admin/change-password?forced=true");
    }
  }

  // The mobile drawer + hamburger now live in TopNav (rendered by each
  // dashboard component). The layout is just a scrollable main pane.
  return (
    <main className="min-h-screen bg-remotiv-bg font-sans">{children}</main>
  );
}
