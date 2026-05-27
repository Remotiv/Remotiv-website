"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

const REASON_BANNER: Record<string, string> = {
  unauthorized: "Please sign in to access the talent dashboard.",
  expired: "Your invite link has expired. Enter your email below to get a new one.",
  invalid: "We couldn't recognise that invite link. Enter your email below to continue.",
  already_claimed:
    "This profile is already claimed. If that's not you, contact talent@remotiv.work.",
  email_conflict:
    "This email is already registered as a client or admin. Please use a different email or contact support.",
};

type TokenState =
  | { kind: "idle" }
  | { kind: "verifying" }
  | { kind: "ok"; email: string; firstName: string | null }
  | { kind: "error"; reason: string };

type SendState =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "sent"; message: string }
  | { kind: "error"; message: string };

export function TalentLoginClient({
  token,
  reason,
}: {
  token: string | null;
  reason: string | null;
}) {
  const [tokenState, setTokenState] = useState<TokenState>(
    token ? { kind: "verifying" } : { kind: "idle" },
  );
  const [email, setEmail] = useState("");
  const [sendState, setSendState] = useState<SendState>({ kind: "idle" });

  // Verify the invite token (if present). On success, redirect to the
  // Supabase magic-link URL which lands at /auth/callback?next=/talent/dashboard.
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
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
          firstName?: string | null;
          actionLink?: string;
        };
        if (cancelled) return;
        if (json.ok && json.actionLink) {
          setTokenState({
            kind: "ok",
            email: json.email ?? "",
            firstName: json.firstName ?? null,
          });
          // Hard navigation: Supabase magic-link URLs need a full document
          // load to set their auth cookies, not a client-side router.push.
          window.location.href = json.actionLink;
          return;
        }
        setTokenState({ kind: "error", reason: json.reason ?? "invalid" });
      } catch (e) {
        if (cancelled) return;
        console.error("[talent-login] verify failed:", e);
        setTokenState({ kind: "error", reason: "invalid" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const handleSendOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    setSendState({ kind: "sending" });
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
        error?: string;
      };
      if (json.ok) {
        setSendState({
          kind: "sent",
          message:
            json.message ??
            "If we found a matching profile, you'll receive an email shortly.",
        });
        return;
      }
      if (json.reason === "email_conflict") {
        setSendState({
          kind: "error",
          message:
            "This email is already registered as a client or admin. Please use a different email or contact support.",
        });
        return;
      }
      setSendState({
        kind: "error",
        message: json.error ?? "Something went wrong. Please try again.",
      });
    } catch (err) {
      console.error("[talent-login] initiate failed:", err);
      setSendState({
        kind: "error",
        message: "Network error. Please try again.",
      });
    }
  };

  // Show only the verifying spinner while a token-verify is in flight.
  if (tokenState.kind === "verifying") {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[#f8f4f1] px-4">
        <div className="rounded-2xl border border-black/[0.06] bg-white p-8 text-sm text-gray-600 shadow-sm">
          Verifying your invite link…
        </div>
      </main>
    );
  }

  // After a successful verify we redirect via window.location.href — but the
  // browser may take a moment, so render an inline confirmation.
  if (tokenState.kind === "ok") {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[#f8f4f1] px-4">
        <div className="rounded-2xl border border-black/[0.06] bg-white p-8 text-sm text-gray-700 shadow-sm">
          Signing you in…
        </div>
      </main>
    );
  }

  const tokenError =
    tokenState.kind === "error" ? REASON_BANNER[tokenState.reason] : null;
  const reasonBanner = reason ? REASON_BANNER[reason] : null;

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

        {reasonBanner && !tokenError && (
          <p
            role="status"
            aria-live="polite"
            className="mt-5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800"
          >
            {reasonBanner}
          </p>
        )}
        {tokenError && (
          <p
            role="alert"
            aria-live="assertive"
            className="mt-5 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
          >
            {tokenError}
          </p>
        )}

        {/* Email entry form — used both for the no-token self-service flow and
            for the post-token retry when the invite was invalid/expired. We
            hide it only on already_claimed, where there's nothing to retry. */}
        {tokenState.kind !== "error" || tokenState.reason !== "already_claimed" ? (
          <form onSubmit={handleSendOtp} className="mt-6 flex flex-col gap-3">
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
              autoComplete="email"
              className="w-full rounded-xl border border-gray-200 px-4 py-3 text-sm text-gray-800 outline-none focus:border-remotiv-purple focus:ring-2 focus:ring-remotiv-purple/20"
            />
            <button
              type="submit"
              disabled={sendState.kind === "sending"}
              aria-busy={sendState.kind === "sending"}
              className="mt-1 w-full rounded-xl bg-remotiv-purple py-3 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-60"
            >
              {sendState.kind === "sending"
                ? "Sending…"
                : "Send me a login link"}
            </button>

            {sendState.kind === "sent" && (
              <p
                role="status"
                aria-live="polite"
                className="rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800"
              >
                {sendState.message}
              </p>
            )}
            {sendState.kind === "error" && (
              <p
                role="alert"
                aria-live="assertive"
                className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
              >
                {sendState.message}
              </p>
            )}
          </form>
        ) : null}

        <p className="mt-6 text-center text-xs text-gray-400">
          Trouble signing in? Email talent@remotiv.work
        </p>
      </div>
    </main>
  );
}
