"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { Job } from "@/lib/jobs";
import { createClient } from "@/lib/supabase/client";

// PLACEHOLDER DATA — Phase 4.5 will wire these to real sources:
//   profileViews: query profile_views table (not yet created)
//   shortlisted: query client_batch_candidates by candidate_id
//   activity: aggregate profile_views + shortlistings + searches (table needed)
//   salaryMedian: aggregate query on talent_profiles by role_category
// Latest jobs tile is REAL (queries jobs table, status=open).

function formatJobSalary(min: number | null, max: number | null): string {
  if (min && max) {
    return `$${min.toLocaleString()} – $${max.toLocaleString()}`;
  }
  if (min) return `$${min.toLocaleString()}+`;
  if (max) return `up to $${max.toLocaleString()}`;
  return "Salary not listed";
}

function formatRelativeDate(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const d = Math.floor(ms / 86400000);
  if (d === 0) return "Today";
  if (d === 1) return "1d ago";
  if (d < 30) return `${d}d ago`;
  const m = Math.floor(d / 30);
  return m === 1 ? "1mo ago" : `${m}mo ago`;
}

export type DashboardProfile = {
  id: string;
  sourceTable: "talent_profiles" | "hire_remote_profiles";
  poolLabel: "Pakistan Talent" | "Remote Ready";
  firstName: string;
  lastName: string | null;
  email: string;
  claimedAt: string | null;
  approvedAt: string | null;
  status: string;
  matchScore: { filled: number; total: number; pct: number };
  missingHighValueFields: string[];
  raw: Record<string, unknown>;
};

function formatSalaryRange(profile: DashboardProfile): string {
  if (profile.sourceTable === "talent_profiles") {
    const min = profile.raw.salary_min as number | null;
    const max = profile.raw.salary_max as number | null;
    if (min && max) {
      return `$${min.toLocaleString()} – $${max.toLocaleString()}/mo`;
    }
    if (min) return `$${min.toLocaleString()}/mo+`;
    if (max) return `up to $${max.toLocaleString()}/mo`;
    return "Not set";
  }
  const rate = profile.raw.hourly_rate as number | null;
  if (rate) return `$${rate}/hr`;
  return "Not set";
}

function buildMissingNudge(missing: string[]): string {
  if (missing.length === 0) return "Your profile looks complete — nicely done.";
  const list =
    missing.length === 1
      ? missing[0]
      : missing.length === 2
        ? `${missing[0]} and ${missing[1]}`
        : `${missing[0]}, ${missing[1]}, and ${missing[2]}`;
  return `Add ${list} → 80%`;
}

