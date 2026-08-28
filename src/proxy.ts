import { createServerClient } from "@supabase/ssr";
import { type NextRequest, NextResponse } from "next/server";

/**
 * Next.js 16's per-request edge interceptor (formerly `middleware.ts`).
 *
 * Two jobs, and only one of them costs anything:
 *
 *   /admin/*        — tag the request with `x-pathname` so server components,
 *                     specifically admin/layout.tsx, can read the current path
 *                     without a client round-trip. Used by the
 *                     must_change_password gate to let the change-password page
 *                     through while redirecting every other admin page to it.
 *                     No network call. Auth lives in the layout, not here.
 *
 *   /ai-dashboard/* — the above, plus a Supabase `getUser()` whose only purpose
 *                     is the refresh it triggers.
 *
 * Why the dashboard needs the second job: a Server Component cannot write
 * cookies, so `createClient()`'s setAll swallows the write (server.ts:18). When
 * the access token expires there is nowhere for the rotated refresh token to
 * land, the next request arrives with no usable session, and the gated layout
 * redirects to login before making a single Supabase call — a 307 in tens of
 * milliseconds with no outgoing requests, which is exactly the shape of the
 * production hang. An interceptor CAN write cookies. This is that write.
 */
export async function proxy(request: NextRequest) {
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-pathname", request.nextUrl.pathname);

  /*
   * ONE response, constructed here and returned by every path below.
   *
   * Supabase hands rotated cookies to setAll, and they only persist if they are
   * written onto the object that is actually returned. Building a second
   * NextResponse after the refresh drops them silently — the same failure this
   * function exists to fix, and just as invisible.
   */
  const response = NextResponse.next({ request: { headers: requestHeaders } });

  if (!request.nextUrl.pathname.startsWith("/ai-dashboard")) {
    return response;
  }

  try {
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() {
            return request.cookies.getAll();
          },
          setAll(cookiesToSet) {
            for (const { name, value, options } of cookiesToSet) {
              response.cookies.set(name, value, options);
            }
          },
        },
      },
    );

    // The return value is deliberately unused: the refresh is the side effect.
    await supabase.auth.getUser();
  } catch (err) {
    // A refresh that could not run must not fail the request. The gated layout
    // already treats an unusable session as "send them to login" — degrading to
    // that is correct, while a throw here would 500 every dashboard page the
    // moment Supabase has a bad minute.
    console.error("[proxy] session refresh failed:", err);
  }

  return response;
}

export const config = {
  // Both entries are path-prefixed, so `/_next/static/*` and `/_next/image` —
  // served from the root, never from under these prefixes — cannot match.
  matcher: ["/admin/:path*", "/ai-dashboard/:path*"],
};
