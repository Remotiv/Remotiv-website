import type { Metadata } from "next";
import { canonicalUrl } from "@/lib/seo";

// Phase 6: route-specific metadata for /pricing.
//
// The page itself is a server component, but route-specific metadata + JSON-LD
// are kept in this sibling layout to mirror the /about and /become-a-talent
// pattern: metadata + structured data live in a server-only layout that wraps
// the page and passes children through unchanged.
//
// Root layout (src/app/layout.tsx) sets `title` as a plain string (NOT a
// template object), so the title declared here REPLACES the root title
// entirely — no double-brand suffix. Description is tuned for SERP display.
export const metadata: Metadata = {
  title: "Remotiv Pricing — Plans for Every Hiring Need",
  description:
    "Simple, transparent pricing for Remotiv. Browse Pakistan's top 1% talent on Starter and Pro plans, or get a custom Enterprise quote. No hidden fees.",
  alternates: { canonical: "/pricing" },
  openGraph: {
    title: "Remotiv Pricing — Plans for Every Hiring Need",
    description:
      "Simple, transparent pricing for Remotiv. Browse Pakistan's top 1% talent on Starter and Pro plans, or get a custom Enterprise quote. No hidden fees.",
    url: "/pricing",
    siteName: "Remotiv",
    locale: "en_US",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Remotiv Pricing — Plans for Every Hiring Need",
    description:
      "Simple, transparent pricing for Remotiv. Browse Pakistan's top 1% talent on Starter and Pro plans, or get a custom Enterprise quote. No hidden fees.",
  },
  robots: { index: true, follow: true },
};

export default function PricingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      {/* BreadcrumbList JSON-LD (Home → Pricing). Rendered from the SERVER
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
                name: "Pricing",
                item: canonicalUrl("/pricing"),
              },
            ],
          }),
        }}
      />
      {children}
    </>
  );
}
