"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { updateTalentBasicInfo } from "./actions";

export type EditableProfile = {
  id: string;
  sourceTable: "talent_profiles" | "hire_remote_profiles";
  poolLabel: "Pakistan Talent" | "Remote Ready";
  firstName: string;
  lastName: string | null;
  phone: string | null;
  linkedinUrl: string | null;
  email: string;
  matchScore: { filled: number; total: number; pct: number };
  raw: Record<string, unknown>;
};

type SectionKey =
  | "basic"
  | "location"
  | "professional"
  | "availability"
  | "skills"
  | "cv";

const INPUT_CLASS =
  "rounded-xl border border-gray-200 bg-white px-4 py-2.5 text-sm outline-none ring-remotiv-purple/30 focus:border-remotiv-purple focus:ring-2";

const LABEL_CLASS =
  "text-[10px] font-semibold uppercase tracking-widest text-gray-500";

function ChevronRightIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="currentColor"
    >
      <path d="M5.5 2.5L11 8l-5.5 5.5L4 12l4-4-4-4 1.5-1.5z" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      width="12"
      height="12"
      fill="currentColor"
    >
      <path d="M8 1.5a3 3 0 00-3 3V6H4a1 1 0 00-1 1v6.5A1.5 1.5 0 004.5 15h7a1.5 1.5 0 001.5-1.5V7a1 1 0 00-1-1h-1V4.5a3 3 0 00-3-3zm-1.5 3a1.5 1.5 0 013 0V6h-3V4.5z" />
    </svg>
  );
}

function basicInfoFilledCount(p: EditableProfile): number {
  let n = 0;
  if (p.firstName.trim()) n += 1;
  if (p.lastName?.trim()) n += 1;
  if (p.phone?.trim()) n += 1;
  if (p.linkedinUrl?.trim()) n += 1;
  return n;
}

function basicInfoBadgeClass(count: number): string {
  if (count === 4) return "bg-green-100 text-green-700";
  if (count === 0) return "bg-red-100 text-red-700";
  return "bg-amber-100 text-amber-800";
}

function basicInfoBadgeLabel(count: number): string {
  if (count === 4) return "Complete";
  if (count === 0) return "Empty";
  return `${count} of 4 filled`;
}

