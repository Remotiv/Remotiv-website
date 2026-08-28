import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Rotate the session before it expires, from somewhere the write can land.
 *
 * A Server Component cannot set cookies, so `createClient()`'s setAll is a
 * no-op during a page render (server.ts:18) and a rotated refresh token has
 * nowhere to go. A Route Handler can write them. That is the entire reason this
 * is an endpoint the client calls rather than work done on the request path:
 * putting it in the proxy bought a Supabase round-trip on every navigation and
 * every prefetch, and a 504 when the refresh retry loop outran the 25s budget.
 *
 * POST-only for the same reason logout is — a GET would let any third-party
 * page rotate a visitor's token via `<img src=…>`.
 */

/*
 * Refresh once we are within five minutes of expiry.
 *
 * The floor is not arbitrary: auth-js refreshes on its own once a token is
 * within EXPIRY_MARGIN_MS — AUTO_REFRESH_TICK_THRESHOLD (3) ×
 * AUTO_REFRESH_TICK_DURATION_MS (30s) = 90 seconds. Inside that band a page
 * render's own getUser() starts attempting a refresh it cannot persist, which
 * is precisely the failure this endpoint exists to prevent. Five minutes clears
 * it by more than 3×, while staying far enough below the hour-long token
 * lifetime that a tab rotates about once an hour rather than once per focus.
 */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

function isSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export async function POST(request: Request) {
  if (!isSameOrigin(request)) {
    return NextResponse.json({ expiresAt: null }, { status: 403 });
  }

  const supabase = await createClient();

  /*
   * Reads the session straight out of the request cookies — no network call
   * unless auth-js finds the token already inside its own 90s margin, and the
   * refresh it does in that case is exactly the one we want, persisted here
   * because a Route Handler can write cookies.
   */
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session?.expires_at) {
    return NextResponse.json({ expiresAt: null }, { status: 401 });
  }

  if (session.expires_at * 1000 - Date.now() > REFRESH_MARGIN_MS) {
    return NextResponse.json({ expiresAt: session.expires_at });
  }

  // No argument on purpose. Passing the session read above would hand
  // refreshSession a refresh token that getSession may already have spent.
  const { data, error } = await supabase.auth.refreshSession();

  if (error || !data.session?.expires_at) {
    console.error("[session-refresh] refresh failed:", error);
    return NextResponse.json({ expiresAt: null }, { status: 401 });
  }

  return NextResponse.json({ expiresAt: data.session.expires_at });
}
