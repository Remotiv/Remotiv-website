"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  Archive,
  Briefcase,
  Building2,
  Check,
  CheckCircle,
  ChevronRight,
  Copy,
  Eye,
  EyeOff,
  KeyRound,
  Mail,
  PauseCircle,
  Plus,
  PlayCircle,
  RefreshCcw,
  Save,
  Search as SearchIcon,
  SlidersHorizontal,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { TopNav } from "./top-nav";
import { useFocusTrap } from "./_shared/use-focus-trap";
import {
  createClient,
  deleteClient,
  resetClientPassword,
  updateClient,
  type Client,
  type ClientStatus,
} from "@/app/admin/clients/actions";
import { type UserRole } from "@/app/admin/lib/roles";

// ── Constants ────────────────────────────────────────────────

const STATUS_FILTERS: Array<"All" | ClientStatus> = ["All", "active", "paused", "archived"];

const STATUS_LABELS: Record<string, string> = {
  All: "All",
  active: "Active",
  paused: "Paused",
  archived: "Archived",
};

const STATUS_BADGE: Record<ClientStatus, { badge: string; dot: string }> = {
  active:   { badge: "bg-green-100 text-green-700",    dot: "bg-green-500" },
  paused:   { badge: "bg-amber-100 text-amber-700",    dot: "bg-amber-500" },
  archived: { badge: "bg-gray-100 text-gray-500",      dot: "bg-gray-400"  },
};

const CLIENT_LOGIN_URL =
  process.env.NEXT_PUBLIC_CLIENT_PORTAL_URL ?? "/client/login";

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

// ── Client Card ──────────────────────────────────────────────

