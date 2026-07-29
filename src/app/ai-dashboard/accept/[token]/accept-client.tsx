"use client";

import { useState } from "react";
import Link from "next/link";
import { Eye, EyeOff } from "lucide-react";
import { acceptInvite } from "../actions";

export function AcceptClient({
  token,
  email,
  inviteeName,
  companyName,
  roleLabel,
  existingAccount,
}: {
  token: string;
  email: string;
  inviteeName: string;
  companyName: string;
  roleLabel: string;
  existingAccount: boolean;
}) {
  // Server-side detection picks the initial copy; acceptInvite can flip this
  // on if the account turns out to exist after all.
  const [signInMode, setSignInMode] = useState(existingAccount);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (!signInMode && password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }

    setLoading(true);
    const result = await acceptInvite({ token, password });

    if (!result.success) {
      if (result.needsExistingPassword) setSignInMode(true);
      setError(result.error);
      setLoading(false);
      return;
    }

    // Full-page navigation, NOT router.push: the session cookie was just set
    // server-side, and an RSC navigation would render the gated layout with
    // stale cookies. `loading` stays true — the page is being replaced.
    window.location.assign("/ai-dashboard");
  }

  const greeting = inviteeName || email.split("@")[0];

  return (
    <div className="ai-shell flex min-h-screen items-center justify-center bg-[var(--ai-page)] px-6 py-16 font-sans">
      <div className="w-full max-w-md">
        <div className="mb-6 text-center">
          <Link
            href="/"
            className="font-heading text-2xl font-bold tracking-tight text-remotiv-purple"
          >
            Remotiv<span className="font-extrabold">.</span>
          </Link>
        </div>

        <div className="rounded-3xl border border-[var(--ai-line)] bg-white p-8 shadow-lg sm:p-10">
          <h1 className="font-heading text-2xl font-bold text-[var(--ai-t1)]">
            {signInMode
              ? `Sign in to join ${companyName}`
              : `Join ${companyName}`}
          </h1>
          <p className="mt-2 text-sm text-[var(--ai-t2)]">
            {signInMode ? (
              <>
                Hi {greeting} — you already have a Remotiv account. Enter your
                existing password to join as a{" "}
                <span className="font-semibold text-[var(--ai-t1)]">{roleLabel}</span>.
              </>
            ) : (
              <>
                Hi {greeting}, set a password to accept your invitation as a{" "}
                <span className="font-semibold text-[var(--ai-t1)]">{roleLabel}</span>.
              </>
            )}
          </p>

          <div className="mt-5 rounded-xl border border-[var(--ai-line)] bg-[var(--ai-inset)] px-4 py-3">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-[var(--ai-t3)]">
              Your email
            </p>
            <p className="mt-0.5 truncate text-sm font-semibold text-[var(--ai-t1)]">
              {email}
            </p>
          </div>

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
                htmlFor="accept-password"
                className="mb-1.5 block text-[10px] font-semibold uppercase tracking-widest text-[var(--ai-t3)]"
              >
                {signInMode ? "Your password" : "Create a password"}{" "}
                <span className="text-red-500" aria-hidden="true">*</span>
              </label>
              <div className="relative">
                <input
                  id="accept-password"
                  type={showPassword ? "text" : "password"}
                  required
                  aria-required="true"
                  autoFocus
                  autoComplete={signInMode ? "current-password" : "new-password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={signInMode ? "••••••••" : "At least 8 characters"}
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

            {!signInMode && (
              <div>
                <label
                  htmlFor="accept-confirm"
                  className="mb-1.5 block text-[10px] font-semibold uppercase tracking-widest text-[var(--ai-t3)]"
                >
                  Confirm password{" "}
                  <span className="text-red-500" aria-hidden="true">*</span>
                </label>
                <input
                  id="accept-confirm"
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
            )}

            <button
              type="submit"
              disabled={loading}
              aria-busy={loading}
              className="mt-2 w-full rounded-xl bg-remotiv-purple py-3 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-60"
            >
              {loading
                ? "Joining…"
                : signInMode
                  ? "Sign in & join"
                  : `Join ${companyName}`}
            </button>
          </form>

          <p className="mt-6 text-center text-xs text-[var(--ai-t3)]">
            This invitation is single-use and expires 7 days after it was sent.
          </p>
        </div>
      </div>
    </div>
  );
}
