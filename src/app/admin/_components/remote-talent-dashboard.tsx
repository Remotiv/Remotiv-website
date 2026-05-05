"use client";

import { useEffect, useMemo, useState } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  Archive,
  Briefcase,
  CheckCircle,
  ChevronRight,
  Clock,
  Download,
  ExternalLink,
  Eye,
  Globe,
  Mail,
  MapPin,
  PauseCircle,
  Phone,
  RotateCcw,
  Save,
  Search as SearchIcon,
  ShieldCheck,
  SlidersHorizontal,
  Star,
  Trash2,
  Trophy,
  X,
  type LucideIcon,
} from "lucide-react";
import { TopNav } from "./top-nav";
import { PaginationControls, paginate } from "./pagination-controls";
import {
  deleteRemoteTalentProfile,
  saveRemoteTalentNote,
  updateRemoteTalentStatus,
  updateRemoteTalentVerification,
  type RemoteTalentProfile,
  type RemoteTalentStatus,
} from "@/app/admin/remote-talent/actions";
import { type UserRole } from "@/app/admin/lib/roles";

// ── Constants ────────────────────────────────────────────────

const STATUS_FILTERS: Array<"All" | RemoteTalentStatus> = [
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

const STATUS_BADGE: Record<RemoteTalentStatus, string> = {
  pending:     "bg-amber-100 text-amber-700",
  approved:    "bg-green-100 text-green-700",
  shortlisted: "bg-[#7E47FF]/10 text-[#7E47FF]",
  placed:      "bg-blue-100 text-blue-700",
  paused:      "bg-orange-100 text-orange-700",
  archived:    "bg-gray-100 text-gray-500",
};

const AVAILABILITY_FILTERS = ["All", "Available Now", "Available Later"] as const;

const WORK_TYPE_FILTERS = [
  "All",
  "Full-time",
  "Part-time",
  "Contract only",
  "Open to contract-to-hire",
] as const;

const HOURS_FILTERS = [
  "All",
  "More than 30 hrs/week",
  "20-30 hrs/week",
  "Less than 20 hrs/week",
] as const;

// ── Helpers ──────────────────────────────────────────────────

function getInitials(profile: RemoteTalentProfile): string {
  const f = profile.first_name?.[0] ?? "";
  const l = profile.last_name?.[0] ?? "";
  return (f + l).toUpperCase() || "?";
}

function fullName(profile: RemoteTalentProfile): string {
  return `${profile.first_name} ${profile.last_name}`.trim();
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

function isAvailableNow(profile: RemoteTalentProfile): boolean {
  return (profile.availability ?? "").toLowerCase().includes("available now");
}

function fmtAvailability(profile: RemoteTalentProfile): string {
  const av = profile.availability ?? "";
  if (av.toLowerCase().includes("future") && profile.available_from_date) {
    return `Available from ${profile.available_from_date}`;
  }
  return av;
}

// ── Avatar ───────────────────────────────────────────────────

function Avatar({
  profile,
  size,
}: {
  profile: RemoteTalentProfile;
  size: number;
}) {
  if (profile.photo_url) {
    return (
      <div
        className="relative shrink-0 overflow-hidden rounded-full"
        style={{ width: size, height: size }}
      >
        <Image
          src={profile.photo_url}
          alt={fullName(profile)}
          fill
          className="object-cover"
          sizes={`${size}px`}
        />
      </div>
    );
  }
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-full bg-[#7E47FF]/10 font-bold text-[#7E47FF]"
      style={{ width: size, height: size, fontSize: Math.max(10, size / 3) }}
    >
      {getInitials(profile)}
    </span>
  );
}

// ── Profile Card ─────────────────────────────────────────────

function ProfileCard({
  profile,
  canApprove,
  onView,
  onApprove,
}: {
  profile: RemoteTalentProfile;
  canApprove: boolean;
  onView: () => void;
  onApprove: () => void;
}) {
  const available = isAvailableNow(profile);
  const visibleSkills = profile.skills.slice(0, 4);
  const extraSkills = Math.max(0, profile.skills.length - visibleSkills.length);

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
            {available ? "Available" : "Later"}
          </span>
          {profile.hourly_rate != null && (
            <span className="rounded-full bg-gray-100 px-2.5 py-1 text-[10px] font-semibold text-gray-700">
              ${profile.hourly_rate}/hr
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
          <p className="truncate font-heading text-base font-bold text-gray-900">{fullName(profile)}</p>
          {profile.job_titles && (
            <p className="truncate text-xs text-gray-500">{profile.job_titles}</p>
          )}
          <p className="mt-1 flex items-center gap-1 text-[11px] text-gray-400">
            {(profile.city || profile.country) && (
              <span className="flex items-center gap-1">
                <MapPin className="size-3" strokeWidth={2} />
                {[profile.city, profile.country].filter(Boolean).join(", ")}
              </span>
            )}
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
        {profile.hours_per_week && <span>{profile.hours_per_week}</span>}
        {profile.work_type && <span>· {profile.work_type}</span>}
      </div>

      <div className="mt-auto flex gap-2 pt-1">
        <button
          type="button"
          onClick={onView}
          className="flex-1 rounded-xl border border-gray-200 py-2 text-xs font-semibold text-gray-700 transition-colors hover:bg-gray-50"
        >
          View Profile
        </button>
        {canApprove && profile.status === "pending" && (
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
  status: RemoteTalentStatus;
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
  onDelete,
  onToast,
}: {
  profile: RemoteTalentProfile;
  isSuperAdmin: boolean;
  onClose: () => void;
  onSetStatus: (status: RemoteTalentStatus) => Promise<void>;
  onReset: () => Promise<void>;
  onDelete: () => void;
  onToast: (msg: string) => void;
}) {
  const router = useRouter();
  const available = isAvailableNow(profile);

  const [note, setNote] = useState(profile.notes ?? "");
  const [savingNote, setSavingNote] = useState(false);
  const [busyStatus, setBusyStatus] = useState<RemoteTalentStatus | null>(null);

  const [idVerified, setIdVerified] = useState(profile.id_verified);
  const [phoneVerified, setPhoneVerified] = useState(profile.phone_verified);
  const [savingVerify, setSavingVerify] = useState(false);

  useEffect(() => {
    setNote(profile.notes ?? "");
    setIdVerified(profile.id_verified);
    setPhoneVerified(profile.phone_verified);
  }, [profile.id, profile.notes, profile.id_verified, profile.phone_verified]);

  async function handleStatus(s: RemoteTalentStatus) {
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
    const result = await saveRemoteTalentNote(profile.id, note);
    setSavingNote(false);
    if (result.success) {
      onToast("Note saved");
    } else {
      onToast(`Save failed: ${result.error}`);
    }
  }

  async function handleSaveVerifications() {
    setSavingVerify(true);
    const result = await updateRemoteTalentVerification(
      profile.id,
      idVerified,
      phoneVerified,
    );
    setSavingVerify(false);
    if (result.success) {
      onToast("Verifications saved");
      router.refresh();
    } else {
      onToast(`Save failed: ${result.error}`);
    }
  }

  const verifBadges: string[] = [];
  if (profile.email_verified) verifBadges.push("Email");
  if (profile.id_verified) verifBadges.push("ID");
  if (profile.phone_verified) verifBadges.push("Phone");

  return (
    <div className="fixed inset-0 z-40 flex">
      {/* Backdrop — desktop only. On mobile the panel covers the full viewport
          so a separate dim layer would be invisible. */}
      <button
        type="button"
        aria-label="Close drawer"
        className="hidden flex-1 bg-black/30 backdrop-blur-sm lg:block"
        onClick={onClose}
      />
      <div className="flex h-full w-full shrink-0 flex-col bg-white shadow-2xl lg:w-[460px]">
        {/* Header */}
        <div className="relative shrink-0 border-b border-gray-100 px-5 py-5 lg:px-6 lg:py-6">
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="absolute right-3 top-3 flex size-11 items-center justify-center rounded-full text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600 lg:right-4 lg:top-4 lg:size-8"
          >
            <X className="size-5 lg:size-4" strokeWidth={2.5} />
          </button>
          <div className="flex items-start gap-4">
            <Avatar profile={profile} size={80} />
            <div className="min-w-0 flex-1 pr-8">
              <p className="truncate font-heading text-xl font-bold text-gray-900">{fullName(profile)}</p>
              {profile.job_titles && (
                <p className="truncate text-sm text-gray-500">{profile.job_titles}</p>
              )}
              <div className="mt-2 flex flex-wrap gap-1.5">
                <span
                  className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-semibold ${
                    available ? "bg-[#49D7A7]/10 text-[#1a9e73]" : "bg-gray-100 text-gray-400"
                  }`}
                >
                  <span className={`size-1.5 rounded-full ${available ? "bg-[#49D7A7]" : "bg-gray-400"}`} />
                  {available ? "Available" : "Later"}
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
                {verifBadges.map((v) => (
                  <span
                    key={v}
                    className="inline-flex items-center gap-1 rounded-full bg-[#49D7A7]/10 px-2 py-0.5 text-[10px] font-semibold text-[#1a9e73]"
                  >
                    <ShieldCheck className="size-2.5" strokeWidth={2.5} />
                    {v}
                  </span>
                ))}
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
                  <ExternalLink className="size-3.5 text-gray-400" strokeWidth={2} />
                  LinkedIn
                </a>
              )}
              {(profile.city || profile.country) && (
                <span className="flex items-center gap-2 text-gray-700">
                  <MapPin className="size-3.5 text-gray-400" strokeWidth={2} />
                  {[profile.city, profile.country].filter(Boolean).join(", ")}
                </span>
              )}
              {profile.time_zone && (
                <span className="flex items-center gap-2 text-gray-700">
                  <Globe className="size-3.5 text-gray-400" strokeWidth={2} />
                  {profile.time_zone}
                </span>
              )}
            </div>
          </DrawerSection>

          {/* Rate */}
          {profile.hourly_rate != null && (
            <DrawerSection title="Rate">
              <div className="rounded-xl bg-[#49D7A7]/8 px-4 py-3">
                <p className="font-heading text-2xl font-extrabold text-[#1a9e73]">
                  ${profile.hourly_rate}/hr
                </p>
              </div>
            </DrawerSection>
          )}

          {/* Work Preferences */}
          <DrawerSection title="Work Preferences">
            <div className="grid grid-cols-2 gap-x-4 gap-y-3 text-xs">
              <DrawerKv label="Hours / Week" value={profile.hours_per_week} icon={Clock} />
              <DrawerKv label="Work Type" value={profile.work_type} icon={Briefcase} />
              <DrawerKv label="Availability" value={fmtAvailability(profile) || null} />
            </div>
            {profile.languages.length > 0 && (
              <div className="mt-3 flex flex-col gap-1">
                <p className="text-[10px] uppercase tracking-widest text-gray-300">Languages</p>
                <div className="flex flex-wrap gap-1.5">
                  {profile.languages.map((l, i) => (
                    <span
                      key={`${l.name}-${i}`}
                      className="rounded-full border border-gray-200 px-2.5 py-0.5 text-[11px] text-gray-700"
                    >
                      {l.name} <span className="text-gray-400">· {l.level}</span>
                    </span>
                  ))}
                </div>
              </div>
            )}
          </DrawerSection>

          {/* Bio */}
          {profile.bio && (
            <DrawerSection title="Bio">
              <p className="whitespace-pre-line text-sm leading-relaxed text-gray-600">
                {profile.bio}
              </p>
            </DrawerSection>
          )}

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

          {/* Employment History */}
          <DrawerSection title="Employment History">
            {profile.employment_history.length > 0 ? (
              <div className="flex flex-col gap-3">
                {profile.employment_history.map((e, i) => (
                  <div
                    key={`${e.company || "exp"}-${i}`}
                    className="rounded-xl border-l-[3px] border-l-[#7E47FF] bg-gray-50 px-4 py-3"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        {e.title && <p className="font-semibold text-gray-800 text-sm">{e.title}</p>}
                        {e.company && <p className="text-xs text-gray-500">{e.company}</p>}
                      </div>
                      {e.dates && <p className="shrink-0 text-[10px] text-gray-400">{e.dates}</p>}
                    </div>
                    {e.description && (
                      <p className="mt-2 text-xs leading-relaxed text-gray-600">{e.description}</p>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <p className="rounded-xl border border-dashed border-gray-200 px-4 py-6 text-center text-xs text-gray-400">
                No employment history
              </p>
            )}
          </DrawerSection>

          {/* Education */}
          {profile.education && (profile.education.institution || profile.education.degree) && (
            <DrawerSection title="Education">
              <div className="rounded-xl bg-gray-50 px-4 py-3">
                {profile.education.degree && (
                  <p className="font-semibold text-sm text-gray-800">{profile.education.degree}</p>
                )}
                {profile.education.institution && (
                  <p className="text-xs text-gray-500">{profile.education.institution}</p>
                )}
                {profile.education.dates && (
                  <p className="mt-0.5 text-[10px] text-gray-400">{profile.education.dates}</p>
                )}
              </div>
            </DrawerSection>
          )}

          {/* Portfolio */}
          {profile.portfolio.length > 0 && (
            <DrawerSection title="Portfolio">
              <div className="flex flex-col gap-2.5">
                {profile.portfolio.map((p, i) => (
                  <div key={`${p.title}-${i}`} className="rounded-xl bg-gray-50 px-4 py-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        {p.title && <p className="font-semibold text-sm text-gray-800">{p.title}</p>}
                        {p.role && <p className="text-[11px] text-gray-500">{p.role}</p>}
                      </div>
                      {p.url && (
                        <a
                          href={p.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex shrink-0 items-center gap-1 rounded-md bg-white px-2 py-1 text-[10px] font-semibold text-[#7E47FF] hover:bg-[#7E47FF]/10"
                        >
                          <ExternalLink className="size-3" strokeWidth={2} />
                          Visit
                        </a>
                      )}
                    </div>
                    {p.description && (
                      <p className="mt-1.5 text-xs leading-relaxed text-gray-600">{p.description}</p>
                    )}
                  </div>
                ))}
              </div>
            </DrawerSection>
          )}

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

          {/* Verifications — admin-editable */}
          <DrawerSection title="Verifications">
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between rounded-xl bg-gray-50 px-3 py-2.5">
                <span className="flex items-center gap-2 text-xs font-medium text-gray-700">
                  <CheckCircle className="size-4 text-[#1a9e73]" strokeWidth={2.5} />
                  Email Verified
                </span>
                <span className="text-[10px] font-semibold uppercase tracking-widest text-gray-400">Auto</span>
              </div>
              <label className="flex cursor-pointer items-center justify-between rounded-xl border border-gray-100 bg-white px-3 py-2.5 transition-colors hover:bg-gray-50">
                <span className="text-xs font-medium text-gray-700">ID Verified</span>
                <input
                  type="checkbox"
                  checked={idVerified}
                  onChange={(e) => setIdVerified(e.target.checked)}
                  className="size-4 cursor-pointer accent-[#49D7A7]"
                />
              </label>
              <label className="flex cursor-pointer items-center justify-between rounded-xl border border-gray-100 bg-white px-3 py-2.5 transition-colors hover:bg-gray-50">
                <span className="text-xs font-medium text-gray-700">Phone Verified</span>
                <input
                  type="checkbox"
                  checked={phoneVerified}
                  onChange={(e) => setPhoneVerified(e.target.checked)}
                  className="size-4 cursor-pointer accent-[#49D7A7]"
                />
              </label>
              <button
                type="button"
                onClick={handleSaveVerifications}
                disabled={savingVerify}
                className="mt-1 flex items-center justify-center gap-1.5 rounded-xl bg-gray-900 py-2.5 text-xs font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                <Save className="size-3.5" strokeWidth={2} />
                {savingVerify ? "Saving…" : "Save Verifications"}
              </button>
            </div>
          </DrawerSection>

          {/* Approval — super_admin only, only while pending */}
          {isSuperAdmin && profile.status === "pending" && (
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

          {/* Stage */}
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

          {/* Danger */}
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

function DrawerKv({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: string | null;
  icon?: LucideIcon;
}) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-widest text-gray-300">{label}</p>
      <p className="mt-0.5 flex items-center gap-1.5 text-gray-700">
        {Icon && <Icon className="size-3 text-gray-400" strokeWidth={2} />}
        {value ?? <span className="text-gray-300">—</span>}
      </p>
    </div>
  );
}

// ── Filter pill helpers ──────────────────────────────────────

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

function FilterGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-5 last:mb-0">
      <p className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-gray-400">{title}</p>
      <div className="flex flex-col gap-1.5">{children}</div>
    </div>
  );
}

// ── Mobile card (tighter, larger touch targets) ──────────────

/**
 * Compact remote-talent card optimized for phone widths (375–414px).
 * Renders only on `<lg`; the desktop ProfileCard is hidden on mobile.
 * The whole surface is one tappable button — quick actions live inside
 * the profile drawer so the row stays a single touch target.
 *
 * Key Hire-Remote fields surfaced up front: hourly rate, work type,
 * verification status (email/ID/phone trust marks).
 */
function RemoteTalentCardMobile({
  profile,
  onView,
}: {
  profile: RemoteTalentProfile;
  onView: () => void;
}) {
  const available = isAvailableNow(profile);
  const visibleSkills = profile.skills.slice(0, 3);
  const extraSkills = Math.max(0, profile.skills.length - visibleSkills.length);
  const verifCount =
    Number(profile.email_verified) +
    Number(profile.id_verified) +
    Number(profile.phone_verified);
  const fullyVerified = verifCount >= 2;

  return (
    <button
      type="button"
      onClick={onView}
      className="flex w-full flex-col gap-3 rounded-2xl border border-black/[0.05] bg-white p-4 text-left shadow-sm transition-shadow active:shadow-md"
    >
      <div className="flex items-start gap-3">
        <Avatar profile={profile} size={48} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <p className="truncate font-heading text-base font-bold text-gray-900">
              {fullName(profile)}
            </p>
            <span
              className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${STATUS_BADGE[profile.status]}`}
            >
              {STATUS_LABELS[profile.status] ?? profile.status}
            </span>
          </div>
          {profile.job_titles && (
            <p className="mt-0.5 truncate text-xs text-gray-500">
              {profile.job_titles}
            </p>
          )}
          <p className="mt-1 flex items-center gap-1 text-[11px] text-gray-400">
            {(profile.city || profile.country) && (
              <span className="flex items-center gap-1">
                <MapPin className="size-3" strokeWidth={2} />
                {[profile.city, profile.country].filter(Boolean).join(", ")}
              </span>
            )}
          </p>
        </div>
      </div>

      {/* Tag row — emphasize hourly rate + verification + work type */}
      <div className="flex flex-wrap items-center gap-1.5">
        <span
          className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-semibold ${
            available ? "bg-[#49D7A7]/10 text-[#1a9e73]" : "bg-gray-100 text-gray-400"
          }`}
        >
          <span className={`size-1.5 rounded-full ${available ? "bg-[#49D7A7]" : "bg-gray-400"}`} />
          {available ? "Available" : "Later"}
        </span>
        {profile.hourly_rate != null && (
          <span className="rounded-full bg-[#7E47FF]/10 px-2 py-0.5 text-[10px] font-bold text-[#7E47FF]">
            ${profile.hourly_rate}/hr
          </span>
        )}
        {fullyVerified && (
          <span className="inline-flex items-center gap-1 rounded-full bg-blue-50 px-2 py-0.5 text-[10px] font-semibold text-blue-700">
            <ShieldCheck className="size-3" strokeWidth={2.5} />
            Verified
          </span>
        )}
        {profile.work_type && (
          <span className="rounded-full bg-gray-50 px-2 py-0.5 text-[10px] font-medium text-gray-600">
            {profile.work_type}
          </span>
        )}
        {profile.hours_per_week && (
          <span className="rounded-full bg-gray-50 px-2 py-0.5 text-[10px] font-medium text-gray-600">
            {profile.hours_per_week}
          </span>
        )}
      </div>

      {visibleSkills.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {visibleSkills.map((s) => (
            <span
              key={s}
              className="rounded-full bg-[#7E47FF]/10 px-2.5 py-0.5 text-[10px] font-medium text-[#7E47FF]"
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

      <div className="-mx-4 -mb-4 mt-auto flex min-h-11 items-center justify-between border-t border-gray-100 bg-gray-50/50 px-4 py-3 text-sm font-semibold text-[#7E47FF]">
        View profile
        <ChevronRight className="size-4" strokeWidth={2.5} />
      </div>
    </button>
  );
}

// ── Mobile filter bottom sheet ───────────────────────────────

function FilterSheetGroup({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  value: string;
  onChange: (next: string) => void;
}) {
  return (
    <div>
      <p className="mb-2 text-sm font-bold text-[#111]">{label}</p>
      <div className="flex flex-wrap gap-2">
        {options.map((opt) => {
          const active = value === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => onChange(opt.value)}
              className={`min-h-10 rounded-xl px-4 py-2 text-sm font-medium transition-colors ${
                active
                  ? "bg-[#7E47FF] text-white"
                  : "border border-gray-200 bg-gray-50 text-gray-700 hover:bg-gray-100"
              }`}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── Main Dashboard ───────────────────────────────────────────

export function RemoteTalentDashboard({
  email,
  userRole,
  initialProfiles,
  initialOpenId,
  initialSearch,
}: {
  email: string;
  userRole: UserRole;
  initialProfiles: RemoteTalentProfile[];
  initialOpenId: string | null;
  initialSearch: string;
}) {
  const router = useRouter();
  const isSuperAdmin = userRole === "super_admin";

  const [profiles, setProfiles] = useState<RemoteTalentProfile[]>(initialProfiles);
  const [search, setSearch] = useState(initialSearch);
  const [filterStatus, setFilterStatus] = useState<string>("All");
  const [filterAvailability, setFilterAvailability] = useState<string>("All");
  const [filterWorkType, setFilterWorkType] = useState<string>("All");
  const [filterHours, setFilterHours] = useState<string>("All");

  const [openId, setOpenId] = useState<string | null>(initialOpenId);
  const [toast, setToast] = useState<string | null>(null);

  const [deleteTarget, setDeleteTarget] = useState<RemoteTalentProfile | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Mobile-only UI state. The profile drawer's structural mobile/desktop
  // difference is handled with Tailwind `lg:` classes inside ProfileDrawer
  // (full-width panel on <lg, 460px side drawer on lg+) — no JS branch needed.
  const [filterDrawerOpen, setFilterDrawerOpen] = useState(false);

  // Body-scroll lock for the mobile filter drawer + ESC to close.
  useEffect(() => {
    if (!filterDrawerOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setFilterDrawerOpen(false);
    }
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [filterDrawerOpen]);

  function clearAllFilters() {
    setFilterStatus("All");
    setFilterAvailability("All");
    setFilterWorkType("All");
    setFilterHours("All");
  }

  const activeFilterCount =
    (filterStatus !== "All" ? 1 : 0) +
    (filterAvailability !== "All" ? 1 : 0) +
    (filterWorkType !== "All" ? 1 : 0) +
    (filterHours !== "All" ? 1 : 0);

  useEffect(() => {
    setProfiles(initialProfiles);
  }, [initialProfiles]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2500);
    return () => clearTimeout(t);
  }, [toast]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return profiles.filter((p) => {
      if (filterStatus !== "All" && p.status !== filterStatus) return false;
      if (filterAvailability === "Available Now"   && !isAvailableNow(p)) return false;
      if (filterAvailability === "Available Later" &&  isAvailableNow(p)) return false;
      if (filterWorkType !== "All" && (p.work_type ?? "") !== filterWorkType) return false;
      if (filterHours !== "All" && (p.hours_per_week ?? "") !== filterHours) return false;
      if (q) {
        const blob = [
          p.first_name,
          p.last_name,
          p.email,
          p.job_titles ?? "",
          p.bio ?? "",
          p.city ?? "",
          p.country ?? "",
          ...(p.skills ?? []),
        ].join(" ").toLowerCase();
        if (!blob.includes(q)) return false;
      }
      return true;
    });
  }, [profiles, search, filterStatus, filterAvailability, filterWorkType, filterHours]);

  const totalCount     = profiles.length;
  const availableCount = profiles.filter(isAvailableNow).length;
  const pendingCount   = profiles.filter((p) => p.status === "pending").length;

  // Client-side pagination — see pagination-controls.tsx for rationale.
  const [page, setPage] = useState(1);
  useEffect(() => {
    setPage(1);
  }, [search, filterStatus, filterAvailability, filterWorkType, filterHours]);
  const pageItems = paginate(filtered, page);

  const openProfile = openId ? profiles.find((p) => p.id === openId) ?? null : null;

  async function handleSetStatus(profile: RemoteTalentProfile, status: RemoteTalentStatus) {
    const optimisticPatch: Partial<RemoteTalentProfile> = { status };
    if (status === "approved" && !profile.approved_at) {
      optimisticPatch.approved_at = new Date().toISOString();
    }
    setProfiles((prev) =>
      prev.map((p) => (p.id === profile.id ? { ...p, ...optimisticPatch } : p)),
    );

    const result = await updateRemoteTalentStatus(profile.id, status);
    if (result.success) {
      setToast(`Marked as ${STATUS_LABELS[status]}`);
      router.refresh();
    } else {
      setProfiles((prev) => prev.map((p) => (p.id === profile.id ? profile : p)));
      setToast(`Update failed: ${result.error}`);
    }
  }

  async function handleResetToApproved(profile: RemoteTalentProfile) {
    setProfiles((prev) =>
      prev.map((p) => (p.id === profile.id ? { ...p, status: "approved" } : p)),
    );

    const result = await updateRemoteTalentStatus(profile.id, "approved");
    if (result.success) {
      setToast("Profile reactivated as Approved");
      router.refresh();
    } else {
      setProfiles((prev) => prev.map((p) => (p.id === profile.id ? profile : p)));
      setToast(`Reset failed: ${result.error}`);
    }
  }

  async function handleDelete(profile: RemoteTalentProfile) {
    setDeleting(true);
    const result = await deleteRemoteTalentProfile(profile.id);
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

      <main className="mx-auto max-w-screen-2xl px-4 py-6 lg:px-8 lg:py-8">
        <div className="mb-6 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-xs text-gray-400">Remote Talent</p>
            <h1 className="font-heading text-2xl font-bold text-gray-900">Remote Talent Network</h1>
            <p className="mt-1 text-sm text-gray-500">
              {totalCount} total · {availableCount} available · {pendingCount} pending
            </p>
          </div>

          {/* Search bar — desktop only; mobile gets the search+filter row below */}
          <div className="hidden flex-1 items-center gap-2 rounded-2xl bg-white p-2 shadow-sm lg:flex lg:max-w-md">
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

        {/* Mobile search + filter trigger */}
        <div className="mb-4 flex items-center gap-2 lg:hidden">
          <div className="relative flex-1">
            <SearchIcon
              className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-gray-400"
              strokeWidth={2}
            />
            <input
              type="text"
              placeholder="Search by name, skill…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full rounded-xl border border-gray-200 bg-white py-3 pl-10 pr-4 text-sm text-gray-800 outline-none placeholder:text-gray-400 focus:border-[#7E47FF]/40 focus:ring-2 focus:ring-[#7E47FF]/20"
            />
          </div>
          <button
            type="button"
            onClick={() => setFilterDrawerOpen(true)}
            className="relative flex min-h-11 items-center gap-2 rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm font-semibold text-gray-700 transition-colors hover:bg-gray-50"
          >
            <SlidersHorizontal className="size-4" strokeWidth={2} />
            Filters
            {activeFilterCount > 0 && (
              <span className="absolute -right-1 -top-1 flex size-5 items-center justify-center rounded-full bg-[#7E47FF] text-[10px] font-bold text-white">
                {activeFilterCount}
              </span>
            )}
          </button>
        </div>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[220px_1fr]">
          {/* Filter sidebar — desktop only */}
          <aside className="hidden lg:sticky lg:top-20 lg:block lg:self-start">
            <div className="rounded-2xl border border-black/[0.05] bg-white p-5 shadow-sm">
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

              <FilterGroup title="Hours">
                {HOURS_FILTERS.map((h) => (
                  <FilterPill
                    key={h}
                    label={h}
                    active={filterHours === h}
                    onClick={() => setFilterHours(h)}
                  />
                ))}
              </FilterGroup>
            </div>
          </aside>

          <div>
            {filtered.length === 0 ? (
              <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-gray-200 bg-white py-20 text-center">
                <Briefcase className="mb-3 size-8 text-gray-300" strokeWidth={1.5} />
                <p className="font-heading text-sm font-semibold text-gray-700">No remote talent matches your filters</p>
                <p className="mt-1 text-xs text-gray-400">Try clearing a filter or broadening your search.</p>
              </div>
            ) : (
              <>
                {/* Desktop card grid — unchanged */}
                <div className="hidden gap-4 lg:grid lg:grid-cols-1 xl:grid-cols-2">
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

                {/* Mobile card list */}
                <div className="flex flex-col gap-3 lg:hidden">
                  {pageItems.map((p) => (
                    <RemoteTalentCardMobile
                      key={p.id}
                      profile={p}
                      onView={() => setOpenId(p.id)}
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

      {/* Mobile filter bottom sheet — slides up from bottom on <lg */}
      <div
        className={`fixed inset-0 z-40 bg-black/50 transition-opacity duration-300 lg:hidden ${
          filterDrawerOpen
            ? "pointer-events-auto opacity-100"
            : "pointer-events-none opacity-0"
        }`}
        onClick={() => setFilterDrawerOpen(false)}
        aria-hidden="true"
      />
      <div
        className={`fixed inset-x-0 bottom-0 z-50 max-h-[85vh] overflow-y-auto rounded-t-3xl bg-white p-6 shadow-2xl transition-transform duration-300 ease-out lg:hidden ${
          filterDrawerOpen ? "translate-y-0" : "translate-y-full"
        }`}
        aria-hidden={!filterDrawerOpen}
      >
        <div className="mb-6 flex items-center justify-between">
          <h3 className="font-heading text-lg font-bold text-[#111]">
            Filters
            {activeFilterCount > 0 && (
              <span className="ml-2 rounded-full bg-[#7E47FF]/10 px-2 py-0.5 text-xs font-semibold text-[#7E47FF]">
                {activeFilterCount}
              </span>
            )}
          </h3>
          <button
            type="button"
            onClick={() => setFilterDrawerOpen(false)}
            aria-label="Close filters"
            className="flex size-11 items-center justify-center rounded-xl bg-gray-50 text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-800"
          >
            <X className="size-5" strokeWidth={2} />
          </button>
        </div>

        <div className="flex flex-col gap-5">
          <FilterSheetGroup
            label="Status"
            value={filterStatus}
            onChange={setFilterStatus}
            options={STATUS_FILTERS.map((s) => ({
              value: s,
              label: STATUS_LABELS[s] ?? s,
            }))}
          />
          <FilterSheetGroup
            label="Availability"
            value={filterAvailability}
            onChange={setFilterAvailability}
            options={AVAILABILITY_FILTERS.map((a) => ({ value: a, label: a }))}
          />
          <FilterSheetGroup
            label="Work Type"
            value={filterWorkType}
            onChange={setFilterWorkType}
            options={WORK_TYPE_FILTERS.map((w) => ({ value: w, label: w }))}
          />
          <FilterSheetGroup
            label="Hours"
            value={filterHours}
            onChange={setFilterHours}
            options={HOURS_FILTERS.map((h) => ({ value: h, label: h }))}
          />
        </div>

        <div className="mt-6 flex gap-3 border-t border-gray-100 pt-6">
          <button
            type="button"
            onClick={clearAllFilters}
            disabled={activeFilterCount === 0}
            className="flex min-h-11 flex-1 items-center justify-center rounded-xl border border-gray-200 py-3 text-sm font-semibold text-gray-700 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Clear all
          </button>
          <button
            type="button"
            onClick={() => setFilterDrawerOpen(false)}
            className="flex min-h-11 flex-1 items-center justify-center rounded-xl bg-[#7E47FF] py-3 text-sm font-semibold text-white transition-colors hover:bg-[#6a38e0]"
          >
            Apply
          </button>
        </div>
      </div>

      {openProfile && (
        <ProfileDrawer
          profile={openProfile}
          isSuperAdmin={isSuperAdmin}
          onClose={() => setOpenId(null)}
          onSetStatus={(status) => handleSetStatus(openProfile, status)}
          onReset={() => handleResetToApproved(openProfile)}
          onDelete={() => setDeleteTarget(openProfile)}
          onToast={setToast}
        />
      )}

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
                  {fullName(deleteTarget)}
                </span>{" "}
                from the remote talent network. This action cannot be undone.
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

      {toast && (
        <div className="fixed bottom-6 right-6 z-50 flex items-center gap-2.5 rounded-xl bg-gray-900 px-4 py-3 text-sm font-medium text-white shadow-xl">
          {toast}
        </div>
      )}
    </div>
  );
}
