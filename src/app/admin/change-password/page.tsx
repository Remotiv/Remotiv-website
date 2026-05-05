"use client";

import { useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";

export default function ChangePasswordPage() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (newPassword !== confirmPassword) {
      setError("New passwords do not match.");
      return;
    }

    if (newPassword.length < 8) {
      setError("New password must be at least 8 characters.");
      return;
    }

    setLoading(true);
    const supabase = createClient();

    const { data: userData } = await supabase.auth.getUser();
    const email = userData.user?.email;

    if (!email) {
      setError("Could not retrieve your account. Please sign in again.");
      setLoading(false);
      return;
    }

    const { error: signInError } = await supabase.auth.signInWithPassword({
      email,
      password: currentPassword,
    });

    if (signInError) {
      setError("Current password is incorrect.");
      setLoading(false);
      return;
    }

    const { error: updateError } = await supabase.auth.updateUser({
      password: newPassword,
    });

    if (updateError) {
      setError(updateError.message);
      setLoading(false);
      return;
    }

    setSuccess(true);
    setCurrentPassword("");
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
          <p className="mt-1 text-sm text-gray-400">Change Password</p>
        </div>

        {success ? (
          <div className="flex flex-col items-center gap-5 text-center">
            <div className="flex size-14 items-center justify-center rounded-full bg-remotiv-green/15">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2.5}
                strokeLinecap="round"
                strokeLinejoin="round"
                className="size-7 text-remotiv-green"
              >
                <polyline points="20 6 9 17 4 12" />
              </svg>
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
                htmlFor="cp-current"
                className="mb-1.5 block text-[10px] font-semibold uppercase tracking-widest text-gray-400"
              >
                Current Password
              </label>
              <input
                id="cp-current"
                type="password"
                required
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                placeholder="••••••••"
                className="w-full rounded-lg border border-gray-200 px-3.5 py-2.5 text-sm text-gray-800 outline-none transition-all focus:border-remotiv-green focus:ring-2 focus:ring-remotiv-green/20"
              />
            </div>

            <div>
              <label
                htmlFor="cp-new"
                className="mb-1.5 block text-[10px] font-semibold uppercase tracking-widest text-gray-400"
              >
                New Password
              </label>
              <input
                id="cp-new"
                type="password"
                required
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="••••••••"
                className="w-full rounded-lg border border-gray-200 px-3.5 py-2.5 text-sm text-gray-800 outline-none transition-all focus:border-remotiv-green focus:ring-2 focus:ring-remotiv-green/20"
              />
            </div>

            <div>
              <label
                htmlFor="cp-confirm"
                className="mb-1.5 block text-[10px] font-semibold uppercase tracking-widest text-gray-400"
              >
                Confirm New Password
              </label>
              <input
                id="cp-confirm"
                type="password"
                required
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="••••••••"
                className="w-full rounded-lg border border-gray-200 px-3.5 py-2.5 text-sm text-gray-800 outline-none transition-all focus:border-remotiv-green focus:ring-2 focus:ring-remotiv-green/20"
              />
            </div>

            {error && (
              <p className="rounded-lg bg-red-50 px-3.5 py-2.5 text-sm text-red-500">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={loading}
              className="mt-2 w-full rounded-lg bg-remotiv-green py-2.5 text-sm font-semibold text-[#111] transition-colors hover:bg-remotiv-green-light disabled:cursor-not-allowed disabled:opacity-60"
            >
              {loading ? "Updating…" : "Update Password"}
            </button>

            <Link
              href="/admin"
              className="mt-1 text-center text-sm text-gray-400 transition-colors hover:text-gray-600"
            >
              Back to Dashboard
            </Link>
          </form>
        )}
      </div>
    </div>
  );
}
