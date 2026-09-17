import type { Metadata } from "next";

const title = "Contact Remotiv — Get in Touch";
const description =
  "Have a question or want to hire vetted remote talent from Pakistan? Contact the Remotiv team — we reply within 24 hours.";

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
    url: "/contact",
    siteName: "Remotiv",
    locale: "en_US",
    type: "website",
    images: ["/opengraph-image"],
  },
};

export default function ContactLayout({ children }: { children: React.ReactNode }) {
  return children;
}
