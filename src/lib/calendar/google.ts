import "server-only";
import {
  type CalendarProvider,
  type ProviderAccount,
  registerProvider,
  type TokenSet,
} from "./provider";

/**
 * Google Calendar, behind the CalendarProvider seam.
 *
 * Nothing outside this file knows a Google endpoint, a Google scope string or
 * the shape of a Google token response.
 */

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";
const CALENDAR_API = "https://www.googleapis.com/calendar/v3";

/**
 * Scopes.
 *
 * `calendar.events` rather than the full `calendar` scope: sessions 2 and 3
 * need to read busy times and create, move and cancel events, none of which
 * requires the ability to delete a recruiter's calendars or edit their
 * sharing rules. `userinfo.email` is what puts a recognisable address on the
 * settings card — a recruiter with a personal and a work Google account needs
 * to see which one they connected.
 */
const SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/userinfo.email",
];

/** Treat a token as dead this long before it truly expires, so a refresh
 *  decided at the top of a request is still valid by the time the call lands. */
export const EXPIRY_SKEW_MS = 60_000;

function credentials(): { clientId: string; clientSecret: string } {
  const clientId = process.env.GOOGLE_CALENDAR_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CALENDAR_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("Google Calendar credentials are not configured");
  }
  return { clientId, clientSecret };
}

/**
 * Turn a failed provider call into an error safe to store and log.
 *
 * Google echoes nothing secret in an error body, but a token exchange body
 * CONTAINS the code and the client secret, so the request is never logged —
 * only the response's error fields, and only the short ones.
 */
async function providerError(res: Response, what: string): Promise<Error> {
  let detail = "";
  try {
    const body = (await res.json()) as { error?: string; error_description?: string };
    detail = [body?.error, body?.error_description].filter(Boolean).join(": ");
  } catch {
    detail = "";
  }
  return new Error(`${what} failed (${res.status})${detail ? `: ${detail.slice(0, 200)}` : ""}`);
}

function toTokenSet(raw: unknown): TokenSet {
  const body = raw as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  };
  if (!body?.access_token) throw new Error("Google returned no access token");

  // expires_in is seconds from now. Convert to an absolute instant here so
  // nothing downstream has to remember what the number was relative to.
  const lifetimeMs = (body.expires_in ?? 3600) * 1000;

  return {
    accessToken: body.access_token,
    // Deliberately null rather than undefined when absent — see storeTokens.
    refreshToken: body.refresh_token ?? null,
    expiresAt: new Date(Date.now() + lifetimeMs).toISOString(),
    scope: body.scope ?? null,
  };
}

const google: CalendarProvider = {
  id: "google",
  label: "Google Calendar",

  /**
   * The consent URL.
   *
   * `access_type=offline` asks for a refresh token. `prompt=consent` FORCES
   * the consent screen every time, and that is not a UX oversight:
   *
   * Google issues a refresh token on the FIRST authorisation of a given
   * client/user pair and, on subsequent ones, omits it. A recruiter
   * reconnecting — after switching accounts, or because they were asked to —
   * would come back with an access token and no refresh token. Writing that
   * response over the row would erase a working refresh token, and nothing
   * would break until the access token expired an hour later. `prompt=consent`
   * makes Google reissue one every time, so the row is always complete.
   *
   * storeTokens ALSO refuses to overwrite a refresh token with nothing. Two
   * defences, because this failure is silent and weeks-delayed, and a future
   * change to these parameters must not be able to reintroduce it.
   *
   * `include_granted_scopes` keeps previously granted scopes attached rather
   * than replacing them.
   */
  authorizeUrl(state, redirectUri) {
    const { clientId } = credentials();
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: SCOPES.join(" "),
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
      state,
    });
    return `${AUTH_ENDPOINT}?${params.toString()}`;
  },

  async exchangeCode(code, redirectUri) {
    const { clientId, clientSecret } = credentials();
    const res = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
      cache: "no-store",
    });
    if (!res.ok) throw await providerError(res, "Google token exchange");
    return toTokenSet(await res.json());
  },

  async refresh(refreshToken) {
    const { clientId, clientSecret } = credentials();
    const res = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "refresh_token",
      }),
      cache: "no-store",
    });
    if (!res.ok) throw await providerError(res, "Google token refresh");
    // A refresh response never carries a new refresh token; toTokenSet maps
    // that to null and storeTokens keeps the one already on the row.
    return toTokenSet(await res.json());
  },

  /**
   * Identify the account and its primary calendar.
   *
   * Two calls rather than one: `calendars/primary` gives the calendar id and
   * its IANA timezone but its `summary` is not reliably an email address, and
   * the address is what the recruiter recognises on the settings card.
   */
  async describeAccount(accessToken): Promise<ProviderAccount> {
    const authed = { authorization: `Bearer ${accessToken}` };

    const [calRes, meRes] = await Promise.all([
      fetch(`${CALENDAR_API}/calendars/primary`, { headers: authed, cache: "no-store" }),
      fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
        headers: authed,
        cache: "no-store",
      }),
    ]);

    if (!calRes.ok) throw await providerError(calRes, "Google primary calendar lookup");

    const cal = (await calRes.json()) as { id?: string; timeZone?: string };

    // The address is a nicety; the calendar is not. A userinfo failure must
    // not sink an otherwise working connection.
    let email = "";
    if (meRes.ok) {
      const me = (await meRes.json()) as { email?: string };
      email = me?.email ?? "";
    }

    return {
      email: email || (cal.id ?? ""),
      calendarId: cal.id ?? "primary",
      // Null, never a substituted "UTC" — the caller decides the fallback and
      // a wrong zone silently shifts every future booking by hours.
      timezone: cal.timeZone ?? null,
    };
  },

  /**
   * Revoke at Google.
   *
   * 200 is success. So is a 400 naming an invalid token: the grant is already
   * gone, which is the state we were asking for. Anything else means we could
   * not tell, and the caller proceeds with the local delete regardless.
   */
  async revoke(token) {
    try {
      const res = await fetch(REVOKE_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token }),
        cache: "no-store",
      });
      if (res.ok) return true;
      if (res.status === 400) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        if (body?.error === "invalid_token") return true;
      }
      return false;
    } catch {
      return false;
    }
  },
};

registerProvider(google);

export { google };
