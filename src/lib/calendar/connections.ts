import "server-only";
import { createServiceClient } from "@/lib/supabase/server";
import { EXPIRY_SKEW_MS } from "./google";
import {
  type CalendarProviderId,
  getProvider,
  type ProviderAccount,
  type TokenSet,
} from "./provider";

/**
 * calendar_connections — reads, writes, and the one supported way to get an
 * access token.
 *
 * ── The token rule ───────────────────────────────────────────
 *
 * Access and refresh tokens are as sensitive as a password: anyone holding
 * them can read and write a recruiter's calendar until they are revoked. So:
 *
 *   · This module is `server-only`. Importing it from a client component is a
 *     BUILD error, not a review comment.
 *   · No function here returns a token to anything but another server module.
 *     `toView()` is the only shape that crosses to the client and it is a
 *     whitelist — new columns are invisible to the UI until someone
 *     deliberately adds them, which is the safe default for a table that will
 *     accumulate more secrets, not fewer.
 *   · No token is ever logged. `last_error` stores provider messages, which
 *     are about the grant, never the credential.
 *
 * ── Not encrypted at rest ────────────────────────────────────
 *
 * The columns hold the tokens as issued. `calendar_connections` is reachable
 * only through the service-role client, the same posture as `background_jobs`
 * and `usage_events`. Application-level encryption would need a key in the
 * environment and a rotation story; it is a real improvement and a deliberate
 * follow-up rather than something to half-do here.
 */

export type CalendarStatus = "active" | "revoked" | "error";

