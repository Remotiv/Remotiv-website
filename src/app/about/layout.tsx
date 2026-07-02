import type { Metadata } from "next";
import { canonicalUrl } from "@/lib/seo";

// Phase 6: route-specific metadata for /about.
//
// The page itself is a server component, but route-specific metadata + JSON-LD
// are kept in this sibling layout to mirror the /join-as-talent pattern:
// metadata + structured data live in a server-only layout that wraps the page
// and passes children through unchanged.
//
// Root layout (src/app/layout.tsx) sets `title` as a plain string (NOT a
// template object), so the title declared here REPLACES the root title
// entirely — no double-brand suffix. Description is tuned for SERP display.
export const metadata: Metadata = {
  title: "About Remotiv — Our Mission & Team",
  description:
    "Remotiv connects companies with Pakistan's top 1% of pre-vetted professionals — faster hires, stronger teams, and zero hiring risk. Meet the team behind it.",
  alternates: { canonical: "/about" },
  openGraph: {
    title: "About Remotiv — Our Mission & Team",
    description:
      "Remotiv connects companies with Pakistan's top 1% of pre-vetted professionals — faster hires, stronger teams, and zero hiring risk. Meet the team behind it.",
    url: "/about",
    siteName: "Remotiv",
    locale: "en_US",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "About Remotiv — Our Mission & Team",
    description:
      "Remotiv connects companies with Pakistan's top 1% of pre-vetted professionals — faster hires, stronger teams, and zero hiring risk. Meet the team behind it.",
  },
  robots: { index: true, follow: true },
};

export default function AboutLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      {/* BreadcrumbList JSON-LD (Home → About). Rendered from the SERVER
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
                name: "About",
                item: canonicalUrl("/about"),
              },
            ],
          }),
        }}
      />
      {children}
    </>
  );
}
