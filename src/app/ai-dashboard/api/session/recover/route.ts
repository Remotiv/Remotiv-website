import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  RECOVER_ATTEMPTED_COOKIE,
  RECOVER_ATTEMPTED_MAX_AGE_S,
  safeNext,
} from "@/lib/supabase/session-cookie";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Bring a dead session back, from the one place the result can be saved.
 *
 * ── The path ─────────────────────────────────────────────────
 *
 *   gated render sees an expired access token
 *     → 307 here, carrying the original URL
 *       → this handler refreshes ONCE and writes the new cookies
 *         → success: 303 back to the original URL
 *         → failure: 303 to login
 *
 * A Server Component cannot set cookies, so the gate cannot do this itself —
 * it can only notice. SessionRefresh (the client pinger) cannot either: it
 * mounts UNDER the gate, and the gate has already redirected before it exists.
 * That is why an open tab stayed alive and a cold return did not.
 *
 * ── Loop protection: ONE attempt per navigation, guaranteed ─
 *
 * A redirect loop on the only door into the product is the failure to design
 * against, so the guarantee is structural, not behavioural:
 *
 *   1. The latch cookie is set BEFORE the refresh is attempted, not after. A
 *      crash, timeout or thrown error between here and the redirect still
 *      leaves the latch behind, so the next render cannot come back.
 *   2. The gate refuses to redirect here while the latch is present, and goes
 *      to login instead. The latch is what the gate checks — not the outcome
 *      of the refresh, which it cannot see.
 *   3. This handler never redirects to a gated URL on failure. Success goes
 *      back; anything else goes to login, which is outside the gate.
 *   4. The latch expires on its own in 30 seconds, so a later, separate
 *      navigation gets its own single attempt.
 *
 * So the worst case is exactly two hops: gate → here → login. Not three.
 *
 * ── Why getSession() and not refreshSession() ────────────────
 *
 * refreshSession() with no argument loads the session (which, on an expired
 * token, already rotates it inside __loadSession) and then rotates it AGAIN
 * with _callRefreshToken. Two rotations, sequentially, on one request. Each
 * spends the previous refresh token, so the second is a reuse of a token the
 * first just retired — allowed only inside Supabase's reuse window. getSession()
 * performs the one rotation this handler is for, and setAll persists it.
 *
 * ── GET, deliberately ────────────────────────────────────────
 *
 * It has to be — the gate reaches it with a redirect, which is a GET. The
 * usual objection (a third party could trigger it with <img src>) buys them
 * nothing: it rotates only the visitor's own session and only sends them back
 * to a dashboard URL they already have access to.
 */

function relativeRedirect(location: string) {
  // Relative on purpose — see logout/route.ts for why an absolute Location is
  // wrong on previews and custom domains.
  return new NextResponse(null, { status: 303, headers: { Location: location } });
}

export async function GET(request: Request) {
  const next = safeNext(new URL(request.url).searchParams.get("next"));
  const cookieStore = await cookies();

  // Step 1 of the guarantee: latch first, refresh second.
  cookieStore.set(RECOVER_ATTEMPTED_COOKIE, "1", {
    path: "/ai-dashboard",
    maxAge: RECOVER_ATTEMPTED_MAX_AGE_S,
    httpOnly: true,
    sameSite: "lax",
    secure: new URL(request.url).protocol === "https:",
  });

  try {
    const supabase = await createClient();
    const {
      data: { session },
      error,
    } = await supabase.auth.getSession();

    if (error || !session) {
      console.warn(
        "[session-recover] could not restore a session:",
        error?.message ?? "no session",
      );
      return relativeRedirect("/ai-dashboard/login");
    }
    return relativeRedirect(next);
  } catch (err) {
    console.error("[session-recover] threw:", err);
    return relativeRedirect("/ai-dashboard/login");
  }
}
