"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { claimProfile } from "@/app/talent/actions";

export type DashboardProfile = {
  id: string;
  sourceTable: "talent_profiles" | "hire_remote_profiles";
  poolLabel: string;
  firstName: string;
  lastName: string;
  email: string;
  claimedAt: string | null;
};

export function DashboardClient({
  email,
  profiles,
}: {
  email: string;
  profiles: DashboardProfile[];
}) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);

  async function handleClaim(profile: DashboardProfile) {
    setBusyId(profile.id);
    setError(null);
    try {
      const result = await claimProfile(profile.id, profile.sourceTable);
      if (!result.success) {
        setError(result.error ?? "Failed to claim profile");
      } else {
        // page.tsx will re-render via revalidatePath; router.refresh forces
        // the client to re-fetch the new claimed_at.
        router.refresh();
      }
    } catch (err) {
      console.error("[handleClaim] threw:", err);
      setError("Failed to claim profile");
    } finally {
      setBusyId(null);
    }
  }

  async function handleSignOut() {
    setSigningOut(true);
    try {
      const supabase = createClient();
      await supabase.auth.signOut();
    } catch (err) {
      console.error("[handleSignOut] threw:", err);
    }
    router.push("/talent/login");
    router.refresh();
  }

  return (
    <main className="min-h-screen bg-[#f8f4f1] px-4 py-10">
      <div className="mx-auto max-w-3xl">
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs text-gray-400">Signed in as {email}</p>
            <h1 className="font-heading text-2xl font-bold text-gray-900">
              Welcome to your Talent Dashboard
            </h1>
          </div>
          <button
            type="button"
            onClick={handleSignOut}
            disabled={signingOut}
            className="rounded-xl border border-gray-200 bg-white px-4 py-2 text-sm font-semibold text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-50"
          >
            {signingOut ? "Signing out…" : "Sign out"}
          </button>
        </div>

        {error && (
          <p
            role="alert"
            aria-live="assertive"
            className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
          >
            {error}
          </p>
        )}

        {profiles.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-black/10 bg-white px-6 py-12 text-center">
            <p className="font-heading text-sm font-semibold text-gray-700">
              No profile found for this email yet
            </p>
            <p className="mt-1 text-xs text-gray-400">
              If you applied with a different email, sign out and try again.
              Otherwise, your application may still be in review.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {profiles.map((p) => {
              const fullName = `${p.firstName} ${p.lastName}`.trim() || p.email;
              const isClaimed = Boolean(p.claimedAt);
              const isBusy = busyId === p.id;
              return (
                <div
                  key={`${p.sourceTable}:${p.id}`}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-black/[0.06] bg-white px-5 py-4 shadow-sm"
                >
                  <div className="min-w-0">
                    <p className="font-heading text-base font-bold text-gray-900">
                      {fullName}
                    </p>
                    <p className="text-xs text-gray-500">{p.poolLabel}</p>
                  </div>
                  {isClaimed ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-3 py-1 text-xs font-semibold text-green-700">
                      ✓ Claimed
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => handleClaim(p)}
                      disabled={isBusy}
                      aria-busy={isBusy || undefined}
                      className="rounded-xl bg-remotiv-purple px-4 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-60"
                    >
                      {isBusy ? "Claiming…" : "Claim this profile"}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <p className="mt-8 text-center text-xs text-gray-400">
          Need help? Email talent@remotiv.work
        </p>
      </div>
    </main>
  );
}
