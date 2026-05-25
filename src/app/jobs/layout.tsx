import type { Metadata } from "next";
import { canonicalUrl } from "@/lib/seo";

// Phase 6: route-specific metadata for /jobs.
//
// The page itself is a server component that wraps a client island, but the
// route-specific metadata + JSON-LD live in this sibling layout to mirror the
// /about and /pricing pattern. Metadata + structured data live in a
// server-only layout that wraps the page and passes children through
// unchanged.
//
// Root layout (src/app/layout.tsx) sets `title` as a plain string (NOT a
// template object), so the title declared here REPLACES the root title
// entirely — no double-brand suffix. Description is tuned for SERP display
// and targets the JOB-SEEKER audience (vs the root layout's hirer focus).
export const metadata: Metadata = {
  title: "Jobs at Remotiv — Find Your Next Remote Role",
  description:
    "Browse open remote roles for engineers, designers, sales, and more. Apply directly and get matched with companies hiring through Remotiv.",
  alternates: { canonical: "/jobs" },
  openGraph: {
    title: "Jobs at Remotiv — Find Your Next Remote Role",
    description:
      "Browse open remote roles for engineers, designers, sales, and more. Apply directly and get matched with companies hiring through Remotiv.",
    url: "/jobs",
    siteName: "Remotiv",
    locale: "en_US",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Jobs at Remotiv — Find Your Next Remote Role",
    description:
      "Browse open remote roles for engineers, designers, sales, and more. Apply directly and get matched with companies hiring through Remotiv.",
  },
  robots: { index: true, follow: true },
};

export default function JobsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      {/* BreadcrumbList JSON-LD (Home → Jobs). Rendered from the SERVER
          layout so it ships in the initial HTML for crawlers. `item` URLs
          come from the shared canonicalUrl() helper (src/lib/seo.ts) so they
          can't drift from the canonical link tag. */}
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: structured data JSON-LD requires raw JSON injection
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            "@context": "https://schema.org",
            "@type": "BreadcrumbList",
            itemListElement: [
              {
                "@type": "ListItem",
                position: 1,
                name: "Home",
                item: canonicalUrl("/"),
              },
              {
                "@type": "ListItem",
                position: 2,
                name: "Jobs",
                item: canonicalUrl("/jobs"),
              },
            ],
          }),
        }}
      />
      {children}
    </>
  );
}
