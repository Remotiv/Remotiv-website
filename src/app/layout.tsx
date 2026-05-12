import type { Metadata } from "next";
import { DM_Sans, Sora } from "next/font/google";
import "./globals.css";
import { AIChatWidget } from "@/components/ai-chat-widget";

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
  metadataBase: new URL("https://remotiv-website-m3jo.vercel.app"),
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
    url: "https://remotiv-website-m3jo.vercel.app",
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
      <body className="min-h-full flex flex-col overflow-x-hidden">
        <a href="#main" className="skip-link">
          Skip to main content
        </a>
        {children}
        <AIChatWidget />
      </body>
    </html>
  );
}
