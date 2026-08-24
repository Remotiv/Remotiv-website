"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  Archive,
  Check,
  CheckCircle,
  ChevronRight,
  Copy,
  Eye,
  EyeOff,
  KeyRound,
  Mail,
  PauseCircle,
  Pencil,
  Plus,
  PlayCircle,
  RefreshCcw,
  Save,
  Search as SearchIcon,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { TopNav } from "./top-nav";
import { useFocusTrap } from "./_shared/use-focus-trap";
import {
  createCompany,
  deleteCompany,
  resetCompanyPassword,
  updateCompany,
  type Company,
} from "@/app/admin/companies/actions";
import { type CompanyStatus } from "@/app/ai-dashboard/lib/company-roles";
import { type UserRole } from "@/app/admin/lib/roles";

// ── Constants ────────────────────────────────────────────────

const STATUS_FILTERS: Array<"All" | CompanyStatus> = ["All", "active", "paused", "archived"];

const STATUS_LABELS: Record<string, string> = {
  All: "All",
  active: "Active",
  paused: "Paused",
  archived: "Archived",
};

const STATUS_BADGE: Record<CompanyStatus, { badge: string; dot: string }> = {
  active:   { badge: "bg-green-100 text-green-700",    dot: "bg-green-500" },
  paused:   { badge: "bg-amber-100 text-amber-700",    dot: "bg-amber-500" },
  archived: { badge: "bg-gray-100 text-gray-500",      dot: "bg-gray-400"  },
};

const COMPANY_LOGIN_URL =
  process.env.NEXT_PUBLIC_AI_DASHBOARD_URL ?? "/ai-dashboard/login";

// ── Helpers ──────────────────────────────────────────────────

function getCompanyInitials(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase() ?? "")
      .join("") || "?"
  );
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

function fmtDateTime(iso: string): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function generatePassword(length = 12): string {
  // Letters + digits + a small symbol set, avoiding ambiguous chars (l, I, O, 0).
  const chars = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@$%&*";
  let out = "";
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    const bytes = new Uint32Array(length);
    crypto.getRandomValues(bytes);
    for (let i = 0; i < length; i++) {
      out += chars[bytes[i] % chars.length];
    }
  } else {
    for (let i = 0; i < length; i++) {
      out += chars[Math.floor(Math.random() * chars.length)];
    }
  }
  return out;
}

// ── Avatar ───────────────────────────────────────────────────

function Avatar({ company, size }: { company: string; size: number }) {
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-full bg-remotiv-purple/10 font-bold text-remotiv-purple"
      style={{ width: size, height: size, fontSize: Math.max(11, size / 2.6) }}
    >
      {getCompanyInitials(company)}
    </span>
  );
}

// ── Stat card ────────────────────────────────────────────────

function StatCard({
  label,
  value,
  tint,
}: {
  label: string;
  value: number;
  tint: string;
}) {
  return (
    <div className="rounded-2xl border border-black/[0.05] bg-white p-5 shadow-sm">
      <p className={`text-[10px] font-semibold uppercase tracking-widest ${tint}`}>{label}</p>
      <p className="mt-2 font-heading text-2xl font-bold text-gray-900">{value}</p>
    </div>
  );
}

// ── Company Card ─────────────────────────────────────────────

function CompanyCard({
  company,
  onManage,
}: {
  company: Company;
  onManage: () => void;
}) {
  const meta = STATUS_BADGE[company.status];
  return (
    <div className="flex flex-col gap-4 rounded-2xl border border-black/[0.05] bg-white p-5 shadow-sm transition-shadow hover:shadow-md">
      <div className="flex items-center justify-between">
        <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-semibold ${meta.badge}`}>
          <span className={`size-1.5 rounded-full ${meta.dot}`} />
          {STATUS_LABELS[company.status] ?? company.status}
        </span>
        <span className="text-[10px] text-gray-300">{fmtDaysAgo(company.created_at)}</span>
      </div>

      <div className="flex items-start gap-3">
        <Avatar company={company.name} size={48} />
        <div className="min-w-0 flex-1">
          <p className="truncate font-heading text-base font-bold text-gray-900">
            {company.name}
          </p>
          {company.contact_name && (
            <p className="truncate text-xs text-gray-500">{company.contact_name}</p>
          )}
          <a
            href={`mailto:${company.contact_email}`}
            className="mt-1 flex items-center gap-1 text-[11px] text-gray-400 hover:text-remotiv-purple"
          >
            <Mail className="size-3" strokeWidth={2} />
            <span className="truncate">{company.contact_email}</span>
          </a>
        </div>
      </div>

      <p className="flex items-center gap-3 text-[11px] font-medium text-gray-500">
        <span className="inline-flex items-center gap-1">
          <Users className="size-3" strokeWidth={2} />
          {company.member_count} {company.member_count === 1 ? "Member" : "Members"}
        </span>
      </p>

      <button
        type="button"
        onClick={onManage}
        className="mt-auto flex items-center justify-center gap-1.5 rounded-xl bg-remotiv-purple/10 px-4 py-2 text-xs font-semibold text-remotiv-purple transition-colors hover:bg-remotiv-purple/20"
      >
        Manage Company →
      </button>
    </div>
  );
}

// ── Mobile card (replaces the desktop CompanyCard on <lg) ────

function CompanyCardMobile({
  company,
  onManage,
}: {
  company: Company;
  onManage: () => void;
}) {
  const meta = STATUS_BADGE[company.status];
  return (
    <button
      type="button"
      onClick={onManage}
      className="flex w-full flex-col overflow-hidden rounded-2xl border border-gray-100 bg-white text-left shadow-sm transition-shadow active:shadow-md"
    >
      <div className="p-4">
        <div className="flex items-start gap-3">
          <Avatar company={company.name} size={40} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2">
              <p className="truncate font-heading text-base font-bold text-gray-900">
                {company.name}
              </p>
              <span
                className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${meta.badge}`}
              >
                {STATUS_LABELS[company.status] ?? company.status}
              </span>
            </div>
            {company.contact_name && (
              <p className="mt-0.5 truncate text-xs text-gray-500">
                {company.contact_name}
              </p>
            )}
            <p className="mt-0.5 truncate text-[11px] text-gray-400">
              {company.contact_email}
            </p>
          </div>
        </div>

        <div className="mt-3 text-xs">
          <p className="text-gray-400">Members</p>
          <p className="font-heading text-sm font-bold text-[#111]">
            {company.member_count}
          </p>
        </div>
      </div>

      <div className="flex min-h-11 items-center justify-between border-t border-gray-100 bg-gray-50/50 px-4 py-3 text-sm font-semibold text-remotiv-purple">
        View / Manage
        <ChevronRight className="size-4" strokeWidth={2.5} />
      </div>
    </button>
  );
}

