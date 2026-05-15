import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Staff Augmentation Services | Remotiv",
  description:
    "Augment your team with pre-vetted senior specialists across engineering, sales, design, data, marketing, operations, and more. Matched in 24 hours, deployed in days, backed by a free replacement guarantee.",
  alternates: {
    canonical: "https://www.remotiv.work/services/staff-augmentation",
  },
  openGraph: {
    title: "Staff Augmentation Services | Remotiv",
    description:
      "Augment your team with pre-vetted senior specialists across engineering, sales, design, data, marketing, operations, and more. Matched in 24 hours, deployed in days, backed by a free replacement guarantee.",
    url: "https://www.remotiv.work/services/staff-augmentation",
    type: "website",
    siteName: "Remotiv",
  },
  twitter: {
    card: "summary_large_image",
    title: "Staff Augmentation Services | Remotiv",
    description:
      "Augment your team with pre-vetted senior specialists across engineering, sales, design, data, marketing, operations, and more.",
  },
};

export default function StaffAugmentationLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
