import { NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/me
 *
 * Tiny "who am I" endpoint for the public navbar's avatar menu. Returns
 * either `{ loggedIn: false }` or `{ loggedIn: true, email, fullName, role }`
 * where role ∈ {"talent","employer"}.
 *
 * Role is derived by checking whether the user owns a claimed profile row
 * in `talent_profiles` or `hire_remote_profiles` (both have a `user_id`
 * column, populated by the claim flow in src/app/talent/actions.ts).
 * Anything else defaults to "employer" — which is also the safe fallback if
 * the lookup throws, because /account (the employer menu's destination)
 * works for any logged-in user.
 *
 * Service client is used for the role lookup so the call doesn't depend on
 * the per-table RLS policy granting self-reads.
 */
export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ loggedIn: false });
  }

  let role: "talent" | "employer" = "employer";
  try {
    const service = createServiceClient();
    const [talentRes, remoteRes] = await Promise.all([
      service
        .from("talent_profiles")
        .select("id")
        .eq("user_id", user.id)
        .limit(1)
        .maybeSingle(),
      service
        .from("hire_remote_profiles")
        .select("id")
        .eq("user_id", user.id)
        .limit(1)
        .maybeSingle(),
    ]);
    const isTalent = Boolean(talentRes.data?.id) || Boolean(remoteRes.data?.id);
    role = isTalent ? "talent" : "employer";
  } catch (err) {
    // The navbar must never break — fall back to the safe employer default.
    console.error("[api/me] role lookup failed:", err);
    role = "employer";
  }

  return NextResponse.json({
    loggedIn: true,
    email: user.email ?? null,
    fullName: (user.user_metadata?.full_name as string | undefined) ?? null,
    role,
  });
}
