import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { AdminSidebar } from "./_components/admin-sidebar";

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

  return (
    <div className="flex h-screen overflow-hidden font-sans">
      {/* Sidebar — mobile only, hidden on desktop */}
      <div className="lg:hidden shrink-0">
        <AdminSidebar email={user.email ?? ""} />
      </div>
      <main className="flex-1 overflow-y-auto bg-[#f8f4f1]">{children}</main>
    </div>
  );
}
