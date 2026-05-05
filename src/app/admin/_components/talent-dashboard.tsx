"use client";

// AVATARS: We always recompute avatar URL via getAvatarUrl(first, last) at
// render time instead of trusting profile.avatar_url, because legacy DB
// rows may contain broken URL formats from older insert paths
// (e.g. "/avatars/male 1.png" with spaces — those files don't exist on
// disk; only the dash + zero-padded format does). Reader is self-healing.

import { useState, useEffect, useMemo } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import {
  Search as SearchIcon,
  X,
  MapPin,
  Mail,
  Phone,
  Briefcase,
  CheckCircle,
  Star,
  Trophy,
  Archive,
  Eye,
  Download,
  Save,
  PauseCircle,
  RotateCcw,
  Send,
  Trash2,
  AlertTriangle,
  type LucideIcon,
} from "lucide-react";
import { TopNav } from "./top-nav";
import { AddToBatchModal, type AddToBatchSnapshot } from "./add-to-batch-modal";
import { PaginationControls, paginate } from "./pagination-controls";
import {
  updateTalentStatus,
  saveTalentNote,
  deleteTalentProfile,
  type TalentProfile,
  type TalentStatus,
} from "@/app/admin/talent/actions";
import { type UserRole } from "@/app/admin/lib/roles";
import { getAvatarUrl } from "@/lib/avatars";

// ── Constants ────────────────────────────────────────────────

const CATEGORIES = [
  "All", "Engineer", "SDR", "CS", "Design",
  "Data", "DevOps", "QA", "Marketing", "Ops", "Finance", "Other",
] as const;

const CATEGORY_LABELS: Record<string, string> = {
  All: "All",
  Engineer: "Engineer",
  SDR: "SDR / Sales",
  CS: "Customer Success",
  Design: "Design & UX",
  Data: "Data & AI",
  DevOps: "DevOps & Cloud",
  QA: "QA",
  Marketing: "Marketing & Growth",
  Ops: "Business & Ops",
  Finance: "Finance & Accounting",
  Other: "Other",
};

const STATUS_FILTERS: Array<"All" | TalentStatus> = [
  "All", "pending", "approved", "shortlisted", "placed", "paused", "archived",
];

const STATUS_LABELS: Record<string, string> = {
  All: "All",
  pending: "Pending",
  approved: "Approved",
  shortlisted: "Shortlisted",
  placed: "Placed",
  paused: "Paused",
  archived: "Archived",
};

const STATUS_BADGE: Record<TalentStatus, string> = {
  pending:     "bg-amber-100 text-amber-700",
  approved:    "bg-green-100 text-green-700",
  shortlisted: "bg-[#7E47FF]/10 text-[#7E47FF]",
  placed:      "bg-blue-100 text-blue-700",
  paused:      "bg-orange-100 text-orange-700",
  archived:    "bg-gray-100 text-gray-500",
};

const AVAILABILITY_FILTERS = ["All", "Available Now", "Not Available"] as const;
const WORK_TYPE_FILTERS    = ["All", "Full-time", "Part-time", "Contract"] as const;

// ── Helpers ──────────────────────────────────────────────────

/** Pull a 4-digit year out of "2021" / "Jan 2021" / "2021 – 2024". */
function extractYear(value: string | undefined | null): number | null {
  if (!value) return null;
  const m = value.match(/(19|20)\d{2}/);
  return m ? Number.parseInt(m[0], 10) : null;
}

/** Earliest start → latest end (Present ⇒ current year). */
function deriveYears(experience: TalentProfile["experience"]): number | null {
  if (!experience || experience.length === 0) return null;
  const now = new Date().getFullYear();
  const starts: number[] = [];
  const ends: number[] = [];
  for (const e of experience) {
    const s = extractYear(e.start) ?? extractYear(e.dates?.split(/[–\-]/)[0]);
    if (s !== null) starts.push(s);
    if (e.end && /present/i.test(e.end)) {
      ends.push(now);
    } else {
      ends.push(extractYear(e.end) ?? extractYear(e.dates?.split(/[–\-]/)[1]) ?? now);
    }
  }
  if (starts.length === 0) return null;
  return Math.max(0, Math.max(...ends) - Math.min(...starts));
}

/** Job title from latest experience entry; falls back to job_title column. */
function deriveTitle(profile: TalentProfile): string | null {
  return profile.experience?.[0]?.title?.trim() || profile.job_title || null;
}

function fmtDaysAgo(iso: string): string {
  if (!iso) return "";
  const diff = Date.now() - new Date(iso).getTime();
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  if (days < 1) return "today";
  if (days === 1) return "1 day ago";
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  if (months === 1) return "1 month ago";
  return `${months} months ago`;
}

