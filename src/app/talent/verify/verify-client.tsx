"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

type VerifyState =
  | { kind: "verifying" }
  | { kind: "error"; message: string };

export function TalentVerifyClient() {
  const router = useRouter();
  const [state, setState] = useState<VerifyState>({ kind: "verifying" });

  useEffect(() => {
    let cancelled = false;

    async function handleVerify() {
      // Supabase puts session tokens in the URL hash after a successful magic
      // link verify: #access_token=...&refresh_token=...&expires_in=...&token_type=bearer
      // Hash is client-only — server components cannot read it.
      const hash = window.location.hash.startsWith("#")
        ? window.location.hash.slice(1)
        : window.location.hash;

      if (!hash) {
        // Could also be an error redirect from Supabase: ?error=...&error_description=...
        const params = new URLSearchParams(window.location.search);
        const err = params.get("error_description") ?? params.get("error");
        setState({
          kind: "error",
          message: err ?? "No session received from the verify link.",
        });
        return;
      }

      const params = new URLSearchParams(hash);
      const accessToken = params.get("access_token");
      const refreshToken = params.get("refresh_token");

      if (!accessToken || !refreshToken) {
        setState({
          kind: "error",
          message: "Verify link is missing required session tokens.",
        });
        return;
      }

      try {
        const supabase = createClient();
        const { error } = await supabase.auth.setSession({
          access_token: accessToken,
          refresh_token: refreshToken,
        });
        if (cancelled) return;
        if (error) {
          console.error("[talent/verify] setSession failed:", error);
          setState({ kind: "error", message: error.message });
          return;
        }
        // Session cookie is now written. Forward to the dashboard.
        // Use router.replace (not push) so the verify URL isn't in browser
        // history. router.refresh forces the server layout to re-read the
        // newly-set auth cookie.
        router.replace("/talent/dashboard");
        router.refresh();
      } catch (e) {
        if (cancelled) return;
        console.error("[talent/verify] threw:", e);
        setState({
          kind: "error",
          message: "Unexpected error verifying link.",
        });
      }
    }

    handleVerify();
    return () => {
      cancelled = true;
    };
  }, [router]);

  if (state.kind === "error") {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[#f8f4f1] px-4">
        <div className="w-full max-w-md rounded-2xl border border-red-200 bg-red-50 p-6 text-sm text-red-700">
          <p className="font-heading text-base font-bold text-red-800">
            We couldn't verify your link
          </p>
          <p className="mt-2">{state.message}</p>
          <Link
            href="/talent/login"
            className="mt-4 inline-block rounded-lg bg-remotiv-purple px-4 py-2 text-xs font-bold text-white"
          >
            Back to login →
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-[#f8f4f1] px-4">
      <div className="rounded-2xl border border-black/[0.06] bg-white p-8 text-sm text-gray-700 shadow-sm">
        Signing you in…
      </div>
    </main>
  );
}
