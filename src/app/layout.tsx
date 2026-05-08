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
  weight: ["300", "400", "500", "600", "700"],
});

export const metadata: Metadata = {
  title: "Remotiv — Hire Top 1% Senior Engineering Talent",
  description:
    "Hire pre-vetted engineers, scale with staff augmentation, or build dedicated teams — without the usual delays.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${sora.variable} ${dmSans.variable} h-full antialiased bg-background`}>
      <body className="min-h-full flex flex-col overflow-x-hidden">
        {children}
        <AIChatWidget />
      </body>
    </html>
  );
}
