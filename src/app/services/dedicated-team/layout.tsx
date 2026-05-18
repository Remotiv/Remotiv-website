import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Dedicated Team Services | Remotiv",
  description:
    "Build a dedicated remote team across engineering, sales, design, customer success, marketing, and operations. Hand-picked, managed, retained — operational in 2 weeks with a free replacement guarantee.",
  alternates: {
    canonical: "https://www.remotiv.work/services/dedicated-team",
  },
  openGraph: {
    title: "Dedicated Team Services | Remotiv",
    description:
      "Build a dedicated remote team across engineering, sales, design, customer success, marketing, and operations. Hand-picked, managed, retained — operational in 2 weeks with a free replacement guarantee.",
    url: "https://www.remotiv.work/services/dedicated-team",
    type: "website",
    siteName: "Remotiv",
  },
  twitter: {
    card: "summary_large_image",
    title: "Dedicated Team Services | Remotiv",
    description:
      "Build a dedicated remote team across engineering, sales, design, customer success, marketing, and operations.",
  },
};

export default function DedicatedTeamLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
