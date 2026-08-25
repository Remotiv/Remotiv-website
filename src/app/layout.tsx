import type { Metadata } from "next";
import { DM_Sans, Sora } from "next/font/google";
import { Analytics } from "@vercel/analytics/react";
import { SpeedInsights } from "@vercel/speed-insights/next";
import "./globals.css";
import { AIChatWidget } from "@/components/ai-chat-widget";
import { FooterWrapper } from "@/components/footer-wrapper";

const sora = Sora({
  variable: "--font-heading",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
});

const dmSans = DM_Sans({
  variable: "--font-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

export const metadata: Metadata = {
  metadataBase: new URL("https://remotiv.work"),
  title: "Remotiv — Hire Top 1% Senior Engineering Talent",
  description:
    "Hire pre-vetted engineers, scale with staff augmentation, or build dedicated teams — without the usual delays.",
  applicationName: "Remotiv",
  keywords: [
    "remote engineering",
    "senior developers",
    "talent marketplace",
    "Pakistan engineers",
    "AI recruiter",
    "staff augmentation",
  ],
  authors: [{ name: "Remotiv" }],
  creator: "Remotiv",
  publisher: "Remotiv",
  openGraph: {
    title: "Remotiv — Hire Top 1% Senior Engineering Talent",
    description:
      "Hire pre-vetted engineers, scale with staff augmentation, or build dedicated teams — without the usual delays.",
    url: "https://remotiv.work",
    siteName: "Remotiv",
    locale: "en_US",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Remotiv — Hire Top 1% Senior Engineering Talent",
    description:
      "Hire pre-vetted engineers, scale with staff augmentation, or build dedicated teams — without the usual delays.",
    creator: "@remotiv",
  },
  icons: {
    icon: "/favicon.ico",
    apple: "/apple-touch-icon.png",
  },
  themeColor: "#7E47FF",
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-image-preview": "large",
    },
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${sora.variable} ${dmSans.variable} h-full antialiased bg-background`}>
      <head>
        <style
          // biome-ignore lint/security/noDangerouslySetInnerHtml: critical-CSS inline style — prevents cold-load FOUC before Tailwind chunk arrives
          dangerouslySetInnerHTML={{
            // The [data-twin-*] pair: responsive twins that BOTH exist in the
            // DOM and rely on Tailwind's `hidden` to pick one. Until that chunk
            // applies neither is hidden and both paint — the applicants list
            // showed its table and its mobile cards at once. Same 1049px
            // breakpoint as the classes, which stay the authority once the
            // sheet lands.
            __html: `html,body{background:#f8f4f1!important}body{display:flex;flex-direction:column;min-height:100vh;overflow-x:hidden}html{--font-heading:'Sora',ui-sans-serif,system-ui,sans-serif;--font-sans:'DM Sans',ui-sans-serif,system-ui,sans-serif}[data-nav]{background:#fff}.skip-link{position:absolute;top:-40px}@media(min-width:1049px){[data-twin-narrow]{display:none}}@media(max-width:1048px){[data-twin-wide]{display:none}}`,
          }}
        />
        <script
          // biome-ignore lint/security/noDangerouslySetInnerHtml: tiny inline bootstrap — disables browser scroll restoration to avoid the loading.tsx → SSR height swap producing a "jump to footer then top" flash on slow-SSR routes (e.g. /browse-talent). Next.js App Router handles scroll-to-top on internal navigation itself.
          dangerouslySetInnerHTML={{
            __html: `if("scrollRestoration" in history){history.scrollRestoration="manual";}`,
          }}
        />
      </head>
      <body className="min-h-full flex flex-col overflow-x-hidden">
        <a href="#main" className="skip-link">
          Skip to main content
        </a>
        {children}
        <FooterWrapper />
        <AIChatWidget />
        <script
          type="application/ld+json"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: structured data JSON-LD requires raw JSON injection
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              "@context": "https://schema.org",
              "@type": "Organization",
              name: "Remotiv",
              url: "https://remotiv.work",
              logo: "https://remotiv.work/opengraph-image",
              description:
                "Hire pre-vetted senior engineering talent. Top 1% engineers, ready in 24 hours.",
              sameAs: [
                "https://www.linkedin.com/company/remotiv-inc/",
                "https://www.instagram.com/remotiv.inc/",
              ],
              contactPoint: {
                "@type": "ContactPoint",
                contactType: "Sales",
                url: "https://remotiv.work/contact",
              },
            }),
          }}
        />
        <script
          type="application/ld+json"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: structured data JSON-LD requires raw JSON injection
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              "@context": "https://schema.org",
              "@type": "WebSite",
              name: "Remotiv",
              url: "https://remotiv.work",
              description:
                "Hire pre-vetted engineers, scale with staff augmentation, or build dedicated teams — without the usual delays.",
            }),
          }}
        />
        <Analytics />
        <SpeedInsights />
      </body>
    </html>
  );
}
