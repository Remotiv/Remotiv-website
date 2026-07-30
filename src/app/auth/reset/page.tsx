import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import { ResetClient } from "./reset-client";

export const dynamic = "force-dynamic";
export const metadata = { title: "Set a new password — Remotiv" };

function InvalidLink() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-remotiv-bg px-6 py-16 font-sans">
      <div className="w-full max-w-md rounded-3xl border border-gray-100 bg-white p-8 text-center shadow-lg sm:p-10">
        <div className="mx-auto mb-4 flex size-14 items-center justify-center rounded-full bg-amber-50">
          <AlertTriangle className="size-7 text-amber-600" strokeWidth={2} />
        </div>
        <h1 className="font-heading text-2xl font-bold text-gray-900">
          Reset link not valid
        </h1>
        <p className="mt-2 text-sm text-gray-600">
          This page needs a valid reset link. Request a new one and use the
          button in the email.
        </p>
        <Link
          href="/forgot-password"
          className="mt-7 inline-block w-full rounded-xl bg-remotiv-purple py-3 text-sm font-semibold text-white transition-opacity hover:opacity-90"
        >
          Reset my Remotiv account
        </Link>
        <Link
          href="/ai-dashboard/forgot-password"
          className="mt-3 inline-block w-full rounded-xl border border-gray-200 py-3 text-sm font-semibold text-gray-600 transition-colors hover:bg-gray-50 hover:text-gray-900"
        >
          Reset my company workspace login
        </Link>
      </div>
    </div>
  );
}

/**
 * Product-neutral landing page for Supabase's recovery email.
 *
 * Supabase has a single global "Reset Password" template but Remotiv has two
 * products with different homes, so the template points here: one page sets
 * the password, then routes the user to whichever product they belong to.
 *
 * NOTHING is verified or consumed here. The recovery token is single-use, so
 * redeeming it on load lets an email-scanner prefetch or a refresh burn it
 * before the user types anything — which surfaces as a bogus "expired". The
 * token is passed inert to the client and redeemed only on explicit submit.
 *
 * Deliberately does NOT redirect when a session exists — a signed-in user may
 * still legitimately be resetting their password.
 */
export default async function SharedResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{
    token_hash?: string;
    type?: string;
    code?: string;
    error?: string;
  }>;
}) {
  const params = await searchParams;

  const tokenHash = params.token_hash ?? null;
  // Backwards compatibility with PKCE links already sitting in inboxes.
  const code = params.code ?? null;

  if (params.error || (!tokenHash && !code)) {
    return <InvalidLink />;
  }

  return (
    <ResetClient
      tokenHash={tokenHash}
      otpType={params.type ?? "recovery"}
      code={code}
    />
  );
}
