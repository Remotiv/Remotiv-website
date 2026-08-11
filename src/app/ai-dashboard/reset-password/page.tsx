import Link from "next/link";
import { TriangleAlert } from "lucide-react";
import { ResetPasswordClient } from "./reset-password-client";

export const dynamic = "force-dynamic";
export const metadata = { title: "Set a new password — Remotiv" };

type InvalidReason = "missing_token" | "link_error";

const INVALID_COPY: Record<InvalidReason, string> = {
  missing_token:
    "This page needs a valid reset link. Request a new one and use the button in the email.",
  link_error:
    "That reset link couldn't be verified. Request a new one and try again.",
};

function InvalidLink({ reason }: { reason: InvalidReason }) {
  return (
    <div className="ai-shell flex min-h-[var(--vh-full)] items-center justify-center bg-[var(--ai-page)] px-6 py-16 font-sans">
      <div className="w-full max-w-md rounded-3xl border border-[var(--ai-line)] bg-white p-8 text-center shadow-lg min-[525px]:p-10">
        <div className="mx-auto mb-4 flex size-14 items-center justify-center rounded-full bg-[var(--ai-amber-tint)]">
          <TriangleAlert
            className="size-7 text-[var(--ai-amber-ink)]"
            strokeWidth={2}
          />
        </div>
        <h1 className="font-heading text-2xl font-bold text-[var(--ai-t1)]">
          Reset link not valid
        </h1>
        <p className="mt-2 text-sm text-[var(--ai-t2)]">
          {INVALID_COPY[reason]}
        </p>
        <Link
          href="/ai-dashboard/forgot-password"
          className="mt-7 inline-block w-full rounded-xl bg-remotiv-purple py-3 text-sm font-semibold text-white transition-opacity hover:opacity-90"
        >
          Request a new link
        </Link>
        <Link
          href="/ai-dashboard/login"
          className="mt-3 inline-block w-full rounded-xl border border-[var(--ai-line)] py-3 text-sm font-semibold text-[var(--ai-t2)] transition-colors hover:bg-[var(--ai-inset)] hover:text-[var(--ai-t1)]"
        >
          Back to sign in
        </Link>
      </div>
    </div>
  );
}

/**
 * Landing page for Supabase's recovery email.
 *
 * NOTHING is verified or exchanged here. The recovery token is single-use, so
 * consuming it on page load meant an email-scanner prefetch or an accidental
 * refresh burned it before the user typed anything — which surfaced as a bogus
 * "expired" a couple of minutes after the email arrived. The token is passed
 * inert to the client and redeemed only on explicit submit.
 *
 * We also prefer `token_hash` + verifyOtp over the PKCE `code` flow: PKCE
 * requires the code verifier stored in the browser that REQUESTED the reset,
 * so requesting in one browser and opening the email in another always failed.
 * verifyOtp carries no such requirement.
 *
 * Deliberately does NOT redirect when a session exists — a signed-in user may
 * still legitimately be resetting their password.
 */
export default async function CompanyResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{
    token_hash?: string;
    type?: string;
    code?: string;
    error?: string;
    error_description?: string;
  }>;
}) {
  const params = await searchParams;

  // Supabase appends ?error=… when it rejects the link before we ever see a token.
  if (params.error) {
    return <InvalidLink reason="link_error" />;
  }

  const tokenHash = params.token_hash ?? null;
  // Backwards compatibility with links already in inboxes from the PKCE flow.
  const code = params.code ?? null;

  if (!tokenHash && !code) {
    return <InvalidLink reason="missing_token" />;
  }

  return (
    <ResetPasswordClient
      tokenHash={tokenHash}
      otpType={params.type ?? "recovery"}
      code={code}
    />
  );
}