function fmtSalary(min: number | null, max: number | null): string | null {
  if (!min && !max) return null;
  const n = (v: number) => v >= 1000 ? `$${(v / 1000).toFixed(v % 1000 === 0 ? 0 : 1)}k` : `$${v}`;
  if (min && max) return `${n(min)}–${n(max)}/mo`;
  if (min) return `${n(min)}+/mo`;
  return `Up to ${n(max!)}/mo`;
}

function getInitials(name: string): string {
  return name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((n) => n[0]?.toUpperCase() ?? "")
    .join("");
}

function isAvailable(profile: TalentProfile): boolean {
  return (profile.availability ?? "").toLowerCase().includes("available");
}

// ── Avatar component ─────────────────────────────────────────

function Avatar({
  profile,
  size,
}: {
  profile: TalentProfile;
  size: number;
}) {
  // Self-healing: we always recompute via getAvatarUrl rather than trust the
  // stored avatar_url. See file header comment.
  const fullName = `${profile.first_name} ${profile.last_name ?? ""}`.trim();
  const [errored, setErrored] = useState(false);
  const url = getAvatarUrl(profile.first_name, profile.last_name);

  if (errored) {
    return (
      <span
        className="flex shrink-0 items-center justify-center rounded-full bg-[#7E47FF]/10 font-bold text-[#7E47FF]"
        style={{ width: size, height: size, fontSize: Math.max(10, size / 3) }}
      >
        {getInitials(fullName) || "?"}
      </span>
    );
  }

  return (
    <div
      className="relative shrink-0 overflow-hidden rounded-full"
      style={{ width: size, height: size }}
    >
      <Image
        src={url}
        alt={fullName}
        fill
        className="object-cover"
        sizes={`${size}px`}
        onError={() => setErrored(true)}
      />
    </div>
  );
}

// ── Profile Card ─────────────────────────────────────────────

