import "server-only";
import type { createServiceClient } from "@/lib/supabase/server";
import { open, seal, sealedKeyId, TokenCryptoError, tokenAad } from "./token-crypto";

/**
 * The token columns of calendar_connections, plaintext and sealed (#68, step
 * 12). The ONLY place that writes them (12b, dual write) or reads them (12c and
 * 12d, readTokens): token-columns-tripwire.test.ts fails any other file that
 * does either.
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

// ── Reading (#68, 12c + 12d) ─────────────────────────────────

/**
 * A calendar_connections row as a token read sees it. Every select that reads
 * tokens names all of these columns (token-columns-tripwire.test.ts checks
 * connections.ts' ROW_COLUMNS and STORED_TOKEN_COLUMNS).
 */
export type TokenRow = {
  id: string;
  member_id: string;
  provider: string;
  access_token: string | null;
  refresh_token: string | null;
  access_token_enc: string | null;
  refresh_token_enc: string | null;
  token_key_id: string | null;
  updated_at: string;
};

export type ReadTokens = {
  accessToken: string | null;
  refreshToken: string | null;
  /** "sealed" when every token the row holds came from its sealed copy. */
  source: "sealed" | "plaintext";
  /** A token was read from plaintext because it had NO sealed copy: seal it now (sealIfMissing). */
  missingSealed: boolean;
  /** A sealed copy did not open. Then nothing on the row is re-sealed (see readTokens). */
  openFailed: boolean;
};

/**
 * The row's tokens, from the sealed copies where they open, else plaintext.
 * Never throws.
 *
 *   - Sealed and it opens (for this row: tokenAad): used.
 *   - No sealed copy: the plaintext (the lazy path; the caller seals it now
 *     with sealIfMissing, guarded by updated_at).
 *   - Sealed but it does not open (wrong key, key missing, tampered, moved):
 *     the plaintext if there is one, and "[calendar-token] open_failed
 *     reason=<code>". NOT re-sealed: a wrong key in the configuration fails the
 *     same way, and re-sealing under it would overwrite a copy the right key
 *     can still open. With no plaintext either, that token is null, and the
 *     caller's own path for a dead grant applies.
 */
export function readTokens(row: TokenRow): ReadTokens {
  let fromPlain = false;
  let missingSealed = false;
  let openFailed = false;
  const one = (sealed: string | null, plain: string | null): string | null => {
    if (sealed) {
      try {
        return open(
          sealed,
          tokenAad({ id: row.id, memberId: row.member_id, provider: row.provider }),
        );
      } catch (err) {
        const reason = err instanceof TokenCryptoError ? err.reason : "unexpected";
        console.error(`[calendar-token] open_failed reason=${reason}`);
        openFailed = true;
        if (plain) fromPlain = true;
        return plain || null;
      }
    }
    if (plain) {
      fromPlain = true;
      missingSealed = true;
    }
    return plain || null;
  };
  const accessToken = one(row.access_token_enc, row.access_token);
  const refreshToken = one(row.refresh_token_enc, row.refresh_token);
  return {
    accessToken,
    refreshToken,
    source: fromPlain ? "plaintext" : "sealed",
    missingSealed,
    openFailed,
  };
}

/**
 * The lazy path: a token was read from plaintext because it had no sealed
 * copy, so both are sealed now for this row, but only if the row is still as
 * it was read (its updated_at): a write in between brought its own sealed
 * copies, which stand. Never when a sealed copy on the row failed to open
 * (that copy is left for the right key). Logs "[calendar-token]
 * read=plaintext sealed_now=<bool>". Never throws; a failure leaves the row
 * as it was.
 */
export async function sealIfMissing(
  service: ReturnType<typeof createServiceClient>,
  row: TokenRow,
  tokens: ReadTokens,
): Promise<boolean> {
  if (!tokens.missingSealed) return false;
  if (tokens.openFailed || !tokens.accessToken) {
    console.log("[calendar-token] read=plaintext sealed_now=false");
    return false;
  }
  let sealedNow = false;
  try {
    const sealed = sealedTokenColumns(
      { id: row.id, memberId: row.member_id, provider: row.provider },
      { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken },
    );
    if (sealed.token_key_id) {
      const { data, error } = await service
        .from("calendar_connections")
        .update(sealed)
        .eq("id", row.id)
        .eq("updated_at", row.updated_at)
        .select("id");
      sealedNow = !error && Array.isArray(data) && data.length > 0;
    }
  } catch {
    sealedNow = false;
  }
  console.log(`[calendar-token] read=plaintext sealed_now=${sealedNow}`);
  return sealedNow;
}
