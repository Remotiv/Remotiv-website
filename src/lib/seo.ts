// Shared canonical host for SEO metadata + JSON-LD.
// Sourced to match `metadataBase` in src/app/layout.tsx (the Vercel preview
// URL today; swap to the production custom domain in ONE place when it goes
// live). Keeping this centralised means JSON-LD `item` URLs, BreadcrumbList
// entries, and any future schema can't drift apart from the canonical that
// Next.js renders in <link rel="canonical">.
export const CANONICAL_HOST = "https://remotiv-website-m3jo.vercel.app";

/**
 * Builds an absolute URL from a path. Tolerates "/foo", "foo", and even
 * "//foo" (callers that accidentally pre-slash a leading "/"). All forms
 * collapse to exactly ONE leading slash so the output is never the broken
 * `https://host//foo`. Used for JSON-LD `item` fields (which must be
 * absolute URLs per schema.org).
 *
 * Trailing-slash for root is preserved: canonicalUrl("/") → "https://host/".
 */
export const canonicalUrl = (path: string): string => {
  const normalized = `/${path.replace(/^\/+/, "")}`;
  return `${CANONICAL_HOST}${normalized}`;
};
