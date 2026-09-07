/**
 * Resolving a CV's storage path, for rows written before the `cvs` bucket was
 * made private.
 *
 * ── Why this module exists ───────────────────────────────────
 *
 * There were TEN copies of this rule: eight identical `deriveCvPathFromUrl`
 * functions, plus two inline regexes, one of which carried a comment saying it
 * was "verbatim" from another file. Every one of them parses the same legacy
 * public-URL shape, and every one of them had to be found and changed together
 * if the bucket name or the URL layout ever moved. That is the same drift shape
 * as the three paging loops, and it is worse here: a copy that silently stops
 * matching does not throw, it just returns null and the CV appears to be gone.
 *
 * ── The legacy shape ─────────────────────────────────────────
 *
 * Before the bucket was private, upload paths persisted a PUBLIC URL into
 * `cv_url` and left `cv_path` null:
 *
 *   https://<ref>.supabase.co/storage/v1/object/public/cvs/<path>
 *
 * That URL 404s now — the bucket is private and every consumer signs. But the
 * `<path>` tail is still the real object key, so it remains the only way to
 * reach a legacy row's file. Which is why `cv_url` stays on those rows and why
 * nothing here deletes it.
 *
 * A PLAIN MODULE — no imports, so a client component can use it. Two of the
 * call sites are in client-side dashboards.
 */

/**
 * The storage path inside a legacy public `cvs` URL, or null.
 *
 * Null for anything that is not that exact shape: a null input, a signed URL, a
 * URL for another bucket, or a bare path that was already a `cv_path`.
 */
export function deriveCvPathFromUrl(cvUrl: string | null | undefined): string | null {
  if (!cvUrl) return null;
  const match = String(cvUrl).match(/^https?:\/\/[^/]+\/storage\/v1\/object\/public\/cvs\/(.+)$/);
  return match ? match[1] : null;
}

/**
 * The storage path for a row, whichever era wrote it.
 *
 * `cv_path` FIRST. That ordering is the point: it is what new rows have, it is
 * what every signing endpoint wants, and the reverse ordering (`cv_url` first)
 * is how a dead public URL used to win over a live path on rows that had both.
 * Legacy rows fall through to the derivation and still resolve.
 */
export function resolveCvPath(row: {
  cv_path?: string | null;
  cv_url?: string | null;
}): string | null {
  const path = (row.cv_path ?? "").trim();
  if (path) return path;
  return deriveCvPathFromUrl(row.cv_url);
}

/**
 * Does this row have a CV at all?
 *
 * The question every "show the CV link" gate is actually asking. Gating on
 * `cv_url` alone was correct only while every upload wrote it; new rows persist
 * `cv_path` and nothing else, so a `cv_url`-only gate now reads as "no CV" for
 * a candidate who has one.
 */
export function hasCv(row: { cv_path?: string | null; cv_url?: string | null }): boolean {
  return Boolean((row.cv_path ?? "").trim() || (row.cv_url ?? "").trim());
}
