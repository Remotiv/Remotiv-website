import { redirect } from "next/navigation";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { SUPER_ADMIN_EMAIL } from "@/app/admin/lib/roles";

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

  // Super-admin shortcut bypasses the admin_users membership + status gate.
  // Everyone else must have an admin_users row with status='active' on every
  // request — this is what catches deleted users with stale JWTs and paused
  // team members.
  if (user.email !== SUPER_ADMIN_EMAIL) {
    const service = createServiceClient();
    const { data: adminRow } = await service
      .from("admin_users")
      .select("role, status")
      .eq("user_id", user.id)
      .maybeSingle();

    const role = (adminRow as { role?: string; status?: string } | null)?.role ?? null;
    const status = (adminRow as { role?: string; status?: string } | null)?.status ?? null;

    if (!adminRow || !role) {
      // No admin_users row → either deleted by a super admin, or the auth
      // account was never granted admin access. Either way, force-logout.
      await supabase.auth.signOut();
      redirect("/login?reason=removed");
    }

    if (status && status !== "active") {
      // Paused or archived. Force-logout and surface the reason on /login.
      await supabase.auth.signOut();
      redirect(`/login?reason=${status}`);
    }
  }

  // The mobile drawer + hamburger now live in TopNav (rendered by each
  // dashboard component). The layout is just a scrollable main pane.
  return (
    <main className="min-h-screen bg-remotiv-bg font-sans">{children}</main>
  );
}
