import type { Metadata } from "next";
import { Navbar } from "@/components/navbar";

// Route-specific metadata. Kept in page.tsx rather than a sibling layout:
// the layouts on /about, /jobs and friends exist to host BreadcrumbList
// JSON-LD alongside the metadata, and this page has none to host — it is
// noindex, so structured data would have nothing to feed.
export const metadata: Metadata = {
  title: "AI Video Interviews — Remotiv",
  description: "Screen candidates with structured, AI-assisted video interviews.",
  // Canonical path is relative; Next.js resolves it against `metadataBase`
  // (set in src/app/layout.tsx).
  alternates: { canonical: "/ai-video-interviews" },
  // Deliberately noindex while this page is under construction.
  // REMOVE THIS, add navbar + footer links, and add the route to
  // sitemap.ts before launch.
  robots: { index: false, follow: false },
};

export default function AIVideoInterviewsPage() {
  return (
    <>
      <Navbar />
      <main id="main" className="min-h-screen bg-remotiv-bg">
        <h1 className="font-heading">AI Video Interviews</h1>
      </main>
    </>
  );
}