function ClientCard({
  client,
  onManage,
}: {
  client: Client;
  onManage: () => void;
}) {
  const meta = STATUS_BADGE[client.status];
  return (
    <div className="flex flex-col gap-4 rounded-2xl border border-black/[0.05] bg-white p-5 shadow-sm transition-shadow hover:shadow-md">
      <div className="flex items-center justify-between">
        <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-semibold ${meta.badge}`}>
          <span className={`size-1.5 rounded-full ${meta.dot}`} />
          {STATUS_LABELS[client.status] ?? client.status}
        </span>
        <span className="text-[10px] text-gray-300">{fmtDaysAgo(client.created_at)}</span>
      </div>

      <div className="flex items-start gap-3">
        <Avatar company={client.company_name} size={48} />
        <div className="min-w-0 flex-1">
          <p className="truncate font-heading text-base font-bold text-gray-900">
            {client.company_name}
          </p>
          {client.contact_name && (
            <p className="truncate text-xs text-gray-500">{client.contact_name}</p>
          )}
          <a
            href={`mailto:${client.email}`}
            className="mt-1 flex items-center gap-1 text-[11px] text-gray-400 hover:text-remotiv-purple"
          >
            <Mail className="size-3" strokeWidth={2} />
            <span className="truncate">{client.email}</span>
          </a>
        </div>
      </div>

      <p className="flex items-center gap-3 text-[11px] font-medium text-gray-500">
        <span className="inline-flex items-center gap-1">
          <Briefcase className="size-3" strokeWidth={2} />
          {client.batch_count} {client.batch_count === 1 ? "Batch" : "Batches"}
        </span>
        <span className="text-gray-300">·</span>
        <span className="inline-flex items-center gap-1">
          <Users className="size-3" strokeWidth={2} />
          {client.candidate_count} {client.candidate_count === 1 ? "Candidate" : "Candidates"}
        </span>
      </p>

      <button
        type="button"
        onClick={onManage}
        className="mt-auto flex items-center justify-center gap-1.5 rounded-xl bg-remotiv-purple/10 px-4 py-2 text-xs font-semibold text-remotiv-purple transition-colors hover:bg-remotiv-purple/20"
      >
        Manage Client →
      </button>
    </div>
  );
}

// ── Mobile card (replaces the desktop ClientCard on <lg) ────

/**
 * Compact client card for phone widths (375–414px).
 * Whole surface is one tappable button; account actions live inside
 * the now-full-screen ClientDrawer so the row stays a single touch
 * target.
 */
function ClientCardMobile({
  client,
  onManage,
}: {
  client: Client;
  onManage: () => void;
}) {
  const meta = STATUS_BADGE[client.status];
  return (
    <button
      type="button"
      onClick={onManage}
      className="flex w-full flex-col overflow-hidden rounded-2xl border border-gray-100 bg-white text-left shadow-sm transition-shadow active:shadow-md"
    >
      <div className="p-4">
        <div className="flex items-start gap-3">
          <Avatar company={client.company_name} size={40} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2">
              <p className="truncate font-heading text-base font-bold text-gray-900">
                {client.company_name}
              </p>
              <span
                className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${meta.badge}`}
              >
                {STATUS_LABELS[client.status] ?? client.status}
              </span>
            </div>
            {client.contact_name && (
              <p className="mt-0.5 truncate text-xs text-gray-500">
                {client.contact_name}
              </p>
            )}
            <p className="mt-0.5 truncate text-[11px] text-gray-400">
              {client.email}
            </p>
          </div>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
          <div>
            <p className="text-gray-400">Batches</p>
            <p className="font-heading text-sm font-bold text-[#111]">
              {client.batch_count}
            </p>
          </div>
          <div>
            <p className="text-gray-400">Candidates</p>
            <p className="font-heading text-sm font-bold text-[#111]">
              {client.candidate_count}
            </p>
          </div>
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

function ClientDrawer({
  client,
  onClose,
  onSetStatus,
  onDelete,
  onToast,
}: {
  client: Client;
  onClose: () => void;
  onSetStatus: (status: ClientStatus) => Promise<void>;
  onDelete: () => void;
  onToast: (msg: string) => void;
}) {
  const router = useRouter();
  const meta = STATUS_BADGE[client.status];

  const [showResetForm, setShowResetForm] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);

  const [busyStatus, setBusyStatus] = useState<ClientStatus | null>(null);

  // Copy-to-clipboard feedback for the credentials section. `copiedField`
  // tracks which row's check icon should flash; `copiedAll` covers the
  // header "Copy All" button.
  const [copiedField, setCopiedField] = useState<"email" | "url" | null>(null);
  const [copiedAll, setCopiedAll] = useState(false);

  useEffect(() => {
    setShowResetForm(false);
    setNewPassword("");
    setShowNewPassword(false);
    setResetError(null);
    setCopiedField(null);
    setCopiedAll(false);
  }, [client.id]);

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
    const blob = `Email: ${client.email}\nLogin URL: ${CLIENT_LOGIN_URL}`;
    try {
      await navigator.clipboard.writeText(blob);
      setCopiedAll(true);
      setTimeout(() => setCopiedAll(false), 1500);
    } catch {
      // Clipboard write blocked — leave the user to copy manually.
    }
  }

  async function handleSetStatus(s: ClientStatus) {
    setBusyStatus(s);
    await onSetStatus(s);
    setBusyStatus(null);
  }

  // Same belt-and-braces guard as createClient — rotating a client's password
  // twice in quick succession is a real footgun (the second call invalidates
  // the password the admin just typed before the toast confirms it).
  const resetInFlightRef = useRef(false);

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
      const result = await resetClientPassword(client.id, newPassword);
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
        aria-label="Client details"
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
            <Avatar company={client.company_name} size={68} />
            <div className="min-w-0 flex-1 pr-8">
              <p className="truncate font-heading text-xl font-bold text-gray-900">
                {client.company_name}
              </p>
              {client.contact_name && (
                <p className="truncate text-sm text-gray-500">{client.contact_name}</p>
              )}
              <a
                href={`mailto:${client.email}`}
                className="mt-1 flex items-center gap-1 text-xs text-gray-400 hover:text-remotiv-purple"
              >
                <Mail className="size-3" strokeWidth={2} />
                <span className="truncate">{client.email}</span>
              </a>
              <span className={`mt-2 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-semibold ${meta.badge}`}>
                <span className={`size-1.5 rounded-full ${meta.dot}`} />
                {STATUS_LABELS[client.status] ?? client.status}
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
              {/* Email */}
              <div className="rounded-xl border border-remotiv-purple/10 bg-white p-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">
                      Login Email
                    </p>
                    <p className="mt-0.5 truncate text-sm font-semibold text-[#111]">
                      {client.email}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleCopyField(client.email, "email")}
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

              {/* Login URL */}
              <div className="rounded-xl border border-remotiv-purple/10 bg-white p-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">
                      Login URL
                    </p>
                    <a
                      href={CLIENT_LOGIN_URL}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-0.5 block truncate font-mono text-xs text-remotiv-purple underline hover:text-[#6c39e0]"
                    >
                      {CLIENT_LOGIN_URL}
                    </a>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleCopyField(CLIENT_LOGIN_URL, "url")}
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
              Use &quot;Reset Password&quot; below to generate a new password for this client.
            </p>
          </section>

          <DrawerSection title="Account Details">
            <div className="grid grid-cols-1 gap-2 text-xs">
              <DrawerKv label="Created" value={fmtDateTime(client.created_at)} />
              <DrawerKv label="User ID" value={client.user_id ?? "—"} mono />
              <DrawerKv label="Batches" value={String(client.batch_count)} />
              <DrawerKv label="Candidates" value={String(client.candidate_count)} />
            </div>
          </DrawerSection>

          <DrawerSection title="Actions">
            <div className="flex flex-col gap-2">
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
                      disabled={resetting}
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
                      disabled={resetting}
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

              <Link
                href={`/admin/client-batches?client_id=${client.id}`}
                className="flex w-full items-center gap-2 rounded-xl border border-gray-100 bg-white px-3 py-2.5 text-xs font-semibold text-gray-700 transition-colors hover:bg-gray-50"
              >
                <Briefcase className="size-3.5 text-remotiv-purple" strokeWidth={2} />
                View Batches →
              </Link>
            </div>
          </DrawerSection>

          <DrawerSection title="Status">
            <div className="grid grid-cols-1 gap-2">
              {client.status !== "active" && (
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
              {client.status !== "paused" && (
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
              {client.status !== "archived" && (
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
              Delete Client
            </button>
            <p className="mt-2 text-[10px] leading-relaxed text-gray-400">
              Deleting a client also removes their auth account and cascades batches + candidates.
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

// ── Create Client Modal ──────────────────────────────────────

function CreateClientModal({
  onClose,
  onSuccess,
}: {
  onClose: () => void;
  onSuccess: (creds: { company_name: string; email: string; password: string }) => void;
}) {
  const [companyName, setCompanyName] = useState("");
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

  // Belt-and-braces double-click guard. createClient creates a Supabase auth
  // user; firing it twice from a fast double-click leaves an orphan account
  // because the second insert hits the unique-email constraint.
  const inFlightRef = useRef(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (inFlightRef.current) return;
    setError(null);
    if (!companyName.trim()) return setError("Company name is required.");
    if (!contactName.trim()) return setError("Contact name is required.");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      return setError("Please enter a valid email address.");
    }
    if (password.length < 8) return setError("Password must be at least 8 characters.");

    inFlightRef.current = true;
    setSubmitting(true);
    try {
      const result = await createClient({
        company_name: companyName.trim(),
        contact_name: contactName.trim(),
        email: email.trim(),
        password,
      });

      if (!result.success) {
        setError(result.error);
        return;
      }

      onSuccess({
        company_name: companyName.trim(),
        email: email.trim().toLowerCase(),
        password,
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
        aria-labelledby="create-client-title"
        className="relative my-4 flex w-full max-w-[480px] flex-col overflow-hidden rounded-2xl bg-white shadow-2xl"
      >
        <div className="relative shrink-0 border-b border-gray-100 px-6 py-5">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            aria-label="Close"
            className="absolute right-4 top-4 flex size-9 items-center justify-center rounded-full text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600 disabled:opacity-50"
          >
            <X className="size-4" strokeWidth={2.5} />
          </button>
          <h2
            id="create-client-title"
            className="font-heading text-lg font-bold text-gray-900"
          >
            Create New Client
          </h2>
          <p className="mt-0.5 text-xs text-gray-500">
            Provisions an auth account and a clients row.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4 px-6 py-5">
          <Field label="Company Name" required>
            <input
              type="text"
              value={companyName}
              onChange={(e) => setCompanyName(e.target.value)}
              placeholder="Acme Inc."
              className={INPUT_CLS}
            />
          </Field>
          <Field label="Contact Name" required>
            <input
              type="text"
              value={contactName}
              onChange={(e) => setContactName(e.target.value)}
              placeholder="Jane Doe"
              className={INPUT_CLS}
            />
          </Field>
          <Field label="Email" required>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="contact@acme.com"
              className={INPUT_CLS}
            />
          </Field>
          <Field label="Password" required hint="Minimum 8 characters.">
            <div className="relative">
              <input
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                minLength={8}
                placeholder="Min 8 characters"
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
              disabled={submitting}
              className="rounded-xl border border-gray-200 px-5 py-2.5 text-sm font-semibold text-gray-600 transition-colors hover:bg-gray-50 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="flex items-center gap-2 rounded-xl bg-remotiv-purple px-5 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-60"
            >
              <Plus className="size-4" strokeWidth={2.5} />
              {submitting ? "Creating…" : "Create Client"}
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
  creds: { company_name: string; email: string; password: string };
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);

  const blob = `Email: ${creds.email}\nPassword: ${creds.password}\nURL: ${CLIENT_LOGIN_URL}`;

  async function copyAll() {
    try {
      await navigator.clipboard.writeText(blob);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard write blocked — leave the user to copy manually.
    }
  }

  // Replaces the previous standalone Escape-handler effect with a focus
  // trap that also handles keyboard cycling and focus-restore on close.
  const credsTrapRef = useFocusTrap<HTMLDivElement>(true, onClose);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm">
      <div
        ref={credsTrapRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="credentials-modal-title"
        className="w-full max-w-md overflow-hidden rounded-2xl bg-white shadow-2xl"
      >
        <div className="px-6 py-5 text-center">
          <div className="mx-auto mb-3 flex size-12 items-center justify-center rounded-full bg-green-100">
            <CheckCircle className="size-6 text-green-600" strokeWidth={2} />
          </div>
          <h3
            id="credentials-modal-title"
            className="font-heading text-lg font-bold text-gray-900"
          >
            Client Created Successfully
          </h3>
          <p className="mt-1 text-xs text-gray-500">
            Send these credentials to <span className="font-semibold text-gray-700">{creds.company_name}</span>:
          </p>
        </div>

        <div className="mx-6 mb-5 flex flex-col gap-2 rounded-xl border border-gray-100 bg-gray-50 p-4 font-mono text-[12px] text-gray-700">
          <div>
            <span className="text-gray-400">Email:</span>{" "}
            <span className="font-semibold">{creds.email}</span>
          </div>
          <div>
            <span className="text-gray-400">Password:</span>{" "}
            <span className="font-semibold">{creds.password}</span>
          </div>
          <div>
            <span className="text-gray-400">URL:</span>{" "}
            <a
              href={CLIENT_LOGIN_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="font-semibold text-remotiv-purple hover:underline"
            >
              {CLIENT_LOGIN_URL}
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

export function ClientsDashboard({
  email,
  userRole,
  initialClients,
}: {
  email: string;
  userRole: UserRole;
  initialClients: Client[];
}) {
  const router = useRouter();

  const [clients, setClients] = useState<Client[]>(initialClients);
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
    | { company_name: string; email: string; password: string }
    | null
  >(null);
  const [deleteTarget, setDeleteTarget] = useState<Client | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    setClients(initialClients);
  }, [initialClients]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2500);
    return () => clearTimeout(t);
  }, [toast]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return clients.filter((c) => {
      if (filterStatus !== "All" && c.status !== filterStatus) return false;
      if (q) {
        const blob = `${c.company_name} ${c.contact_name ?? ""} ${c.email}`.toLowerCase();
        if (!blob.includes(q)) return false;
      }
      return true;
    });
  }, [clients, search, filterStatus]);

  const totalCount    = clients.length;
  const activeCount   = clients.filter((c) => c.status === "active").length;
  const pausedCount   = clients.filter((c) => c.status === "paused").length;
  const archivedCount = clients.filter((c) => c.status === "archived").length;

  const openClient = openId ? clients.find((c) => c.id === openId) ?? null : null;

  async function handleSetStatus(client: Client, status: ClientStatus) {
    setClients((prev) =>
      prev.map((c) => (c.id === client.id ? { ...c, status } : c)),
    );
    const result = await updateClient(client.id, { status });
    if (result.success) {
      setToast(`Marked as ${STATUS_LABELS[status]}`);
      router.refresh();
    } else {
      setClients((prev) => prev.map((c) => (c.id === client.id ? client : c)));
      setToast(`Update failed: ${result.error}`);
    }
  }

  async function handleDelete(client: Client) {
    setDeleting(true);
    const result = await deleteClient(client.id);
    setDeleting(false);
    if (result.success) {
      setClients((prev) => prev.filter((c) => c.id !== client.id));
      if (openId === client.id) setOpenId(null);
      setDeleteTarget(null);
      setToast("Client deleted");
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
            <p className="text-xs text-gray-400">Clients</p>
            <h1 className="font-heading text-2xl font-bold text-gray-900">Clients</h1>
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
              aria-label="New client"
              className="flex min-h-11 shrink-0 items-center gap-2 rounded-xl bg-remotiv-purple px-3 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90 sm:px-4"
            >
              <Plus className="size-4" strokeWidth={2.5} />
              <span className="hidden sm:inline">New Client</span>
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
            <Building2 className="mb-3 size-8 text-gray-300" strokeWidth={1.5} />
            <p className="font-heading text-sm font-semibold text-gray-700">
              {clients.length === 0 ? "No clients yet" : "No clients match your filters"}
            </p>
            <p className="mt-1 text-xs text-gray-400">
              {clients.length === 0
                ? "Click \"New Client\" to provision the first account."
                : "Try clearing a filter or broadening your search."}
            </p>
          </div>
        ) : (
          <>
            {/* Desktop card grid — unchanged */}
            <div className="hidden gap-4 lg:grid lg:grid-cols-1 xl:grid-cols-2">
              {filtered.map((c) => (
                <ClientCard
                  key={c.id}
                  client={c}
                  onManage={() => setOpenId(c.id)}
                />
              ))}
            </div>

            {/* Mobile card list */}
            <div className="flex flex-col gap-3 lg:hidden">
              {filtered.map((c) => (
                <ClientCardMobile
                  key={c.id}
                  client={c}
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

      {openClient && (
        <ClientDrawer
          client={openClient}
          onClose={() => setOpenId(null)}
          onSetStatus={(status) => handleSetStatus(openClient, status)}
          onDelete={() => setDeleteTarget(openClient)}
          onToast={setToast}
        />
      )}

      {showCreate && (
        <CreateClientModal
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
            aria-labelledby="delete-client-title"
            className="w-full max-w-sm overflow-hidden rounded-2xl bg-white shadow-2xl"
          >
            <div className="flex flex-col items-center p-8 text-center">
              <div className="mb-4 flex size-14 items-center justify-center rounded-full bg-red-50">
                <AlertTriangle className="size-7 text-red-500" strokeWidth={2} />
              </div>
              <h3 id="delete-client-title" className="font-heading text-lg font-bold text-gray-900">Delete client?</h3>
              <p className="mt-2 text-sm text-gray-500">
                This permanently removes{" "}
                <span className="font-semibold text-gray-700">
                  {deleteTarget.company_name}
                </span>
                , their auth account, all batches, and all candidate rows. This action cannot be undone.
              </p>
            </div>
            <div className="flex gap-3 border-t border-gray-100 px-6 py-4">
              <button
                type="button"
                onClick={() => setDeleteTarget(null)}
                disabled={deleting}
                className="flex-1 rounded-xl border border-gray-200 py-2.5 text-sm font-medium text-gray-600 transition-colors hover:bg-gray-50 disabled:opacity-50"
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
