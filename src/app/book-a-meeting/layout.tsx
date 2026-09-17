import type { Metadata } from "next";

const title = "Book a Meeting — Remotiv";
const description =
  "Schedule a free intro call with the Remotiv team to discuss hiring vetted remote talent from Pakistan. Pick a time that works for you.";

// openGraph replaces the root's wholesale rather than merging into it, so this
// block restates siteName, locale, type and the shared card image — omit any of
// them and this route emits none. Without the block it inherited the root's
// absolute url and told every platform it was the homepage, which matters here:
// this link gets sent to prospects.
export const metadata: Metadata = {
  title,
  description,
  openGraph: {
    title,
    description,
    url: "/book-a-meeting",
    siteName: "Remotiv",
    locale: "en_US",
    type: "website",
    images: ["/opengraph-image"],
  },
};

export default function BookAMeetingLayout({ children }: { children: React.ReactNode }) {
  return children;
}
