"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  CalendarDays,
  CheckCircle,
  ChevronRight,
  Mail,
  MessageSquare,
  Save,
  Search as SearchIcon,
  SlidersHorizontal,
  Trash2,
  X,
} from "lucide-react";
import { TopNav } from "./top-nav";
import { PaginationControls, paginate } from "./pagination-controls";
import {
  deleteInquiry,
  updateInquiryNotes,
  updateInquiryStatus,
  type Inquiry,
  type InquiryStatus,
  type InquiryType,
} from "@/app/admin/contacts/actions";
import { type UserRole } from "@/app/admin/lib/roles";

type Tab = "inquiries" | "bookings";

const STATUS_FILTERS: ReadonlyArray<"All" | InquiryStatus> = [
  "All",
  "new",
  "in_progress",
  "closed",
  "archived",
];

const STATUS_LABEL: Record<string, string> = {
  All: "All",
  new: "New",
  in_progress: "In Progress",
  closed: "Closed",
  archived: "Archived",
};

const STATUS_BADGE: Record<InquiryStatus, string> = {
  new:         "bg-blue-100 text-blue-700",
  in_progress: "bg-amber-100 text-amber-700",
  closed:      "bg-gray-100 text-gray-500",
  archived:    "bg-gray-100 text-gray-400",
};

function fmtDate(iso: string): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
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

