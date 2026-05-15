import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/browse-talent";
  const type = searchParams.get("type"); // 'signup' | 'recovery' | 'magiclink' | etc.

  // Error from Supabase (e.g. expired link)
  const errorCode = searchParams.get("error");
  const errorDescription = searchParams.get("error_description");

  if (errorCode) {
    const errorParam = encodeURIComponent(errorDescription || errorCode);
    return NextResponse.redirect(`${origin}/signin?error=${errorParam}`);
  }

  if (!code) {
    return NextResponse.redirect(`${origin}/signin?error=missing_code`);
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    const errorParam = encodeURIComponent(error.message);
    return NextResponse.redirect(`${origin}/signin?error=${errorParam}`);
  }

  // Route based on auth flow type
  if (type === "recovery") {
    // Password reset → user must set new password
    return NextResponse.redirect(`${origin}/reset-password`);
  }

  if (type === "signup") {
    // Email confirmed → land on browse-talent with success param
    return NextResponse.redirect(`${origin}/browse-talent?confirmed=true`);
  }

  // Default: respect `next` param, fallback to browse-talent
  return NextResponse.redirect(`${origin}${next}`);
}
