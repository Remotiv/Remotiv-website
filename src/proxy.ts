import { NextResponse, type NextRequest } from "next/server";

/**
 * Next.js 16's per-request edge interceptor (formerly `middleware.ts`).
 *
 * We tag every /admin/* request with `x-pathname` so server components —
 * specifically admin/layout.tsx — can read the current path without a
 * client round-trip. Auth lives in the layout, not here.
 *
 * Used by the must_change_password gate to allow the change-password page
 * through while redirecting every other admin page to it.
 */
export function proxy(request: NextRequest) {
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-pathname", request.nextUrl.pathname);
  return NextResponse.next({ request: { headers: requestHeaders } });
}

export const config = {
  matcher: ["/admin/:path*"],
};
