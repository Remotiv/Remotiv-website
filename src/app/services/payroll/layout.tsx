import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Payroll & Compliance Services | Remotiv",
  description:
    "Hassle-free international payroll, contracts, and compliance for remote teams across engineering, sales, design, customer success, and operations. Live in 48 hours with full statutory coverage.",
  alternates: {
    canonical: "https://www.remotiv.work/services/payroll",
  },
  openGraph: {
    title: "Payroll & Compliance Services | Remotiv",
    description:
      "Hassle-free international payroll, contracts, and compliance for remote teams across engineering, sales, design, customer success, and operations. Live in 48 hours with full statutory coverage.",
    url: "https://www.remotiv.work/services/payroll",
    type: "website",
    siteName: "Remotiv",
  },
  twitter: {
    card: "summary_large_image",
    title: "Payroll & Compliance Services | Remotiv",
    description:
      "Hassle-free international payroll, contracts, and compliance for remote teams. Live in 48 hours with full statutory coverage.",
  },
};

export default function PayrollLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
