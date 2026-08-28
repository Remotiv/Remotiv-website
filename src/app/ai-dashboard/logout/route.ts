import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Logout is POST-only — a GET handler would let any third-party page sign
 * the user out via `<img src="/ai-dashboard/logout">`.
 */
export async function POST() {
  const supabase = await createClient();
  await supabase.auth.signOut();

  /*
   * A RELATIVE Location, so this cannot send anyone to the wrong host.
   *
   * It used to build an absolute URL from NEXT_PUBLIC_SITE_URL, which is a
   * build-time constant naming one deployment. On any other deployment — a
   * preview, most obviously — sign-out cleared the session cookie on the host
   * you were using and then sent the browser to a DIFFERENT host, which looked
   * like a hang: the logout had in fact succeeded, and only a manual reload
   * revealed it.
   *
   * The browser resolves a relative Location against the request URI, so this
   * is correct on localhost, on a preview, and on every custom domain, without
   * knowing the name of any of them. NextResponse.redirect() is not used
   * because it requires an absolute URL — which is the thing to avoid here.
   *
   * NEXT_PUBLIC_SITE_URL remains right for absolute links that leave the app,
   * such as invite and interview emails. It is wrong for a request-local hop.
   */
  return new NextResponse(null, { status: 303, headers: { Location: "/ai-dashboard/login" } });
}
