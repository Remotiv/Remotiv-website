import type { Metadata } from "next";

const TITLE = "Hire Remote Talent | Remotiv";
const DESCRIPTION =
  "Browse and hire Pakistan's top 1% vetted remote talent. Filter by role, skills, rate, and availability. Submit a hire request in minutes.";
const URL = "https://www.remotiv.work/hire-remote";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    url: URL,
    siteName: "Remotiv",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
  },
};

export default function HireRemoteLayout({ children }: { children: React.ReactNode }) {
  return children;
}
