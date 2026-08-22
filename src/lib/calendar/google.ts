import "server-only";
import {
  type BusyInterval,
  type CalendarProvider,
  type CreatedEvent,
  type EventDraft,
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
   * Busy intervals from the freeBusy endpoint.
   *
   * freeBusy rather than listing events: it returns opaque busy blocks with no
   * titles, attendees or descriptions, which is all availability needs and the
   * least the scope has to expose. Reading full event bodies to compute
   * availability would put a recruiter's meeting subjects through this server
   * for no benefit.
   *
   * `timeMin`/`timeMax` are sent as UTC instants and the response is parsed
   * back to instants. No wall-clock time crosses this boundary in either
   * direction.
   */
  async freeBusy(accessToken, { calendarId, startMs, endMs }): Promise<BusyInterval[]> {
    const res = await fetch(`${CALENDAR_API}/freeBusy`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        timeMin: new Date(startMs).toISOString(),
        timeMax: new Date(endMs).toISOString(),
        items: [{ id: calendarId }],
      }),
      cache: "no-store",
    });
    if (!res.ok) throw await providerError(res, "Google free/busy");

    const body = (await res.json()) as {
      calendars?: Record<string, { busy?: { start?: string; end?: string }[]; errors?: unknown[] }>;
    };
    const entry = body.calendars?.[calendarId] ?? Object.values(body.calendars ?? {})[0];

    /*
     * Google reports per-calendar errors INSIDE a 200 response. Treating that
     * as "no busy blocks" would offer every working hour against a calendar we
     * failed to read — the exact confident double-booking this feature must
     * not produce. Throw, so the caller returns "unreadable".
     */
    if (entry?.errors?.length) {
      throw new Error("Google could not read this calendar's free/busy");
    }

    return (entry?.busy ?? [])
      .map((b) => ({ start: Date.parse(b.start ?? ""), end: Date.parse(b.end ?? "") }))
      .filter((b) => Number.isFinite(b.start) && Number.isFinite(b.end) && b.end > b.start);
  },

  /**
   * Create the event, and a Meet link when asked for one.
   *
   * ── Calendar provider is not meeting provider ────────────────
   *
   * A Google Calendar account does not guarantee Meet — Workspace policy can
   * disable conferencing, and a plain consumer account behaves differently
   * again. So conferencing is REQUESTED, the response is inspected for what
   * actually came back, and the meeting provider is reported separately from
   * the calendar provider rather than inferred from it.
   *
   * When no link materialises, the event is still created. A meeting with a
   * time and no link is a booking someone can fix; a failed booking is not.
   */
  async createEvent(accessToken, draft: EventDraft): Promise<CreatedEvent> {
    const conferenceRequest = draft.requestConferencing
      ? {
          conferenceData: {
            createRequest: {
              // Idempotency key: a retried create must not mint a second
              // conference for the same meeting.
              requestId: `remotiv-${draft.startMs}-${draft.calendarId}`.slice(0, 64),
              conferenceSolutionKey: { type: "hangoutsMeet" },
            },
          },
        }
      : {};

    const params = new URLSearchParams({
      sendUpdates: "all",
      ...(draft.requestConferencing ? { conferenceDataVersion: "1" } : {}),
    });

    const res = await fetch(
      `${CALENDAR_API}/calendars/${encodeURIComponent(draft.calendarId)}/events?${params}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          summary: draft.summary,
          description: draft.description,
          // dateTime is a UTC instant; timeZone travels alongside it so the
          // provider renders and re-resolves it in the host's zone.
          start: { dateTime: new Date(draft.startMs).toISOString(), timeZone: draft.timeZone },
          end: { dateTime: new Date(draft.endMs).toISOString(), timeZone: draft.timeZone },
          attendees: draft.attendeeEmails.filter(Boolean).map((email) => ({ email })),
          ...(draft.manualUrl ? { location: draft.manualUrl } : {}),
          ...conferenceRequest,
        }),
        cache: "no-store",
      },
    );
    if (!res.ok) throw await providerError(res, "Google event create");

    const body = (await res.json()) as {
      id?: string;
      hangoutLink?: string;
      conferenceData?: { entryPoints?: { entryPointType?: string; uri?: string }[] };
    };

    const meetUrl =
      body.hangoutLink ??
      body.conferenceData?.entryPoints?.find((e) => e.entryPointType === "video")?.uri ??
      null;

    // Manual URL wins when supplied — the recruiter chose it explicitly.
    const meetingUrl = draft.manualUrl ?? meetUrl;
    const meetingProvider = draft.manualUrl ? "manual" : meetUrl ? "google_meet" : null;

    if (draft.requestConferencing && !meetUrl && !draft.manualUrl) {
      console.error(
        "[calendar] Google created the event but issued no Meet link — conferencing may be disabled for this account.",
      );
    }

    return { eventId: body.id ?? "", meetingUrl, meetingProvider };
  },

  /**
   * PATCH the event's times. Everything else — attendees, description, the
   * Meet link — is left exactly as it is, because a PATCH only touches what it
   * names.
   *
   * `sendUpdates=all` so both attendees get the calendar's own "this event has
   * moved" notice, which is the one their calendar app acts on.
   */
  async updateEventTime(accessToken, { calendarId, eventId, startMs, endMs, timeZone }) {
    const res = await fetch(
      `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}?sendUpdates=all`,
      {
        method: "PATCH",
        headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
        body: JSON.stringify({
          start: { dateTime: new Date(startMs).toISOString(), timeZone },
          end: { dateTime: new Date(endMs).toISOString(), timeZone },
        }),
        cache: "no-store",
      },
    );
    if (!res.ok) throw await providerError(res, "Google event move");
  },

  /**
   * Delete the event.
   *
   * 200/204 is success. So is 404 or 410 — the event is already gone, which is
   * the state we were asking for, and treating that as a failure would leave a
   * cancellation permanently stuck. Anything else means we could not tell, and
   * the caller cancels locally regardless.
   */
  async deleteEvent(accessToken, { calendarId, eventId }) {
    try {
      const res = await fetch(
        `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}?sendUpdates=all`,
        {
          method: "DELETE",
          headers: { authorization: `Bearer ${accessToken}` },
          cache: "no-store",
        },
      );
      if (res.ok || res.status === 404 || res.status === 410) return true;
      return false;
    } catch {
      return false;
    }
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
