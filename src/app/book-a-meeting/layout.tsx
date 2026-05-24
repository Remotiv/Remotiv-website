import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Book a Meeting — Remotiv",
  description:
    "Schedule a free intro call with the Remotiv team to discuss hiring vetted remote talent from Pakistan. Pick a time that works for you.",
};

export default function BookAMeetingLayout({ children }: { children: React.ReactNode }) {
  return children;
}
