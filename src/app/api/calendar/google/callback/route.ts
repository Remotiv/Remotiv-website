import { NextResponse } from "next/server";
import { getCompanyContext } from "@/app/ai-dashboard/lib/company-guards";
import { storeTokens } from "@/lib/calendar/connections";
import "@/lib/calendar/google";
import { getProvider } from "@/lib/calendar/provider";
import { calendarRedirectUri, settingsReturnUrl } from "@/lib/calendar/redirect-uri";
import { STATE_COOKIE, verifyState } from "@/lib/calendar/state";

/**
 * Google hands the browser back here with `code` and `state`.
 *
 * ── The three checks, and why each is separate ───────────────
 *
 *   1. STATE. Signed by us and carrying a nonce that must equal the cookie set
 *      when the flow began. Proves we minted it and that this browser started
 *      it. Without this the endpoint accepts any `code`, and an attacker can
 *      cause a logged-in recruiter to silently attach the ATTACKER's calendar
 *      — after which every interview booked lands in the attacker's diary.
 *
 *   2. SESSION. The caller is re-derived from their own cookies. The identity
 *      in the state payload is never trusted as an instruction, only compared
 *      against.
 *
 *   3. MEMBERSHIP. The member id and company id in the state must match the
 *      session's. A state minted in one account and completed in another is
 *      the confused-deputy case, and a signature alone would wave it through
 *      because the signature is perfectly valid — it just belongs to somebody
 *      else.
 *
 * The cookie is cleared on every path, success or failure, so a state cannot
 * be replayed against a second attempt.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = {
  "cache-control": "no-store, max-age=0",
  "referrer-policy": "no-referrer",
} as const;

/**
 * Back to settings with a short machine-readable reason.
 *
 * Deliberately a code, not a message: the query string is attacker-influenced
 * on the failure paths, and reflecting provider text into a page someone else
 * can trigger is a small XSS surface for no benefit. The settings card maps
 * these to sentences it owns.
 */
function finish(reason: string): NextResponse {
  const res = NextResponse.redirect(
    `${settingsReturnUrl()}?calendar=${encodeURIComponent(reason)}`,
    { headers: NO_STORE },
  );
  // One use only. Cleared even on success — the flow is over either way.
  res.cookies.set(STATE_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/api/calendar",
    maxAge: 0,
  });
  return res;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const stateParam = url.searchParams.get("state");
  const deniedBy = url.searchParams.get("error");

  // The recruiter pressed Cancel on the consent screen. Not an error.
  if (deniedBy) return finish(deniedBy === "access_denied" ? "cancelled" : "provider_error");

  // ── 1. State ──────────────────────────────────────────────
  const cookieNonce =
    request.headers
      .get("cookie")
      ?.split(";")
      .map((c) => c.trim())
      .find((c) => c.startsWith(`${STATE_COOKIE}=`))
      ?.slice(STATE_COOKIE.length + 1) ?? null;

  const state = verifyState(stateParam, cookieNonce ? decodeURIComponent(cookieNonce) : null);
  if (!state.ok) {
    // The reason is logged for us, but only "invalid_state"/"expired" reaches
    // the URL — which of the checks failed is not something a prober should be
    // able to enumerate by watching the redirect.
    console.error("[calendar] callback state rejected:", state.reason);
    return finish(state.reason === "expired" ? "expired" : "invalid_state");
  }

  if (!code) return finish("invalid_state");

  // ── 2. Session ────────────────────────────────────────────
  let ctx: Awaited<ReturnType<typeof getCompanyContext>>;
  try {
    ctx = await getCompanyContext();
  } catch {
    return finish("not_signed_in");
  }

  // ── 3. Membership ─────────────────────────────────────────
  /*
   * Both halves are compared. memberId alone would be enough today because it
   * is unique, but a member whose company changed mid-flow would then write a
   * connection stamped with a company they have left, and every later
   * company-scoped read of that row would be wrong.
   */
  if (!ctx.memberId || ctx.memberId !== state.payload.memberId) {
    console.error("[calendar] callback member mismatch — refusing to store.");
    return finish("member_mismatch");
  }
  if (ctx.companyId !== state.payload.companyId) {
    console.error("[calendar] callback company mismatch — refusing to store.");
    return finish("member_mismatch");
  }

  const provider = getProvider("google");
  if (!provider) return finish("unavailable");

  // ── Exchange, describe, store ─────────────────────────────
  try {
    // The redirect URI must be the same string used to start the flow, or
    // Google rejects the exchange — hence the shared resolver.
    const tokens = await provider.exchangeCode(code, calendarRedirectUri("google"));

    /*
     * If Google somehow issued no refresh token on a FIRST connection, the row
     * would be unrefreshable an hour later. google.ts sends prompt=consent
     * precisely so this cannot happen, and storeTokens will not overwrite an
     * existing one — but a first connection has nothing to preserve, so it is
     * worth knowing about rather than discovering weeks later.
     */
    if (!tokens.refreshToken) {
      console.error(
        "[calendar] Google returned no refresh token on connect — check that prompt=consent is still sent.",
        { memberId: ctx.memberId },
      );
    }

    const account = await provider.describeAccount(tokens.accessToken);

    const stored = await storeTokens({
      companyId: ctx.companyId,
      memberId: ctx.memberId,
      provider: "google",
      tokens,
      account,
    });
    if (!stored.ok) return finish("store_failed");

    return finish(account.timezone ? "connected" : "connected_no_timezone");
  } catch (err) {
    /*
     * Logged, not surfaced. A token-exchange failure message can quote request
     * parameters back, and those parameters include the authorization code.
     * The recruiter gets a code the settings card turns into a sentence.
     */
    console.error("[calendar] Google connect failed:", err instanceof Error ? err.message : err);
    return finish("exchange_failed");
  }
}
