"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Eye, EyeOff } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

const REASON_MESSAGES: Record<string, string> = {
  unauthorized: "This login is for clients only. Please use admin login if you're a Remotiv team member.",
  paused: "Your client account has been paused. Contact your account manager.",
  archived: "Your client account has been archived. Contact your account manager.",
};

export default function ClientLoginPage() {
  return (
    <Suspense fallback={<LoginFallback />}>
      <LoginForm />
    </Suspense>
  );
}

function LoginFallback() {
  return (
    <div className="grid min-h-screen place-items-center bg-[#f8f4f1]">
      <p className="text-sm text-gray-400">Loading…</p>
    </div>
  );
}

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const reason = searchParams.get("reason");
  const reasonMessage = reason ? REASON_MESSAGES[reason] ?? null : null;

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const supabase = createClient();
    const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });

    // TEMP DIAGNOSTIC LOGS — remove once "valid client rejected" is confirmed
    // resolved. Browser-side: open DevTools → Console.
    console.log("[client login] signIn data:", authData);
    console.log("[client login] signIn error:", authError);
    console.log("[client login] user.id:", authData?.user?.id);

    if (authError || !authData.user) {
      setError("Invalid email or password");
      setLoading(false);
      return;
    }

    // Verify the auth user actually owns a clients row before redirecting.
    // Without this, an admin user could land in the client portal.
    const { data: clientRow, error: clientErr } = await supabase
      .from("clients")
      .select("id, status, user_id")
      .eq("user_id", authData.user.id)
      .maybeSingle();

    console.log("[client login] client lookup user_id query:", authData.user.id);
    console.log("[client login] clientRow:", clientRow);
    console.log("[client login] clientErr:", clientErr);

    if (!clientRow) {
      await supabase.auth.signOut();
      setError(REASON_MESSAGES.unauthorized);
      setLoading(false);
      return;
    }

    const status = (clientRow as { status: string }).status;
    if (status !== "active") {
      await supabase.auth.signOut();
      setError(REASON_MESSAGES[status] ?? "Your account isn't active.");
      setLoading(false);
      return;
    }

    router.push("/client/dashboard");
    router.refresh();
  }

  return (
    <div className="grid min-h-screen grid-cols-1 lg:grid-cols-[3fr_2fr]">
      {/* Left — brand showcase */}
      <aside className="relative hidden flex-col justify-between overflow-hidden bg-gradient-to-br from-[#f8f4f1] via-white to-[#f8f4f1] px-12 py-10 lg:flex">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-[linear-gradient(rgba(0,0,0,0.04)_1px,transparent_1px),linear-gradient(90deg,rgba(0,0,0,0.04)_1px,transparent_1px)] bg-[size:48px_48px]"
        />
        <Link
          href="/"
          className="relative font-heading text-2xl font-bold tracking-tight text-[#7E47FF]"
        >
          Remotiv<span className="font-extrabold">.</span>
        </Link>

        <div className="relative max-w-xl">
          <span className="mb-5 inline-flex items-center gap-2 rounded-full bg-[#c9ff85] px-3 py-1 text-[11px] font-bold uppercase tracking-widest text-[#3a5c08]">
            Client Portal
          </span>
          <h1 className="font-heading text-[clamp(2.4rem,4.4vw,3.6rem)] font-extrabold leading-[1.05] tracking-[-0.03em] text-[#111]">
            Your candidates,
            <br />
            <span className="text-[#7E47FF]">ready for review.</span>
          </h1>
          <p className="mt-5 max-w-md text-base leading-relaxed text-gray-600">
            Approve, reject, or request interviews — all in one place.
          </p>
          <div className="mt-7 flex flex-wrap gap-2">
            <Pill>Real-time updates</Pill>
            <Pill>Secure access</Pill>
            <Pill>Mobile-friendly</Pill>
          </div>
        </div>

        <div className="relative flex items-center gap-3 text-xs text-gray-400">
          <span>© Remotiv {new Date().getFullYear()}</span>
        </div>
      </aside>

      {/* Right — login form */}
      <main className="flex items-center justify-center bg-white px-6 py-10 sm:px-10">
        <div className="w-full max-w-md">
          <Link
            href="/"
            className="mb-8 inline-block font-heading text-xl font-bold text-[#7E47FF] lg:hidden"
          >
            Remotiv.
          </Link>
          <div className="rounded-3xl border border-gray-100 bg-white p-8 shadow-lg sm:p-10">
            <h2 className="font-heading text-2xl font-bold text-gray-900">Welcome back</h2>
            <p className="mt-1 text-sm text-gray-500">Sign in to view your candidate batch.</p>

            {reasonMessage && !error && (
              <p className="mt-5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                {reasonMessage}
              </p>
            )}
            {error && (
              <p className="mt-5 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                {error}
              </p>
            )}

            <form onSubmit={handleSubmit} className="mt-6 flex flex-col gap-4">
              <div>
                <label
                  htmlFor="cl-email"
                  className="mb-1.5 block text-[10px] font-semibold uppercase tracking-widest text-gray-400"
                >
                  Email
                </label>
                <input
                  id="cl-email"
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="contact@yourcompany.com"
                  className="w-full rounded-xl border border-gray-200 px-4 py-3 text-sm text-gray-800 outline-none transition-all focus:border-[#7E47FF] focus:ring-2 focus:ring-[#7E47FF]/20"
                />
              </div>

              <div>
                <label
                  htmlFor="cl-password"
                  className="mb-1.5 block text-[10px] font-semibold uppercase tracking-widest text-gray-400"
                >
                  Password
                </label>
                <div className="relative">
                  <input
                    id="cl-password"
                    type={showPassword ? "text" : "password"}
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    className="w-full rounded-xl border border-gray-200 px-4 py-3 pr-11 text-sm text-gray-800 outline-none transition-all focus:border-[#7E47FF] focus:ring-2 focus:ring-[#7E47FF]/20"
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
                disabled={loading}
                className="mt-2 w-full rounded-xl bg-[#7E47FF] py-3 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-60"
              >
                {loading ? "Signing in…" : "Sign In"}
              </button>
            </form>

            <p className="mt-6 text-center text-xs text-gray-400">
              Forgot password? Contact your account manager.
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
      <span className="size-1.5 rounded-full bg-[#49D7A7]" />
      {children}
    </span>
  );
}