// ── Mobile filter bottom-sheet group ─────────────────────────

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
                  ? "bg-remotiv-purple text-white"
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

// ── Drawer ───────────────────────────────────────────────────

function CompanyDrawer({
  company,
  onClose,
  onSetStatus,
  onDelete,
  onToast,
  onUpdated,
}: {
  company: Company;
  onClose: () => void;
  onSetStatus: (status: CompanyStatus) => Promise<void>;
  onDelete: () => void;
  onToast: (msg: string) => void;
  onUpdated: (patch: { name: string; contact_name: string; contact_email: string }) => void;
}) {
  const router = useRouter();
  const meta = STATUS_BADGE[company.status];

  const [showResetForm, setShowResetForm] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);

  const [busyStatus, setBusyStatus] = useState<CompanyStatus | null>(null);

  // Inline "Edit Details" form — mirrors the showResetForm pattern so the
  // drawer stays a single component. Fields are seeded from `company` here
  // AND re-seeded at button-click time so an optimistic parent update
  // between opens is picked up without stale local state.
  const [showEditForm, setShowEditForm] = useState(false);
  const [editName, setEditName] = useState(company.name);
  const [editContact, setEditContact] = useState(company.contact_name ?? "");
  const [editEmail, setEditEmail] = useState(company.contact_email);
  const [editSubmitting, setEditSubmitting] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  const [copiedField, setCopiedField] = useState<"email" | "url" | null>(null);
  const [copiedAll, setCopiedAll] = useState(false);

  useEffect(() => {
    setShowResetForm(false);
    setNewPassword("");
    setShowNewPassword(false);
    setResetError(null);
    setCopiedField(null);
    setCopiedAll(false);
  }, [company.id]);

  // Kept separate from the effect above because it depends on the editable
  // company fields; folding those into the reset effect's dep list would flip
  // Biome's useExhaustiveDependencies rule and clear reset state on unrelated
  // field changes.
  useEffect(() => {
    setShowEditForm(false);
    setEditName(company.name);
    setEditContact(company.contact_name ?? "");
    setEditEmail(company.contact_email);
    setEditError(null);
  }, [company.id, company.name, company.contact_name, company.contact_email]);

  async function handleCopyField(text: string, field: "email" | "url") {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedField(field);
      setTimeout(() => setCopiedField(null), 1500);
    } catch {
      // Clipboard write blocked — leave the user to copy manually.
    }
  }

  async function handleCopyAllCreds() {
    const blob = `Email: ${company.contact_email}\nLogin URL: ${COMPANY_LOGIN_URL}`;
    try {
      await navigator.clipboard.writeText(blob);
      setCopiedAll(true);
      setTimeout(() => setCopiedAll(false), 1500);
    } catch {
      // Clipboard write blocked — leave the user to copy manually.
    }
  }

  async function handleSetStatus(s: CompanyStatus) {
    setBusyStatus(s);
    await onSetStatus(s);
    setBusyStatus(null);
  }

  // Same belt-and-braces guard as createCompany — rotating a company's
  // password twice in quick succession is a real footgun (the second call
  // invalidates the password the admin just typed before the toast confirms).
  const resetInFlightRef = useRef(false);
  // Mirror guard for the edit path: an email change kicks a Supabase auth
  // updateUserById; firing it twice from a double-click is the same
  // half-successful footgun so we lock the ref until the server settles.
  const editInFlightRef = useRef(false);

  async function handleEditSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (editInFlightRef.current) return;
    setEditError(null);

    const nameTrim = editName.trim();
    const contactTrim = editContact.trim();
    const emailTrim = editEmail.trim();

    if (!nameTrim) {
      setEditError("Company name is required.");
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailTrim)) {
      setEditError("Please enter a valid email address.");
      return;
    }

    editInFlightRef.current = true;
    setEditSubmitting(true);
    try {
      const result = await updateCompany(company.id, {
        name: nameTrim,
        contact_name: contactTrim,
        contact_email: emailTrim,
      });
      if (result.success) {
        onToast("Company updated");
        // Optimistic parent update — no router.refresh(), the action already
        // ran revalidatePath so a subsequent navigation picks up the server
        // truth. Email is lowercased to match the action.
        onUpdated({
          name: nameTrim,
          contact_name: contactTrim,
          contact_email: emailTrim.toLowerCase(),
        });
        setShowEditForm(false);
      } else {
        setEditError(result.error);
      }
    } finally {
      editInFlightRef.current = false;
      setEditSubmitting(false);
    }
  }

  async function handleResetSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (resetInFlightRef.current) return;
    setResetError(null);
    if (newPassword.length < 8) {
      setResetError("Password must be at least 8 characters.");
      return;
    }
    resetInFlightRef.current = true;
    setResetting(true);
    try {
      const result = await resetCompanyPassword(company.id, newPassword);
      if (result.success) {
        onToast("Password updated");
        setShowResetForm(false);
        setNewPassword("");
        setShowNewPassword(false);
        router.refresh();
      } else {
        setResetError(result.error);
      }
    } finally {
      resetInFlightRef.current = false;
      setResetting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex">
      {/* Backdrop — desktop only. On mobile the panel covers the full
          viewport so a separate dim layer would be invisible. */}
      <button
        type="button"
        aria-label="Close drawer"
        className="hidden flex-1 bg-black/30 backdrop-blur-sm lg:block"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Company details"
        className="flex h-full w-full shrink-0 flex-col bg-white shadow-2xl lg:w-[420px]"
      >
        <div className="relative shrink-0 border-b border-gray-100 px-4 py-5 lg:px-6 lg:py-6">
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="absolute right-3 top-3 flex size-11 items-center justify-center rounded-full text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600 lg:right-4 lg:top-4 lg:size-8"
          >
            <X className="size-5 lg:size-4" strokeWidth={2.5} />
          </button>
          <div className="flex items-start gap-4">
            <Avatar company={company.name} size={68} />
            <div className="min-w-0 flex-1 pr-8">
              <p className="truncate font-heading text-xl font-bold text-gray-900">
                {company.name}
              </p>
              {company.contact_name && (
                <p className="truncate text-sm text-gray-500">{company.contact_name}</p>
              )}
              <a
                href={`mailto:${company.contact_email}`}
                className="mt-1 flex items-center gap-1 text-xs text-gray-400 hover:text-remotiv-purple"
              >
                <Mail className="size-3" strokeWidth={2} />
                <span className="truncate">{company.contact_email}</span>
              </a>
              <span className={`mt-2 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-semibold ${meta.badge}`}>
                <span className={`size-1.5 rounded-full ${meta.dot}`} />
                {STATUS_LABELS[company.status] ?? company.status}
              </span>
            </div>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          {/* Login Credentials — always visible at the top of the panel. */}
          <section className="mb-5 rounded-2xl border border-remotiv-purple/15 bg-remotiv-purple/5 p-4">
            <div className="mb-3 flex items-center justify-between gap-2">
              <h3 className="text-[10px] font-bold uppercase tracking-widest text-remotiv-purple">
                Login Credentials
              </h3>
              <button
                type="button"
                onClick={handleCopyAllCreds}
                className="flex min-h-[36px] items-center gap-1 rounded-lg px-2 text-xs font-semibold text-remotiv-purple transition-colors hover:bg-remotiv-purple/10"
              >
                {copiedAll ? (
                  <>
                    <Check className="size-3.5" strokeWidth={2.5} />
                    Copied!
                  </>
                ) : (
                  <>
                    <Copy className="size-3.5" strokeWidth={2} />
                    Copy All
                  </>
                )}
              </button>
            </div>

            <div className="space-y-2.5">
              <div className="rounded-xl border border-remotiv-purple/10 bg-white p-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">
                      Login Email
                    </p>
                    <p className="mt-0.5 truncate text-sm font-semibold text-[#111]">
                      {company.contact_email}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleCopyField(company.contact_email, "email")}
                    aria-label={copiedField === "email" ? "Copied email" : "Copy email"}
                    className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-remotiv-purple/10 text-remotiv-purple transition-colors hover:bg-remotiv-purple/20"
                  >
                    {copiedField === "email" ? (
                      <Check className="size-4 text-green-600" strokeWidth={2.5} />
                    ) : (
                      <Copy className="size-4" strokeWidth={2} />
                    )}
                  </button>
                </div>
              </div>

              <div className="rounded-xl border border-remotiv-purple/10 bg-white p-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">
                      Login URL
                    </p>
                    <a
                      href={COMPANY_LOGIN_URL}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-0.5 block truncate font-mono text-xs text-remotiv-purple underline hover:text-[#6c39e0]"
                    >
                      {COMPANY_LOGIN_URL}
                    </a>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleCopyField(COMPANY_LOGIN_URL, "url")}
                    aria-label={copiedField === "url" ? "Copied URL" : "Copy URL"}
                    className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-remotiv-purple/10 text-remotiv-purple transition-colors hover:bg-remotiv-purple/20"
                  >
                    {copiedField === "url" ? (
                      <Check className="size-4 text-green-600" strokeWidth={2.5} />
                    ) : (
                      <Copy className="size-4" strokeWidth={2} />
                    )}
                  </button>
                </div>
              </div>
            </div>

            <p className="mt-3 text-[10px] text-gray-500">
              Use &quot;Reset Password&quot; below to generate a new password for this company.
            </p>
          </section>

          <DrawerSection title="Account Details">
            <div className="grid grid-cols-1 gap-2 text-xs">
              <DrawerKv label="Created" value={fmtDateTime(company.created_at)} />
              <DrawerKv label="User ID" value={company.user_id ?? "—"} mono />
              <DrawerKv label="Members" value={String(company.member_count)} />
            </div>
          </DrawerSection>

          <DrawerSection title="Actions">
            <div className="flex flex-col gap-2">
              {showEditForm ? (
                <form onSubmit={handleEditSubmit} className="flex flex-col gap-3 rounded-xl border border-gray-100 bg-gray-50/60 p-3">
                  <Field label="Company Name" required>
                    <input
                      type="text"
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      autoFocus
                      className={INPUT_CLS}
                    />
                  </Field>
                  <Field label="Contact Name">
                    <input
                      type="text"
                      value={editContact}
                      onChange={(e) => setEditContact(e.target.value)}
                      className={INPUT_CLS}
                    />
                  </Field>
                  <Field label="Contact Email" required hint="Also updates the Supabase auth login email.">
                    <input
                      type="email"
                      value={editEmail}
                      onChange={(e) => setEditEmail(e.target.value)}
                      className={INPUT_CLS}
                    />
                  </Field>
                  {editError && (
                    <p className="text-[10px] font-medium text-red-500">{editError}</p>
                  )}
                  <div className="flex gap-2">
                    <button
                      type="submit"
                      disabled={editSubmitting} aria-busy={editSubmitting}
                      className="flex flex-1 items-center justify-center gap-1 rounded-lg bg-remotiv-purple px-3 py-2 text-xs font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                    >
                      <Save className="size-3.5" strokeWidth={2} />
                      {editSubmitting ? "Saving…" : "Save"}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setShowEditForm(false);
                        setEditError(null);
                      }}
                      disabled={editSubmitting} aria-busy={editSubmitting}
                      className="rounded-lg border border-gray-200 px-3 py-2 text-xs font-medium text-gray-600 transition-colors hover:bg-gray-100 disabled:opacity-50"
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    setEditName(company.name);
                    setEditContact(company.contact_name ?? "");
                    setEditEmail(company.contact_email);
                    setEditError(null);
                    setShowEditForm(true);
                  }}
                  className="flex w-full items-center gap-2 rounded-xl border border-gray-100 bg-white px-3 py-2.5 text-xs font-semibold text-gray-700 transition-colors hover:bg-gray-50"
                >
                  <Pencil className="size-3.5 text-remotiv-purple" strokeWidth={2} />
                  Edit Details
                </button>
              )}

              {showResetForm ? (
                <form onSubmit={handleResetSubmit} className="flex flex-col gap-2 rounded-xl border border-gray-100 bg-gray-50/60 p-3">
                  <label className="text-[10px] font-semibold uppercase tracking-widest text-gray-400">
                    New Password (min 8 chars)
                  </label>
                  <div className="relative">
                    <input
                      type={showNewPassword ? "text" : "password"}
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      minLength={8}
                      autoFocus
                      className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 pr-9 text-sm text-gray-800 outline-none transition-colors focus:border-remotiv-purple focus:ring-2 focus:ring-remotiv-purple/20"
                    />
                    <button
                      type="button"
                      onClick={() => setShowNewPassword((v) => !v)}
                      aria-label={showNewPassword ? "Hide password" : "Show password"}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                    >
                      {showNewPassword ? <EyeOff className="size-4" strokeWidth={2} /> : <Eye className="size-4" strokeWidth={2} />}
                    </button>
                  </div>
                  {resetError && (
                    <p className="text-[10px] font-medium text-red-500">{resetError}</p>
                  )}
                  <div className="flex gap-2">
                    <button
                      type="submit"
                      disabled={resetting} aria-busy={resetting}
                      className="flex flex-1 items-center justify-center gap-1 rounded-lg bg-remotiv-purple px-3 py-2 text-xs font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                    >
                      <Save className="size-3.5" strokeWidth={2} />
                      {resetting ? "Saving…" : "Save"}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setShowResetForm(false);
                        setNewPassword("");
                        setResetError(null);
                      }}
                      disabled={resetting} aria-busy={resetting}
                      className="rounded-lg border border-gray-200 px-3 py-2 text-xs font-medium text-gray-600 transition-colors hover:bg-gray-100 disabled:opacity-50"
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              ) : (
                <button
                  type="button"
                  onClick={() => setShowResetForm(true)}
                  className="flex w-full items-center gap-2 rounded-xl border border-gray-100 bg-white px-3 py-2.5 text-xs font-semibold text-gray-700 transition-colors hover:bg-gray-50"
                >
                  <KeyRound className="size-3.5 text-remotiv-purple" strokeWidth={2} />
                  Reset Password
                </button>
              )}
            </div>
          </DrawerSection>

          <DrawerSection title="Status">
            <div className="grid grid-cols-1 gap-2">
              {company.status !== "active" && (
                <button
                  type="button"
                  disabled={busyStatus !== null}
                  onClick={() => handleSetStatus("active")}
                  className="flex items-center justify-center gap-1.5 rounded-xl bg-green-50 px-3 py-2.5 text-xs font-semibold text-green-700 transition-colors hover:bg-green-100 disabled:opacity-50"
                >
                  <PlayCircle className="size-3.5" strokeWidth={2} />
                  {busyStatus === "active" ? "Reactivating…" : "Reactivate"}
                </button>
              )}
              {company.status !== "paused" && (
                <button
                  type="button"
                  disabled={busyStatus !== null}
                  onClick={() => handleSetStatus("paused")}
                  className="flex items-center justify-center gap-1.5 rounded-xl bg-amber-50 px-3 py-2.5 text-xs font-semibold text-amber-700 transition-colors hover:bg-amber-100 disabled:opacity-50"
                >
                  <PauseCircle className="size-3.5" strokeWidth={2} />
                  {busyStatus === "paused" ? "Pausing…" : "Pause"}
                </button>
              )}
              {company.status !== "archived" && (
                <button
                  type="button"
                  disabled={busyStatus !== null}
                  onClick={() => handleSetStatus("archived")}
                  className="flex items-center justify-center gap-1.5 rounded-xl bg-gray-100 px-3 py-2.5 text-xs font-semibold text-gray-600 transition-colors hover:bg-gray-200 disabled:opacity-50"
                >
                  <Archive className="size-3.5" strokeWidth={2} />
                  {busyStatus === "archived" ? "Archiving…" : "Archive"}
                </button>
              )}
            </div>
          </DrawerSection>

          <DrawerSection title="Danger">
            <button
              type="button"
              onClick={onDelete}
              className="flex w-full items-center justify-center gap-1.5 rounded-xl bg-red-50 px-3 py-2.5 text-xs font-semibold text-red-600 transition-colors hover:bg-red-100"
            >
              <Trash2 className="size-3.5" strokeWidth={2} />
              Delete Company
            </button>
            <p className="mt-2 text-[10px] leading-relaxed text-gray-400">
              Deleting a company also removes their auth account and cascades all team members.
            </p>
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
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-baseline gap-3">
      <span className="w-20 shrink-0 text-[10px] uppercase tracking-widest text-gray-300">
        {label}
      </span>
      <span className={`flex-1 break-all text-gray-700 ${mono ? "font-mono text-[11px]" : ""}`}>
        {value}
      </span>
    </div>
  );
}

