import ResetPasswordClient from "./reset-password-client";

export const dynamic = "force-dynamic";

/**
 * Accepts three entry shapes, and verifies NONE of them here — the recovery
 * token is single-use, so consuming it on load lets an email-scanner prefetch
 * or a refresh burn it before the user types anything. Redemption happens on
 * submit inside the client.
 *
 *   1. ?token_hash=…&type=recovery  → verifyOtp   (works across browsers)
 *   2. an existing recovery session → updateUser  (today's /auth/callback path)
 *   3. ?code=…                      → exchangeCodeForSession (PKCE fallback)
 */
export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token_hash?: string; type?: string; code?: string }>;
}) {
  const params = await searchParams;

  // We do NOT redirect-if-logged-in here — user arrives via recovery flow with a temporary session
  return (
    <ResetPasswordClient
      tokenHash={params.token_hash ?? null}
      otpType={params.type ?? "recovery"}
      code={params.code ?? null}
    />
  );
}
