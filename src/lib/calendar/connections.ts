import "server-only";
import { randomUUID } from "node:crypto";
import { createServiceClient } from "@/lib/supabase/server";
import { accountKeyFor } from "./account-key";
import { EXPIRY_SKEW_MS } from "./google";
import {
  type CalendarProviderId,
  getProvider,
  type ProviderAccount,
  type TokenSet,
} from "./provider";
import { readTokens, sealedWrite, type TokenRow } from "./token-columns";

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
 *   · No token is ever logged. `last_error` stores only CONNECTION_PROBLEM's
 *     plain sentences (#19); a provider's own words go to the log as a code.
 *
 * ── Encrypted at rest (#68) ──────────────────────────────────
 *
 * The tokens are stored only sealed (AES-256-GCM, bound to the row:
 * token-crypto.ts), and token-columns.ts is the one place that seals or opens
 * them. `calendar_connections` is also reachable only through the service-role
 * client, the same posture as `background_jobs` and `usage_events`.
 */

export type CalendarStatus = "active" | "revoked" | "error";

/** The row, as the database holds it. NEVER leaves the server. */
/** The token columns (TokenRow) are read only through token-columns.ts readTokens. */
type ConnectionRow = TokenRow & {
  company_id: string;
  provider_account: string | null;
  expires_at: string | null;
  scope: string | null;
  calendar_id: string | null;
  timezone: string | null;
  status: CalendarStatus;
  last_error: string | null;
  last_synced_at: string | null;
  created_at: string;
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
  "id, member_id, provider, access_token_enc, refresh_token_enc, token_key_id, updated_at, company_id, provider_account, expires_at, scope, calendar_id, timezone, status, last_error, last_synced_at, created_at";

/**
 * What storeTokens reads of an existing row: the token columns readTokens
 * needs (TokenRow), so the write knows the row's id, its updated_at (the
 * guard) and the refresh token it holds. Spelled out here, as ROW_COLUMNS is:
 * the tenant scan reads selects only as same-file string constants.
 * token-columns-tripwire.test.ts checks that both name every TokenRow column
 * and no plaintext token column.
 */
const STORED_TOKEN_COLUMNS =
  "id, member_id, provider, access_token_enc, refresh_token_enc, token_key_id, updated_at";

/** storeTokens' tries: a read and a guarded write each, again when a racing write moved the row. */
const STORE_ATTEMPTS = 3;
const UNIQUE_VIOLATION = "23505";

/** Columns safe to read when only the view is needed — no tokens fetched at all. */
const VIEW_COLUMNS = "provider, provider_account, timezone, status, last_error, created_at";

/**
 * What the settings card says about a calendar that stopped working (#19).
 * Only these sentences are ever written to `last_error`, and only these are
 * ever shown: a stored value that is not one of them (a provider's own text,
 * written before #19) is shown as the plain sentence for its status instead.
 * The provider's words go to the server log as a code, never to a screen.
 */
export const CONNECTION_PROBLEM = {
  revoked: "Access was revoked at the provider. Reconnect to continue.",
  noRefreshToken: "This calendar needs reconnecting. No refresh token is stored.",
  unavailable: "This calendar provider isn't available right now. Reconnect to continue.",
  refreshFailed: "This calendar couldn't be refreshed just now. Try again later, or reconnect it.",
  generic: "This calendar stopped working. Reconnect it to continue.",
} as const;
const KNOWN_PROBLEMS = new Set<string>(Object.values(CONNECTION_PROBLEM));

/** The sentence a not-active connection shows: a known one, else its status's plain one. */
export function connectionProblem(status: CalendarStatus, stored: string | null): string | null {
  if (status === "active") return null;
  if (stored && KNOWN_PROBLEMS.has(stored)) return stored;
  return status === "revoked" ? CONNECTION_PROBLEM.revoked : CONNECTION_PROBLEM.generic;
}

/**
 * Reduce a row to what the client may see. The problem line is one of
 * CONNECTION_PROBLEM's sentences, never stored text as it is (#19).
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
    problem: connectionProblem(row.status, row.last_error),
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
 * One row per (member_id, provider): reconnecting replaces the grant rather
 * than accumulating rows, and a reconnect after a failure clears the error
 * state in the same write.
 *
 * ── Sealed only, and a row's id never changes (#68, 12e) ─────
 *
 * The tokens are stored only sealed, bound to the row's id (token-columns.ts),
 * so the id must be settled before the write and must never change after:
 *   - a row exists: its sealed columns are rewritten for ITS id, guarded by
 *     the updated_at just read, so a write that landed in between is not
 *     overwritten (the guard matches nothing and the loop reads again);
 *   - no row: INSERTED with an id generated here. Never an upsert: on a
 *     conflict an upsert would rewrite the existing row's id, or its sealed
 *     copies under an id the row does not have. Two first connects racing:
 *     the loser's insert hits the unique (member_id, provider) and the loop
 *     reads the winner's row and updates it.
 * A reconnect that brings no refresh token re-seals the one the row holds; if
 * that copy does not open it is left exactly as stored (sealedWrite leaves
 * refresh_token_enc out). A seal that fails, or a read that fails, fails the
 * connect: the settings card says so and the recruiter tries again. Nothing is
 * ever written in plaintext.
 */
export async function storeTokens(args: {
  companyId: string;
  memberId: string;
  provider: CalendarProviderId;
  tokens: TokenSet;
  account: ProviderAccount;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const service = createServiceClient();

  let written = false;
  for (let attempt = 0; attempt < STORE_ATTEMPTS && !written; attempt++) {
    const now = new Date().toISOString();
    const fields: Record<string, unknown> = {
      company_id: args.companyId,
      member_id: args.memberId,
      provider: args.provider,
      provider_account: args.account.email || null,
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

    const { data: existing, error: readError } = await service
      .from("calendar_connections")
      .select(STORED_TOKEN_COLUMNS)
      .eq("member_id", args.memberId)
      .eq("provider", args.provider)
      .maybeSingle();
    if (readError) {
      console.error(`[calendar] storeTokens failed: read ${readError.code ?? "error"}`);
      return { ok: false, error: readError.code ?? "error" };
    }
    const stored = existing as TokenRow | null;
    const rowId = stored?.id ?? randomUUID();
    // THE LINE THAT MATTERS (sealedWrite keeps it): no refresh token in this
    // grant means the one the row holds is kept, re-sealed, never cleared.
    const sealed = sealedWrite(
      { id: rowId, memberId: args.memberId, provider: args.provider },
      {
        accessToken: args.tokens.accessToken,
        refreshToken: args.tokens.refreshToken,
        storedRefreshToken: stored ? readTokens(stored).refreshToken : null,
      },
    );
    if (!sealed.ok) {
      console.error(`[calendar] storeTokens failed: seal_${sealed.reason}`);
      return { ok: false, error: "seal_failed" };
    }

    if (stored) {
      const { data: updated, error } = await service
        .from("calendar_connections")
        .update({ ...fields, ...sealed.columns })
        .eq("id", stored.id)
        .eq("updated_at", stored.updated_at)
        .select("id");
      if (error) {
        // The code only (#19): the message names columns and constraints.
        console.error(`[calendar] storeTokens failed: ${error.code ?? "error"}`);
        return { ok: false, error: error.code ?? "error" };
      }
      // Nothing matched: the row changed (or went) since the read. Read again.
      written = Array.isArray(updated) && updated.length > 0;
      continue;
    }

    const { error } = await service
      .from("calendar_connections")
      .insert({ id: rowId, ...fields, ...sealed.columns });
    if (!error) {
      written = true;
      continue;
    }
    if (error.code === UNIQUE_VIOLATION) continue; // a racing first connect won: read its row
    console.error(`[calendar] storeTokens failed: ${error.code ?? "error"}`);
    return { ok: false, error: error.code ?? "error" };
  }
  if (!written) {
    console.error("[calendar] storeTokens failed: conflict");
    return { ok: false, error: "conflict" };
  }

  /*
   * Which account, as an HMAC (#56, account-key.ts): copied onto every event
   * this connection creates, so a leftover event is cleared automatically only
   * when this SAME account reconnects. Its own write, so a database without
   * the column (migration 070 not yet applied) loses only the key, never the
   * connection: cleanups are then resolved by hand.
   */
  const { error: keyError } = await service
    .from("calendar_connections")
    .update({ provider_account_key: accountKeyFor(args.provider, args.account) ?? "" })
    .eq("member_id", args.memberId)
    .eq("provider", args.provider)
    .eq("company_id", args.companyId);
  if (keyError) console.error(`[calendar] account key not stored: ${keyError.code ?? "error"}`);

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
  message: (typeof CONNECTION_PROBLEM)[keyof typeof CONNECTION_PROBLEM],
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
    await markConnectionProblem(memberId, provider, "error", CONNECTION_PROBLEM.unavailable);
    return null;
  }

  // #68: the sealed copies only. A token that cannot be had (no copy, or one
  // that does not open) is null and takes the paths below: refresh, or the
  // reconnect-needed state.
  const tokens = readTokens(row);

  const expiresAt = row.expires_at ? Date.parse(row.expires_at) : 0;
  const stillValid = Number.isFinite(expiresAt) && expiresAt - EXPIRY_SKEW_MS > Date.now();
  if (tokens.accessToken && stillValid) return tokens.accessToken;

  if (!tokens.refreshToken) {
    /*
     * No refresh token and an expired access token: unrecoverable without the
     * recruiter re-consenting. This is exactly the state the storeTokens rule
     * exists to prevent, so if it is ever seen in the wild it is worth
     * treating as a bug report rather than routine.
     */
    await markConnectionProblem(memberId, provider, "error", CONNECTION_PROBLEM.noRefreshToken);
    return null;
  }

  try {
    const refreshed = await impl.refresh(tokens.refreshToken);
    // #68: both tokens sealed for this row under the current key, the refresh
    // token from the new one if Google sent one, else the one that just worked
    // (same rule as storeTokens: an absence must not destroy it). No plaintext.
    const sealed = sealedWrite(
      { id: row.id, memberId, provider },
      {
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        storedRefreshToken: tokens.refreshToken,
      },
    );
    if (!sealed.ok) {
      // Nothing can be stored without a seal, and the plaintext is never
      // written: the refresh fails, the card says so, a later call retries.
      console.error(`[calendar] token refresh not stored: seal_${sealed.reason}`);
      await markConnectionProblem(memberId, provider, "error", CONNECTION_PROBLEM.refreshFailed);
      return null;
    }
    const service = createServiceClient();
    const patch: Record<string, unknown> = {
      ...sealed.columns,
      expires_at: refreshed.expiresAt,
      status: "active" satisfies CalendarStatus,
      last_error: null,
      last_synced_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    // By id: the copies are sealed for THIS row, so a row disconnected and
    // made again meanwhile (a new id) is left alone.
    const { error } = await service
      .from("calendar_connections")
      .update(patch)
      .eq("id", row.id)
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
    // #19: Google's own words are a code in the log, never the stored problem.
    console.error(
      `[calendar] token refresh failed: ${revoked ? "invalid_grant" : err instanceof Error ? err.name : "error"}`,
    );
    await markConnectionProblem(
      memberId,
      provider,
      revoked ? "revoked" : "error",
      revoked ? CONNECTION_PROBLEM.revoked : CONNECTION_PROBLEM.refreshFailed,
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
  // Whichever copy opens (readTokens), refresh token first. The row is deleted
  // next, so nothing is lazily sealed here.
  const { accessToken, refreshToken } = readTokens(row);
  const token = refreshToken || accessToken;

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

export type MemberDisconnectOutcome =
  | {
      ok: true;
      results: { provider: string; deleted: boolean; revokedAtProvider: boolean }[];
    }
  | { ok: false };

/**
 * Disconnect EVERY calendar a member has connected (#69 step 6), each through
 * `disconnect` above: revoke at the provider, then delete the row, the delete
 * happening either way. Used when a member is removed from the team, so their
 * grant does not outlive their access.
 *
 * Unlike listConnectionsForMember, a failed read is reported (`ok: false`)
 * rather than read as "no connections": the caller has to tell someone the
 * grant may still be live, and an empty list would hide that.
 */
export async function disconnectAllForMember(memberId: string): Promise<MemberDisconnectOutcome> {
  const service = createServiceClient();
  const { data, error } = await service
    .from("calendar_connections")
    .select("provider")
    .eq("member_id", memberId);
  if (error) {
    console.error(`[calendar] disconnectAllForMember: read failed (${error.code ?? "db"})`);
    return { ok: false };
  }
  const results: { provider: string; deleted: boolean; revokedAtProvider: boolean }[] = [];
  for (const row of (data ?? []) as { provider: string }[]) {
    const out = await disconnect(memberId, row.provider as CalendarProviderId);
    results.push({ provider: row.provider, ...out });
  }
  return { ok: true, results };
}

/**
 * Disconnect every calendar connection a COMPANY still has (#69 step 5), each
 * through `disconnect` (revoke, then delete the row either way). The company
 * delete runs it right before the company row goes, to catch a connection made
 * after its per-member pass: the row would otherwise be cascaded away with its
 * token never revoked. A failed read is reported (`ok: false`), as above.
 */
export async function disconnectAllForCompany(companyId: string): Promise<MemberDisconnectOutcome> {
  const service = createServiceClient();
  const { data, error } = await service
    .from("calendar_connections")
    .select("member_id, provider")
    .eq("company_id", companyId)
    .order("member_id", { ascending: true });
  if (error) {
    console.error(`[calendar] disconnectAllForCompany: read failed (${error.code ?? "db"})`);
    return { ok: false };
  }
  const results: { provider: string; deleted: boolean; revokedAtProvider: boolean }[] = [];
  for (const row of (data ?? []) as { member_id: string; provider: string }[]) {
    const out = await disconnect(row.member_id, row.provider as CalendarProviderId);
    results.push({ provider: row.provider, ...out });
  }
  return { ok: true, results };
}
