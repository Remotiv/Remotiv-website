import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST-only admin sign-out. Mirrors /client/logout. The admin top-nav
 * posts a hidden form rather than calling supabase.auth.signOut() inline,
 * so a network failure on the auth call still surfaces a redirect.
 */
export async function POST(request: Request) {
  const supabase = await createClient();
  await supabase.auth.signOut();
  const origin = process.env.NEXT_PUBLIC_SITE_URL ?? new URL(request.url).origin;
  return NextResponse.redirect(new URL("/login", origin), { status: 303 });
}
