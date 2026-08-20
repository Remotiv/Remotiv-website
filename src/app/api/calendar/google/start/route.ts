import { NextResponse } from "next/server";
import { getCompanyContext } from "@/app/ai-dashboard/lib/company-guards";
import "@/lib/calendar/google";
import { getProvider } from "@/lib/calendar/provider";
import { calendarRedirectUri, settingsReturnUrl } from "@/lib/calendar/redirect-uri";
import { encodeState, newNonce, STATE_COOKIE } from "@/lib/calendar/state";

/**
 * Begin the Google Calendar consent flow.
 *
 * ── Why a GET route and not a server action ──────────────────
 *
 * The end of this handler is a redirect to Google, and the browser has to
 * perform it as a top-level navigation so the consent screen owns the tab and
 * the callback can come back with the cookie attached. A server action would
 * have to hand a URL back to the client to navigate to, which puts the
 * consent URL — and the state with it — through client JavaScript for no gain.
 *
 * The trade is that a GET is CSRF-reachable: a third-party page can link here
 * and cause a logged-in recruiter's browser to hit it. That is harmless by
 * construction. The handler's only effects are setting a nonce cookie and
 * redirecting to Google's consent screen; nothing is written, and the flow
 * cannot complete without the recruiter actively approving it on Google's own
 * page. The state minted here is bound to THIS session, so a state obtained
 * this way cannot be used to attach a calendar to anyone else.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The consent screen must never be framed, cached, or referrer-leaked. */
const NO_STORE = {
  "cache-control": "no-store, max-age=0",
  "referrer-policy": "no-referrer",
} as const;

function back(reason: string): NextResponse {
  return NextResponse.redirect(`${settingsReturnUrl()}?calendar=${encodeURIComponent(reason)}`, {
    headers: NO_STORE,
  });
}

export async function GET() {
  // Resolves the caller from their session. Throws when there is no session or
  // no active company — caught below so a logged-out click lands on the login
  // page rather than a stack trace.
  let ctx: Awaited<ReturnType<typeof getCompanyContext>>;
  try {
    ctx = await getCompanyContext();
  } catch {
    return NextResponse.redirect(`${settingsReturnUrl()}`, { headers: NO_STORE });
  }

  /*
   * A connection belongs to a MEMBER, not a company — the unique key is
   * (member_id, provider) and the whole feature is "a recruiter connects their
   * own calendar".
   *
   * getCompanyContext resolves memberId to null on the legacy path where an
   * owner is found through companies.user_id and has no company_members row.
   * Such an account has no id to hang a connection on, so the flow stops here
   * with something actionable rather than writing a row keyed on null.
   */
  if (!ctx.memberId) {
    return back("no_member");
  }

  const provider = getProvider("google");
  if (!provider) return back("unavailable");

  const nonce = newNonce();
  const state = encodeState({
    memberId: ctx.memberId,
    companyId: ctx.companyId,
    provider: "google",
    nonce,
    issuedAt: Date.now(),
    returnTo: "/ai-dashboard/settings",
  });
  if (!state) return back("unavailable");

  let url: string;
  try {
    url = provider.authorizeUrl(state, calendarRedirectUri("google"));
  } catch (err) {
    // credentials() throws when the client id/secret are missing. The message
    // names the variable, never a value.
    console.error("[calendar] cannot start Google OAuth:", err);
    return back("unavailable");
  }

  const res = NextResponse.redirect(url, { headers: NO_STORE });

  /*
   * httpOnly so script cannot read it, sameSite "lax" so it IS sent on the
   * top-level GET that Google redirects back with (a "strict" cookie would be
   * withheld on that cross-site navigation and every callback would fail its
   * nonce check), secure in production, and scoped to the callback path so it
   * rides along with nothing else.
   */
  res.cookies.set(STATE_COOKIE, nonce, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/api/calendar",
    maxAge: 600,
  });

  return res;
}
