import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { LoginClient } from "./login-client";

export const dynamic = "force-dynamic";
export const metadata = { title: "Sign in — Remotiv Admin" };

export default async function AdminLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ reason?: string }>;
}) {
  // Already signed in → don't show the form, send them home.
  // The admin layout will bounce non-admins out and surface the right reason.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (user) redirect("/admin");

  const { reason } = await searchParams;
  return <LoginClient reason={reason ?? null} />;
}
