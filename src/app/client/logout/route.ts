import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Logout is POST-only — a GET handler would let any third-party page sign
 * the user out via `<img src="/client/logout">`. The client top-nav posts
 * a hidden form, never a link.
 */
export async function POST() {
  const supabase = await createClient();
  await supabase.auth.signOut();

  // Relative Location — see /ai-dashboard/logout for why. In short: this used
  // to build an absolute URL from NEXT_PUBLIC_SITE_URL, a build-time constant
  // naming one deployment, so on any other host sign-out cleared the cookie
  // here and then sent the browser somewhere else.
  return new NextResponse(null, { status: 303, headers: { Location: "/client/login" } });
}
