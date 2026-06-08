"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

const REASON_BANNER: Record<string, string> = {
  unauthorized: "Please sign in to access the talent dashboard.",
  expired:
    "Your invite link has expired. Enter your email below to get a new code.",
  invalid:
    "We couldn't recognise that invite link. Enter your email below to continue.",
  already_claimed:
    "This profile is already claimed. If that's not you, contact talent@remotiv.work.",
  email_conflict:
    "This email is already registered as a client or admin. Please use a different email or contact support.",
};

type Step =
  | { kind: "email" }
  | { kind: "code"; email: string }
  | { kind: "error"; reason: string };

export function TalentLoginClient({
  token,
  reason,
}: {
  token: string | null;
  reason: string | null;
}) {
  const router = useRouter();
  const [step, setStep] = useState<Step>({ kind: "email" });
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Token path (admin invite): validate token, pre-fill email, trigger code send,
  // jump straight to code-entry step.
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    setBusy(true);
    (async () => {
      try {
        const res = await fetch("/api/claim/verify", {
          method: "POST",
          cache: "no-store",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
        });
        const json = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          reason?: string;
          email?: string;
        };
        if (cancelled) return;
        if (!json.ok || !json.email) {
          setStep({ kind: "error", reason: json.reason ?? "invalid" });
          setBusy(false);
          return;
        }
        // Trigger the OTP code send on the verified email
        const initRes = await fetch("/api/claim/initiate", {
          method: "POST",
          cache: "no-store",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: json.email }),
        });
        const initJson = (await initRes.json().catch(() => ({}))) as {
          ok?: boolean;
          reason?: string;
        };
        if (cancelled) return;
        if (initJson.reason === "email_conflict") {
          setStep({ kind: "error", reason: "email_conflict" });
        } else {
          setStep({ kind: "code", email: json.email });
          setMessage(`We sent a 6-digit code to ${json.email}.`);
        }
      } catch (e) {
        if (cancelled) return;
        console.error("[talent-login] token verify failed:", e);
        setStep({ kind: "error", reason: "invalid" });
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function handleEmailSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setMessage(null);
    setBusy(true);
    try {
      const res = await fetch("/api/claim/initiate", {
        method: "POST",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim() }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        reason?: string;
        message?: string;
      };
      if (json.reason === "email_conflict") {
        setError(REASON_BANNER.email_conflict ?? "Email conflict.");
        return;
      }
      if (json.ok) {
        setStep({ kind: "code", email: email.trim().toLowerCase() });
        setMessage(
          json.message ??
            "If we found a matching profile, you'll receive a 6-digit code shortly.",
        );
      } else {
        setError("Something went wrong. Please try again.");
      }
    } catch (err) {
      console.error("[talent-login] initiate failed:", err);
      setError("Network error. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function handleCodeSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (step.kind !== "code") return;
    const trimmed = code.trim();
    if (trimmed.length !== 6 || !/^\d{6}$/.test(trimmed)) {
      setError("Please enter the 6-digit code from your email.");
      return;
    }
    setError(null);
    setMessage(null);
    setBusy(true);
    try {
      const supabase = createClient();
      const { error: verifyErr } = await supabase.auth.verifyOtp({
        email: step.email,
        token: trimmed,
        type: "email",
      });
      if (verifyErr) {
        console.error("[talent-login] verifyOtp failed:", verifyErr);
        setError("Invalid or expired code. Please try again.");
        return;
      }
      // Session is set. Forward to dashboard; router.refresh ensures
      // the server layout re-reads the new auth cookie.
      router.replace("/talent/dashboard");
      router.refresh();
    } catch (err) {
      console.error("[talent-login] verifyOtp threw:", err);
      setError("Unexpected error. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  function handleBackToEmail() {
    setStep({ kind: "email" });
    setCode("");
    setMessage(null);
    setError(null);
  }

  const reasonBanner = reason ? REASON_BANNER[reason] : null;
  const stepError =
    step.kind === "error" ? REASON_BANNER[step.reason] : null;

  return (
    <main className="flex min-h-screen items-center justify-center bg-[#f8f4f1] px-4 py-10">
      <div className="w-full max-w-md rounded-2xl border border-black/[0.06] bg-white p-8 shadow-sm">
        <Link
          href="/"
          className="mb-6 inline-block font-heading text-xl font-bold text-remotiv-purple"
        >
          Remotiv.
        </Link>
        <h1 className="font-heading text-2xl font-bold text-gray-900">
          Talent Login
        </h1>
        <p className="mt-1 text-sm text-gray-500">
          Sign in to claim or manage your profile.
        </p>

        {reasonBanner && !stepError && (
          <p
            role="status"
            aria-live="polite"
            className="mt-5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800"
          >
            {reasonBanner}
          </p>
        )}
        {stepError && (
          <p
            role="alert"
            aria-live="assertive"
            className="mt-5 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
          >
            {stepError}
          </p>
        )}

        {step.kind === "email" && (
          <form onSubmit={handleEmailSubmit} className="mt-6 flex flex-col gap-3">
            <label
              htmlFor="talent-email"
              className="text-[10px] font-semibold uppercase tracking-widest text-gray-400"
            >
              Email
            </label>
            <input
              id="talent-email"
              type="email"
              required
              aria-required="true"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className="rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm outline-none ring-remotiv-purple/30 focus:border-remotiv-purple focus:ring-2"
            />
            <button
              type="submit"
              disabled={busy}
              className="mt-2 rounded-xl bg-remotiv-purple px-4 py-3 text-sm font-bold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {busy ? "Sending…" : "Send me a 6-digit code"}
            </button>
          </form>
        )}

        {step.kind === "code" && (
          <form onSubmit={handleCodeSubmit} className="mt-6 flex flex-col gap-3">
            {message && (
              <p className="rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
                {message}
              </p>
            )}
            <label
              htmlFor="talent-code"
              className="text-[10px] font-semibold uppercase tracking-widest text-gray-400"
            >
              6-digit code
            </label>
            <input
              id="talent-code"
              type="text"
              inputMode="numeric"
              pattern="\d{6}"
              maxLength={6}
              required
              aria-required="true"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
              placeholder="000000"
              // biome-ignore lint/a11y/noAutofocus: OTP flow — focus is expected on the code field as soon as it appears
              autoFocus
              className="rounded-xl border border-gray-200 bg-white px-4 py-3 text-center font-mono text-2xl tracking-[0.5em] outline-none ring-remotiv-purple/30 focus:border-remotiv-purple focus:ring-2"
            />
            {error && (
              <p className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                {error}
              </p>
            )}
            <button
              type="submit"
              disabled={busy}
              className="mt-2 rounded-xl bg-remotiv-purple px-4 py-3 text-sm font-bold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {busy ? "Verifying…" : "Verify & sign in"}
            </button>
            <button
              type="button"
              onClick={handleBackToEmail}
              className="text-xs text-gray-400 hover:text-gray-600"
            >
              Use a different email
            </button>
          </form>
        )}

        {step.kind === "email" && error && (
          <p className="mt-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </p>
        )}

        <p className="mt-6 text-center text-xs text-gray-400">
          Trouble signing in? Email{" "}
          <a
            href="mailto:talent@remotiv.work"
            className="text-remotiv-purple hover:underline"
          >
            talent@remotiv.work
          </a>
        </p>
      </div>
    </main>
  );
}