function clamp(text: string, max = 80): string {
  if (!text) return "—";
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function isThisWeek(iso: string): boolean {
  if (!iso) return false;
  const ageMs = Date.now() - new Date(iso).getTime();
  return ageMs >= 0 && ageMs <= 7 * 24 * 60 * 60 * 1000;
}

// ── Stat card ────────────────────────────────────────────────

function StatCard({
  label,
  value,
  tint,
}: {
  label: string;
  value: number | string;
  tint: string;
}) {
  return (
    <div className="rounded-2xl border border-black/[0.05] bg-white p-5 shadow-sm">
      <p className={`text-[10px] font-semibold uppercase tracking-widest ${tint}`}>{label}</p>
      <p className="mt-2 font-heading text-2xl font-bold text-gray-900">{value}</p>
    </div>
  );
}

// ── Drawer ──────────────────────────────────────────────────

function InquiryDrawer({
  inquiry,
  type,
  isSuperAdmin,
  onClose,
  onLocalUpdate,
  onLocalRemove,
  onToast,
}: {
  inquiry: Inquiry;
  type: InquiryType;
  isSuperAdmin: boolean;
  onClose: () => void;
  onLocalUpdate: (updated: Inquiry) => void;
  onLocalRemove: (id: string) => void;
  onToast: (msg: string) => void;
}) {
  const router = useRouter();
  const [status, setStatus] = useState<InquiryStatus>(inquiry.status);
  const [notes, setNotes] = useState(inquiry.admin_notes ?? "");
  const [savingStatus, setSavingStatus] = useState(false);
  const [savingNotes, setSavingNotes] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    setStatus(inquiry.status);
    setNotes(inquiry.admin_notes ?? "");
    setConfirmDelete(false);
  }, [inquiry.id, inquiry.status, inquiry.admin_notes]);

  async function handleStatus(next: InquiryStatus) {
    setStatus(next);
    setSavingStatus(true);
    const result = await updateInquiryStatus(inquiry.id, type, next);
    setSavingStatus(false);
    if (!result.success) {
      setStatus(inquiry.status);
      onToast(`Status update failed: ${result.error}`);
      return;
    }
    onLocalUpdate({ ...inquiry, status: next });
    onToast("Status updated");
    router.refresh();
  }

  async function handleSaveNotes() {
    setSavingNotes(true);
    const result = await updateInquiryNotes(inquiry.id, type, notes);
    setSavingNotes(false);
    if (!result.success) {
      onToast(`Notes save failed: ${result.error}`);
      return;
    }
    onLocalUpdate({ ...inquiry, admin_notes: notes.trim() || null });
    onToast("Notes saved");
  }

  async function handleDelete() {
    setDeleting(true);
    const result = await deleteInquiry(inquiry.id, type);
    setDeleting(false);
    if (!result.success) {
      onToast(`Delete failed: ${result.error}`);
      return;
    }
    onLocalRemove(inquiry.id);
    onClose();
    onToast(`${type === "booking" ? "Booking" : "Inquiry"} deleted`);
  }

  return (
    <div className="fixed inset-0 z-40 flex">
      {/* Backdrop — desktop only. On mobile the panel covers the full
          viewport so a separate dim layer would be invisible. */}
      <button
        type="button"
        aria-label="Close drawer"
        onClick={onClose}
        className="hidden flex-1 bg-black/30 backdrop-blur-sm lg:block"
      />
      <div className="flex h-full w-full shrink-0 flex-col bg-white shadow-2xl lg:w-[460px]">
        <div className="relative shrink-0 border-b border-gray-100 px-4 py-5 lg:px-6">
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="absolute right-3 top-3 flex size-11 items-center justify-center rounded-full text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600 lg:right-4 lg:top-4 lg:size-8"
          >
            <X className="size-5 lg:size-4" strokeWidth={2.5} />
          </button>
          <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-400">
            {type === "booking" ? "Booking request" : "Inquiry"}
          </p>
          <p className="mt-1 truncate font-heading text-lg font-bold text-gray-900 pr-8">
            {inquiry.name || "—"}
          </p>
          {inquiry.company && (
            <p className="truncate text-xs text-gray-500">{inquiry.company}</p>
          )}
          <span className={`mt-2 inline-flex rounded-full px-2.5 py-1 text-[10px] font-semibold ${STATUS_BADGE[inquiry.status]}`}>
            {STATUS_LABEL[inquiry.status] ?? inquiry.status}
          </span>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          <DrawerSection title="Contact">
            <div className="flex flex-col gap-2 text-sm">
              {inquiry.email && (
                <a
                  href={`mailto:${inquiry.email}?subject=${encodeURIComponent(`Re: ${type === "booking" ? "your booking request" : "your inquiry"}`)}`}
                  className="inline-flex items-center gap-2 text-gray-700 hover:text-[#7E47FF]"
                >
                  <Mail className="size-3.5 text-gray-400" strokeWidth={2} />
                  {inquiry.email}
                </a>
              )}
              {inquiry.service && (
                <p className="text-gray-700">
                  <span className="text-[10px] font-semibold uppercase tracking-widest text-gray-300">Service</span>
                  <br />
                  {inquiry.service}
                </p>
              )}
              {type === "booking" && (
                <div className="mt-1 grid grid-cols-2 gap-3 rounded-xl bg-gray-50 px-3 py-2 text-xs">
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-400">Preferred Date</p>
                    <p className="text-gray-700">{inquiry.preferred_date ? fmtDate(inquiry.preferred_date) : "—"}</p>
                  </div>
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-400">Preferred Time</p>
                    <p className="text-gray-700">{inquiry.preferred_time ?? "—"}</p>
                  </div>
                </div>
              )}
              <p className="text-[11px] text-gray-400">Submitted {fmtDateTime(inquiry.created_at)}</p>
            </div>
          </DrawerSection>

          <DrawerSection title="Message">
            <p className="whitespace-pre-line rounded-xl bg-gray-50 px-4 py-3 text-sm leading-relaxed text-gray-700">
              {inquiry.message || "—"}
            </p>
          </DrawerSection>

          <DrawerSection title="Status">
            <div className="grid grid-cols-2 gap-2">
              {(["new", "in_progress", "closed", "archived"] as InquiryStatus[]).map((s) => (
                <button
                  key={s}
                  type="button"
                  disabled={savingStatus || status === s}
                  onClick={() => handleStatus(s)}
                  className={`flex items-center justify-center gap-1.5 rounded-xl px-3 py-2.5 text-xs font-semibold transition-colors disabled:opacity-50 ${
                    status === s ? STATUS_BADGE[s] : "border border-gray-200 bg-white text-gray-600 hover:bg-gray-50"
                  }`}
                >
                  {STATUS_LABEL[s]}
                </button>
              ))}
            </div>
          </DrawerSection>

          <DrawerSection title="Internal Notes · Admin only">
            <textarea
              rows={4}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Track follow-ups, mark blockers, leave context for teammates…"
              className="w-full resize-none rounded-xl border border-gray-200 px-3.5 py-2.5 text-sm text-gray-800 outline-none focus:border-[#7E47FF] focus:ring-2 focus:ring-[#7E47FF]/20"
            />
            <button
              type="button"
              onClick={handleSaveNotes}
              disabled={savingNotes}
              className="mt-2 flex items-center gap-1.5 rounded-xl bg-gray-900 px-4 py-2 text-xs font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              <Save className="size-3.5" strokeWidth={2} />
              {savingNotes ? "Saving…" : "Save Notes"}
            </button>
          </DrawerSection>

          {isSuperAdmin && (
            <DrawerSection title="Danger">
              {confirmDelete ? (
                <div className="flex flex-col gap-2 rounded-xl border border-red-200 bg-red-50 p-3">
                  <p className="text-xs font-semibold text-red-700">
                    Permanently delete this {type === "booking" ? "booking" : "inquiry"}?
                  </p>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => setConfirmDelete(false)}
                      disabled={deleting}
                      className="flex-1 rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs font-semibold text-gray-600 hover:bg-gray-50 disabled:opacity-50"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={handleDelete}
                      disabled={deleting}
                      className="flex-1 rounded-lg bg-red-500 px-3 py-2 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50"
                    >
                      {deleting ? "Deleting…" : "Delete"}
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmDelete(true)}
                  className="flex w-full items-center justify-center gap-1.5 rounded-xl bg-red-50 px-3 py-2.5 text-xs font-semibold text-red-600 hover:bg-red-100"
                >
                  <Trash2 className="size-3.5" strokeWidth={2} />
                  Delete {type === "booking" ? "Booking" : "Inquiry"}
                </button>
              )}
            </DrawerSection>
          )}
        </div>
      </div>
    </div>
  );
}

function DrawerSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-6 last:mb-2">
      <p className="mb-3 text-[10px] font-semibold uppercase tracking-widest text-gray-400">{title}</p>
      {children}
    </section>
  );
}

// ── Mobile cards (replace the wide desktop table on <lg) ────

function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const min = Math.max(0, Math.floor(diffMs / 60_000));
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
  });
}

function InquiryCardMobile({
  inquiry,
  onClick,
}: {
  inquiry: Inquiry;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full flex-col overflow-hidden rounded-2xl border border-gray-100 bg-white text-left shadow-sm transition-shadow active:shadow-md"
    >
      <div className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <p className="truncate font-heading text-base font-bold text-gray-900">
              {inquiry.name || "No name"}
            </p>
            <p className="mt-0.5 truncate text-xs text-gray-500">
              {inquiry.email}
            </p>
            {inquiry.company && (
              <p className="mt-0.5 truncate text-[11px] text-gray-400">
                {inquiry.company}
              </p>
            )}
          </div>
          <span
            className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${STATUS_BADGE[inquiry.status]}`}
          >
            {STATUS_LABEL[inquiry.status] ?? inquiry.status}
          </span>
        </div>

        {inquiry.service && (
          <span className="mt-2 inline-block rounded-full bg-[#7E47FF]/10 px-2 py-0.5 text-[10px] font-medium text-[#7E47FF]">
            {inquiry.service}
          </span>
        )}

        {inquiry.message && (
          <p className="mt-3 line-clamp-2 text-sm text-gray-600">
            {inquiry.message}
          </p>
        )}
      </div>

      <div className="flex min-h-11 items-center justify-between border-t border-gray-100 bg-gray-50/50 px-4 py-3 text-xs text-gray-500">
        {relativeTime(inquiry.created_at)}
        <span className="flex items-center gap-1 text-sm font-semibold text-[#7E47FF]">
          View
          <ChevronRight className="size-4" strokeWidth={2.5} />
        </span>
      </div>
    </button>
  );
}

function BookingCardMobile({
  booking,
  onClick,
}: {
  booking: Inquiry;
  onClick: () => void;
}) {
  // Bookings store the requested slot in `preferred_date` + `preferred_time`
  // (free-text "morning" / "afternoon" / etc. — there's no exact timestamp).
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full flex-col overflow-hidden rounded-2xl border border-gray-100 bg-white text-left shadow-sm transition-shadow active:shadow-md"
    >
      <div className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <p className="truncate font-heading text-base font-bold text-gray-900">
              {booking.name || "No name"}
            </p>
            <p className="mt-0.5 truncate text-xs text-gray-500">
              {booking.email}
            </p>
            {booking.company && (
              <p className="mt-0.5 truncate text-[11px] text-gray-400">
                {booking.company}
              </p>
            )}
          </div>
          <span
            className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${STATUS_BADGE[booking.status]}`}
          >
            {STATUS_LABEL[booking.status] ?? booking.status}
          </span>
        </div>

        {(booking.preferred_date || booking.preferred_time) && (
          <div className="mt-3 flex items-center gap-2 rounded-xl bg-[#7E47FF]/5 p-2.5">
            <CalendarDays className="size-4 shrink-0 text-[#7E47FF]" strokeWidth={2} />
            <div className="min-w-0 flex-1">
              {booking.preferred_date && (
                <p className="truncate text-xs font-semibold text-[#111]">
                  {fmtDate(booking.preferred_date)}
                </p>
              )}
              {booking.preferred_time && (
                <p className="truncate text-[11px] text-gray-600">
                  {booking.preferred_time}
                </p>
              )}
            </div>
          </div>
        )}

        {booking.service && (
          <span className="mt-2 inline-block rounded-full bg-gray-50 px-2 py-0.5 text-[10px] font-medium text-gray-600">
            {booking.service}
          </span>
        )}
      </div>

      <div className="flex min-h-11 items-center justify-between border-t border-gray-100 bg-gray-50/50 px-4 py-3 text-xs text-gray-500">
        Booked {relativeTime(booking.created_at)}
        <span className="flex items-center gap-1 text-sm font-semibold text-[#7E47FF]">
          View
          <ChevronRight className="size-4" strokeWidth={2.5} />
        </span>
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

// ── Main dashboard ──────────────────────────────────────────

export function ContactsDashboard({
  email,
  userRole,
  initialInquiries,
  initialBookings,
  initialTab = "inquiries",
}: {
  email: string;
  userRole: UserRole;
  initialInquiries: Inquiry[];
  initialBookings: Inquiry[];
  initialTab?: Tab;
}) {
  const isSuperAdmin = userRole === "super_admin";

  const [tab, setTab] = useState<Tab>(initialTab);
  const [inquiries, setInquiries] = useState<Inquiry[]>(initialInquiries);
  const [bookings, setBookings] = useState<Inquiry[]>(initialBookings);
  const [search, setSearch] = useState("");
  const [filterStatus, setFilterStatus] = useState<string>("All");
  const [openId, setOpenId] = useState<string | null>(null);
  const [openType, setOpenType] = useState<InquiryType>("inquiry");
  const [toast, setToast] = useState<string | null>(null);

  // Mobile-only filter drawer. The detail drawer's structural mobile/desktop
  // difference is handled with Tailwind `lg:` classes inside InquiryDrawer.
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

  useEffect(() => setInquiries(initialInquiries), [initialInquiries]);
  useEffect(() => setBookings(initialBookings), [initialBookings]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2500);
    return () => clearTimeout(t);
  }, [toast]);

  const activeRows = tab === "bookings" ? bookings : inquiries;

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return activeRows.filter((row) => {
      if (filterStatus !== "All" && row.status !== filterStatus) return false;
      if (q) {
        const blob = `${row.name} ${row.email} ${row.company ?? ""} ${row.message}`.toLowerCase();
        if (!blob.includes(q)) return false;
      }
      return true;
    });
  }, [activeRows, search, filterStatus]);

  // Client-side pagination — see pagination-controls.tsx for rationale.
  const [page, setPage] = useState(1);
  useEffect(() => {
    setPage(1);
  }, [tab, search, filterStatus]);
  const pageItems = paginate(filtered, page);

  const allRows = useMemo(() => [...inquiries, ...bookings], [inquiries, bookings]);

  const totalCount = allRows.length;
  const newCount = allRows.filter((r) => r.status === "new").length;
  const thisWeekCount = allRows.filter((r) => isThisWeek(r.created_at)).length;
  const conversion = allRows.length === 0
    ? "—"
    : `${Math.round(
        (allRows.filter((r) => r.status === "closed").length / allRows.length) * 100,
      )}%`;

  const openInquiry = (() => {
    if (!openId) return null;
    return openType === "booking"
      ? bookings.find((b) => b.id === openId) ?? null
      : inquiries.find((i) => i.id === openId) ?? null;
  })();

  function handleLocalUpdate(updated: Inquiry) {
    if (openType === "booking") {
      setBookings((prev) => prev.map((b) => (b.id === updated.id ? updated : b)));
    } else {
      setInquiries((prev) => prev.map((i) => (i.id === updated.id ? updated : i)));
    }
  }

  function handleLocalRemove(id: string) {
    if (openType === "booking") {
      setBookings((prev) => prev.filter((b) => b.id !== id));
    } else {
      setInquiries((prev) => prev.filter((i) => i.id !== id));
    }
  }

  return (
    <div className="min-h-screen bg-[#f8f4f1]">
      <TopNav email={email} userRole={userRole} />

      <main className="mx-auto max-w-screen-2xl px-4 py-6 lg:px-8 lg:py-8">
        <div className="mb-6">
          <p className="text-xs text-gray-400">Contacts</p>
          <h1 className="font-heading text-2xl font-bold text-gray-900">Inquiries & Bookings</h1>
          <p className="mt-1 text-sm text-gray-500">
            All public form submissions in one place.
          </p>
        </div>

        <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4">
          <StatCard label="Total" value={totalCount} tint="text-gray-400" />
          <StatCard label="New" value={newCount} tint="text-blue-600" />
          <StatCard label="This Week" value={thisWeekCount} tint="text-[#7E47FF]" />
          <StatCard label="Conversion" value={conversion} tint="text-[#1a9e73]" />
        </div>

        {/* Mobile: iOS-style segmented toggle */}
        <div className="mb-4 lg:hidden">
          <div className="flex gap-1 rounded-2xl bg-gray-100 p-1">
            <button
              type="button"
              onClick={() => { setTab("inquiries"); setFilterStatus("All"); }}
              className={`flex min-h-[40px] flex-1 items-center justify-center gap-2 rounded-xl py-2.5 text-sm font-semibold transition-all ${
                tab === "inquiries"
                  ? "bg-white text-[#111] shadow-sm"
                  : "text-gray-500"
              }`}
            >
              Inquiries
              {inquiries.length > 0 && (
                <span
                  className={`inline-flex min-w-[20px] items-center justify-center rounded-full px-1.5 py-0.5 text-[10px] font-bold ${
                    tab === "inquiries" ? "bg-[#7E47FF] text-white" : "bg-gray-200 text-gray-600"
                  }`}
                >
                  {inquiries.length}
                </span>
              )}
            </button>
            <button
              type="button"
              onClick={() => { setTab("bookings"); setFilterStatus("All"); }}
              className={`flex min-h-[40px] flex-1 items-center justify-center gap-2 rounded-xl py-2.5 text-sm font-semibold transition-all ${
                tab === "bookings"
                  ? "bg-white text-[#111] shadow-sm"
                  : "text-gray-500"
              }`}
            >
              Bookings
              {bookings.length > 0 && (
                <span
                  className={`inline-flex min-w-[20px] items-center justify-center rounded-full px-1.5 py-0.5 text-[10px] font-bold ${
                    tab === "bookings" ? "bg-[#7E47FF] text-white" : "bg-gray-200 text-gray-600"
                  }`}
                >
                  {bookings.length}
                </span>
              )}
            </button>
          </div>
        </div>

        {/* Mobile: search + Filters trigger row */}
        <div className="mb-4 flex items-center gap-2 lg:hidden">
          <div className="relative flex-1">
            <SearchIcon
              className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-gray-400"
              strokeWidth={2}
            />
            <input
              type="text"
              placeholder="Search…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full rounded-xl border border-gray-200 bg-white py-3 pl-10 pr-4 text-sm text-gray-800 outline-none placeholder:text-gray-400 focus:border-[#7E47FF]/40 focus:ring-2 focus:ring-[#7E47FF]/20"
            />
          </div>
          <button
            type="button"
            onClick={() => setFilterDrawerOpen(true)}
            aria-label="Open filters"
            className="relative flex min-h-11 items-center gap-2 rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm font-semibold text-gray-700 transition-colors hover:bg-gray-50"
          >
            <SlidersHorizontal className="size-4" strokeWidth={2} />
            {activeFilterCount > 0 && (
              <span className="absolute -right-1 -top-1 flex size-5 items-center justify-center rounded-full bg-[#7E47FF] text-[10px] font-bold text-white">
                {activeFilterCount}
              </span>
            )}
          </button>
        </div>

        {/* Desktop: tabs + search row */}
        <div className="mb-6 hidden flex-wrap items-center justify-between gap-4 lg:flex">
          <div className="inline-flex rounded-2xl bg-white p-1 shadow-sm">
            <button
              type="button"
              onClick={() => { setTab("inquiries"); setFilterStatus("All"); }}
              className={`flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold transition-colors ${
                tab === "inquiries"
                  ? "bg-[#7E47FF] text-white"
                  : "text-gray-500 hover:bg-gray-50 hover:text-gray-800"
              }`}
            >
              Inquiries
              <span className={`rounded-full px-1.5 text-[10px] ${tab === "inquiries" ? "bg-white/20" : "bg-gray-100 text-gray-500"}`}>
                {inquiries.length}
              </span>
            </button>
            <button
              type="button"
              onClick={() => { setTab("bookings"); setFilterStatus("All"); }}
              className={`flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold transition-colors ${
                tab === "bookings"
                  ? "bg-[#7E47FF] text-white"
                  : "text-gray-500 hover:bg-gray-50 hover:text-gray-800"
              }`}
            >
              Bookings
              <span className={`rounded-full px-1.5 text-[10px] ${tab === "bookings" ? "bg-white/20" : "bg-gray-100 text-gray-500"}`}>
                {bookings.length}
              </span>
            </button>
          </div>

          <div className="flex flex-1 items-center gap-2 rounded-2xl bg-white p-2 shadow-sm lg:max-w-md">
            <SearchIcon className="ml-2 size-4 shrink-0 text-gray-400" strokeWidth={2} />
            <input
              type="text"
              placeholder="Search by name, email, company, or message…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-10 flex-1 bg-transparent text-sm text-gray-800 outline-none placeholder:text-gray-400"
            />
          </div>
        </div>

        {/* Desktop: status pill row */}
        <div className="mb-6 hidden flex-wrap gap-2 lg:flex">
          {STATUS_FILTERS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setFilterStatus(s)}
              className={`rounded-full px-4 py-1.5 text-xs font-semibold transition-colors ${
                filterStatus === s
                  ? "bg-[#7E47FF] text-white"
                  : "border border-gray-200 bg-white text-gray-500 hover:border-[#7E47FF]/30 hover:text-gray-700"
              }`}
            >
              {STATUS_LABEL[s] ?? s}
            </button>
          ))}
        </div>

        {/* Mobile card list — replaces the wide desktop table on <lg */}
        <div className="lg:hidden">
          {filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-gray-200 bg-white py-16 text-center">
              <MessageSquare className="mb-3 size-8 text-gray-300" strokeWidth={1.5} />
              <p className="font-heading text-sm font-semibold text-gray-700">
                {activeRows.length === 0
                  ? `No ${tab === "bookings" ? "bookings" : "inquiries"} yet`
                  : "No rows match your filters"}
              </p>
            </div>
          ) : (
            <>
              <div className="flex flex-col gap-3">
                {pageItems.map((row) => {
                  const onClick = () => {
                    setOpenType(tab === "bookings" ? "booking" : "inquiry");
                    setOpenId(row.id);
                  };
                  return tab === "bookings" ? (
                    <BookingCardMobile key={row.id} booking={row} onClick={onClick} />
                  ) : (
                    <InquiryCardMobile key={row.id} inquiry={row} onClick={onClick} />
                  );
                })}
              </div>
              <div className="mt-4">
                <PaginationControls page={page} setPage={setPage} total={filtered.length} />
              </div>
            </>
          )}
        </div>

        <div className="hidden overflow-x-auto rounded-2xl border border-black/[0.05] bg-white shadow-sm lg:block">
          <table className="w-full text-sm">
            <thead className="border-b border-gray-100 bg-gray-50/60">
              <tr>
                {tab === "inquiries"
                  ? ["Name", "Email", "Company", "Service", "Message", "Date", "Status", "Actions"].map((h) => (
                      <th key={h} className="whitespace-nowrap px-4 py-3 text-left text-[10px] font-semibold uppercase tracking-widest text-gray-400">{h}</th>
                    ))
                  : ["Name", "Email", "Company", "Service", "Preferred Date", "Time", "Message", "Status", "Actions"].map((h) => (
                      <th key={h} className="whitespace-nowrap px-4 py-3 text-left text-[10px] font-semibold uppercase tracking-widest text-gray-400">{h}</th>
                    ))}
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={tab === "inquiries" ? 8 : 9} className="px-6 py-16 text-center text-sm text-gray-400">
                    {activeRows.length === 0
                      ? `No ${tab === "bookings" ? "bookings" : "inquiries"} yet`
                      : "No rows match your filters"}
                  </td>
                </tr>
              ) : (
                pageItems.map((row) => (
                  <tr
                    key={row.id}
                    className="cursor-pointer border-b border-gray-50 hover:bg-gray-50/50"
                    onClick={() => {
                      setOpenType(tab === "bookings" ? "booking" : "inquiry");
                      setOpenId(row.id);
                    }}
                  >
                    <td className="whitespace-nowrap px-4 py-3 font-medium text-gray-800">{row.name || "—"}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-gray-500">
                      <a
                        href={`mailto:${row.email}`}
                        onClick={(e) => e.stopPropagation()}
                        className="inline-flex items-center gap-1 hover:text-[#7E47FF]"
                      >
                        <Mail className="size-3" strokeWidth={2} />
                        {row.email}
                      </a>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-gray-500">{row.company ?? "—"}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-gray-500">{row.service ?? "—"}</td>
                    {tab === "bookings" && (
                      <>
                        <td className="whitespace-nowrap px-4 py-3 text-gray-500">{row.preferred_date ? fmtDate(row.preferred_date) : "—"}</td>
                        <td className="whitespace-nowrap px-4 py-3 text-gray-500">{row.preferred_time ?? "—"}</td>
                      </>
                    )}
                    <td className="px-4 py-3 text-gray-600" title={row.message ?? undefined}>
                      <span className="block max-w-[280px] truncate">{clamp(row.message)}</span>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-gray-400">{fmtDate(row.created_at)}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex rounded-full px-2.5 py-0.5 text-[10px] font-semibold ${STATUS_BADGE[row.status]}`}>
                        {STATUS_LABEL[row.status] ?? row.status}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3" onClick={(e) => e.stopPropagation()}>
                      <button
                        type="button"
                        onClick={() => {
                          setOpenType(tab === "bookings" ? "booking" : "inquiry");
                          setOpenId(row.id);
                        }}
                        className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-[#7E47FF]"
                        aria-label="Open"
                      >
                        <MessageSquare className="size-3.5" strokeWidth={2} />
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
          {filtered.length > 0 && (
            <div className="border-t border-gray-100 px-6 py-4">
              <PaginationControls page={page} setPage={setPage} total={filtered.length} />
            </div>
          )}
        </div>
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

        <FilterSheetGroup
          label="Status"
          value={filterStatus}
          onChange={setFilterStatus}
          options={STATUS_FILTERS.map((s) => ({
            value: s,
            label: STATUS_LABEL[s] ?? s,
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
            className="flex min-h-11 flex-1 items-center justify-center rounded-xl bg-[#7E47FF] py-3 text-sm font-semibold text-white transition-colors hover:bg-[#6a38e0]"
          >
            Apply
          </button>
        </div>
      </div>

      {openInquiry && (
        <InquiryDrawer
          inquiry={openInquiry}
          type={openType}
          isSuperAdmin={isSuperAdmin}
          onClose={() => setOpenId(null)}
          onLocalUpdate={handleLocalUpdate}
          onLocalRemove={handleLocalRemove}
          onToast={setToast}
        />
      )}

      {toast && (
        <div className="fixed bottom-6 right-6 z-50 flex items-center gap-2 rounded-xl bg-gray-900 px-4 py-3 text-sm font-medium text-white shadow-xl">
          {toast.startsWith("Status") || toast.includes("deleted") || toast.includes("saved") ? (
            <CheckCircle className="size-4" strokeWidth={2} />
          ) : (
            <AlertTriangle className="size-4" strokeWidth={2} />
          )}
          {toast}
        </div>
      )}

    </div>
  );
}
