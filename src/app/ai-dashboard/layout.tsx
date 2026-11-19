import type { Metadata } from "next";
import "./ai-dashboard.css";

// #43: dashboard pages already name the product ("Jobs - Remotiv AI
// Interviews"), so the root's " - Remotiv" is not added again under here. A
// page with no title of its own reads "Remotiv AI Interviews": absolute, not
// default, because Next applies the root's template to a default.
export const metadata: Metadata = {
  title: { absolute: "Remotiv AI Interviews", template: "%s" },
};

/**
 * Segment-level pass-through. Exists solely to load the scoped token sheet for
 * every /ai-dashboard route (login and change-password included) without
 * touching globals.css. No chrome here — the gated layout owns the shell.
 */
export default function AiDashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
