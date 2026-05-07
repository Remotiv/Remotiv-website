"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { CheckCircle2, Eye, EyeOff } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { friendlyError } from "@/app/admin/lib/errors";
import { clearMustChangePassword } from "./actions";

export default function ChangePasswordPage() {
  return (
    <Suspense fallback={null}>
      <ChangePasswordForm />
    </Suspense>
  );
}

function ChangePasswordForm() {
  const searchParams = useSearchParams();
  const isForced = searchParams.get("forced") === "true";

  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showNew, setShowNew] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    if (newPassword.length < 8) {
      setError("New password must be at least 8 characters.");
      setLoading(false);
      return;
    }

    if (newPassword !== confirmPassword) {
      setError("New passwords do not match.");
      setLoading(false);
      return;
    }

    // We don't re-verify the current password — Supabase requires a recent
    // session for `updateUser({ password })`, and the previous re-auth pattern
    // was consuming the per-IP rate-limit budget on every typo.
    const supabase = createClient();
    const { error: updateError } = await supabase.auth.updateUser({
      password: newPassword,
    });

    if (updateError) {
      setError(friendlyError(updateError, "Password update failed"));
      setLoading(false);
      return;
    }

    // Clear the must_change_password flag so future logins skip the gate.
    await clearMustChangePassword();

    setSuccess(true);
    setNewPassword("");
    setConfirmPassword("");
    setLoading(false);
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-remotiv-purple p-4 font-sans">
      <div className="w-full max-w-sm rounded-2xl bg-white p-8 shadow-xl">
        <div className="mb-8 text-center">
          <span className="font-heading text-2xl font-bold text-remotiv-purple">
            Remotiv.
          </span>
          <p className="mt-1 text-sm text-gray-400">
            {isForced ? "Set a new password" : "Change Password"}
          </p>
        </div>

        {isForced && !success && (
          <p
            role="status"
            aria-live="polite"
            className="mb-5 rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-sm text-amber-800"
          >
            Welcome! Please set a new password to continue.
          </p>
        )}

        {success ? (
          <div className="flex flex-col items-center gap-5 text-center">
            <div className="flex size-14 items-center justify-center rounded-full bg-remotiv-green/15">
              <CheckCircle2 className="size-7 text-remotiv-green" strokeWidth={2.5} />
            </div>
            <div>
              <p className="font-semibold text-gray-800">Password updated successfully!</p>
              <p className="mt-1 text-sm text-gray-400">Your password has been changed.</p>
            </div>
            <Link
              href="/admin"
              className="w-full rounded-lg bg-remotiv-green py-2.5 text-center text-sm font-semibold text-[#111] transition-colors hover:bg-remotiv-green-light"
            >
              Back to Dashboard
            </Link>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div>
              <label
                htmlFor="cp-new"
                className="mb-1.5 block text-[10px] font-semibold uppercase tracking-widest text-gray-400"
              >
                New Password <span className="text-red-500" aria-hidden="true">*</span>
              </label>
              <div className="relative">
                <input
                  id="cp-new"
                  type={showNew ? "text" : "password"}
                  required
                  aria-required="true"
                  autoFocus
                  autoComplete="new-password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="At least 8 characters"
                  className="w-full rounded-lg border border-gray-200 px-3.5 py-3 pr-11 text-sm text-gray-800 outline-none transition-all focus:border-remotiv-green focus:ring-2 focus:ring-remotiv-green/20"
                />
                <button
                  type="button"
                  onClick={() => setShowNew((v) => !v)}
                  aria-label={showNew ? "Hide password" : "Show password"}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                >
                  {showNew ? <EyeOff className="size-4" strokeWidth={2} /> : <Eye className="size-4" strokeWidth={2} />}
                </button>
              </div>
            </div>

            <div>
              <label
                htmlFor="cp-confirm"
                className="mb-1.5 block text-[10px] font-semibold uppercase tracking-widest text-gray-400"
              >
                Confirm New Password <span className="text-red-500" aria-hidden="true">*</span>
              </label>
              <div className="relative">
                <input
                  id="cp-confirm"
                  type={showConfirm ? "text" : "password"}
                  required
                  aria-required="true"
                  autoComplete="new-password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="••••••••"
                  className="w-full rounded-lg border border-gray-200 px-3.5 py-3 pr-11 text-sm text-gray-800 outline-none transition-all focus:border-remotiv-green focus:ring-2 focus:ring-remotiv-green/20"
                />
                <button
                  type="button"
                  onClick={() => setShowConfirm((v) => !v)}
                  aria-label={showConfirm ? "Hide password" : "Show password"}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                >
                  {showConfirm ? <EyeOff className="size-4" strokeWidth={2} /> : <Eye className="size-4" strokeWidth={2} />}
                </button>
              </div>
            </div>

            {error && (
              <p
                role="alert"
                aria-live="assertive"
                className="rounded-lg bg-red-50 px-3.5 py-2.5 text-sm text-red-500"
              >
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={loading} aria-busy={loading}
              className="mt-2 w-full rounded-lg bg-remotiv-green py-2.5 text-sm font-semibold text-[#111] transition-colors hover:bg-remotiv-green-light disabled:cursor-not-allowed disabled:opacity-60"
            >
              {loading ? "Updating…" : "Update Password"}
            </button>

            {!isForced && (
              <Link
                href="/admin"
                className="mt-1 text-center text-sm text-gray-400 transition-colors hover:text-gray-600"
              >
                Back to Dashboard
              </Link>
            )}
          </form>
        )}
      </div>
    </div>
  );
}
