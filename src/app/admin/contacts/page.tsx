import { redirect } from "next/navigation";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { ContactsDashboard } from "@/app/admin/_components/contacts-dashboard";
import { type UserRole, SUPER_ADMIN_EMAIL } from "@/app/admin/lib/roles";
import { fetchBookings, fetchContactSubmissions } from "./actions";

export const dynamic = "force-dynamic";

export default async function AdminContactsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const { tab } = await searchParams;

  const supabase = await createClient();
  const service = createServiceClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const userId = user.id;
  const userEmail = user.email ?? "";

  let userRole: UserRole = "viewer";
  if (userEmail === SUPER_ADMIN_EMAIL) {
    userRole = "super_admin";
  } else {
    const { data: roleRow } = await service
      .from("admin_users")
      .select("role")
      .eq("user_id", userId)
      .maybeSingle();
    if (roleRow?.role) userRole = roleRow.role as UserRole;
  }

  if (userRole !== "super_admin" && userRole !== "admin") {
    redirect("/admin");
  }

  const [inquiries, bookings] = await Promise.all([
    fetchContactSubmissions(),
    fetchBookings(),
  ]);

  const initialTab: "inquiries" | "bookings" = tab === "bookings" ? "bookings" : "inquiries";

  return (
    <ContactsDashboard
      email={userEmail}
      userRole={userRole}
      initialInquiries={inquiries}
      initialBookings={bookings}
      initialTab={initialTab}
    />
  );
}
