"use client";

import { useState } from "react";
import Link from "next/link";
import { MailCheck } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

export function ForgotPasswordClient() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const supabase = createClient();
    // The reset page redeems `token_hash` via verifyOtp, NOT the PKCE `code`
    // flow — PKCE needs the verifier from the browser that requested the
    // reset, so a request in Chrome opened in Safari always failed. That
    // requires the Supabase "Reset Password" email template to build its link
    // from {{ .TokenHash }} rather than {{ .ConfirmationURL }} — see the note
    // in the reset page. The `code` path is still handled there for links
    // already sitting in inboxes.
    const { error: resetError } = await supabase.auth.resetPasswordForEmail(
      email.trim(),
      {
        redirectTo: `${window.location.origin}/auth/reset`,
      },
    );

    setLoading(false);

    // Enumeration safety: Supabase returns no error for an unknown address, and
    // we must not add one. Only a rate-limit is surfaced distinctly — every
    // other outcome shows the same neutral confirmation. Membership is
    // deliberately NOT checked here; that would leak which emails have
    // accounts, and login already enforces company membership on the way in.
    if (resetError) {
      const raw = resetError.message?.toLowerCase() ?? "";
      const status = (resetError as { status?: number }).status;
      if (raw.includes("rate") || status === 429) {
        setError("Too many requests. Please wait a moment and try again.");
        return;
      }
    }

    setSent(true);
  }

  return (
    <div className="ai-shell flex min-h-[var(--vh-full)] items-center justify-center bg-[var(--ai-page)] px-6 py-16 font-sans">
      <div className="w-full max-w-md">
        <div className="mb-6 text-center">
          <Link
            href="/"
            className="font-heading text-2xl font-bold tracking-tight text-remotiv-purple"
          >
            Remotiv<span className="font-extrabold">.</span>
          </Link>
        </div>

        <div className="rounded-3xl border border-[var(--ai-line)] bg-white p-8 shadow-lg min-[525px]:p-10">
          {sent ? (
            <div className="text-center">
              <div className="mx-auto mb-4 flex size-14 items-center justify-center rounded-full bg-[var(--ai-purple-tint)]">
                <MailCheck
                  className="size-7 text-remotiv-purple"
                  strokeWidth={2}
                />
              </div>
              <h1 className="font-heading text-2xl font-bold text-[var(--ai-t1)]">
                Check your email
              </h1>
              <p className="mt-2 text-sm text-[var(--ai-t2)]">
                If an account exists for that email, we&apos;ve sent a link to
                reset your Remotiv password. The link expires shortly, so use it
                soon.
              </p>
              <p className="mt-4 text-[13px] text-[var(--ai-t3)]">
                Didn&apos;t get it? Check your spam folder, or{" "}
                <button
                  type="button"
                  onClick={() => {
                    setSent(false);
                    setError(null);
                  }}
                  className="font-semibold text-remotiv-purple hover:underline"
                >
                  try again
                </button>
                .
              </p>
              <Link
                href="/ai-dashboard/login"
                className="mt-7 inline-block w-full rounded-xl border border-[var(--ai-line)] py-3 text-sm font-semibold text-[var(--ai-t2)] transition-colors hover:bg-[var(--ai-inset)] hover:text-[var(--ai-t1)]"
              >
                Back to sign in
              </Link>
            </div>
          ) : (
            <>
              <h1 className="font-heading text-2xl font-bold text-[var(--ai-t1)]">
                Forgot your password?
              </h1>
              <p className="mt-2 text-sm text-[var(--ai-t2)]">
                Enter the email you use to sign in and we&apos;ll send you a link
                to set a new password.
              </p>

              {error && (
                <p
                  role="alert"
                  aria-live="assertive"
                  className="mt-5 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
                >
                  {error}
                </p>
              )}

              <form onSubmit={handleSubmit} className="mt-6 flex flex-col gap-4">
                <div>
                  <label
                    htmlFor="fp-email"
                    className="mb-1.5 block text-[10px] font-semibold uppercase tracking-widest text-[var(--ai-t3)]"
                  >
                    Email{" "}
                    <span className="text-red-500" aria-hidden="true">
                      *
                    </span>
                  </label>
                  <input
                    id="fp-email"
                    type="email"
                    required
                    aria-required="true"
                    autoFocus
                    autoComplete="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@yourcompany.com"
                    className="w-full rounded-xl border border-[var(--ai-line)] px-4 py-3 text-sm text-[var(--ai-t1)] outline-none transition-all focus:border-remotiv-purple focus:ring-2 focus:ring-remotiv-purple/20"
                  />
                </div>

                <button
                  type="submit"
                  disabled={loading}
                  aria-busy={loading}
                  className="mt-2 w-full rounded-xl bg-remotiv-purple py-3 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-60"
                >
                  {loading ? "Sending…" : "Send reset link"}
                </button>
              </form>

              <p className="mt-6 text-center text-xs text-[var(--ai-t3)]">
                Remembered it?{" "}
                <Link
                  href="/ai-dashboard/login"
                  className="font-semibold text-remotiv-purple hover:underline"
                >
                  Back to sign in
                </Link>
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
