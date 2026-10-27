import { createHash } from "node:crypto";

/**
 * The connections the BROWSER will use, reported by the server as hashes.
 *
 * The sentinel read proves where the server's service-role client talks. The
 * browser never uses that client: it is handed NEXT_PUBLIC_SUPABASE_URL and
 * NEXT_PUBLIC_SUPABASE_ANON_KEY, inlined from this process's environment into
 * the bundle (src/lib/supabase/client.ts). A server on staging and a browser
 * bundle on production is a split the sentinel cannot see, so this reports:
 *
 *   publicRefSha256    SHA-256 of the project ref in NEXT_PUBLIC_SUPABASE_URL
 *   anonKeyRefSha256   SHA-256 of the `ref` claim inside the anon key, when
 *                      the key is a legacy JWT (null for a publishable key)
 *   anonKeyValid       whether the project's auth settings endpoint accepts
 *                      the key as its apikey (null when unreachable)
 *
 * Hashes and booleans only. No ref, URL or key fragment leaves this module.
 */

export type PublicConnection = {
  publicRefSha256: string | null;
  anonKeyRefSha256: string | null;
  anonKeyValid: boolean | null;
};

export const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

/** The project ref in a Supabase URL, or null for anything else. */
export function refOf(url: string | undefined): string | null {
  if (!url) return null;
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }
  if (!host.endsWith(".supabase.co") && !host.endsWith(".supabase.in")) return null;
  return host.split(".")[0] || null;
}

/** The `ref` claim of a legacy JWT anon key, decoded without verification; null otherwise. */
export function anonKeyRef(key: string | undefined): string | null {
  if (!key) return null;
  const parts = key.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as {
      ref?: unknown;
    };
    return typeof payload.ref === "string" && payload.ref !== "" ? payload.ref : null;
  } catch {
    return null;
  }
}

export async function publicConnection({
  url,
  anonKey,
  fetchImpl = globalThis.fetch,
}: {
  url: string | undefined;
  anonKey: string | undefined;
  fetchImpl?: typeof fetch;
}): Promise<PublicConnection> {
  const ref = refOf(url);
  const keyRef = anonKeyRef(anonKey);
  let valid: boolean | null = null;
  if (ref && anonKey) {
    try {
      const res = await fetchImpl(`${new URL(url as string).origin}/auth/v1/settings`, {
        headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` },
      });
      valid = res.status === 200;
    } catch {
      valid = null;
    }
  }
  return {
    publicRefSha256: ref ? sha256(ref) : null,
    anonKeyRefSha256: keyRef ? sha256(keyRef) : null,
    anonKeyValid: valid,
  };
}
