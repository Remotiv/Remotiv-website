import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Logout is POST-only — a GET handler would let any third-party page sign
 * the user out via `<img src="/ai-dashboard/logout">`.
 */
export async function POST(request: Request) {
  const supabase = await createClient();
  await supabase.auth.signOut();
  const origin = process.env.NEXT_PUBLIC_SITE_URL ?? new URL(request.url).origin;
  return NextResponse.redirect(new URL("/ai-dashboard/login", origin), { status: 303 });
}