// ── Create Company Modal ─────────────────────────────────────

function CreateCompanyModal({
  onClose,
  onSuccess,
}: {
  onClose: () => void;
  onSuccess: (creds: {
    name: string;
    email: string;
    password: string | null;
    linked: boolean;
  }) => void;
}) {
  const [name, setName] = useState("");
  const [contactName, setContactName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !submitting) onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, submitting]);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, []);

  // Belt-and-braces double-click guard. On the CREATE path a second call would
  // leave an orphan auth account behind the failed company insert. On the LINK
  // path nothing is created, so the second call is merely refused by
  // companies_contact_email_key — harmless, but still worth not sending.
  const inFlightRef = useRef(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (inFlightRef.current) return;
    setError(null);
    if (!name.trim()) return setError("Company name is required.");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      return setError("Please enter a valid email address.");
    }
    // Blank is allowed: it means "this person already has a Remotiv login,
    // link it". A password that IS typed still has to be a usable one.
    if (password.length > 0 && password.length < 8) {
      return setError("Password must be at least 8 characters, or leave it blank to link an existing account.");
    }

    inFlightRef.current = true;
    setSubmitting(true);
    try {
      const result = await createCompany({
        name: name.trim(),
        contact_name: contactName.trim(),
        contact_email: email.trim(),
        password,
      });

      if (!result.success) {
        setError(result.error);
        return;
      }

      onSuccess({
        name: name.trim(),
        email: email.trim().toLowerCase(),
        // Never a password on the link path — the account kept its own, and
        // this field may hold one the admin typed that was then discarded.
        password: result.data.linked ? null : password,
        linked: result.data.linked,
      });
    } finally {
      inFlightRef.current = false;
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 backdrop-blur-sm sm:p-8">
      <button
        type="button"
        aria-label="Close modal"
        onClick={() => !submitting && onClose()}
        className="absolute inset-0 -z-10 cursor-default"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-company-title"
        className="relative my-4 flex w-full max-w-[480px] flex-col overflow-hidden rounded-2xl bg-white shadow-2xl"
      >
        <div className="relative shrink-0 border-b border-gray-100 px-6 py-5">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting} aria-busy={submitting}
            aria-label="Close"
            className="absolute right-4 top-4 flex size-9 items-center justify-center rounded-full text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600 disabled:opacity-50"
          >
            <X className="size-4" strokeWidth={2.5} />
          </button>
          <h2
            id="create-company-title"
            className="font-heading text-lg font-bold text-gray-900"
          >
            Create New Company
          </h2>
          <p className="mt-0.5 text-xs text-gray-500">
            Provisions an auth account, a companies row, and an owner membership.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4 px-6 py-5">
          <Field label="Company Name" required>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Acme Inc."
              className={INPUT_CLS}
            />
          </Field>
          <Field label="Contact Name">
            <input
              type="text"
              value={contactName}
              onChange={(e) => setContactName(e.target.value)}
              placeholder="Jane Doe"
              className={INPUT_CLS}
            />
          </Field>
          <Field label="Contact Email" required>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="contact@acme.com"
              className={INPUT_CLS}
            />
          </Field>
          <Field
            label="Password"
            hint="Minimum 8 characters. Leave blank if this person already has a Remotiv login — their existing password is kept."
          >
            <div className="relative">
              <input
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                minLength={8}
                placeholder="Blank to link an existing account"
                className={`${INPUT_CLS} pr-20`}
              />
              <div className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-1">
                <button
                  type="button"
                  onClick={() => setPassword(generatePassword())}
                  className="rounded-md px-2 py-1 text-[10px] font-semibold text-remotiv-purple hover:bg-remotiv-purple/10"
                  title="Auto-generate a 12-character password"
                >
                  <RefreshCcw className="inline size-3" strokeWidth={2} />
                  <span className="ml-1">Auto</span>
                </button>
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  className="rounded-md p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
                >
                  {showPassword ? <EyeOff className="size-4" strokeWidth={2} /> : <Eye className="size-4" strokeWidth={2} />}
                </button>
              </div>
            </div>
          </Field>

          {error && (
            <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {error}
            </div>
          )}

          <div className="mt-2 flex items-center justify-end gap-3 border-t border-gray-100 pt-4">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting} aria-busy={submitting}
              className="rounded-xl border border-gray-200 px-5 py-2.5 text-sm font-semibold text-gray-600 transition-colors hover:bg-gray-50 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting} aria-busy={submitting}
              className="flex items-center gap-2 rounded-xl bg-remotiv-purple px-5 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-60"
            >
              <Plus className="size-4" strokeWidth={2.5} />
              {submitting ? "Creating…" : "Create Company"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function Field({
  label,
  required,
  hint,
  children,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-gray-500">
        {label}
        {required && <span className="ml-0.5 text-red-500">*</span>}
      </span>
      {children}
      {hint && <p className="mt-1 text-[11px] text-gray-400">{hint}</p>}
    </div>
  );
}

const INPUT_CLS =
  "w-full h-10 rounded-lg border border-gray-200 px-3 text-sm text-gray-800 outline-none transition-colors focus:border-remotiv-purple focus:ring-2 focus:ring-remotiv-purple/20";

// ── Credentials Modal (after successful create) ──────────────

function CredentialsModal({
  creds,
  onClose,
}: {
  creds: { name: string; email: string; password: string | null; linked: boolean };
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);

  // A linked account kept its own password, and this modal has none to show.
  // Printing an empty or stale one would be worse than the error this path
  // replaced: the admin would send credentials that do not work.
  const blob = creds.password
    ? `Email: ${creds.email}\nPassword: ${creds.password}\nURL: ${COMPANY_LOGIN_URL}`
    : `Email: ${creds.email}\nPassword: their existing Remotiv password (unchanged)\nURL: ${COMPANY_LOGIN_URL}`;

  async function copyAll() {
    try {
      await navigator.clipboard.writeText(blob);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard write blocked — leave the user to copy manually.
    }
  }

  const credsTrapRef = useFocusTrap<HTMLDivElement>(true, onClose);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm">
      <div
        ref={credsTrapRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="company-credentials-modal-title"
        className="w-full max-w-md overflow-hidden rounded-2xl bg-white shadow-2xl"
      >
        <div className="px-6 py-5 text-center">
          <div className="mx-auto mb-3 flex size-12 items-center justify-center rounded-full bg-green-100">
            <CheckCircle className="size-6 text-green-600" strokeWidth={2} />
          </div>
          <h3
            id="company-credentials-modal-title"
            className="font-heading text-lg font-bold text-gray-900"
          >
            {creds.linked ? "Company Linked to an Existing Account" : "Company Created Successfully"}
          </h3>
          <p className="mt-1 text-xs text-gray-500">
            {creds.linked ? (
              <>
                <span className="font-semibold text-gray-700">{creds.email}</span> already had a
                Remotiv account. It is now also the owner of{" "}
                <span className="font-semibold text-gray-700">{creds.name}</span> — no new account,
                no new password. Tell them to sign in as they always do.
              </>
            ) : (
              <>
                Send these credentials to{" "}
                <span className="font-semibold text-gray-700">{creds.name}</span>:
              </>
            )}
          </p>
        </div>

        <div className="mx-6 mb-5 flex flex-col gap-2 rounded-xl border border-gray-100 bg-gray-50 p-4 font-mono text-[12px] text-gray-700">
          <div>
            <span className="text-gray-400">Email:</span>{" "}
            <span className="font-semibold">{creds.email}</span>
          </div>
          <div>
            <span className="text-gray-400">Password:</span>{" "}
            {creds.password ? (
              <span className="font-semibold">{creds.password}</span>
            ) : (
              <span className="italic text-gray-500">unchanged — they keep their existing one</span>
            )}
          </div>
          <div>
            <span className="text-gray-400">URL:</span>{" "}
            <a
              href={COMPANY_LOGIN_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="font-semibold text-remotiv-purple hover:underline"
            >
              {COMPANY_LOGIN_URL}
            </a>
          </div>
        </div>

        <div className="flex gap-3 border-t border-gray-100 px-6 py-4">
          <button
            type="button"
            onClick={copyAll}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-xl border border-gray-200 py-2.5 text-sm font-semibold text-gray-700 transition-colors hover:bg-gray-50"
          >
            {copied ? (
              <>
                <CheckCircle className="size-4 text-green-600" strokeWidth={2.5} />
                Copied
              </>
            ) : (
              <>
                <Copy className="size-4" strokeWidth={2} />
                Copy All
              </>
            )}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-remotiv-green py-2.5 text-sm font-semibold text-[#1a4f3a] transition-opacity hover:opacity-90"
          >
            <CheckCircle className="size-4" strokeWidth={2.5} />
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main Dashboard ───────────────────────────────────────────

export function CompaniesDashboard({
  email,
  userRole,
  initialCompanies,
}: {
  email: string;
  userRole: UserRole;
  initialCompanies: Company[];
}) {
  const router = useRouter();

  const [companies, setCompanies] = useState<Company[]>(initialCompanies);
  const [search, setSearch] = useState("");
  const [filterStatus, setFilterStatus] = useState<string>("All");

  // Mobile-only UI state. Drawer responsiveness uses Tailwind `lg:` classes
  // (full-width panel on <lg, 420px side drawer on lg+) — no JS branch needed.
  const [filterDrawerOpen, setFilterDrawerOpen] = useState(false);
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
  const activeFilterCount = filterStatus !== "All" ? 1 : 0;

  const [openId, setOpenId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [createdCreds, setCreatedCreds] = useState<
    | { name: string; email: string; password: string | null; linked: boolean }
    | null
  >(null);
  const [deleteTarget, setDeleteTarget] = useState<Company | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    setCompanies(initialCompanies);
  }, [initialCompanies]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2500);
    return () => clearTimeout(t);
  }, [toast]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return companies.filter((c) => {
      if (filterStatus !== "All" && c.status !== filterStatus) return false;
      if (q) {
        const blob = `${c.name} ${c.contact_name ?? ""} ${c.contact_email}`.toLowerCase();
        if (!blob.includes(q)) return false;
      }
      return true;
    });
  }, [companies, search, filterStatus]);

  const totalCount    = companies.length;
  const activeCount   = companies.filter((c) => c.status === "active").length;
  const pausedCount   = companies.filter((c) => c.status === "paused").length;
  const archivedCount = companies.filter((c) => c.status === "archived").length;

  const openCompany = openId ? companies.find((c) => c.id === openId) ?? null : null;

  // Optimistic local update after a successful edit in the drawer. Mirrors the
  // setCompanies spread in handleSetStatus but for editable detail fields;
  // deliberately no router.refresh() — updateCompany's revalidatePath already
  // invalidates the cache for next navigation.
  function handleCompanyUpdated(
    companyId: string,
    patch: { name: string; contact_name: string; contact_email: string },
  ) {
    setCompanies((prev) =>
      prev.map((c) =>
        c.id === companyId
          ? {
              ...c,
              name: patch.name,
              contact_name: patch.contact_name,
              contact_email: patch.contact_email,
            }
          : c,
      ),
    );
  }

  async function handleSetStatus(company: Company, status: CompanyStatus) {
    setCompanies((prev) =>
      prev.map((c) => (c.id === company.id ? { ...c, status } : c)),
    );
    const result = await updateCompany(company.id, { status });
    if (result.success) {
      setToast(`Marked as ${STATUS_LABELS[status]}`);
      router.refresh();
    } else {
      setCompanies((prev) => prev.map((c) => (c.id === company.id ? company : c)));
      setToast(`Update failed: ${result.error}`);
    }
  }

  async function handleDelete(company: Company) {
    setDeleting(true);
    const result = await deleteCompany(company.id);
    setDeleting(false);
    if (result.success) {
      setCompanies((prev) => prev.filter((c) => c.id !== company.id));
      if (openId === company.id) setOpenId(null);
      setDeleteTarget(null);
      setToast("Company deleted");
      router.refresh();
    } else {
      setToast(`Delete failed: ${result.error}`);
    }
  }

  return (
    <div className="min-h-screen bg-remotiv-bg">
      <TopNav email={email} userRole={userRole} />

      <main className="mx-auto max-w-screen-2xl px-4 py-6 lg:px-8 lg:py-8">
        <div className="mb-6 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-xs text-gray-400">AI Video Interviews</p>
            <h1 className="font-heading text-2xl font-bold text-gray-900">Companies</h1>
            <p className="mt-1 text-sm text-gray-500">
              {totalCount} total · {activeCount} active · {pausedCount} paused · {archivedCount} archived
            </p>
          </div>

          <div className="flex min-w-0 items-center gap-2 sm:gap-3">
            <div className="flex min-w-0 flex-1 items-center gap-2 rounded-2xl bg-white p-2 shadow-sm lg:w-[360px]">
              <SearchIcon className="ml-2 size-4 shrink-0 text-gray-400" strokeWidth={2} />
              <input
                type="search"
                aria-label="Search"
                placeholder="Search by company name or email…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="h-10 min-w-0 flex-1 bg-transparent text-sm text-gray-800 outline-none placeholder:text-gray-400"
              />
            </div>
            {/* Mobile filters trigger — desktop uses the inline pill row */}
            <button
              type="button"
              onClick={() => setFilterDrawerOpen(true)}
              aria-label="Open filters"
              className="relative flex min-h-11 shrink-0 items-center justify-center rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-sm font-semibold text-gray-700 transition-colors hover:bg-gray-50 lg:hidden"
            >
              <SlidersHorizontal className="size-4" strokeWidth={2} />
              {activeFilterCount > 0 && (
                <span className="absolute -right-1 -top-1 flex size-5 items-center justify-center rounded-full bg-remotiv-purple text-[10px] font-bold text-white">
                  {activeFilterCount}
                </span>
              )}
            </button>
            <button
              type="button"
              onClick={() => setShowCreate(true)}
              aria-label="New company"
              className="flex min-h-11 shrink-0 items-center gap-2 rounded-xl bg-remotiv-purple px-3 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90 sm:px-4"
            >
              <Plus className="size-4" strokeWidth={2.5} />
              <span className="hidden sm:inline">New Company</span>
              <span className="sm:hidden">New</span>
            </button>
          </div>
        </div>

        <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
          <StatCard label="Total"    value={totalCount}    tint="text-gray-400" />
          <StatCard label="Active"   value={activeCount}   tint="text-green-600" />
          <StatCard label="Paused"   value={pausedCount}   tint="text-amber-600" />
          <StatCard label="Archived" value={archivedCount} tint="text-gray-500" />
        </div>

        <div className="mb-6 hidden flex-wrap gap-2 lg:flex">
          {STATUS_FILTERS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setFilterStatus(s)}
              className={`rounded-full px-4 py-1.5 text-xs font-semibold transition-colors ${
                filterStatus === s
                  ? "bg-remotiv-purple text-white"
                  : "border border-gray-200 bg-white text-gray-500 hover:border-remotiv-purple/30 hover:text-gray-700"
              }`}
            >
              {STATUS_LABELS[s] ?? s}
            </button>
          ))}
        </div>

        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-gray-200 bg-white py-20 text-center">
            <Sparkles className="mb-3 size-8 text-gray-300" strokeWidth={1.5} />
            <p className="font-heading text-sm font-semibold text-gray-700">
              {companies.length === 0 ? "No companies yet" : "No companies match your filters"}
            </p>
            <p className="mt-1 text-xs text-gray-400">
              {companies.length === 0
                ? "Click \"New Company\" to provision the first account."
                : "Try clearing a filter or broadening your search."}
            </p>
          </div>
        ) : (
          <>
            {/* Desktop card grid */}
            <div className="hidden gap-4 lg:grid lg:grid-cols-1 xl:grid-cols-2">
              {filtered.map((c) => (
                <CompanyCard
                  key={c.id}
                  company={c}
                  onManage={() => setOpenId(c.id)}
                />
              ))}
            </div>

            {/* Mobile card list */}
            <div className="flex flex-col gap-3 lg:hidden">
              {filtered.map((c) => (
                <CompanyCardMobile
                  key={c.id}
                  company={c}
                  onManage={() => setOpenId(c.id)}
                />
              ))}
            </div>
          </>
        )}
      </main>

      {/* Mobile filter bottom sheet */}
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
              <span className="ml-2 rounded-full bg-remotiv-purple/10 px-2 py-0.5 text-xs font-semibold text-remotiv-purple">
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

        <FilterSheetGroup
          label="Status"
          value={filterStatus}
          onChange={setFilterStatus}
          options={STATUS_FILTERS.map((s) => ({
            value: s,
            label: STATUS_LABELS[s] ?? s,
          }))}
        />

        <div className="mt-6 flex gap-3 border-t border-gray-100 pt-6">
          <button
            type="button"
            onClick={() => setFilterStatus("All")}
            disabled={activeFilterCount === 0}
            className="flex min-h-11 flex-1 items-center justify-center rounded-xl border border-gray-200 py-3 text-sm font-semibold text-gray-700 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Clear
          </button>
          <button
            type="button"
            onClick={() => setFilterDrawerOpen(false)}
            className="flex min-h-11 flex-1 items-center justify-center rounded-xl bg-remotiv-purple py-3 text-sm font-semibold text-white transition-colors hover:bg-[#6a38e0]"
          >
            Apply
          </button>
        </div>
      </div>

      {openCompany && (
        <CompanyDrawer
          company={openCompany}
          onClose={() => setOpenId(null)}
          onSetStatus={(status) => handleSetStatus(openCompany, status)}
          onDelete={() => setDeleteTarget(openCompany)}
          onToast={setToast}
          onUpdated={(patch) => handleCompanyUpdated(openCompany.id, patch)}
        />
      )}

      {showCreate && (
        <CreateCompanyModal
          onClose={() => setShowCreate(false)}
          onSuccess={(creds) => {
            setShowCreate(false);
            setCreatedCreds(creds);
            router.refresh();
          }}
        />
      )}

      {createdCreds && (
        <CredentialsModal
          creds={createdCreds}
          onClose={() => setCreatedCreds(null)}
        />
      )}

      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-company-title"
            className="w-full max-w-sm overflow-hidden rounded-2xl bg-white shadow-2xl"
          >
            <div className="flex flex-col items-center p-8 text-center">
              <div className="mb-4 flex size-14 items-center justify-center rounded-full bg-red-50">
                <AlertTriangle className="size-7 text-red-500" strokeWidth={2} />
              </div>
              <h3 id="delete-company-title" className="font-heading text-lg font-bold text-gray-900">Delete company?</h3>
              <p className="mt-2 text-sm text-gray-500">
                This permanently removes{" "}
                <span className="font-semibold text-gray-700">
                  {deleteTarget.name}
                </span>
                , their auth account, and all team members. This action cannot be undone.
              </p>
            </div>
            <div className="flex gap-3 border-t border-gray-100 px-6 py-4">
              <button
                type="button"
                onClick={() => setDeleteTarget(null)}
                disabled={deleting} aria-busy={deleting}
                className="flex-1 rounded-xl border border-gray-200 py-2.5 text-sm font-medium text-gray-600 transition-colors hover:bg-gray-50 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => deleteTarget && handleDelete(deleteTarget)}
                disabled={deleting} aria-busy={deleting}
                className="flex-1 rounded-xl bg-red-600 py-2.5 text-sm font-semibold text-white transition-opacity hover:bg-red-700 disabled:opacity-50"
              >
                {deleting ? "Deleting…" : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div role="status" aria-live="polite" aria-atomic="true" className="fixed bottom-6 right-6 z-50 flex items-center gap-2.5 rounded-xl bg-gray-900 px-4 py-3 text-sm font-medium text-white shadow-xl">
          {toast}
        </div>
      )}
    </div>
  );
}
