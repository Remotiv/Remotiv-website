import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ClientLoginClient } from "./login-client";

export const dynamic = "force-dynamic";
export const metadata = { title: "Sign in — Remotiv Client Portal" };

export default async function ClientLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ reason?: string }>;
}) {
  // Already signed in → bounce to the dashboard. The dashboard itself
  // resolves single-batch clients to /client/batch/[id] so we don't have
  // to duplicate that routing here.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (user) redirect("/client/dashboard");

  const { reason } = await searchParams;
  return <ClientLoginClient reason={reason ?? null} />;
}
