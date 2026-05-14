import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Recruitment Services | Remotiv",
  description:
    "End-to-end recruitment across engineering, sales, design, data, marketing, and operations. Pre-vetted candidates delivered in 1 business day. 90-day replacement guarantee.",
  alternates: {
    canonical: "https://www.remotiv.work/services/recruitment",
  },
  openGraph: {
    title: "Recruitment Services | Remotiv",
    description:
      "End-to-end recruitment across engineering, sales, design, data, marketing, and operations. Pre-vetted candidates in 1 business day. 90-day guarantee.",
    url: "https://www.remotiv.work/services/recruitment",
    type: "website",
    siteName: "Remotiv",
  },
  twitter: {
    card: "summary_large_image",
    title: "Recruitment Services | Remotiv",
    description:
      "End-to-end recruitment. Pre-vetted candidates in 1 business day. 90-day guarantee.",
  },
};

export default function RecruitmentLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
