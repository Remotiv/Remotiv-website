import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Contact Remotiv — Get in Touch",
  description:
    "Have a question or want to hire vetted remote talent from Pakistan? Contact the Remotiv team — we reply within 24 hours.",
};

export default function ContactLayout({ children }: { children: React.ReactNode }) {
  return children;
}
