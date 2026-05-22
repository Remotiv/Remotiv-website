// Shared canonical host for SEO metadata + JSON-LD.
// Sourced to match `metadataBase` in src/app/layout.tsx (the Vercel preview
// URL today; swap to the production custom domain in ONE place when it goes
// live). Keeping this centralised means JSON-LD `item` URLs, BreadcrumbList
// entries, and any future schema can't drift apart from the canonical that
// Next.js renders in <link rel="canonical">.
export const CANONICAL_HOST = "https://remotiv-website-m3jo.vercel.app";

/**
 * Builds an absolute URL from a path. Tolerates both "/foo" and "foo" inputs
 * so callers don't have to remember the leading slash. Used for JSON-LD
 * `item` fields (which must be absolute URLs per schema.org).
 */
export const canonicalUrl = (path: string): string =>
  `${CANONICAL_HOST}${path.startsWith("/") ? path : `/${path}`}`;
