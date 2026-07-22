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

// Token failures split two ways. Recoverable ones (bad/stale link) drop the
// candidate back to the email step so they can self-serve a fresh code via the
// existing /api/claim/initiate flow — the banner copy already promises that.
// Terminal ones can't be fixed by a resend, so they stay a dead end.
const TERMINAL_TOKEN_REASONS = new Set(["already_claimed", "email_conflict"]);

export function TalentLoginClient({
  token,
  reason,
  profileId = null,
  sourceTable = null,
}: {
  token: string | null;
  reason: string | null;
  profileId?: string | null;
  sourceTable?: "talent_profiles" | "hire_remote_profiles" | null;
}) {
  const router = useRouter();
  const [step, setStep] = useState<Step>({ kind: "email" });
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Banner shown above the email form after a recoverable token failure.
  const [notice, setNotice] = useState<string | null>(null);
  // Resend state — deliberately separate from `busy`, which is shared with the
  // verify button (reusing it would disable/relabel "Verify & sign in").
  const [resending, setResending] = useState(false);
  const [cooldown, setCooldown] = useState(0);

  // Cooldown countdown. Cleanup is mandatory — this component unmounts on a
  // successful verify (router.replace), which would otherwise leak the timer.
  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setInterval(() => setCooldown((c) => c - 1), 1000);
    return () => clearInterval(t);
  }, [cooldown]);

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
          const reason = json.reason ?? "invalid";
          if (TERMINAL_TOKEN_REASONS.has(reason)) {
            setStep({ kind: "error", reason });
          } else {
            // expired / invalid / unknown → recoverable: land on the email
            // step with the banner so the candidate can request a new code.
            setStep({ kind: "email" });
            setNotice(REASON_BANNER[reason] ?? REASON_BANNER.invalid ?? null);
          }
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

  // Shared by the email form and the code-step resend so both hit the same
  // endpoint with the same request shape. `status` is surfaced so callers can
  // distinguish the server's 429 rate-limit from a generic failure.
  async function requestCode(targetEmail: string): Promise<{
    ok: boolean;
    message?: string;
    reason?: string;
    status: number;
  }> {
    const res = await fetch("/api/claim/initiate", {
      method: "POST",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: targetEmail }),
    });
    const json = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      reason?: string;
      message?: string;
    };
    return {
      ok: Boolean(json.ok),
      message: json.message,
      reason: json.reason,
      status: res.status,
    };
  }

  async function handleEmailSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setMessage(null);
    setBusy(true);
    try {
      const json = await requestCode(email.trim());
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
      const dashboardUrl =
        profileId && sourceTable
          ? `/talent/dashboard?profile_id=${profileId}&source_table=${sourceTable}`
          : "/talent/dashboard";
      router.replace(dashboardUrl);
      router.refresh();
    } catch (err) {
      console.error("[talent-login] verifyOtp threw:", err);
      setError("Unexpected error. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function handleResend() {
    if (resending || cooldown > 0) return;
    if (step.kind !== "code") return;
    const targetEmail = step.email;
    setResending(true);
    setError(null);
    try {
      const r = await requestCode(targetEmail);
      if (r.status === 429) {
        setError("Please wait a moment before requesting another code.");
      } else if (r.ok) {
        setMessage(`We sent a new 6-digit code to ${targetEmail}.`);
        setError(null);
        // The previous code is invalidated by the new send — clear the input
        // so a stale value can't be submitted.
        setCode("");
        setCooldown(30);
      } else {
        setError("Couldn't resend the code. Please try again.");
      }
    } catch (err) {
      console.error("[talent-login] resend failed:", err);
      setError("Network error. Please try again.");
    } finally {
      setResending(false);
    }
  }

  function handleBackToEmail() {
    setStep({ kind: "email" });
    setCode("");
    setMessage(null);
    setError(null);
  }

  const reasonBanner = reason ? REASON_BANNER[reason] : null;
  // A recoverable token failure's notice takes precedence over the ?reason=
  // banner — both render through the same element below.
  const banner = notice ?? reasonBanner;
  const stepError =
    step.kind === "error" ? REASON_BANNER[step.reason] : null;

  return (
    <main className="flex min-h-screen flex-col bg-white md:flex-row">
      <aside className="hidden flex-col justify-between bg-gradient-to-br from-remotiv-purple to-remotiv-purple-light p-10 md:flex md:w-5/12 lg:w-1/2 lg:p-14">
        <div>
          <Link
            href="/"
            className="font-heading text-2xl font-bold text-white"
          >
            Remotiv.
          </Link>
          <h1 className="mt-12 font-heading text-4xl font-bold leading-tight text-white lg:text-5xl">
            Welcome back to your career.
          </h1>
          <p className="mt-4 max-w-md text-base text-white/80">
            Claim or manage your Remotiv talent profile in 3 simple steps.
          </p>
          <ol className="mt-10 flex flex-col gap-4">
            <li className="flex items-center gap-4">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white font-heading text-sm font-bold text-remotiv-purple">
                1
              </span>
              <span className="text-sm text-white/90">Enter your email</span>
            </li>
            <li className="flex items-center gap-4">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white font-heading text-sm font-bold text-remotiv-purple">
                2
              </span>
              <span className="text-sm text-white/90">
                Get a 6-digit code
              </span>
            </li>
            <li className="flex items-center gap-4">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white font-heading text-sm font-bold text-remotiv-purple">
                3
              </span>
              <span className="text-sm text-white/90">Claim your profile</span>
            </li>
          </ol>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div className="rounded-2xl border border-white/15 bg-white/10 p-4 backdrop-blur">
            <p className="font-heading text-2xl font-bold text-white">
              1,000+
            </p>
            <p className="mt-1 text-[11px] uppercase tracking-widest text-white/70">
              Talent
            </p>
          </div>
          <div className="rounded-2xl border border-white/15 bg-white/10 p-4 backdrop-blur">
            <p className="font-heading text-2xl font-bold text-white">100+</p>
            <p className="mt-1 text-[11px] uppercase tracking-widest text-white/70">
              Companies
            </p>
          </div>
          <div className="rounded-2xl border border-white/15 bg-white/10 p-4 backdrop-blur">
            <p className="font-heading text-2xl font-bold text-white">24hr</p>
            <p className="mt-1 text-[11px] uppercase tracking-widest text-white/70">
              Hiring
            </p>
          </div>
        </div>
      </aside>

      <div className="flex items-center justify-between bg-gradient-to-br from-remotiv-purple to-remotiv-purple-light px-6 py-4 md:hidden">
        <Link href="/" className="font-heading text-lg font-bold text-white">
          Remotiv.
        </Link>
        <p className="text-xs text-white/80">
          Talent Portal — Sign in to claim your profile
        </p>
      </div>

      <section className="flex flex-1 flex-col justify-center bg-[#f8f4f1] px-6 py-10 md:w-7/12 md:px-12 lg:w-1/2 lg:px-16">
        <div className="mx-auto w-full max-w-md">
          <h1 className="font-heading text-3xl font-bold text-gray-900">
            Talent Login
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            Sign in to claim or manage your profile.
          </p>

          {banner && !stepError && (
            <p
              role="status"
              aria-live="polite"
              className="mt-5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800"
            >
              {banner}
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
            <form
              onSubmit={handleEmailSubmit}
              className="mt-6 flex flex-col gap-3"
            >
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
            <form
              onSubmit={handleCodeSubmit}
              className="mt-6 flex flex-col gap-3"
            >
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
                onClick={handleResend}
                disabled={resending || cooldown > 0}
                className="text-xs text-gray-400 hover:text-gray-600 disabled:opacity-50"
              >
                {resending
                  ? "Sending…"
                  : cooldown > 0
                    ? `Resend code (${cooldown}s)`
                    : "Resend code"}
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
      </section>
    </main>
  );
}
