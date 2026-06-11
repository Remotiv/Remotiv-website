import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { TalentLoginClient } from "./login-client";

export const dynamic = "force-dynamic";
export const metadata = { title: "Talent Login — Remotiv" };

export default async function TalentLoginPage({
  searchParams,
}: {
  searchParams: Promise<{
    token?: string;
    reason?: string;
    profile_id?: string;
    source_table?: string;
  }>;
}) {
  // Already signed in → straight to the dashboard. The dashboard's own
  // layout enforces auth so this is purely a UX shortcut.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (user) redirect("/talent/dashboard");

  const params = await searchParams;
  const { token, reason } = params;

  const validProfileId =
    typeof params.profile_id === "string" &&
    /^[0-9a-fA-F-]{36}$/.test(params.profile_id)
      ? params.profile_id
      : null;
  const validSourceTable =
    params.source_table === "talent_profiles" ||
    params.source_table === "hire_remote_profiles"
      ? params.source_table
      : null;
  // Pair invariant: only thread both if both validate; otherwise drop both.
  const profileId = validProfileId && validSourceTable ? validProfileId : null;
  const sourceTable =
    validProfileId && validSourceTable ? validSourceTable : null;

  return (
    <TalentLoginClient
      token={token ?? null}
      reason={reason ?? null}
      profileId={profileId}
      sourceTable={sourceTable}
    />
  );
}
