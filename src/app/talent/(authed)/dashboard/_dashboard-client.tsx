"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, useTransition } from "react";
import type { Job } from "@/lib/jobs";
import { createClient } from "@/lib/supabase/client";
import { claimProfile } from "@/app/talent/actions";
import { TalentNotificationsBell } from "./_notifications-bell";

// PLACEHOLDER DATA — Phase 4.5 will wire these to real sources:
//   profileViews: query profile_views table (not yet created)
//   shortlisted: query client_batch_candidates by candidate_id
//   activity: aggregate profile_views + shortlistings + searches (table needed)
//   salaryMedian: aggregate query on talent_profiles by role_category
// Latest jobs tile is REAL (queries jobs table via publiclyVisible —
// status=open AND archived_at IS NULL).

// Output matches fmtSalary on the public /jobs list exactly, including the
// en-dash and the USD default: a candidate must not see one number here and a
// different one after clicking through. en-US is pinned rather than left to
// the ambient locale so the server prerender and the client agree on the
// thousands separator.
function formatJobSalary(min: number | null, max: number | null, currency: string | null): string {
  const cur = (currency ?? "").trim().toUpperCase() || "USD";
  const fmt = (n: number) => n.toLocaleString("en-US");
  if (min && max) {
    if (min === max) return `${cur} ${fmt(min)}/mo`;
    return `${cur} ${fmt(min)} – ${fmt(max)}/mo`;
  }
  if (min) return `From ${cur} ${fmt(min)}/mo`;
  if (max) return `Up to ${cur} ${fmt(max)}/mo`;
  return "Salary not disclosed";
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

type ClaimState =
  | { kind: "claimed" }
  | { kind: "claimable" }
  | { kind: "pending"; status: string };

function classifyClaimState(profile: DashboardProfile): ClaimState {
  if (profile.claimedAt) return { kind: "claimed" };
  if (profile.status === "approved") return { kind: "claimable" };
  return { kind: "pending", status: profile.status };
}

export type DashboardRecentApplication = {
  id: string;
  jobId: string;
  jobTitle: string;
  company: string | null;
  status: string;
  createdAt: string;
};

export function DashboardClient({
  email,
  profiles,
  jobs,
  unreadCount = 0,
  shortlistedCount = 0,
  recentApplications = [],
  autoClaimProfileId = null,
  autoClaimSourceTable = null,
}: {
  email: string;
  profiles: DashboardProfile[];
  jobs: Job[];
  unreadCount?: number;
  shortlistedCount?: number;
  recentApplications?: DashboardRecentApplication[];
  autoClaimProfileId?: string | null;
  autoClaimSourceTable?: "talent_profiles" | "hire_remote_profiles" | null;
}) {
  const router = useRouter();
  // Prefer a CLAIMED profile as the initial active pool. If the user has
  // both a claimed and an unclaimed profile (the cross-pool case 4.5C
  // surfaces), bento tiles should default to the one they actually own.
  const [activePool, setActivePool] = useState<
    DashboardProfile["sourceTable"] | null
  >(() => {
    const claimed = profiles.find((p) => p.claimedAt);
    return (claimed ?? profiles[0])?.sourceTable ?? null;
  });
  const [signingOut, setSigningOut] = useState(false);
  const [claimingId, setClaimingId] = useState<string | null>(null);
  const [claimError, setClaimError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const claimStates = useMemo(
    () =>
      new Map<string, ClaimState>(
        profiles.map((p) => [p.id, classifyClaimState(p)]),
      ),
    [profiles],
  );

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

  async function handleClaim(profile: DashboardProfile) {
    if (claimingId) return;
    setClaimingId(profile.id);
    setClaimError(null);
    try {
      const result = await claimProfile(profile.id, profile.sourceTable);
      if (!result.success) {
        setClaimError(result.error || "Could not claim profile.");
        return;
      }
      startTransition(() => {
        router.refresh();
      });
    } catch (err) {
      console.error("[dashboard] claim threw:", err);
      setClaimError("Could not claim profile. Please try again.");
    } finally {
      setClaimingId(null);
    }
  }

  // 5B.2 claim-after-login: when the user arrived from /talent/[id] via the
  // OTP flow, the URL carries the profile they wanted to claim. Scroll the
  // matching upsell card into view and flash a purple ring so the existing
  // "Claim →" button is the obvious next action. Silent no-op if the card
  // isn't rendered (e.g. that pool was already claimed before this session).
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only — URL params are stable for the page lifetime
  useEffect(() => {
    if (!autoClaimProfileId || !autoClaimSourceTable) return;
    const el = document.querySelector(
      `[data-upsell-pool="${autoClaimSourceTable}"]`,
    );
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.add("ring-2", "ring-remotiv-purple");
    const t = setTimeout(() => {
      el.classList.remove("ring-2", "ring-remotiv-purple");
    }, 2500);
    return () => clearTimeout(t);
  }, []);

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
  // Approved profiles drive the "View public profile" buttons in the
  // header. 0 → nothing rendered, 1 → generic single button, 2 → one
  // pool-labelled button per profile. /talent/[id] handles both pools.
  const approvedProfiles = profiles.filter((p) => p.approvedAt);
  const { pct } = activeProfile.matchScore;
  const missingNudge = buildMissingNudge(activeProfile.missingHighValueFields);
  const greetingName = activeProfile.firstName || "there";
  const salaryRange = formatSalaryRange(activeProfile);
  const isHourly = activeProfile.sourceTable === "hire_remote_profiles";
  const memberSinceLabel = (() => {
    const ts = activeProfile.claimedAt ?? activeProfile.approvedAt;
    if (!ts) return "Recently";
    return formatRelativeDate(ts);
  })();

  return (
    <main className="min-h-screen bg-remotiv-bg p-4 font-sans md:p-8">
      <div className="mx-auto max-w-6xl">
        <header className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-white px-5 py-4 shadow-sm">
          <div className="min-w-0">
            <h1 className="font-heading text-2xl font-bold text-gray-900">
              Hey {greetingName} 👋
            </h1>
            {unreadCount > 0 && (
              <p className="text-sm text-gray-500">
                {unreadCount} new update{unreadCount === 1 ? "" : "s"} since you
                last checked
              </p>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <TalentNotificationsBell />
            <Link
              href="/talent/dashboard/edit"
              className="inline-flex items-center gap-1 rounded-full bg-remotiv-purple px-3 py-1.5 text-xs font-bold text-white hover:opacity-90"
            >
              Edit profile
            </Link>
            {approvedProfiles.length === 1 && (
              <Link
                href={`/talent/${approvedProfiles[0].id}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 rounded-full border border-gray-200 bg-white px-3 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-50"
              >
                View public profile ↗
              </Link>
            )}
            {approvedProfiles.length >= 2 &&
              approvedProfiles.map((p) => (
                <Link
                  key={p.id}
                  href={`/talent/${p.id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 rounded-full border border-gray-200 bg-white px-3 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-50"
                >
                  {p.sourceTable === "talent_profiles"
                    ? "View Pakistan profile ↗"
                    : "View Remote profile ↗"}
                </Link>
              ))}
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

        {activeProfile && claimStates.get(activeProfile.id)?.kind === "claimable" && (
          <section
            data-upsell-pool={activeProfile.sourceTable}
            className="mb-6 rounded-2xl border border-remotiv-purple/20 bg-remotiv-purple/5 p-5 md:p-6"
          >
            <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
              <div className="min-w-0 flex-1">
                <h2 className="font-heading text-lg font-bold text-gray-900 md:text-xl">
                  Claim your profile to get noticed by more companies
                </h2>
                <p className="mt-2 text-sm leading-relaxed text-gray-600 md:text-[15px]">
                  Companies prefer verified profiles. Claim yours to edit your info, get shortlist notifications, and stand out.
                </p>
              </div>
              <button
                type="button"
                onClick={() => handleClaim(activeProfile)}
                disabled={claimingId === activeProfile.id}
                className="shrink-0 rounded-full bg-remotiv-purple px-6 py-3 text-sm font-bold text-white hover:opacity-90 disabled:opacity-50"
              >
                {claimingId === activeProfile.id ? "Claiming…" : "Claim now →"}
              </button>
            </div>
          </section>
        )}

        {profiles.length > 0 && (
          <div className="mb-4 flex flex-wrap gap-2">
            {profiles.map((p) => {
              const active = p.sourceTable === activeProfile.sourceTable;
              const state = claimStates.get(p.id);
              const isPending = state?.kind === "pending";
              const isClaimed = state?.kind === "claimed";
              return (
                <div
                  key={p.sourceTable}
                  className="flex items-center gap-2"
                >
                  <button
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
                  {isPending && (
                    <span className="rounded-full bg-gray-100 px-3 py-1.5 text-[11px] font-semibold text-gray-600">
                      Awaiting approval
                    </span>
                  )}
                  {isClaimed && (
                    <span className="rounded-full bg-remotiv-green/15 px-3 py-1.5 text-[11px] font-semibold text-remotiv-green">
                      ✓ Claimed
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {(() => {
          const claimedProfiles = profiles.filter((p) => p.claimedAt);
          const unclaimedProfiles = profiles.filter((p) => !p.claimedAt);
          const hasClaimedTalent = claimedProfiles.some(
            (p) => p.sourceTable === "talent_profiles",
          );
          const hasClaimedRemote = claimedProfiles.some(
            (p) => p.sourceTable === "hire_remote_profiles",
          );
          const showUpsell = !(hasClaimedTalent && hasClaimedRemote);
          if (!showUpsell) return null;

          // Pick the "missing" pool. When the user has nothing claimed yet,
          // default to nudging Pakistan Talent first (matches existing 4.5A
          // copy ordering).
          const missingPool: DashboardProfile["sourceTable"] = hasClaimedTalent
            ? "hire_remote_profiles"
            : hasClaimedRemote
              ? "talent_profiles"
              : profiles[0]?.sourceTable === "talent_profiles"
                ? "hire_remote_profiles"
                : "talent_profiles";
          const unclaimedInMissing =
            unclaimedProfiles.find((p) => p.sourceTable === missingPool) ??
            null;
          const label =
            missingPool === "talent_profiles"
              ? "Pakistan Talent"
              : "Hire Remote";
          const intakePath =
            missingPool === "talent_profiles"
              ? "/join-as-talent"
              : "/join-as-freelancer";

          if (unclaimedInMissing && unclaimedInMissing.status === "approved") {
            return (
              <section
                data-upsell-pool={missingPool}
                className="mb-6 rounded-2xl border border-remotiv-purple/20 bg-remotiv-purple/5 p-4"
              >
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <p className="font-heading text-sm font-bold text-gray-900">
                      Claim your {label} profile
                    </p>
                    <p className="mt-1 text-xs text-gray-500">
                      You have a {label} profile waiting. Claim it to see it
                      on your dashboard.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleClaim(unclaimedInMissing)}
                    disabled={claimingId === unclaimedInMissing.id}
                    className="shrink-0 rounded-full bg-remotiv-purple px-4 py-2 text-xs font-bold text-white hover:opacity-90 disabled:opacity-50"
                  >
                    {claimingId === unclaimedInMissing.id
                      ? "Claiming…"
                      : "Claim profile →"}
                  </button>
                </div>
              </section>
            );
          }

          if (unclaimedInMissing) {
            return (
              <section
                data-upsell-pool={missingPool}
                className="mb-6 rounded-2xl border border-gray-200 bg-gray-50 p-4"
              >
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <p className="font-heading text-sm font-bold text-gray-900">
                      Your {label} profile is under review
                    </p>
                    <p className="mt-1 text-xs text-gray-500">
                      An admin will review it shortly. We'll notify you when
                      it's live.
                    </p>
                  </div>
                  <span className="shrink-0 rounded-full bg-gray-200 px-3 py-1 text-[11px] font-semibold text-gray-700">
                    Awaiting approval
                  </span>
                </div>
              </section>
            );
          }

          return (
            <section
              data-upsell-pool={missingPool}
              className="mb-6 rounded-2xl border border-remotiv-purple/20 bg-remotiv-purple/5 p-4"
            >
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <p className="font-heading text-sm font-bold text-gray-900">
                    Add your {label} profile
                  </p>
                  <p className="mt-1 text-xs text-gray-500">
                    One account, two pools. Add your other profile to reach
                    more clients.
                  </p>
                </div>
                <Link
                  href={intakePath}
                  className="shrink-0 rounded-full bg-remotiv-purple px-4 py-2 text-xs font-bold text-white hover:opacity-90"
                >
                  Add profile →
                </Link>
              </div>
            </section>
          );
        })()}

        {claimError && (
          <div className="mb-4 rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-700">
            {claimError}
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
                          {formatJobSalary(
                            job.salary_min,
                            job.salary_max,
                            job.salary_currency,
                          )}
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

          {/* TILE 2 — MEMBER SINCE (REAL DATA: claimed_at) */}
          <section className="rounded-2xl bg-remotiv-lime p-4">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-700">
              Member since
            </p>
            <p className="mt-2 font-heading text-3xl font-bold text-gray-900">
              {memberSinceLabel}
            </p>
            <p className="mt-1 text-xs text-gray-700">
              You've been on Remotiv for a while
            </p>
          </section>

          {/* TILE 3 — SHORTLISTED (REAL: client_batch_candidates count) */}
          <section className="rounded-2xl bg-remotiv-green p-4 text-white">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-white/80">
              Shortlisted
            </p>
            <p className="mt-2 font-heading text-3xl font-bold">
              {shortlistedCount}
            </p>
            <p className="mt-1 text-xs text-white/85">
              {shortlistedCount === 0
                ? "Be the next to be shortlisted"
                : shortlistedCount === 1
                  ? "company has you in mind"
                  : "companies have you in mind"}
            </p>
          </section>

          {/* TILE 4 — PROFILE STRENGTH (REAL DATA) */}
          <section className="relative rounded-2xl border border-black/[0.06] bg-white p-5 md:col-span-3">
            {activeProfile.claimedAt ? (
              <Link
                href="/talent/dashboard/edit"
                className="absolute top-4 right-4 rounded-full bg-remotiv-purple px-3 py-1 text-xs font-bold text-white hover:opacity-90"
              >
                Edit profile
              </Link>
            ) : (
              <span className="absolute top-4 right-4 rounded-full bg-gray-100 px-3 py-1 text-[11px] font-semibold text-gray-500">
                Claim to edit
              </span>
            )}
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

          {/* TILE 5 — RECENT APPLICATIONS (REAL DATA, Pakistan via email) */}
          {recentApplications.length > 0 && (
            <section className="rounded-2xl border border-black/[0.06] bg-white p-5 md:col-span-3">
              <div className="flex items-center justify-between">
                <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-500">
                  Recent applications
                </p>
                <Link
                  href="/jobs"
                  className="text-xs font-semibold text-remotiv-purple hover:underline"
                >
                  Browse jobs →
                </Link>
              </div>
              <ul className="mt-3 space-y-2">
                {recentApplications.map((app) => (
                  <li
                    key={app.id}
                    className="flex items-center justify-between gap-3"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-gray-900">
                        {app.jobTitle}
                      </p>
                      {app.company && (
                        <p className="truncate text-xs text-gray-500">
                          {app.company}
                        </p>
                      )}
                    </div>
                    <span className="shrink-0 rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-gray-600">
                      {app.status}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

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
