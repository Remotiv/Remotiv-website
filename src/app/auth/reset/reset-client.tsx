"use client";

import { useState } from "react";
import Link from "next/link";
import { Eye, EyeOff, ShieldCheck } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { resolveResetDestination } from "./actions";

export function ResetClient({
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
  /** True only when the LINK itself is dead — surfaces the recovery links. */
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
    //    requesting in Chrome and opening the email in Safari works.
    let verifyError: { message: string } | null = null;
    if (tokenHash) {
      const { error: otpError } = await supabase.auth.verifyOtp({
        token_hash: tokenHash,
        type: otpType as "recovery",
      });
      verifyError = otpError;
    } else if (code) {
      const { error: codeError } = await supabase.auth.exchangeCodeForSession(code);
      verifyError = codeError;
    }

    if (verifyError) {
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

    // 3. One template serves both products, so ask the server which home this
    //    user belongs to. It reads only the session we just established.
    const destination = await resolveResetDestination();

    // 4. Full-page navigation, NOT router.push: the session cookie was just
    //    written client-side, and an RSC navigation would render the
    //    destination on the server with stale cookies. `loading` stays true —
    //    the page is being replaced.
    window.location.assign(destination);
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-remotiv-bg px-6 py-16 font-sans">
      <div className="w-full max-w-md">
        <div className="mb-6 text-center">
          <Link
            href="/"
            className="font-heading text-2xl font-bold tracking-tight text-remotiv-purple"
          >
            Remotiv<span className="font-extrabold">.</span>
          </Link>
        </div>

        <div className="rounded-3xl border border-gray-100 bg-white p-8 shadow-lg sm:p-10">
          <div className="mx-auto mb-4 flex size-14 items-center justify-center rounded-full bg-remotiv-purple/10">
            <ShieldCheck className="size-7 text-remotiv-purple" strokeWidth={2} />
          </div>

          <h1 className="text-center font-heading text-2xl font-bold text-gray-900">
            Set a new password
          </h1>
          {/* Account-level wording on purpose: one Remotiv login can span
              products, so this changes the password everywhere. */}
          <p className="mt-2 text-center text-sm text-gray-600">
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
                <span className="mt-1 block">
                  Request a new one:{" "}
                  <Link href="/forgot-password" className="font-semibold underline">
                    Remotiv account
                  </Link>{" "}
                  ·{" "}
                  <Link
                    href="/ai-dashboard/forgot-password"
                    className="font-semibold underline"
                  >
                    company workspace
                  </Link>
                </span>
              )}
            </div>
          )}

          <form onSubmit={handleSubmit} className="mt-6 flex flex-col gap-4">
            <div>
              <label
                htmlFor="ar-password"
                className="mb-1.5 block text-[10px] font-semibold uppercase tracking-widest text-gray-400"
              >
                New password{" "}
                <span className="text-red-500" aria-hidden="true">
                  *
                </span>
              </label>
              <div className="relative">
                <input
                  id="ar-password"
                  type={showPassword ? "text" : "password"}
                  required
                  aria-required="true"
                  autoFocus
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="At least 8 characters"
                  className="w-full rounded-xl border border-gray-200 px-4 py-3 pr-11 text-sm text-gray-800 outline-none transition-all focus:border-remotiv-purple focus:ring-2 focus:ring-remotiv-purple/20"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
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
                htmlFor="ar-confirm"
                className="mb-1.5 block text-[10px] font-semibold uppercase tracking-widest text-gray-400"
              >
                Confirm new password{" "}
                <span className="text-red-500" aria-hidden="true">
                  *
                </span>
              </label>
              <input
                id="ar-confirm"
                type={showPassword ? "text" : "password"}
                required
                aria-required="true"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="••••••••"
                className="w-full rounded-xl border border-gray-200 px-4 py-3 text-sm text-gray-800 outline-none transition-all focus:border-remotiv-purple focus:ring-2 focus:ring-remotiv-purple/20"
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

          <p className="mt-6 text-center text-xs text-gray-400">
            You&apos;ll be signed in automatically once your password is updated.
          </p>
        </div>
      </div>
    </div>
  );
}
