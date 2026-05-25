import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "AI Talent Matching — Remotiv",
  description:
    "Describe the role you're hiring for and let Remotiv's AI match you with the best-fit vetted remote candidates from Pakistan in seconds.",
};

export default function AiMatchingLayout({ children }: { children: React.ReactNode }) {
  return children;
}
