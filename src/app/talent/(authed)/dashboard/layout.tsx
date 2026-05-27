import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

// Route-segment layout. Wraps only the (authed) group — /talent/login is a
// sibling under /talent/ and is NOT gated by this layout.
export default async function TalentDashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect("/talent/login?reason=unauthorized");
  }
  return <>{children}</>;
}
