import { redirect } from "next/navigation";
import { createClient, createServiceClient } from "@/lib/supabase/server";

export default async function GatedClientLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/client/login");
  }

  const service = createServiceClient();
  const { data: client } = await service
    .from("clients")
    .select("must_change_password")
    .eq("user_id", user.id)
    .single();

  // No client row = admin preview (or no role at all). Let the page-level
  // getCurrentClientOrAdmin guard handle authorization; we only enforce
  // the password-change gate here.
  if (client?.must_change_password === true) {
    redirect("/client/change-password?forced=true");
  }

  return <>{children}</>;
}
