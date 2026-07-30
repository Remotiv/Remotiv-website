"use client";

import { useState } from "react";
import Link from "next/link";
import { Eye, EyeOff, ShieldCheck } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

export function ResetPasswordClient({
  tokenHash,
  otpType,
  code,
}: {
  tokenHash: string | null;
  otpType: string;
  code: string | null;
}) {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** True only when the LINK is dead — surfaces a "request a new one" link. */
  const [linkDead, setLinkDead] = useState(false);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLinkDead(false);

    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }

    setLoading(true);
    const supabase = createClient();

    // 1. Redeem the recovery token — on submit, never on load, so a scanner
    //    prefetch or a refresh can't burn this single-use token first.
    //    verifyOtp is browser-independent: unlike the PKCE code exchange it
    //    needs no verifier from the browser that requested the reset, so
    //    requesting in Chrome and opening the email in Safari now works.
    const verifyError = tokenHash
      ? (
          await supabase.auth.verifyOtp({
            token_hash: tokenHash,
            type: otpType as "recovery",
          })
        ).error
      : code
        ? (await supabase.auth.exchangeCodeForSession(code)).error
        : null;

    if (verifyError || (!tokenHash && !code)) {
      setLinkDead(true);
      setError("This reset link is no longer valid. Request a new one.");
      setLoading(false);
      return;
    }

    // 2. Token accepted — a recovery session now exists, which authorises this.
    const { error: updateError } = await supabase.auth.updateUser({ password });

    if (updateError) {
      // Surface the real reason (e.g. "Password should be at least …") rather
      // than blaming the link, which has already been verified by this point.
      setError(updateError.message || "Couldn't update your password. Please try again.");
      setLoading(false);
      return;
    }

    // 3. Full-page navigation, NOT router.push: updateUser just rotated the
    //    session cookie, and an RSC navigation would render the gated layout on
    //    the server with stale cookies and stall on its redirect. `loading`
    //    stays true — the page is being replaced.
    window.location.assign("/ai-dashboard");
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
          <div className="mx-auto mb-4 flex size-14 items-center justify-center rounded-full bg-[var(--ai-purple-tint)]">
            <ShieldCheck className="size-7 text-remotiv-purple" strokeWidth={2} />
          </div>

          <h1 className="text-center font-heading text-2xl font-bold text-[var(--ai-t1)]">
            Set a new password
          </h1>
          {/* Account-level wording on purpose: one Remotiv login can span
              products, so this changes the password everywhere. Saying "your
              AI Interviews password" would imply per-product passwords. */}
          <p className="mt-2 text-center text-sm text-[var(--ai-t2)]">
            Choose a new password for your Remotiv account. You&apos;ll use it
            everywhere you sign in to Remotiv.
          </p>

          {error && (
            <div
              role="alert"
              aria-live="assertive"
              className="mt-5 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
            >
              {error}
              {linkDead && (
                <Link
                  href="/ai-dashboard/forgot-password"
                  className="mt-1 block font-semibold underline"
                >
                  Request a new reset link
                </Link>
              )}
            </div>
          )}

          <form onSubmit={handleSubmit} className="mt-6 flex flex-col gap-4">
            <div>
              <label
                htmlFor="rp-password"
                className="mb-1.5 block text-[10px] font-semibold uppercase tracking-widest text-[var(--ai-t3)]"
              >
                New password{" "}
                <span className="text-red-500" aria-hidden="true">
                  *
                </span>
              </label>
              <div className="relative">
                <input
                  id="rp-password"
                  type={showPassword ? "text" : "password"}
                  required
                  aria-required="true"
                  autoFocus
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="At least 8 characters"
                  className="w-full rounded-xl border border-[var(--ai-line)] px-4 py-3 pr-11 text-sm text-[var(--ai-t1)] outline-none transition-all focus:border-remotiv-purple focus:ring-2 focus:ring-remotiv-purple/20"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--ai-t3)] hover:text-[var(--ai-t1)]"
                >
                  {showPassword ? (
                    <EyeOff className="size-4" strokeWidth={2} />
                  ) : (
                    <Eye className="size-4" strokeWidth={2} />
                  )}
                </button>
              </div>
            </div>

            <div>
              <label
                htmlFor="rp-confirm"
                className="mb-1.5 block text-[10px] font-semibold uppercase tracking-widest text-[var(--ai-t3)]"
              >
                Confirm new password{" "}
                <span className="text-red-500" aria-hidden="true">
                  *
                </span>
              </label>
              <input
                id="rp-confirm"
                type={showPassword ? "text" : "password"}
                required
                aria-required="true"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="••••••••"
                className="w-full rounded-xl border border-[var(--ai-line)] px-4 py-3 text-sm text-[var(--ai-t1)] outline-none transition-all focus:border-remotiv-purple focus:ring-2 focus:ring-remotiv-purple/20"
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              aria-busy={loading}
              className="mt-2 w-full rounded-xl bg-remotiv-purple py-3 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-60"
            >
              {loading ? "Updating…" : "Update password"}
            </button>
          </form>

          <p className="mt-6 text-center text-xs text-[var(--ai-t3)]">
            You&apos;ll be signed in automatically once your password is updated.
          </p>
        </div>
      </div>
    </div>
  );
}