export function DashboardClient({
  email,
  profiles,
  jobs,
}: {
  email: string;
  profiles: DashboardProfile[];
  jobs: Job[];
}) {
  const router = useRouter();
  const [activePool, setActivePool] = useState<
    DashboardProfile["sourceTable"] | null
  >(profiles[0]?.sourceTable ?? null);
  const [signingOut, setSigningOut] = useState(false);

  async function handleSignOut() {
    setSigningOut(true);
    try {
      const supabase = createClient();
      await supabase.auth.signOut();
    } catch (err) {
      console.error("[dashboard] sign out failed:", err);
    }
    router.push("/talent/login");
    router.refresh();
  }

  if (profiles.length === 0) {
    return (
      <main className="min-h-screen bg-remotiv-bg p-4 font-sans md:p-8">
        <div className="mx-auto max-w-3xl">
          <div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-white px-5 py-4">
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
              className="rounded-full border border-gray-200 bg-white px-4 py-1.5 text-xs font-semibold text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-50"
            >
              {signingOut ? "Signing out…" : "Sign out"}
            </button>
          </div>
          <div className="rounded-2xl border border-dashed border-black/10 bg-white px-6 py-12 text-center">
            <p className="font-heading text-sm font-semibold text-gray-700">
              No profile found for this email yet
            </p>
            <p className="mt-1 text-xs text-gray-400">
              If you applied with a different email, sign out and try again.
              Otherwise, your application may still be in review.
            </p>
          </div>
          <p className="mt-8 text-center text-xs text-gray-400">
            Need help? Email talent@remotiv.work
          </p>
        </div>
      </main>
    );
  }

  const activeProfile =
    profiles.find((p) => p.sourceTable === activePool) ?? profiles[0];
  const { pct } = activeProfile.matchScore;
  const missingNudge = buildMissingNudge(activeProfile.missingHighValueFields);
  const greetingName = activeProfile.firstName || "there";
  const salaryRange = formatSalaryRange(activeProfile);
  const isHourly = activeProfile.sourceTable === "hire_remote_profiles";

  return (
    <main className="min-h-screen bg-remotiv-bg p-4 font-sans md:p-8">
      <div className="mx-auto max-w-6xl">
        <header className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-white px-5 py-4 shadow-sm">
          <div className="min-w-0">
            <h1 className="font-heading text-2xl font-bold text-gray-900">
              Hey {greetingName} 👋
            </h1>
            {/* PLACEHOLDER — Phase 4.5: real "new since last visit" count */}
            <p className="text-sm text-gray-500">
              3 new things since you last checked
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {/* PLACEHOLDER — Phase 4.5: notifications bell + real badge count */}
            <button
              type="button"
              aria-label="Notifications (3 new)"
              className="relative inline-flex h-9 w-9 items-center justify-center rounded-full border border-gray-200 bg-white text-gray-600 hover:bg-gray-50"
            >
              <span aria-hidden="true">🔔</span>
              <span className="absolute -top-1 -right-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-remotiv-purple px-1 text-[10px] font-bold text-white">
                3
              </span>
            </button>
            {/* PLACEHOLDER URL — no /talent/{id} public route yet, sending to browse-talent */}
            <Link
              href="/browse-talent"
              className="inline-flex items-center gap-1 rounded-full border border-gray-200 bg-white px-3 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-50"
            >
              View public profile ↗
            </Link>
            <button
              type="button"
              onClick={handleSignOut}
              disabled={signingOut}
              className="rounded-full border border-gray-200 bg-white px-3 py-1.5 text-xs font-semibold text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-50"
            >
              {signingOut ? "Signing out…" : "Sign out"}
            </button>
          </div>
        </header>

        {profiles.length > 1 && (
          <div className="mb-4 flex flex-wrap gap-2">
            {profiles.map((p) => {
              const active = p.sourceTable === activeProfile.sourceTable;
              return (
                <button
                  key={p.sourceTable}
                  type="button"
                  onClick={() => setActivePool(p.sourceTable)}
                  className={
                    active
                      ? "rounded-full bg-remotiv-purple px-4 py-1.5 text-xs font-semibold text-white"
                      : "rounded-full border border-gray-200 bg-white px-4 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-50"
                  }
                >
                  {p.poolLabel}
                </button>
              );
            })}
          </div>
        )}

        <div className="grid grid-cols-1 gap-3 md:grid-cols-3 md:gap-3">
          {/* TILE 1 — LATEST JOBS ON REMOTIV (REAL DATA) */}
          <section className="flex flex-col rounded-2xl bg-remotiv-purple p-6 text-white md:col-span-2 md:row-span-2">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-widest text-white/70">
                  Latest jobs on Remotiv
                </p>
                <p className="mt-1 font-heading text-2xl font-bold">
                  {jobs.length}{" "}
                  {jobs.length === 1
                    ? "live opportunity"
                    : "live opportunities"}
                </p>
              </div>
              <Link
                href="/jobs"
                className="rounded-full bg-white px-3 py-1 text-xs font-bold text-remotiv-purple hover:opacity-90"
              >
                See all →
              </Link>
            </div>

            {jobs.length === 0 ? (
              <div className="flex flex-1 items-center justify-center rounded-2xl bg-white/10 p-6 text-center text-sm text-white/80">
                No live jobs right now. Check back soon.
              </div>
            ) : (
              <ul
                className="flex flex-col gap-2 overflow-y-auto pr-1"
                style={{ maxHeight: "440px" }}
              >
                {jobs.map((job) => (
                  <li
                    key={job.id}
                    className="rounded-xl bg-white/10 p-3 transition-colors hover:bg-white/15"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-heading text-sm font-bold">
                          {job.title}
                        </p>
                        <p className="text-xs text-white/80">
                          {job.company} · {job.location}
                        </p>
                        <div className="mt-2 flex flex-wrap items-center gap-1.5">
                          <span className="rounded-full bg-white/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-white">
                            {job.work_type}
                          </span>
                          <span className="rounded-full bg-white/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-white">
                            {job.contract_type}
                          </span>
                          <span className="rounded-full bg-white/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-white">
                            {job.experience_level}
                          </span>
                        </div>
                        <p className="mt-2 text-xs text-white/85">
                          {formatJobSalary(job.salary_min, job.salary_max)}
                        </p>
                      </div>
                      <div className="flex flex-col items-end gap-2">
                        <span className="text-[10px] text-white/60">
                          {formatRelativeDate(job.created_at)}
                        </span>
                        <Link
                          href="/jobs"
                          className="rounded-full bg-white px-3 py-1 text-[11px] font-bold text-remotiv-purple hover:opacity-90"
                        >
                          View →
                        </Link>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* TILE 2 — PROFILE VIEWS (PLACEHOLDER) */}
          <section className="rounded-2xl bg-remotiv-lime p-4">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-700">
              Profile views
            </p>
            <p className="mt-2 font-heading text-3xl font-bold text-gray-900">
              47
            </p>
            <p className="mt-1 text-xs text-gray-700">↑ 12 this week</p>
          </section>

          {/* TILE 3 — SHORTLISTED (PLACEHOLDER) */}
          <section className="rounded-2xl bg-remotiv-green p-4 text-white">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-white/80">
              Shortlisted
            </p>
            <p className="mt-2 font-heading text-3xl font-bold">3</p>
            <p className="mt-1 text-xs text-white/85">companies</p>
          </section>

          {/* TILE 4 — PROFILE STRENGTH (REAL DATA) */}
          <section className="relative rounded-2xl border border-black/[0.06] bg-white p-5 md:col-span-3">
            <Link
              href="/talent/dashboard/edit"
              className="absolute top-4 right-4 rounded-full bg-remotiv-purple px-3 py-1 text-xs font-bold text-white hover:opacity-90"
            >
              Edit profile
            </Link>
            <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-500">
              Profile strength
            </p>
            <p className="mt-2 font-heading text-3xl font-bold text-gray-900">
              {pct}%
            </p>
            <div className="mt-3 h-1.5 w-full rounded-full bg-black/5">
              <div
                className="h-1.5 rounded-full bg-remotiv-purple"
                style={{ width: `${pct}%` }}
                aria-hidden="true"
              />
            </div>
            <p className="mt-3 text-xs text-gray-500">{missingNudge}</p>
          </section>

          {/* TILE 5 — RECENT ACTIVITY (PLACEHOLDER) */}
          <section className="rounded-2xl border border-black/[0.06] bg-white p-5 md:col-span-3">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-500">
              Activity
            </p>
            <ul className="mt-3 flex flex-col gap-3">
              <li className="flex items-center justify-between gap-3">
                <span className="flex items-center gap-3">
                  <span
                    aria-hidden="true"
                    className="inline-block h-2 w-2 shrink-0 rounded-full bg-remotiv-purple"
                  />
                  <span className="text-sm text-gray-700">
                    TechCo viewed your profile
                  </span>
                </span>
                <span className="text-xs text-gray-400">2h ago</span>
              </li>
              <li className="flex items-center justify-between gap-3">
                <span className="flex items-center gap-3">
                  <span
                    aria-hidden="true"
                    className="inline-block h-2 w-2 shrink-0 rounded-full bg-remotiv-lime"
                  />
                  <span className="text-sm text-gray-700">
                    FinStart shortlisted you
                  </span>
                </span>
                <span className="text-xs text-gray-400">1d ago</span>
              </li>
              <li className="flex items-center justify-between gap-3">
                <span className="flex items-center gap-3">
                  <span
                    aria-hidden="true"
                    className="inline-block h-2 w-2 shrink-0 rounded-full bg-remotiv-green"
                  />
                  <span className="text-sm text-gray-700">
                    5 companies searched for React + Node
                  </span>
                </span>
                <span className="text-xs text-gray-400">3d ago</span>
              </li>
            </ul>
          </section>

          {/* TILE 6 — SALARY INSIGHTS (PLACEHOLDER median, REAL current range) */}
          <section className="rounded-2xl border border-black/[0.06] bg-white p-5 md:col-span-3">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-500">
              Talent like you earn
            </p>
            <p className="mt-2 font-heading text-2xl font-bold text-gray-900">
              {isHourly ? "$25 – $45/hr" : "$2,800 – $4,200/mo"}
            </p>
            <p className="mt-2 text-xs text-gray-500">
              Your current range: {salaryRange} ·{" "}
              <span className="text-remotiv-purple">You could ask for more</span>
            </p>
          </section>
        </div>

        <p className="mt-6 text-center text-xs text-gray-400">
          Need help? Email talent@remotiv.work
        </p>
      </div>
    </main>
  );
}
