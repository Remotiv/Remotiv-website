import type { Metadata } from "next";
import { canonicalUrl } from "@/lib/seo";

// Phase 6: route-specific metadata for /become-a-talent.
//
// The page is a client component ("use client" at the top of page.tsx) so it
// can't `export const metadata` itself — Next.js disallows that from client
// modules. This server-only layout exists solely to attach metadata + a
// BreadcrumbList JSON-LD block to the route; it passes children through
// unchanged so the page's own render is untouched.
//
// Root layout (src/app/layout.tsx) sets `title` as a plain string (NOT a
// template object), so the title declared here REPLACES the root title
// entirely — no double-brand suffix. Description is tuned to ~155 chars for
// full SERP display.
export const metadata: Metadata = {
  title: "Join Our Talent Network — Remotiv",
  description:
    "Submit your profile once and get matched to remote roles at vetted global companies. Free to join. Built for engineers, sales, design and ops talent.",
  alternates: { canonical: "/become-a-talent" },
  openGraph: {
    title: "Join the Remotiv Talent Network",
    description:
      "Submit your profile once and get matched to remote roles at vetted global companies.",
    url: "/become-a-talent",
    siteName: "Remotiv",
    locale: "en_US",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Join the Remotiv Talent Network",
    description:
      "Submit your profile once and get matched to remote roles at vetted global companies.",
  },
  robots: { index: true, follow: true },
};

export default function BecomeATalentLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      {/* Phase 6 M1: BreadcrumbList JSON-LD (Home → Become a Talent). Rendered
          from the SERVER layout so it ships in the initial HTML for crawlers
          — the client page.tsx couldn't emit this safely. `item` URLs come
          from the shared canonicalUrl() helper (src/lib/seo.ts) so they
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
                name: "Become a Talent",
                item: canonicalUrl("/become-a-talent"),
              },
            ],
          }),
        }}
      />
      {children}
    </>
  );
}