function ProfileCard({
  profile,
  canApprove,
  onView,
  onApprove,
}: {
  profile: TalentProfile;
  canApprove: boolean;
  onView: () => void;
  onApprove: () => void;
}) {
  const available = isAvailable(profile);
  const fullName = `${profile.first_name} ${profile.last_name ?? ""}`.trim();
  const visibleSkills = profile.skills.slice(0, 4);
  const extraSkills = Math.max(0, profile.skills.length - visibleSkills.length);
  const salary = fmtSalary(profile.salary_min, profile.salary_max);

  return (
    <div className="flex flex-col gap-4 rounded-2xl border border-black/[0.05] bg-white p-5 shadow-sm transition-shadow hover:shadow-md">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span
            className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-semibold ${
              available ? "bg-[#49D7A7]/10 text-[#1a9e73]" : "bg-gray-100 text-gray-400"
            }`}
          >
            <span className={`size-1.5 rounded-full ${available ? "bg-[#49D7A7]" : "bg-gray-400"}`} />
            {available ? "Available" : "Not Available"}
          </span>
          {profile.role_category && (
            <span className="rounded-full bg-gray-100 px-2.5 py-1 text-[10px] font-medium text-gray-500">
              {CATEGORY_LABELS[profile.role_category] ?? profile.role_category}
            </span>
          )}
        </div>
        <div className="flex flex-col items-end gap-1">
          <div className="flex items-center gap-1">
            {profile.approved_at && (
              <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2 py-0.5 text-[10px] font-semibold text-green-700">
                <CheckCircle className="size-2.5" strokeWidth={2.5} />
                Approved
              </span>
            )}
            <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${STATUS_BADGE[profile.status]}`}>
              {STATUS_LABELS[profile.status] ?? profile.status}
            </span>
          </div>
          <span className="text-[10px] text-gray-300">{fmtDaysAgo(profile.created_at)}</span>
        </div>
      </div>

      <div className="flex items-start gap-3">
        <Avatar profile={profile} size={48} />
        <div className="min-w-0 flex-1">
          <p className="truncate font-heading text-base font-bold text-gray-900">{fullName}</p>
          {(() => {
            const t = deriveTitle(profile);
            return t ? <p className="truncate text-xs text-gray-500">{t}</p> : null;
          })()}
          <p className="mt-1 flex items-center gap-2 text-[11px] text-gray-400">
            {profile.city && (
              <span className="flex items-center gap-1">
                <MapPin className="size-3" strokeWidth={2} />
                {profile.city}
              </span>
            )}
            {(() => {
              const y = deriveYears(profile.experience) ?? profile.years_experience;
              return y != null ? <span>· {y} yrs</span> : null;
            })()}
          </p>
        </div>
      </div>

      {visibleSkills.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {visibleSkills.map((s) => (
            <span
              key={s}
              className="rounded-full bg-[#7E47FF]/8 px-2.5 py-0.5 text-[10px] font-medium text-[#7E47FF]"
            >
              {s}
            </span>
          ))}
          {extraSkills > 0 && (
            <span className="rounded-full bg-gray-100 px-2.5 py-0.5 text-[10px] font-medium text-gray-400">
              +{extraSkills}
            </span>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-gray-500">
        {profile.work_type && profile.work_type !== "Any" && <span>{profile.work_type}</span>}
        {profile.work_location && <span>· {profile.work_location}</span>}
        {profile.notice_period  && <span>· {profile.notice_period}</span>}
      </div>

      {salary && (
        <p className="flex items-center gap-1.5 text-xs font-semibold text-gray-700">
          💰 {salary}
        </p>
      )}

      <div className="mt-auto flex gap-2 pt-1">
        <button
          type="button"
          onClick={onView}
          className="flex-1 rounded-xl border border-gray-200 py-2 text-xs font-semibold text-gray-700 transition-colors hover:bg-gray-50"
        >
          View Profile
        </button>
        {canApprove && !profile.approved_at && (
          <button
            type="button"
            onClick={onApprove}
            className="flex items-center gap-1.5 rounded-xl bg-[#49D7A7] px-4 py-2 text-xs font-semibold text-[#1a4f3a] transition-opacity hover:opacity-90"
          >
            <CheckCircle className="size-3.5" strokeWidth={2.5} />
            Approve
          </button>
        )}
      </div>
    </div>
  );
}

// ── Drawer ───────────────────────────────────────────────────

type StageAction = {
  status: TalentStatus;
  label: string;
  icon: LucideIcon;
  className: string;
};

const STAGE_ACTIONS: StageAction[] = [
  { status: "shortlisted", label: "Shortlist",      icon: Star,        className: "bg-[#7E47FF]/10 text-[#7E47FF] hover:bg-[#7E47FF]/20" },
  { status: "placed",      label: "Mark as Placed", icon: Trophy,      className: "bg-blue-50 text-blue-600 hover:bg-blue-100" },
  { status: "paused",      label: "Pause",          icon: PauseCircle, className: "bg-orange-50 text-orange-700 hover:bg-orange-100" },
  { status: "archived",    label: "Archive",        icon: Archive,     className: "bg-gray-100 text-gray-600 hover:bg-gray-200" },
];

function ProfileDrawer({
  profile,
  isSuperAdmin,
  onClose,
  onSetStatus,
  onReset,
  onAddToBatch,
  onDelete,
  onToast,
}: {
  profile: TalentProfile;
  isSuperAdmin: boolean;
  onClose: () => void;
  onSetStatus: (status: TalentStatus) => Promise<void>;
  onReset: () => Promise<void>;
  onAddToBatch: () => void;
  onDelete: () => void;
  onToast: (msg: string) => void;
}) {
  const fullName = `${profile.first_name} ${profile.last_name ?? ""}`.trim();
  const available = isAvailable(profile);
  const salary = fmtSalary(profile.salary_min, profile.salary_max);
  const [note, setNote] = useState(profile.notes ?? "");
  const [savingNote, setSavingNote] = useState(false);
  const [busyStatus, setBusyStatus] = useState<TalentStatus | null>(null);

  // Re-seed when a different profile is opened.
  useEffect(() => {
    setNote(profile.notes ?? "");
  }, [profile.id, profile.notes]);

  async function handleStatus(s: TalentStatus) {
    setBusyStatus(s);
    await onSetStatus(s);
    setBusyStatus(null);
  }

  async function handleReset() {
    setBusyStatus("approved");
    await onReset();
    setBusyStatus(null);
  }

  const canReset =
    profile.status === "paused" ||
    profile.status === "archived" ||
    profile.status === "shortlisted" ||
    profile.status === "placed";

  async function handleSaveNote() {
    setSavingNote(true);
    const result = await saveTalentNote(profile.id, note);
    setSavingNote(false);
    if (result.success) {
      onToast("Note saved");
    } else {
      onToast(`Save failed: ${result.error}`);
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex">
      <button
        type="button"
        aria-label="Close drawer"
        className="flex-1 bg-black/30 backdrop-blur-sm"
        onClick={onClose}
      />
      <div className="flex h-full w-[420px] shrink-0 flex-col bg-white shadow-2xl">
        {/* Header */}
        <div className="relative shrink-0 border-b border-gray-100 px-6 py-6">
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="absolute right-4 top-4 flex size-8 items-center justify-center rounded-full text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
          >
            <X className="size-4" strokeWidth={2.5} />
          </button>
          <div className="flex items-start gap-4">
            <Avatar profile={profile} size={80} />
            <div className="min-w-0 flex-1 pr-8">
              <p className="truncate font-heading text-xl font-bold text-gray-900">{fullName}</p>
              {(() => {
                const t = deriveTitle(profile);
                return t ? <p className="truncate text-sm text-gray-500">{t}</p> : null;
              })()}
              <div className="mt-2 flex flex-wrap gap-1.5">
                <span
                  className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-semibold ${
                    available ? "bg-[#49D7A7]/10 text-[#1a9e73]" : "bg-gray-100 text-gray-400"
                  }`}
                >
                  <span className={`size-1.5 rounded-full ${available ? "bg-[#49D7A7]" : "bg-gray-400"}`} />
                  {available ? "Available" : "Not Available"}
                </span>
                {profile.approved_at && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2.5 py-1 text-[10px] font-semibold text-green-700">
                    <CheckCircle className="size-3" strokeWidth={2.5} />
                    Approved
                  </span>
                )}
                <span className={`rounded-full px-2.5 py-1 text-[10px] font-semibold ${STATUS_BADGE[profile.status]}`}>
                  {STATUS_LABELS[profile.status] ?? profile.status}
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Body */}
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          {/* Contact */}
          <DrawerSection title="Contact">
            <div className="flex flex-col gap-2 text-sm">
              {profile.email && (
                <a href={`mailto:${profile.email}`} className="flex items-center gap-2 text-gray-700 hover:text-[#7E47FF]">
                  <Mail className="size-3.5 text-gray-400" strokeWidth={2} />
                  {profile.email}
                </a>
              )}
              {profile.phone && (
                <span className="flex items-center gap-2 text-gray-700">
                  <Phone className="size-3.5 text-gray-400" strokeWidth={2} />
                  {profile.phone}
                </span>
              )}
              {profile.linkedin_url && (
                <a
                  href={profile.linkedin_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 text-gray-700 hover:text-[#7E47FF]"
                >
                  <svg className="size-3.5 text-gray-400" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M16 8a6 6 0 0 1 6 6v7h-4v-7a2 2 0 0 0-2-2 2 2 0 0 0-2 2v7h-4v-7a6 6 0 0 1 6-6zM2 9h4v12H2z" />
                    <circle cx="4" cy="4" r="2" />
                  </svg>
                  LinkedIn
                </a>
              )}
              {profile.github_url && (
                <a
                  href={profile.github_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 text-gray-700 hover:text-[#7E47FF]"
                >
                  <svg className="size-3.5 text-gray-400" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z" />
                  </svg>
                  GitHub
                </a>
              )}
            </div>
          </DrawerSection>

          {/* Profile */}
          <DrawerSection title="Profile">
            <div className="grid grid-cols-2 gap-x-4 gap-y-3 text-xs">
              <DrawerKv label="Category" value={profile.role_category ? (CATEGORY_LABELS[profile.role_category] ?? profile.role_category) : null} />
              {(() => {
                const y = deriveYears(profile.experience) ?? profile.years_experience;
                return <DrawerKv label="Experience" value={y != null ? `${y} years` : null} />;
              })()}
              <DrawerKv
                label="Education"
                value={
                  profile.degree || profile.institution
                    ? [profile.degree, profile.institution].filter(Boolean).join(" · ")
                    : null
                }
              />
              <DrawerKv label="Location" value={[profile.city, profile.country].filter(Boolean).join(", ") || null} />
            </div>
          </DrawerSection>

          {/* Work Experience — full list from JSONB */}
          <DrawerSection title="Work Experience">
            {profile.experience && profile.experience.length > 0 ? (
              <div className="flex flex-col gap-3">
                {profile.experience.map((exp, i) => (
                  <div
                    key={`${exp.company ?? "exp"}-${i}`}
                    className="flex gap-3 rounded-xl border border-gray-100 bg-gray-50/40 p-3"
                  >
                    <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-white text-xs">🏢</div>
                    <div className="min-w-0 flex-1 text-xs">
                      {exp.title && <p className="font-semibold text-gray-800">{exp.title}</p>}
                      {exp.company && <p className="text-gray-500">{exp.company}</p>}
                      {exp.dates && <p className="mt-0.5 text-[10px] text-gray-400">{exp.dates}</p>}
                      {exp.skills && exp.skills.length > 0 && (
                        <div className="mt-1.5 flex flex-wrap gap-1">
                          {exp.skills.map((s, j) => (
                            <span
                              key={`${s}-${j}`}
                              className="rounded border border-gray-200 bg-white px-1.5 py-0.5 text-[10px] text-gray-600"
                            >
                              {s}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="rounded-xl border border-dashed border-gray-200 px-4 py-6 text-center text-xs text-gray-400">
                No work experience added
              </p>
            )}
          </DrawerSection>

          {/* Skills */}
          {profile.skills.length > 0 && (
            <DrawerSection title="Skills">
              <div className="flex flex-wrap gap-1.5">
                {profile.skills.map((s) => (
                  <span
                    key={s}
                    className="rounded-full bg-[#7E47FF]/10 px-3 py-1 text-xs font-medium text-[#7E47FF]"
                  >
                    {s}
                  </span>
                ))}
              </div>
            </DrawerSection>
          )}

          {/* Summary */}
          {profile.summary && (
            <DrawerSection title="Summary">
              <p className="whitespace-pre-line text-sm leading-relaxed text-gray-600">{profile.summary}</p>
            </DrawerSection>
          )}

          {/* Preferences */}
          <DrawerSection title="Preferences">
            <div className="grid grid-cols-2 gap-x-4 gap-y-3 text-xs">
              {profile.work_type && profile.work_type !== "Any" && (
                <DrawerKv label="Work Type" value={profile.work_type} />
              )}
              {profile.notice_period && (
                <DrawerKv label="Notice Period" value={profile.notice_period} />
              )}
              {profile.work_location && (
                <DrawerKv label="Work Location" value={profile.work_location} />
              )}
              {salary && <DrawerKv label="Salary" value={salary} />}
            </div>
          </DrawerSection>

          {/* CV */}
          {profile.cv_url && (
            <DrawerSection title="CV">
              <div className="flex gap-2">
                <a
                  href={profile.cv_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-[#7E47FF]/10 px-3 py-2 text-xs font-semibold text-[#7E47FF] transition-colors hover:bg-[#7E47FF]/20"
                >
                  <Eye className="size-3.5" strokeWidth={2} />
                  View CV
                </a>
                <a
                  href={profile.cv_url}
                  download
                  className="flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-gray-100 px-3 py-2 text-xs font-semibold text-gray-600 transition-colors hover:bg-gray-200"
                >
                  <Download className="size-3.5" strokeWidth={2} />
                  Download CV
                </a>
              </div>
            </DrawerSection>
          )}

          {/* Approval — super_admin only, only while not yet approved */}
          {isSuperAdmin && !profile.approved_at && (
            <DrawerSection title="Approval">
              <button
                type="button"
                disabled={busyStatus !== null}
                onClick={() => handleStatus("approved")}
                className="flex w-full items-center justify-center gap-1.5 rounded-xl bg-[#49D7A7]/10 px-3 py-2.5 text-xs font-semibold text-[#1a9e73] transition-colors hover:bg-[#49D7A7]/20 disabled:opacity-50"
              >
                <CheckCircle className="size-3.5" strokeWidth={2} />
                {busyStatus === "approved" ? "Approving…" : "Approve"}
              </button>
            </DrawerSection>
          )}

          {/* Client Batch — open the picker to file this candidate into a batch */}
          <DrawerSection title="Client Batch">
            <button
              type="button"
              onClick={onAddToBatch}
              className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-[#7E47FF]/30 bg-[#7E47FF]/10 px-3 py-2.5 text-xs font-semibold text-[#7E47FF] transition-colors hover:bg-[#7E47FF]/20"
            >
              <Send className="size-3.5" strokeWidth={2} />
              Add to Client Batch
            </button>
          </DrawerSection>

          {/* Stage — available to all admins viewing this drawer */}
          <DrawerSection title="Stage">
            {canReset && (
              <button
                type="button"
                disabled={busyStatus !== null}
                onClick={handleReset}
                className="mb-2 flex w-full items-center justify-center gap-1.5 rounded-xl border border-[#49D7A7]/30 bg-[#49D7A7]/10 px-3 py-2.5 text-xs font-semibold text-[#1a9e73] transition-colors hover:bg-[#49D7A7]/20 disabled:opacity-50"
              >
                <RotateCcw className="size-3.5" strokeWidth={2} />
                {busyStatus === "approved" ? "Resetting…" : "Reset to Approved"}
              </button>
            )}
            <div className="grid grid-cols-2 gap-2">
              {STAGE_ACTIONS.map((a) => {
                const Icon = a.icon;
                return (
                  <button
                    key={a.status}
                    type="button"
                    disabled={busyStatus !== null || profile.status === a.status}
                    onClick={() => handleStatus(a.status)}
                    className={`flex items-center justify-center gap-1.5 rounded-xl px-3 py-2.5 text-xs font-semibold transition-colors disabled:opacity-50 ${a.className}`}
                  >
                    <Icon className="size-3.5" strokeWidth={2} />
                    {busyStatus === a.status ? "…" : a.label}
                  </button>
                );
              })}
            </div>
          </DrawerSection>

          {/* Danger — super_admin only */}
          {isSuperAdmin && (
            <DrawerSection title="Danger">
              <button
                type="button"
                onClick={onDelete}
                className="flex w-full items-center justify-center gap-1.5 rounded-xl bg-red-50 px-3 py-2.5 text-xs font-semibold text-red-600 transition-colors hover:bg-red-100"
              >
                <Trash2 className="size-3.5" strokeWidth={2} />
                Delete Profile
              </button>
            </DrawerSection>
          )}

          {/* Notes */}
          <DrawerSection title="Notes">
            <textarea
              rows={4}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Add an internal note about this candidate…"
              className="w-full resize-none rounded-xl border border-gray-200 px-3.5 py-2.5 text-sm text-gray-800 outline-none transition-all focus:border-[#7E47FF] focus:ring-2 focus:ring-[#7E47FF]/20"
            />
            <button
              type="button"
              onClick={handleSaveNote}
              disabled={savingNote}
              className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-xl bg-gray-900 py-2.5 text-xs font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              <Save className="size-3.5" strokeWidth={2} />
              {savingNote ? "Saving…" : "Save Note"}
            </button>
          </DrawerSection>
        </div>
      </div>
    </div>
  );
}

function DrawerSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-6 last:mb-2">
      <p className="mb-3 text-[10px] font-semibold uppercase tracking-widest text-gray-400">
        {title}
      </p>
      {children}
    </section>
  );
}

function DrawerKv({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-widest text-gray-300">{label}</p>
      <p className="mt-0.5 text-gray-700">{value ?? <span className="text-gray-300">—</span>}</p>
    </div>
  );
}

// ── Sidebar pill helper ──────────────────────────────────────

function FilterPill({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full rounded-lg px-3 py-1.5 text-left text-xs font-medium transition-colors ${
        active
          ? "bg-[#7E47FF] text-white"
          : "border border-gray-100 bg-white text-gray-500 hover:border-[#7E47FF]/30 hover:text-gray-700"
      }`}
    >
      {label}
    </button>
  );
}

// ── Component ────────────────────────────────────────────────

export function TalentDashboard({
  email,
  userRole,
  initialProfiles,
  initialOpenId,
  initialSearch,
}: {
  email: string;
  userRole: UserRole;
  initialProfiles: TalentProfile[];
  initialOpenId: string | null;
  initialSearch: string;
}) {
  const router = useRouter();
  const isSuperAdmin = userRole === "super_admin";

  const [profiles, setProfiles] = useState<TalentProfile[]>(initialProfiles);
  const [search, setSearch] = useState(initialSearch);
  const [filterCategory, setFilterCategory] = useState<string>("All");
  const [filterStatus, setFilterStatus] = useState<string>("All");
  const [filterAvailability, setFilterAvailability] = useState<string>("All");
  const [filterWorkType, setFilterWorkType] = useState<string>("All");

  const [openId, setOpenId] = useState<string | null>(initialOpenId);
  const [toast, setToast] = useState<string | null>(null);

  // Keep state in sync with refreshed server data
  useEffect(() => {
    setProfiles(initialProfiles);
  }, [initialProfiles]);

  // Auto-dismiss toast
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2500);
    return () => clearTimeout(t);
  }, [toast]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return profiles.filter((p) => {
      if (filterCategory !== "All" && p.role_category !== filterCategory) return false;
      if (filterStatus   !== "All" && p.status !== filterStatus)           return false;
      if (filterAvailability === "Available Now"  && !isAvailable(p))      return false;
      if (filterAvailability === "Not Available"  && isAvailable(p))       return false;
      if (filterWorkType !== "All" && (p.work_type ?? "") !== filterWorkType) return false;
      if (q) {
        const blob = [
          p.first_name,
          p.last_name ?? "",
          p.email,
          p.job_title ?? "",
          p.summary ?? "",
          p.city ?? "",
          ...(p.skills ?? []),
        ].join(" ").toLowerCase();
        if (!blob.includes(q)) return false;
      }
      return true;
    });
  }, [profiles, search, filterCategory, filterStatus, filterAvailability, filterWorkType]);

  const totalCount     = profiles.length;
  const availableCount = profiles.filter(isAvailable).length;
  const pendingCount   = profiles.filter((p) => p.status === "pending").length;

  // ── Pagination (client-side, against the filtered set) ────
  const [page, setPage] = useState(1);
  useEffect(() => {
    setPage(1);
  }, [search, filterCategory, filterStatus, filterAvailability, filterWorkType]);
  const pageItems = paginate(filtered, page);

  const openProfile = openId ? profiles.find((p) => p.id === openId) ?? null : null;

  const [deleteTarget, setDeleteTarget] = useState<TalentProfile | null>(null);
  const [addToBatchTarget, setAddToBatchTarget] = useState<TalentProfile | null>(null);
  const [deleting, setDeleting] = useState(false);

  async function handleSetStatus(profile: TalentProfile, status: TalentStatus) {
    // Optimistic — stamp approved_at locally too so the green badge appears
    // immediately on approval.
    const optimisticPatch: Partial<TalentProfile> = { status };
    if (status === "approved" && !profile.approved_at) {
      optimisticPatch.approved_at = new Date().toISOString();
    }
    setProfiles((prev) =>
      prev.map((p) => (p.id === profile.id ? { ...p, ...optimisticPatch } : p)),
    );

    const result = await updateTalentStatus(profile.id, status);
    if (result.success) {
      setToast(`Marked as ${STATUS_LABELS[status]}`);
      router.refresh();
    } else {
      setProfiles((prev) => prev.map((p) => (p.id === profile.id ? profile : p)));
      setToast(`Update failed: ${result.error}`);
    }
  }

  async function handleResetToApproved(profile: TalentProfile) {
    setProfiles((prev) =>
      prev.map((p) => (p.id === profile.id ? { ...p, status: "approved" } : p)),
    );

    const result = await updateTalentStatus(profile.id, "approved");
    if (result.success) {
      setToast("Profile reactivated as Approved");
      router.refresh();
    } else {
      setProfiles((prev) => prev.map((p) => (p.id === profile.id ? profile : p)));
      setToast(`Reset failed: ${result.error}`);
    }
  }

  async function handleDelete(profile: TalentProfile) {
    setDeleting(true);
    const result = await deleteTalentProfile(profile.id);
    setDeleting(false);
    if (result.success) {
      setProfiles((prev) => prev.filter((p) => p.id !== profile.id));
      if (openId === profile.id) setOpenId(null);
      setDeleteTarget(null);
      setToast("Profile deleted");
      router.refresh();
    } else {
      setToast(`Delete failed: ${result.error}`);
    }
  }

  return (
    <div className="min-h-screen bg-[#f8f4f1]">
      <TopNav email={email} userRole={userRole} />

      <main className="mx-auto max-w-screen-2xl px-8 py-8">
        {/* Header */}
        <div className="mb-6 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-xs text-gray-400">Talent</p>
            <h1 className="font-heading text-2xl font-bold text-gray-900">Talent Network</h1>
            <p className="mt-1 text-sm text-gray-500">
              {totalCount} total · {availableCount} available · {pendingCount} pending
            </p>
          </div>

          <div className="flex flex-1 items-center gap-2 rounded-2xl bg-white p-2 shadow-sm lg:max-w-md">
            <SearchIcon className="ml-2 size-4 shrink-0 text-gray-400" strokeWidth={2} />
            <input
              type="text"
              placeholder="Search by name, skill, location…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-10 flex-1 bg-transparent text-sm text-gray-800 outline-none placeholder:text-gray-400"
            />
          </div>
        </div>

        {/* 3-column layout */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[220px_1fr]">
          {/* Filter sidebar */}
          <aside className="lg:sticky lg:top-20 lg:self-start">
            <div className="rounded-2xl border border-black/[0.05] bg-white p-5 shadow-sm">
              <FilterGroup title="Category">
                {(CATEGORIES as readonly string[]).map((c) => (
                  <FilterPill
                    key={c}
                    label={CATEGORY_LABELS[c] ?? c}
                    active={filterCategory === c}
                    onClick={() => setFilterCategory(c)}
                  />
                ))}
              </FilterGroup>

              <FilterGroup title="Status">
                {STATUS_FILTERS.map((s) => (
                  <FilterPill
                    key={s}
                    label={STATUS_LABELS[s] ?? s}
                    active={filterStatus === s}
                    onClick={() => setFilterStatus(s)}
                  />
                ))}
              </FilterGroup>

              <FilterGroup title="Availability">
                {AVAILABILITY_FILTERS.map((a) => (
                  <FilterPill
                    key={a}
                    label={a}
                    active={filterAvailability === a}
                    onClick={() => setFilterAvailability(a)}
                  />
                ))}
              </FilterGroup>

              <FilterGroup title="Work Type">
                {WORK_TYPE_FILTERS.map((w) => (
                  <FilterPill
                    key={w}
                    label={w}
                    active={filterWorkType === w}
                    onClick={() => setFilterWorkType(w)}
                  />
                ))}
              </FilterGroup>
            </div>
          </aside>

          {/* Card grid */}
          <div>
            {filtered.length === 0 ? (
              <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-gray-200 bg-white py-20 text-center">
                <Briefcase className="mb-3 size-8 text-gray-300" strokeWidth={1.5} />
                <p className="font-heading text-sm font-semibold text-gray-700">No talent matches your filters</p>
                <p className="mt-1 text-xs text-gray-400">Try clearing a filter or broadening your search.</p>
              </div>
            ) : (
              <>
                <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
                  {pageItems.map((p) => (
                    <ProfileCard
                      key={p.id}
                      profile={p}
                      canApprove={isSuperAdmin}
                      onView={() => setOpenId(p.id)}
                      onApprove={() => handleSetStatus(p, "approved")}
                    />
                  ))}
                </div>
                <div className="mt-6">
                  <PaginationControls page={page} setPage={setPage} total={filtered.length} />
                </div>
              </>
            )}
          </div>
        </div>
      </main>

      {/* Drawer */}
      {openProfile && (
        <ProfileDrawer
          profile={openProfile}
          isSuperAdmin={isSuperAdmin}
          onClose={() => setOpenId(null)}
          onSetStatus={(status) => handleSetStatus(openProfile, status)}
          onReset={() => handleResetToApproved(openProfile)}
          onAddToBatch={() => setAddToBatchTarget(openProfile)}
          onDelete={() => setDeleteTarget(openProfile)}
          onToast={setToast}
        />
      )}

      {/* Add-to-Batch modal */}
      {addToBatchTarget && (() => {
        const t = addToBatchTarget;
        const latest = Array.isArray(t.experience) ? t.experience[0] : null;
        const salary = (() => {
          if (t.salary_min && t.salary_max) return `${t.salary_min}-${t.salary_max}`;
          if (t.salary_min) return `${t.salary_min}+`;
          if (t.salary_max) return `up to ${t.salary_max}`;
          return null;
        })();
        const snapshot: AddToBatchSnapshot & { full_name: string } = {
          source_type: "talent",
          source_id: t.id,
          first_name: t.first_name,
          last_name: t.last_name ?? "",
          email: t.email,
          phone: t.phone ?? null,
          linkedin_url: t.linkedin_url ?? null,
          cv_url: t.cv_url ?? null,
          location: [t.city, t.country].filter(Boolean).join(", ") || null,
          university: [t.degree, t.institution].filter(Boolean).join(" — ") || null,
          position_applied: t.job_title ?? null,
          total_experience: null,
          current_role: latest?.title ?? t.job_title ?? null,
          current_company: latest?.company ?? null,
          current_salary: salary,
          salary_expectations: null,
          notice_period: t.notice_period ?? null,
          full_name: `${t.first_name} ${t.last_name ?? ""}`.trim(),
        };
        return (
          <AddToBatchModal
            candidate={snapshot}
            onClose={() => setAddToBatchTarget(null)}
            onToast={(msg) => {
              setAddToBatchTarget(null);
              setToast(msg);
              router.refresh();
            }}
          />
        );
      })()}

      {/* Delete confirm */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-sm overflow-hidden rounded-2xl bg-white shadow-2xl">
            <div className="flex flex-col items-center p-8 text-center">
              <div className="mb-4 flex size-14 items-center justify-center rounded-full bg-red-50">
                <AlertTriangle className="size-7 text-red-500" strokeWidth={2} />
              </div>
              <h3 className="font-heading text-lg font-bold text-gray-900">Delete profile?</h3>
              <p className="mt-2 text-sm text-gray-500">
                This permanently removes{" "}
                <span className="font-semibold text-gray-700">
                  {deleteTarget.first_name} {deleteTarget.last_name ?? ""}
                </span>{" "}
                from the talent network. This action cannot be undone.
              </p>
            </div>
            <div className="flex gap-3 border-t border-gray-100 px-6 py-4">
              <button
                type="button"
                onClick={() => setDeleteTarget(null)}
                className="flex-1 rounded-xl border border-gray-200 py-2.5 text-sm font-medium text-gray-600 transition-colors hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => deleteTarget && handleDelete(deleteTarget)}
                disabled={deleting}
                className="flex-1 rounded-xl bg-red-500 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {deleting ? "Deleting…" : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-6 right-6 z-50 flex items-center gap-2.5 rounded-xl bg-gray-900 px-4 py-3 text-sm font-medium text-white shadow-xl">
          {toast}
        </div>
      )}
    </div>
  );
}

function FilterGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-5 last:mb-0">
      <p className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-gray-400">{title}</p>
      <div className="flex flex-col gap-1.5">{children}</div>
    </div>
  );
}
