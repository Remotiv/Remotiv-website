"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Eye, EyeOff } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

const REASON_MESSAGES: Record<string, string> = {
  removed: "Your admin access was removed. Email support@remotiv.work if this is unexpected.",
  paused: "Your account has been paused. Email support@remotiv.work to restore access.",
  archived: "Your account has been archived. Email support@remotiv.work to restore access.",
};

export function LoginClient({ reason }: { reason: string | null }) {
  const router = useRouter();
  const reasonMessage = reason ? REASON_MESSAGES[reason] ?? null : null;

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const supabase = createClient();
    const { error: authError } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });

    if (authError) {
      // Don't leak whether the email exists. Map credential-shaped errors to
      // a single generic string; surface rate-limit feedback distinctly so
      // users don't keep mashing while throttled.
      const raw = authError.message?.toLowerCase() ?? "";
      const status = (authError as { status?: number }).status;
      const isRateLimited = raw.includes("rate") || status === 429;
      const isCredentialError =
        raw.includes("invalid") ||
        raw.includes("credentials") ||
        raw.includes("user not found") ||
        raw.includes("email");

      if (isRateLimited) {
        setError("Too many attempts. Please try again in a minute.");
      } else if (isCredentialError) {
        setError("Invalid email or password.");
      } else {
        setError("Sign-in failed. Please try again.");
      }
      setLoading(false);
      return;
    }

    router.push("/admin");
    router.refresh();
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-remotiv-purple p-4 font-sans">
      <div className="w-full max-w-sm rounded-2xl bg-white p-8 shadow-xl">
        <div className="mb-8 text-center">
          <span className="font-heading text-2xl font-bold text-remotiv-purple">
            Remotiv.
          </span>
          <p className="mt-1 text-sm text-gray-400">Admin Portal</p>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div>
            <label
              htmlFor="al-email"
              className="mb-1.5 block text-[10px] font-semibold uppercase tracking-widest text-gray-400"
            >
              Email
            </label>
            <input
              id="al-email"
              type="email"
              required
              autoFocus
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="admin@remotiv.work"
              className="w-full rounded-lg border border-gray-200 px-3.5 py-3 text-sm text-gray-800 outline-none transition-all focus:border-remotiv-green focus:ring-2 focus:ring-remotiv-green/20"
            />
          </div>

          <div>
            <label
              htmlFor="al-password"
              className="mb-1.5 block text-[10px] font-semibold uppercase tracking-widest text-gray-400"
            >
              Password
            </label>
            <div className="relative">
              <input
                id="al-password"
                type={showPassword ? "text" : "password"}
                required
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                className="w-full rounded-lg border border-gray-200 px-3.5 py-3 pr-11 text-sm text-gray-800 outline-none transition-all focus:border-remotiv-green focus:ring-2 focus:ring-remotiv-green/20"
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? "Hide password" : "Show password"}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
              >
                {showPassword ? <EyeOff className="size-4" strokeWidth={2} /> : <Eye className="size-4" strokeWidth={2} />}
              </button>
            </div>
          </div>

          {reasonMessage && !error && (
            <p
              role="status"
              aria-live="polite"
              className="rounded-lg bg-amber-50 px-3.5 py-2.5 text-sm text-amber-700"
            >
              {reasonMessage}
            </p>
          )}

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
            className="mt-2 w-full rounded-lg bg-remotiv-green py-3 text-sm font-semibold text-[#111] transition-colors hover:bg-remotiv-green-light disabled:cursor-not-allowed disabled:opacity-60"
          >
            {loading ? "Signing in…" : "Sign In"}
          </button>
        </form>
      </div>
    </div>
  );
}
