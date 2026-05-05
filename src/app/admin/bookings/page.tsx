import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

// Bookings now share a tab with inquiries on /admin/contacts.
// Keep this route alive as a redirect so existing bookmarks and the old
// nav link survive.
export default function AdminBookingsRedirect() {
  redirect("/admin/contacts?tab=bookings");
}
