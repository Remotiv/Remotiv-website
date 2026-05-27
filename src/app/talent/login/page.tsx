import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { TalentLoginClient } from "./login-client";

export const dynamic = "force-dynamic";
export const metadata = { title: "Talent Login — Remotiv" };

export default async function TalentLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; reason?: string }>;
}) {
  // Already signed in → straight to the dashboard. The dashboard's own
  // layout enforces auth so this is purely a UX shortcut.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (user) redirect("/talent/dashboard");

  const { token, reason } = await searchParams;
  return <TalentLoginClient token={token ?? null} reason={reason ?? null} />;
}
