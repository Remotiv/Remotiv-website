import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "AI Match Results — Remotiv",
  description:
    "Your AI-matched shortlist of vetted remote candidates, ranked by fit for your role.",
};

export default function AiResultsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
