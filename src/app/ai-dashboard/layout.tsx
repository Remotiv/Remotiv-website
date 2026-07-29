import "./ai-dashboard.css";

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
