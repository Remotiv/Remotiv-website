import "server-only";
import { seal, sealedKeyId, TokenCryptoError, tokenAad } from "./token-crypto";

/**
 * The token columns of a calendar_connections write, plaintext and sealed
 * together (#68, step 12b: dual write). The ONLY place that builds them:
 * token-columns-tripwire.test.ts fails any other file that writes
 * access_token or refresh_token to the table.
 *
 * Reads stay on the plaintext columns for now (12d switches them); this keeps
 * the sealed copies in step with every write, so the backfill (12c) has only
 * the rows written before this, or whose seal failed, left to do.
 *
 * ── Bound to the stored row ──────────────────────────────────
 *
 * Each token is sealed for its row (tokenAad: connection id | member id |
 * provider). `row.id` must be the id the row HAS: a write never sends an id,
 * so a row's id is the database's and never changes. Where the id is not
 * known before the write (storeTokens' upsert), the plaintext goes first with
 * the sealed columns cleared (plainTokenColumns), the upsert returns the
 * stored row, and the sealed columns follow for that id
 * (sealedTokenColumns).
 *
 * ── One key per row ──────────────────────────────────────────
 *
 * token_key_id names the key both sealed columns are under. So whenever the
 * access token is re-sealed, the refresh token is re-sealed too, from the new
 * one when the write carries one, else from the one already stored
 * (`storedRefreshToken`). The plaintext refresh_token is still written ONLY
 * when the write carries a new one (storeTokens' rule: an absent refresh token
 * must never overwrite a working one).
 *
 * ── A seal that fails does not block ─────────────────────────
 *
 * Missing or invalid keys must not stop a connect or a refresh in 12b: the
 * plaintext is written, the sealed columns and token_key_id are written NULL
 * (never left holding a copy of an older token), and one line is logged with
 * the reason code only. The backfill picks those rows up.
 */

export type TokenColumns = {
  access_token: string;
  refresh_token?: string;
  access_token_enc: string | null;
  refresh_token_enc: string | null;
  token_key_id: string | null;
};

type Row = { id: string; memberId: string; provider: string };
type SealedColumns = Pick<TokenColumns, "access_token_enc" | "refresh_token_enc" | "token_key_id">;

/** Plaintext and sealed together, for a write whose row id is known (the refresh). */
export function tokenColumns(
  row: Row,
  tokens: {
    accessToken: string;
    /** A refresh token this write carries, or null when it carries none. */
    refreshToken: string | null;
    /** The refresh token already stored, re-sealed when the write carries none. */
    storedRefreshToken?: string | null;
  },
): TokenColumns {
  return {
    ...plainTokenColumns(tokens),
    ...sealedTokenColumns(row, {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken || tokens.storedRefreshToken || null,
    }),
  };
}

/**
 * The plaintext, with the sealed columns cleared: the first of two writes when
 * the row id is not known yet. Cleared, so the row never holds a sealed copy
 * of an older token next to a newer plaintext one.
 */
export function plainTokenColumns(tokens: {
  accessToken: string;
  refreshToken: string | null;
}): TokenColumns {
  return {
    access_token: tokens.accessToken,
    ...(tokens.refreshToken ? { refresh_token: tokens.refreshToken } : {}),
    access_token_enc: null,
    refresh_token_enc: null,
    token_key_id: null,
  };
}

/**
 * Just the sealed columns, for the row as stored: `refreshToken` is the
 * refresh token the row holds (new or kept). On a seal failure, all three
 * null and the one log line.
 */
export function sealedTokenColumns(
  row: Row,
  tokens: { accessToken: string; refreshToken: string | null },
): SealedColumns {
  try {
    const aad = tokenAad(row);
    const accessEnc = seal(tokens.accessToken, aad);
    return {
      access_token_enc: accessEnc,
      refresh_token_enc: tokens.refreshToken ? seal(tokens.refreshToken, aad) : null,
      token_key_id: sealedKeyId(accessEnc),
    };
  } catch (err) {
    return unsealed(err instanceof TokenCryptoError ? err.reason : "unexpected");
  }
}

/** The sealed columns cleared, with the one log line; for a seal that failed or could not be tried. */
export function unsealed(reason: string): SealedColumns {
  console.error(`[calendar-token-crypto] seal_failed reason=${reason}`);
  return { access_token_enc: null, refresh_token_enc: null, token_key_id: null };
}
