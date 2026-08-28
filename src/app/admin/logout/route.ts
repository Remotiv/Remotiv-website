import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST-only admin sign-out. Mirrors /client/logout. The admin top-nav
 * posts a hidden form rather than calling supabase.auth.signOut() inline,
 * so a network failure on the auth call still surfaces a redirect.
 */
export async function POST() {
  const supabase = await createClient();
  await supabase.auth.signOut();

  // Relative Location — see /ai-dashboard/logout for why. In short: this used
  // to build an absolute URL from NEXT_PUBLIC_SITE_URL, a build-time constant
  // naming one deployment, so on any other host sign-out cleared the cookie
  // here and then sent the browser somewhere else.
  return new NextResponse(null, { status: 303, headers: { Location: "/login" } });
}
