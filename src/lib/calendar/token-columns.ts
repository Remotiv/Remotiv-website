import "server-only";
import { open, seal, sealedKeyId, TokenCryptoError, tokenAad } from "./token-crypto";

/**
 * The token columns of calendar_connections (#68, step 12). The ONLY place
 * that writes them (sealedWrite) or reads them (readTokens):
 * token-columns-tripwire.test.ts fails any other file that does either.
 *
 * ── Sealed only (12e) ────────────────────────────────────────
 *
 * The sealed copies are the only store. Every write sets the plaintext
 * columns to NULL, and nothing reads them: they are emptied by the 12e data
 * step and dropped in 12f. A seal that fails (keys missing or invalid) fails
 * the write: there is no plaintext to fall back to.
 *
 * ── Bound to the stored row ──────────────────────────────────
 *
 * Each token is sealed for its row (tokenAad: connection id | member id |
 * provider). `row.id` is the id the row has, or is inserted with, and a row's
 * id never changes (storeTokens never upserts).
 *
 * ── One key per row; a missing refresh token never destroys one ──
 *
 * token_key_id names the key both sealed columns are under, so the refresh
 * token is re-sealed with the access token: the new one when the write carries
 * one, else the one the row already holds (`storedRefreshToken`, opened by
 * readTokens). With neither, refresh_token_enc is left OUT of the write, so
 * the stored copy is kept as it is (Google sends a refresh token only on some
 * authorisations, and never on a refresh).
 */

type Row = { id: string; memberId: string; provider: string };

/** The token columns of one write. The plaintext ones are always null. */
export type SealedWrite = {
  access_token: null;
  refresh_token: null;
  access_token_enc: string;
  refresh_token_enc?: string;
  token_key_id: string;
};

export type SealResult = { ok: true; columns: SealedWrite } | { ok: false; reason: string };

/**
 * The token columns for a write to `row`. On a seal failure, `ok: false` and
 * one line, "[calendar-token-crypto] seal_failed reason=<code>": the caller
 * fails the connect or refresh.
 */
export function sealedWrite(
  row: Row,
  tokens: {
    accessToken: string;
    /** A refresh token this write carries, or null when it carries none. */
    refreshToken: string | null;
    /** The refresh token the row already holds (readTokens), re-sealed when the write carries none. */
    storedRefreshToken?: string | null;
  },
): SealResult {
  const refresh = tokens.refreshToken || tokens.storedRefreshToken || null;
  try {
    const aad = tokenAad(row);
    const accessEnc = seal(tokens.accessToken, aad);
    return {
      ok: true,
      columns: {
        access_token: null,
        refresh_token: null,
        access_token_enc: accessEnc,
        ...(refresh ? { refresh_token_enc: seal(refresh, aad) } : {}),
        token_key_id: sealedKeyId(accessEnc) as string,
      },
    };
  } catch (err) {
    const reason = err instanceof TokenCryptoError ? err.reason : "unexpected";
    console.error(`[calendar-token-crypto] seal_failed reason=${reason}`);
    return { ok: false, reason };
  }
}

// ── Reading ──────────────────────────────────────────────────

/**
 * A calendar_connections row as a token read sees it. Every select that reads
 * tokens names all of these columns, and no plaintext token column
 * (token-columns-tripwire.test.ts checks connections.ts' ROW_COLUMNS and
 * STORED_TOKEN_COLUMNS).
 */
export type TokenRow = {
  id: string;
  member_id: string;
  provider: string;
  access_token_enc: string | null;
  refresh_token_enc: string | null;
  token_key_id: string | null;
  updated_at: string;
};

export type ReadTokens = {
  accessToken: string | null;
  refreshToken: string | null;
  /** A sealed copy was there but did not open. */
  openFailed: boolean;
};

/**
 * The row's tokens, from its sealed copies only. Never throws. A copy that
 * does not open (wrong key, key missing, tampered, moved to another row) is
 * null, with "[calendar-token] open_failed reason=<code>"; the caller's path
 * for a dead grant applies (reconnect needed). Nothing is ever re-sealed here:
 * a wrong key in the configuration fails the same way, and re-sealing under
 * it would overwrite a copy the right key can still open.
 */
export function readTokens(row: TokenRow): ReadTokens {
  let openFailed = false;
  const one = (sealed: string | null): string | null => {
    if (!sealed) return null;
    try {
      return open(
        sealed,
        tokenAad({ id: row.id, memberId: row.member_id, provider: row.provider }),
      );
    } catch (err) {
      const reason = err instanceof TokenCryptoError ? err.reason : "unexpected";
      console.error(`[calendar-token] open_failed reason=${reason}`);
      openFailed = true;
      return null;
    }
  };
  return {
    accessToken: one(row.access_token_enc),
    refreshToken: one(row.refresh_token_enc),
    openFailed,
  };
}
