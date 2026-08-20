import "server-only";

/**
 * The provider seam.
 *
 * ── Where a second provider plugs in ─────────────────────────
 *
 * Everything provider-specific — endpoint URLs, scope strings, the shape of a
 * token response, how a primary calendar and its timezone are discovered —
 * lives behind this interface. `google.ts` implements it. Adding Microsoft is
 * a new module implementing `CalendarProvider` plus one line in the registry
 * at the bottom of this file; nothing in connections.ts, the routes or the UI
 * needs to know a second provider exists.
 *
 * Microsoft is deliberately NOT stubbed. A stub that throws is a file that
 * looks finished in a directory listing, gets imported by mistake, and shows
 * up in a UI as a broken button. When the Azure tenant exists, the work is to
 * write `microsoft.ts` against this interface — which is a smaller job than
 * unpicking a stub written without the API in front of you.
 *
 * ── What is deliberately NOT abstracted ──────────────────────
 *
 * The `calendar_connections` row shape. Both providers issue OAuth2 tokens
 * with refresh, so one table serves both; a provider that did not fit would be
 * a schema conversation, not an interface one.
 */

/** Values the `provider` column accepts. Microsoft is unimplemented. */
export type CalendarProviderId = "google" | "microsoft";

/** Tokens as the provider returns them, normalised. */
export type TokenSet = {
  accessToken: string;
  /**
   * ABSENT on most re-authorisations — this is not an error condition and
   * must never be written over a refresh token we already hold. See the
   * note on storeTokens in connections.ts.
   */
  refreshToken: string | null;
  /** Absolute instant the access token dies, as an ISO string. */
  expiresAt: string;
  /** Space-separated granted scopes, as returned. May differ from requested. */
  scope: string | null;
};

/** Who the tokens belong to, and which calendar to write to later. */
export type ProviderAccount = {
  /** The account's email address. Shown in the UI so a recruiter with two
   *  Google accounts can tell which one they connected. */
  email: string;
  /** Provider's id for the primary calendar. */
  calendarId: string;
  /**
   * The calendar's IANA zone, e.g. "Asia/Karachi". Stored on the row so every
   * later booking is UTC plus a named zone rather than a local timestamp.
   * Null when the provider did not report one — the caller decides the
   * fallback rather than this layer inventing "UTC".
   */
  timezone: string | null;
};

/** A block of time the host is not free. Instants, never wall clocks. */
export type BusyInterval = { start: number; end: number };

/**
 * A meeting to place on the host's calendar.
 *
 * `timeZone` accompanies the instants deliberately. The instants alone fully
 * determine WHEN, but a calendar entry also has to render sensibly for a human
 * and survive the organiser later dragging it — providers use the attached
 * zone for that, and omitting it makes a recurring or moved event resolve
 * against the provider's default rather than the host's.
 */
export type EventDraft = {
  calendarId: string;
  summary: string;
  description: string;
  startMs: number;
  endMs: number;
  timeZone: string;
  attendeeEmails: string[];
  /**
   * Ask the provider to mint a conferencing link. False when the recruiter
   * supplied a manual URL, which is then put in the location instead.
   */
  requestConferencing: boolean;
  /** Used instead of provider conferencing when requestConferencing is false. */
  manualUrl: string | null;
};

export type CreatedEvent = {
  /** Stored as interview_bookings.provider_event_id, for session 3. */
  eventId: string;
  /**
   * The meeting URL, whatever its origin.
   *
   * May be null even on success: a Google Calendar account can exist without
   * Meet, so a calendar provider does NOT imply a meeting provider. Which one
   * actually produced the link is reported separately.
   */
  meetingUrl: string | null;
  /**
   * The MEETING provider, which is not the calendar provider. "google_meet",
   * "manual", or null when there is no link at all. Stored separately so a
   * later change of calendar provider does not silently reinterpret every
   * historical meeting link.
   */
  meetingProvider: string | null;
};

export interface CalendarProvider {
  readonly id: CalendarProviderId;
  /** Shown in the UI. */
  readonly label: string;

  /** The consent screen to send the browser to. */
  authorizeUrl(state: string, redirectUri: string): string;

  /** Swap the one-time code for tokens. Throws on a provider error. */
  exchangeCode(code: string, redirectUri: string): Promise<TokenSet>;

  /** Swap a refresh token for a fresh access token. Throws on a provider error. */
  refresh(refreshToken: string): Promise<TokenSet>;

  /** Identify the account and its primary calendar. Throws on a provider error. */
  describeAccount(accessToken: string): Promise<ProviderAccount>;

  /**
   * Busy intervals in a window. Optional so a provider can be added for
   * connection only before its scheduling surface is written.
   */
  freeBusy?(
    accessToken: string,
    args: { calendarId: string; startMs: number; endMs: number },
  ): Promise<BusyInterval[]>;

  /** Place the meeting. Throws on a provider error — the caller must not
   *  record a booking whose event never landed. */
  createEvent?(accessToken: string, draft: EventDraft): Promise<CreatedEvent>;

  /**
   * Invalidate the grant at the provider.
   *
   * Returns true when the grant is gone — INCLUDING when the provider says the
   * token was already invalid, which is the desired end state reached early
   * rather than a failure. Returns false when we could not tell (network,
   * 5xx); it must not throw, because disconnect has to proceed either way.
   */
  revoke(token: string): Promise<boolean>;
}

/**
 * Provider registry.
 *
 * A plain object rather than a Map so the keys are visible to TypeScript and
 * an unimplemented provider is a type error at the call site instead of an
 * undefined at runtime.
 */
const REGISTRY: Partial<Record<CalendarProviderId, CalendarProvider>> = {};

export function registerProvider(provider: CalendarProvider): void {
  REGISTRY[provider.id] = provider;
}

/**
 * Look up a provider, or null when it is not implemented.
 *
 * Null rather than throw: a `calendar_connections` row could name a provider
 * this deployment cannot service (a row written before a rollback, say), and
 * that should render as "needs reconnecting" rather than crash a settings
 * page.
 */
export function getProvider(id: string): CalendarProvider | null {
  return REGISTRY[id as CalendarProviderId] ?? null;
}

/** Providers this deployment can actually connect. Drives the UI. */
export function implementedProviders(): CalendarProvider[] {
  return Object.values(REGISTRY).filter((p): p is CalendarProvider => Boolean(p));
}
