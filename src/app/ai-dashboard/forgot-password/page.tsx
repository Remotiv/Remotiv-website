import { ForgotPasswordClient } from "./forgot-password-client";

export const dynamic = "force-dynamic";
export const metadata = { title: "Reset password — Remotiv AI Interviews" };

// Deliberately no redirect-if-signed-in: a member whose password was changed
// elsewhere may still hold a stale session and still need a reset link.
export default function CompanyForgotPasswordPage() {
  return <ForgotPasswordClient />;
}
