import { NextResponse, type NextRequest } from "next/server";
import { reportOnlyDirectives, resolveSupabaseUrl, supabaseHost, toCsp } from "@/lib/security/csp";

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
 *
 * And a Content-Security-Policy-Report-Only with a fresh nonce (#72 step 13),
 * on the request and on the response. On the request, because that is where
 * Next reads the nonce from to stamp its own inline and external scripts
 * (get-script-nonce-from-header.js: the request's Content-Security-Policy,
 * then its Report-Only). On the response, so the browser reports every script
 * that would be blocked without 'unsafe-inline'. Report-Only: the enforced
 * policy from next.config.ts still applies and still allows 'unsafe-inline',
 * so nothing is blocked. Every page under these two prefixes renders per
 * request already, so a nonce costs no static page.
 */
const SUPABASE_HOST = supabaseHost(resolveSupabaseUrl());

/** 16 random bytes, base64: a fresh CSP nonce. */
export function newNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

export function proxy(request: NextRequest) {
  const nonce = newNonce();
  const reportOnly = toCsp(
    reportOnlyDirectives({
      supabaseHost: SUPABASE_HOST,
      isProduction: process.env.NODE_ENV === "production",
      nonce,
    }),
  );
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-pathname", request.nextUrl.pathname);
  requestHeaders.set("x-url", request.nextUrl.pathname + request.nextUrl.search);
  requestHeaders.set("content-security-policy-report-only", reportOnly);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy-Report-Only", reportOnly);
  return response;
}

export const config = {
  matcher: ["/admin/:path*", "/ai-dashboard/:path*"],
};