/** The row, as the database holds it. NEVER leaves the server. */
type ConnectionRow = {
  id: string;
  company_id: string;
  member_id: string;
  provider: string;
  provider_account: string | null;
  access_token: string | null;
  refresh_token: string | null;
  expires_at: string | null;
  scope: string | null;
  calendar_id: string | null;
  timezone: string | null;
  status: CalendarStatus;
  last_error: string | null;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * What the CLIENT is allowed to see. Every field here is either the
 * recruiter's own input or a status they must be able to act on.
 *
 * Note what is absent and must stay absent: access_token, refresh_token,
 * expires_at, and the row id.
 */
export type CalendarConnectionView = {
  provider: CalendarProviderId;
  providerLabel: string;
  /** The connected account's email, so two Google accounts are tellable apart. */
  account: string;
  /** Shown as "Times are read and written in <zone>". */
  timezone: string | null;
  status: CalendarStatus;
  /** A short, human message when status is not active. Never a raw stack. */
  problem: string | null;
  connectedAt: string;
};

/** Columns selected for server-side use. Spelled out rather than `*` so a
 *  future column is not silently pulled into memory on every settings render. */
const ROW_COLUMNS =
  "id, company_id, member_id, provider, provider_account, access_token, refresh_token, expires_at, scope, calendar_id, timezone, status, last_error, last_synced_at, created_at, updated_at";

/** Columns safe to read when only the view is needed — no tokens fetched at all. */
const VIEW_COLUMNS = "provider, provider_account, timezone, status, last_error, created_at";

/**
 * Reduce a row to what the client may see.
 *
 * `last_error` is a provider message. It is surfaced because a recruiter whose
 * calendar has silently stopped working needs to know it needs reconnecting —
 * "it broke" with no reason is the state that generates support tickets — but
 * it is truncated, because an unbounded provider string in a UI is how a page
 * ends up rendering something nobody reviewed.
 */
function toView(row: {
  provider: string;
  provider_account: string | null;
  timezone: string | null;
  status: CalendarStatus;
  last_error: string | null;
  created_at: string;
}): CalendarConnectionView {
  return {
    provider: row.provider as CalendarProviderId,
    providerLabel: getProvider(row.provider)?.label ?? row.provider,
    account: row.provider_account ?? "",
    timezone: row.timezone,
    status: row.status,
    problem: row.status === "active" ? null : (row.last_error ?? "").slice(0, 200) || null,
    connectedAt: row.created_at,
  };
}

/**
 * Every calendar the given member has connected, for the settings card.
 *
 * Selects the view columns only, so a token is not even read into memory on a
 * page render. Returns [] for a member with no id — see the note in the
 * settings action about the legacy owner path.
 */
export async function listConnectionsForMember(
  memberId: string | null,
): Promise<CalendarConnectionView[]> {
  if (!memberId) return [];
  const service = createServiceClient();
  const { data, error } = await service
    .from("calendar_connections")
    .select(VIEW_COLUMNS)
    .eq("member_id", memberId)
    .order("created_at", { ascending: true });

  if (error) {
    console.error("[calendar] listConnectionsForMember failed:", error.message);
    return [];
  }
  return (data ?? []).map((r) => toView(r as Parameters<typeof toView>[0]));
}

/** The full row, for server-side callers only. */
async function readRow(memberId: string, provider: string): Promise<ConnectionRow | null> {
  const service = createServiceClient();
  const { data, error } = await service
    .from("calendar_connections")
    .select(ROW_COLUMNS)
    .eq("member_id", memberId)
    .eq("provider", provider)
    .maybeSingle();

  if (error) {
    console.error("[calendar] readRow failed:", error.message);
    return null;
  }
  return (data as ConnectionRow | null) ?? null;
}

/**
 * Create or update the connection for (member, provider).
 *
 * ── The refresh-token rule this exists to enforce ────────────
 *
 * `refresh_token` is written ONLY when the token set actually carries one.
 *
 * Google issues a refresh token on the first authorisation and omits it on
 * later ones; a refresh response never contains one at all. Spreading the
 * token set into the patch would therefore write null over a working refresh
 * token on every re-authorisation and on every single refresh — and nothing
 * would fail until the access token expired, at which point the connection
 * would be permanently dead with no way back except reconnecting. That is the
 * silent, weeks-later breakage this function is shaped to prevent.
 *
 * `prompt=consent` in google.ts makes Google send one every time. This is the
 * second defence: even if that parameter is changed, an absent refresh token
 * can no longer destroy the stored one.
 *
 * Upsert on the unique (member_id, provider): reconnecting replaces the grant
 * rather than accumulating rows, and a reconnect after a failure clears the
 * error state in the same write.
 */
export async function storeTokens(args: {
  companyId: string;
  memberId: string;
  provider: CalendarProviderId;
  tokens: TokenSet;
  account: ProviderAccount;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const service = createServiceClient();
  const now = new Date().toISOString();

  const patch: Record<string, unknown> = {
    company_id: args.companyId,
    member_id: args.memberId,
    provider: args.provider,
    provider_account: args.account.email || null,
    access_token: args.tokens.accessToken,
    expires_at: args.tokens.expiresAt,
    scope: args.tokens.scope,
    calendar_id: args.account.calendarId,
    // The provider's IANA zone. Nothing scheduled later stores a local
    // timestamp; it stores UTC plus this name, so a booking survives the
    // recruiter's DST change and their laptop being set to the wrong zone.
    timezone: args.account.timezone,
    status: "active" satisfies CalendarStatus,
    last_error: null,
    updated_at: now,
  };

  // THE LINE THAT MATTERS. Absent refresh token → key omitted → existing value
  // preserved by the upsert.
  if (args.tokens.refreshToken) {
    patch.refresh_token = args.tokens.refreshToken;
  }

  const { error } = await service
    .from("calendar_connections")
    .upsert(patch, { onConflict: "member_id,provider" });

  if (error) {
    // The message names a column or a constraint, never a token value.
    console.error("[calendar] storeTokens failed:", error.message);
    return { ok: false, error: error.message };
  }
  return { ok: true };
}

/**
 * Mark a connection as needing attention, rather than throwing at the caller.
 *
 * A revoked grant is not an exception — it is a state the recruiter has to see
 * and fix. Callers in sessions 2 and 3 will get a null access token and can
 * skip that recruiter's availability; the settings card is what tells them
 * why.
 */
export async function markConnectionProblem(
  memberId: string,
  provider: string,
  status: Exclude<CalendarStatus, "active">,
  message: string,
): Promise<void> {
  const service = createServiceClient();
  const { error } = await service
    .from("calendar_connections")
    .update({
      status,
      last_error: message.slice(0, 500),
      updated_at: new Date().toISOString(),
    })
    .eq("member_id", memberId)
    .eq("provider", provider);

  if (error) console.error("[calendar] markConnectionProblem failed:", error.message);
}

/**
 * THE ONLY SUPPORTED WAY TO GET AN ACCESS TOKEN.
 *
 * Every future caller — availability lookup, event creation, reschedule,
 * cancel — goes through here and none of them refreshes inline. One place
 * decides whether a token is stale, one place performs the refresh, one place
 * writes the result back. Inline refreshing would mean several call sites
 * racing to refresh the same grant, each writing a different access token over
 * the others, and every one of them reimplementing the expiry arithmetic.
 *
 * Returns null rather than throwing when the connection cannot be used, having
 * first recorded WHY on the row. A caller that gets null should degrade — skip
 * that recruiter's calendar — not abort the operation.
 *
 * Refreshes EARLY, by EXPIRY_SKEW_MS, so a token judged valid at the top of a
 * request has not expired by the time the API call lands.
 */
export async function getAccessToken(
  memberId: string,
  provider: CalendarProviderId = "google",
): Promise<string | null> {
  const row = await readRow(memberId, provider);
  if (!row) return null;

  if (row.status === "revoked") return null;

  const impl = getProvider(provider);
  if (!impl) {
    await markConnectionProblem(
      memberId,
      provider,
      "error",
      `Provider "${provider}" is not available`,
    );
    return null;
  }

  const expiresAt = row.expires_at ? Date.parse(row.expires_at) : 0;
  const stillValid = Number.isFinite(expiresAt) && expiresAt - EXPIRY_SKEW_MS > Date.now();
  if (row.access_token && stillValid) return row.access_token;

  if (!row.refresh_token) {
    /*
     * No refresh token and an expired access token: unrecoverable without the
     * recruiter re-consenting. This is exactly the state the storeTokens rule
     * exists to prevent, so if it is ever seen in the wild it is worth
     * treating as a bug report rather than routine.
     */
    await markConnectionProblem(
      memberId,
      provider,
      "error",
      "This calendar needs reconnecting — no refresh token is stored.",
    );
    return null;
  }

  try {
    const refreshed = await impl.refresh(row.refresh_token);
    const service = createServiceClient();
    const patch: Record<string, unknown> = {
      access_token: refreshed.accessToken,
      expires_at: refreshed.expiresAt,
      status: "active" satisfies CalendarStatus,
      last_error: null,
      last_synced_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    // Same rule as storeTokens: a refresh response has no refresh token, and
    // writing that absence would destroy the one that just worked.
    if (refreshed.refreshToken) patch.refresh_token = refreshed.refreshToken;

    const { error } = await service
      .from("calendar_connections")
      .update(patch)
      .eq("member_id", memberId)
      .eq("provider", provider);

    if (error) {
      // The refresh SUCCEEDED even though persisting it did not, so the token
      // in hand is usable for this request. The next call refreshes again.
      console.error("[calendar] failed to persist refreshed token:", error.message);
    }
    return refreshed.accessToken;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    /*
     * `invalid_grant` is Google's answer when the user revoked access in their
     * Google account, changed their password, or the token simply aged out. It
     * is terminal — retrying cannot fix it — so the row is marked `revoked`
     * and the card tells the recruiter to reconnect. Anything else might be
     * transient, so it is `error` and a later call may recover.
     */
    const revoked = /invalid_grant/i.test(message);
    await markConnectionProblem(
      memberId,
      provider,
      revoked ? "revoked" : "error",
      revoked ? "Access was revoked at the provider. Reconnect to continue." : message,
    );
    return null;
  }
}

/**
 * Disconnect: revoke at the provider, then delete the row — in that order, and
 * the delete happens either way.
 *
 * ── What happens when revocation fails ───────────────────────
 *
 * The row is deleted anyway, and the caller is told revocation did not
 * confirm.
 *
 * The alternative — keep the row so revocation can be retried — is worse on
 * both counts that matter. The recruiter asked us to stop using their
 * calendar, and the part we control is honouring that; a row left behind
 * shows "connected" in the UI and contradicts what they just did. It also
 * means keeping a live credential we have decided not to use, which is
 * strictly more exposure than deleting it.
 *
 * The cost is real and is surfaced rather than hidden: once the row is gone we
 * can never revoke that grant, so it lives at Google until it expires or the
 * recruiter removes it themselves. That is why `revokedAtProvider: false`
 * comes back — the UI tells them to remove Remotiv from their Google account
 * permissions, which is the one action that definitely finishes the job.
 *
 * The refresh token is revoked in preference to the access token: at Google,
 * revoking the refresh token invalidates the whole grant, whereas revoking an
 * access token can leave the refresh token usable.
 */
export async function disconnect(
  memberId: string,
  provider: CalendarProviderId,
): Promise<{ deleted: boolean; revokedAtProvider: boolean }> {
  const row = await readRow(memberId, provider);
  if (!row) return { deleted: false, revokedAtProvider: false };

  let revokedAtProvider = false;
  const impl = getProvider(provider);
  const token = row.refresh_token || row.access_token;

  if (impl && token) {
    // Never throws by contract — disconnect must proceed regardless.
    revokedAtProvider = await impl.revoke(token);
    if (!revokedAtProvider) {
      console.error(
        "[calendar] revocation did not confirm; deleting the local row anyway.",
        // Identifiers only. Never the token.
        { memberId, provider, account: row.provider_account },
      );
    }
  }

  const service = createServiceClient();
  const { error } = await service
    .from("calendar_connections")
    .delete()
    .eq("member_id", memberId)
    .eq("provider", provider);

  if (error) {
    console.error("[calendar] disconnect delete failed:", error.message);
    return { deleted: false, revokedAtProvider };
  }
  return { deleted: true, revokedAtProvider };
}
