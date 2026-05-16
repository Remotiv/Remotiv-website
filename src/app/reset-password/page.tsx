import ResetPasswordClient from "./reset-password-client";

export const dynamic = "force-dynamic";

export default function ResetPasswordPage() {
  // We do NOT redirect-if-logged-in here — user arrives via recovery flow with a temporary session
  return <ResetPasswordClient />;
}
