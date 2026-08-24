"use client";

import { useState } from "react";
import Link from "next/link";
import { Eye, EyeOff } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { verifyCompanyAccess } from "./actions";

const REASON_MESSAGES: Record<string, string> = {
  unauthorized: "This login is for company accounts only. Please use the portal you were given access to.",
  paused: "Your company account has been paused. Contact your account manager.",
  archived: "Your company account has been archived. Contact your account manager.",
};

export function CompanyLoginClient({ reason }: { reason: string | null }) {
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
    const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });

    if (authError || !authData.user) {
      // Enumeration-safe handling: collapse credential errors, surface
      // rate-limit distinctly.
      const raw = authError?.message?.toLowerCase() ?? "";
      const status = (authError as { status?: number } | null)?.status;
      if (raw.includes("rate") || status === 429) {
        setError("Too many attempts. Please try again in a minute.");
      } else {
        setError("Invalid email or password.");
      }
      setLoading(false);
      return;
    }

    // Verify the auth user actually belongs to a company before redirecting.
    // Without this, a client-portal or admin user could land here. This runs
    // server-side (service client): RLS on companies/company_members has no
    // policies, so the browser client can never read those rows.
    const verified = await verifyCompanyAccess();

    /*
     * A failed LOOKUP is not a failed login.
     *
     * Signing out here is how the gate evicts someone who doesn't belong. When
     * the check itself could not run, the session is left intact and they are
     * asked to retry — signing a legitimate member out over a transient
     * database error, and telling them their account is the wrong kind, would
     * be the worse of the two mistakes.
     */
    if (!verified.ok && verified.reason === "unavailable") {
      setError("We couldn't verify your account just now. Try again in a moment.");
      setLoading(false);
      return;
    }

    if (!verified.ok) {
      await supabase.auth.signOut();
      setError(
        verified.reason === "inactive"
          ? (verified.status ? REASON_MESSAGES[verified.status] : null) ??
              "Your account isn't active."
          : REASON_MESSAGES.unauthorized,
      );
      setLoading(false);
      return;
    }

    // Full-page navigation, NOT router.push: the session cookie was just set
    // client-side, and an RSC navigation would render the gated layout on the
    // server with stale cookies — its redirect() then stalls the transition.
    // `loading` is deliberately left true; the page is being replaced, so
    // "Signing in…" is the correct state until it unloads.
    window.location.assign("/ai-dashboard");
  }

  return (
    <div className="grid min-h-screen grid-cols-1 lg:grid-cols-[3fr_2fr]">
      {/* Left — brand showcase */}
      <aside className="relative hidden flex-col justify-between overflow-hidden bg-gradient-to-br from-remotiv-bg via-white to-remotiv-bg px-12 py-10 lg:flex">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-[linear-gradient(rgba(0,0,0,0.04)_1px,transparent_1px),linear-gradient(90deg,rgba(0,0,0,0.04)_1px,transparent_1px)] bg-[size:48px_48px]"
        />
        <Link
          href="/"
          className="relative font-heading text-2xl font-bold tracking-tight text-remotiv-purple"
        >
          Remotiv<span className="font-extrabold">.</span>
        </Link>

        <div className="relative max-w-xl">
          <span className="mb-5 inline-flex items-center gap-2 rounded-full bg-remotiv-lime-card px-3 py-1 text-[11px] font-bold uppercase tracking-widest text-[#3a5c08]">
            AI Interviews
          </span>
          <h1 className="font-heading text-[clamp(2.4rem,4.4vw,3.6rem)] font-extrabold leading-[1.05] tracking-[-0.03em] text-[#111]">
            Hire faster,
            <br />
            <span className="text-remotiv-purple">screen smarter.</span>
          </h1>
          <p className="mt-5 max-w-md text-base leading-relaxed text-gray-600">
            AI-powered screening and video interviews — all in one place.
          </p>
          <div className="mt-7 flex flex-wrap gap-2">
            <Pill>AI screening</Pill>
            <Pill>Video interviews</Pill>
            <Pill>Explainable scores</Pill>
          </div>
        </div>

        <div className="relative flex items-center gap-3 text-xs text-gray-400">
          <span>© Remotiv {new Date().getFullYear()}</span>
        </div>
      </aside>

      <main className="flex items-center justify-center bg-white px-6 py-10 sm:px-10">
        <div className="w-full max-w-md">
          <Link
            href="/"
            className="mb-8 inline-block font-heading text-xl font-bold text-remotiv-purple lg:hidden"
          >
            Remotiv.
          </Link>
          <div className="rounded-3xl border border-gray-100 bg-white p-8 shadow-lg sm:p-10">
            <h2 className="font-heading text-2xl font-bold text-gray-900">Welcome back</h2>
            <p className="mt-1 text-sm text-gray-500">Sign in to your company workspace.</p>

            {reasonMessage && !error && (
              <p
                role="status"
                aria-live="polite"
                className="mt-5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800"
              >
                {reasonMessage}
              </p>
            )}
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
                  htmlFor="co-email"
                  className="mb-1.5 block text-[10px] font-semibold uppercase tracking-widest text-gray-400"
                >
                  Email <span className="text-red-500" aria-hidden="true">*</span>
                </label>
                <input
                  id="co-email"
                  type="email"
                  required
                  aria-required="true"
                  autoFocus
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="contact@yourcompany.com"
                  className="w-full rounded-xl border border-gray-200 px-4 py-3 text-sm text-gray-800 outline-none transition-all focus:border-remotiv-purple focus:ring-2 focus:ring-remotiv-purple/20"
                />
              </div>

              <div>
                <label
                  htmlFor="co-password"
                  className="mb-1.5 block text-[10px] font-semibold uppercase tracking-widest text-gray-400"
                >
                  Password <span className="text-red-500" aria-hidden="true">*</span>
                </label>
                <div className="relative">
                  <input
                    id="co-password"
                    type={showPassword ? "text" : "password"}
                    required
                    aria-required="true"
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    className="w-full rounded-xl border border-gray-200 px-4 py-3 pr-11 text-sm text-gray-800 outline-none transition-all focus:border-remotiv-purple focus:ring-2 focus:ring-remotiv-purple/20"
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

              <button
                type="submit"
                disabled={loading} aria-busy={loading}
                className="mt-2 w-full rounded-xl bg-remotiv-purple py-3 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-60"
              >
                {loading ? "Signing in…" : "Sign In"}
              </button>
            </form>

            <p className="mt-6 text-center text-xs text-gray-400">
              <Link
                href="/ai-dashboard/forgot-password"
                className="font-semibold text-remotiv-purple hover:underline"
              >
                Forgot password?
              </Link>
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}

function Pill({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-gray-200 bg-white/70 px-3 py-1 text-[11px] font-medium text-gray-600 backdrop-blur-sm">
      <span className="size-1.5 rounded-full bg-remotiv-green" />
      {children}
    </span>
  );
}
