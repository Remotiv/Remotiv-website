import { NextResponse, type NextRequest } from "next/server";

/**
 * Next.js 16's per-request edge interceptor (formerly `middleware.ts`).
 *
 * We tag requests with the current URL so server components can read it
 * without a client round-trip. Auth lives in the layouts, not here — this
 * never touches Supabase, so it costs no round-trip on any navigation.
 *
 *   x-pathname  /admin/*         admin/layout.tsx's must_change_password gate
 *   x-url       /ai-dashboard/*  the gated layout's session recovery, which
 *                                needs path + query to send the user back to
 *                                the exact page after a refresh
 */
export function proxy(request: NextRequest) {
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-pathname", request.nextUrl.pathname);
  requestHeaders.set("x-url", request.nextUrl.pathname + request.nextUrl.search);
  return NextResponse.next({ request: { headers: requestHeaders } });
}

export const config = {
  matcher: ["/admin/:path*", "/ai-dashboard/:path*"],
};