export function EditClient({
  email,
  profiles,
}: {
  email: string;
  profiles: EditableProfile[];
}) {
  const router = useRouter();
  const [activePool, setActivePool] = useState<
    EditableProfile["sourceTable"] | null
  >(profiles[0]?.sourceTable ?? null);
  const [openSections, setOpenSections] = useState<Set<SectionKey>>(new Set());
  const [signingOut, setSigningOut] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const activeProfile =
    profiles.find((p) => p.sourceTable === activePool) ?? profiles[0] ?? null;

  // Local form state for the Basic Info section. Resets whenever the active
  // profile changes so the right row's values are shown after a tab switch.
  const [basicFirstName, setBasicFirstName] = useState("");
  const [basicLastName, setBasicLastName] = useState("");
  const [basicPhone, setBasicPhone] = useState("");
  const [basicLinkedin, setBasicLinkedin] = useState("");
  const [basicErrors, setBasicErrors] = useState<{
    firstName?: string;
    lastName?: string;
    phone?: string;
    linkedinUrl?: string;
  }>({});
  const [basicSaving, setBasicSaving] = useState(false);
  const [basicSnapshot, setBasicSnapshot] = useState<{
    firstName: string;
    lastName: string;
    phone: string;
    linkedin: string;
  } | null>(null);

  useEffect(() => {
    if (!activeProfile) {
      setBasicFirstName("");
      setBasicLastName("");
      setBasicPhone("");
      setBasicLinkedin("");
      setBasicSnapshot(null);
      return;
    }
    const next = {
      firstName: activeProfile.firstName ?? "",
      lastName: activeProfile.lastName ?? "",
      phone: activeProfile.phone ?? "",
      linkedin: activeProfile.linkedinUrl ?? "",
    };
    setBasicFirstName(next.firstName);
    setBasicLastName(next.lastName);
    setBasicPhone(next.phone);
    setBasicLinkedin(next.linkedin);
    setBasicSnapshot(next);
    setBasicErrors({});
  }, [activeProfile]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2500);
    return () => clearTimeout(t);
  }, [toast]);

  function toggleSection(key: SectionKey) {
    setOpenSections((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function handleSignOut() {
    setSigningOut(true);
    try {
      const supabase = createClient();
      await supabase.auth.signOut();
    } catch (err) {
      console.error("[edit] sign out failed:", err);
    }
    router.push("/talent/login");
    router.refresh();
  }

  function handleBasicCancel() {
    if (!basicSnapshot) return;
    setBasicFirstName(basicSnapshot.firstName);
    setBasicLastName(basicSnapshot.lastName);
    setBasicPhone(basicSnapshot.phone);
    setBasicLinkedin(basicSnapshot.linkedin);
    setBasicErrors({});
  }

  async function handleBasicSave() {
    if (!activeProfile) return;
    const errors: typeof basicErrors = {};
    const fn = basicFirstName.trim();
    const ln = basicLastName.trim();
    const phoneRaw = basicPhone.trim();
    const linkRaw = basicLinkedin.trim();
    if (!fn) errors.firstName = "First name is required.";
    else if (fn.length > 80) errors.firstName = "Must be 80 characters or fewer.";
    if (!ln) errors.lastName = "Last name is required.";
    else if (ln.length > 80) errors.lastName = "Must be 80 characters or fewer.";
    if (phoneRaw && phoneRaw.length < 7) {
      errors.phone = "Phone number looks too short.";
    }
    if (linkRaw && !linkRaw.toLowerCase().includes("linkedin.com")) {
      errors.linkedinUrl = "Use your linkedin.com URL.";
    }
    setBasicErrors(errors);
    if (Object.keys(errors).length > 0) return;

    setBasicSaving(true);
    try {
      const result = await updateTalentBasicInfo({
        profileId: activeProfile.id,
        sourceTable: activeProfile.sourceTable,
        firstName: fn,
        lastName: ln,
        phone: phoneRaw || null,
        linkedinUrl: linkRaw || null,
      });
      if (!result.success) {
        setToast(result.error || "Couldn't save — try again.");
        return;
      }
      const saved = result.data;
      setBasicFirstName(saved.firstName);
      setBasicLastName(saved.lastName);
      setBasicPhone(saved.phone ?? "");
      setBasicLinkedin(saved.linkedinUrl ?? "");
      setBasicSnapshot({
        firstName: saved.firstName,
        lastName: saved.lastName,
        phone: saved.phone ?? "",
        linkedin: saved.linkedinUrl ?? "",
      });
      setToast("Saved");
      router.refresh();
    } catch (err) {
      console.error("[edit] basic save threw:", err);
      setToast("Couldn't save — try again.");
    } finally {
      setBasicSaving(false);
    }
  }

  if (!activeProfile) {
    return (
      <main className="min-h-screen bg-remotiv-bg p-4 font-sans md:p-8">
        <div className="mx-auto max-w-3xl">
          <div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-white px-5 py-4">
            <div>
              <p className="text-xs text-gray-400">Signed in as {email}</p>
              <h1 className="font-heading text-2xl font-bold text-gray-900">
                Edit your profile
              </h1>
            </div>
            <button
              type="button"
              onClick={handleSignOut}
              disabled={signingOut}
              className="rounded-full border border-gray-200 bg-white px-4 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50"
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
        </div>
      </main>
    );
  }

  const completePct = activeProfile.matchScore.pct;
  const basicCount = basicInfoFilledCount(activeProfile);
  const rawSummary = (activeProfile.raw.summary as string | null) ?? null;
  const rawRoleCategory =
    (activeProfile.raw.role_category as string | null) ?? null;
  const showBoostBadge = !rawSummary?.trim() || !rawRoleCategory?.trim();

  const sections: Array<{
    key: SectionKey;
    title: string;
    badge: { className: string; label: string };
  }> = [
    {
      key: "basic",
      title: "Basic info",
      badge: {
        className: basicInfoBadgeClass(basicCount),
        label: basicInfoBadgeLabel(basicCount),
      },
    },
    {
      key: "location",
      title: "Location",
      badge: { className: "bg-gray-100 text-gray-600", label: "Coming soon" },
    },
    {
      key: "professional",
      title: "Professional details",
      badge: showBoostBadge
        ? { className: "bg-amber-100 text-amber-800", label: "Boost score" }
        : { className: "bg-gray-100 text-gray-600", label: "Coming soon" },
    },
    {
      key: "availability",
      title: "Availability & salary",
      badge: { className: "bg-gray-100 text-gray-600", label: "Coming soon" },
    },
    {
      key: "skills",
      title: "Skills & experience",
      badge: { className: "bg-gray-100 text-gray-600", label: "Coming soon" },
    },
    {
      key: "cv",
      title: "CV & photo",
      badge: { className: "bg-gray-100 text-gray-600", label: "Locked" },
    },
  ];

  return (
    <main className="min-h-screen bg-remotiv-bg p-4 font-sans md:p-8">
      <div className="mx-auto max-w-4xl">
        <header className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-white px-5 py-4 shadow-sm">
          <Link
            href="/talent/dashboard"
            className="inline-flex items-center gap-1 text-sm font-semibold text-gray-700 hover:text-gray-900"
          >
            <span aria-hidden="true">←</span>
            Back to dashboard
          </Link>
          <div className="flex flex-wrap items-center gap-2">
            {/* PLACEHOLDER — real "last saved" timestamp comes in a later phase */}
            <span className="hidden text-xs text-gray-400 md:inline">
              Last saved just now
            </span>
            <span className="inline-flex items-center gap-1 rounded-full bg-remotiv-purple px-3 py-1 text-xs font-bold text-white">
              {completePct}% complete
            </span>
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

        {sections.map((section) => {
          const isOpen = openSections.has(section.key);
          return (
            <section
              key={section.key}
              className="mb-3 overflow-hidden rounded-2xl border border-black/[0.06] bg-white"
            >
              <button
                type="button"
                onClick={() => toggleSection(section.key)}
                className="flex w-full items-center justify-between gap-3 px-5 py-4 text-left hover:bg-gray-50"
                aria-expanded={isOpen}
                aria-controls={`section-${section.key}`}
              >
                <span className="flex min-w-0 items-center gap-3">
                  <span
                    aria-hidden="true"
                    className={
                      isOpen
                        ? "inline-flex rotate-90 text-gray-400 transition-transform"
                        : "inline-flex text-gray-400 transition-transform"
                    }
                  >
                    <ChevronRightIcon />
                  </span>
                  <span className="font-heading text-base font-semibold text-gray-900">
                    {section.title}
                  </span>
                </span>
                <span
                  className={`inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-semibold ${section.badge.className}`}
                >
                  {section.key === "cv" && <LockIcon />}
                  {section.badge.label}
                </span>
              </button>

              {isOpen && (
                <div
                  id={`section-${section.key}`}
                  className="border-t border-black/[0.06] px-5 py-5"
                >
                  {section.key === "basic" && (
                    <div>
                      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                        <label className="flex flex-col gap-1.5">
                          <span className={LABEL_CLASS}>First name</span>
                          <input
                            type="text"
                            value={basicFirstName}
                            onChange={(e) => setBasicFirstName(e.target.value)}
                            maxLength={80}
                            aria-invalid={Boolean(basicErrors.firstName)}
                            className={INPUT_CLASS}
                          />
                          {basicErrors.firstName && (
                            <span className="text-xs text-red-600">
                              {basicErrors.firstName}
                            </span>
                          )}
                        </label>
                        <label className="flex flex-col gap-1.5">
                          <span className={LABEL_CLASS}>Last name</span>
                          <input
                            type="text"
                            value={basicLastName}
                            onChange={(e) => setBasicLastName(e.target.value)}
                            maxLength={80}
                            aria-invalid={Boolean(basicErrors.lastName)}
                            className={INPUT_CLASS}
                          />
                          {basicErrors.lastName && (
                            <span className="text-xs text-red-600">
                              {basicErrors.lastName}
                            </span>
                          )}
                        </label>
                        <label className="flex flex-col gap-1.5">
                          <span className={LABEL_CLASS}>Phone</span>
                          <input
                            type="tel"
                            value={basicPhone}
                            onChange={(e) => setBasicPhone(e.target.value)}
                            maxLength={40}
                            placeholder="+92 300 0000000"
                            aria-invalid={Boolean(basicErrors.phone)}
                            className={INPUT_CLASS}
                          />
                          {basicErrors.phone && (
                            <span className="text-xs text-red-600">
                              {basicErrors.phone}
                            </span>
                          )}
                        </label>
                        <label className="flex flex-col gap-1.5">
                          <span className={LABEL_CLASS}>LinkedIn URL</span>
                          <input
                            type="url"
                            value={basicLinkedin}
                            onChange={(e) => setBasicLinkedin(e.target.value)}
                            maxLength={300}
                            placeholder="linkedin.com/in/yourname"
                            aria-invalid={Boolean(basicErrors.linkedinUrl)}
                            className={INPUT_CLASS}
                          />
                          {basicErrors.linkedinUrl && (
                            <span className="text-xs text-red-600">
                              {basicErrors.linkedinUrl}
                            </span>
                          )}
                        </label>
                      </div>
                      <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
                        <button
                          type="button"
                          onClick={handleBasicCancel}
                          disabled={basicSaving}
                          className="rounded-full border border-gray-200 bg-white px-4 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          onClick={handleBasicSave}
                          disabled={basicSaving}
                          className="rounded-full bg-remotiv-purple px-4 py-1.5 text-xs font-bold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                        >
                          {basicSaving ? "Saving…" : "Save changes"}
                        </button>
                      </div>
                    </div>
                  )}

                  {section.key === "location" && (
                    <p className="text-sm text-gray-500">
                      Coming in the next prompt (4.2B).
                    </p>
                  )}

                  {section.key === "professional" && (
                    <p className="text-sm text-gray-500">
                      Coming in the next prompt (4.2B).
                    </p>
                  )}

                  {section.key === "availability" && (
                    <p className="text-sm text-gray-500">
                      Coming in the next prompt (4.2B).
                    </p>
                  )}

                  {section.key === "skills" && (
                    <p className="text-sm text-gray-500">
                      Coming in the next prompt (4.2B).
                    </p>
                  )}

                  {section.key === "cv" && (
                    <div className="flex items-center justify-between">
                      <p className="text-sm text-gray-500">
                        File uploads come in Phase 4.3.
                      </p>
                      <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-3 py-1 text-xs font-semibold text-gray-600">
                        <LockIcon />
                        Locked
                      </span>
                    </div>
                  )}
                </div>
              )}
            </section>
          );
        })}

        <p className="mt-6 text-center text-xs text-gray-400">
          Need help? Email talent@remotiv.work
        </p>
      </div>

      {toast && (
        <div
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className="fixed bottom-6 right-6 z-50 flex items-center gap-2.5 rounded-xl bg-gray-900 px-4 py-3 text-sm font-medium text-white shadow-xl"
        >
          {toast}
        </div>
      )}
    </main>
  );
}
