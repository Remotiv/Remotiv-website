import type { Metadata } from "next";

const title = "AI Talent Matching — Remotiv";
const description =
  "Describe the role you're hiring for and let Remotiv's AI match you with the best-fit vetted remote candidates from Pakistan in seconds.";

// openGraph replaces the root's wholesale rather than merging into it, so this
// block restates siteName, locale, type and the shared card image — omit any of
// them and this route emits none. Without the block it inherited the root's
// absolute url and told every platform it was the homepage.
export const metadata: Metadata = {
  title,
  description,
  openGraph: {
    title,
    description,
    url: "/ai-matching",
    siteName: "Remotiv",
    locale: "en_US",
    type: "website",
    images: ["/opengraph-image"],
  },
};

export default function AiMatchingLayout({ children }: { children: React.ReactNode }) {
  return children;
}
