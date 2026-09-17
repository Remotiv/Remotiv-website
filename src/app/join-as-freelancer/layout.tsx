import type { Metadata } from "next";

const title = "Apply to Join Remotiv | Join as Freelancer";
const description =
  "Join Remotiv's talent network and get hired by global companies. Build your freelancer profile and start working with clients in the US, UK, Europe, and the Middle East.";

// openGraph replaces the root's wholesale rather than merging into it, so this
// block restates siteName, locale, type and the shared card image — omit any of
// them and this route emits none. Without the block it inherited the root's
// card, which sells hiring to employers; this page recruits talent, so the
// shared copy addressed the wrong audience.
export const metadata: Metadata = {
  title,
  description,
  openGraph: {
    title,
    description,
    url: "/join-as-freelancer",
    siteName: "Remotiv",
    locale: "en_US",
    type: "website",
    images: ["/opengraph-image"],
  },
};

export default function RemoteReadyLayout({ children }: { children: React.ReactNode }) {
  return children;
}
