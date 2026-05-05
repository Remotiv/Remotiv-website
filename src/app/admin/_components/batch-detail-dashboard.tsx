"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  Calendar,
  Check,
  ChevronRight,
  Copy,
  Edit2,
  ExternalLink,
  Eye,
  Pencil,
  Plus,
  Save,
  Search as SearchIcon,
  Share2,
  Star,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { TopNav } from "./top-nav";
import { PaginationControls, paginate } from "./pagination-controls";
import {
  BATCH_STAGES,
  CLIENT_DECISION_ICON,
  CLIENT_DECISION_LABEL,
  stageBadgeClass,
} from "./batch-stages";
import { getAvatarUrl, getInitials } from "@/lib/avatars";
import {
  addAdminCandidateNote,
  addCandidateToBatch,
  fetchAdminCandidateNotes,
  fetchAvailableCandidates,
  removeCandidateFromBatch,
  updateBatch,
  updateBatchCandidate,
  type AdminCandidateNote,
  type AvailableCandidate,
  type BatchCandidate,
  type BatchStatus,
  type ClientBatch,
  type SourceType,
} from "@/app/admin/client-batches/actions";
import { type UserRole } from "@/app/admin/lib/roles";

const CLIENT_LOGIN_URL =
  process.env.NEXT_PUBLIC_CLIENT_PORTAL_URL ??
  "http://localhost:3000/client/login";

// ── Helpers ──────────────────────────────────────────────────

function fullName(c: { first_name: string; last_name: string }): string {
  return `${c.first_name} ${c.last_name}`.trim() || "—";
}

function fmtDateTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function clamp(text: string, max = 60): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

const INPUT_CLS =
  "w-full h-9 rounded-lg border border-gray-200 px-3 text-sm text-gray-800 outline-none focus:border-[#7E47FF] focus:ring-2 focus:ring-[#7E47FF]/20";

const TEXTAREA_CLS =
  "w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-800 outline-none focus:border-[#7E47FF] focus:ring-2 focus:ring-[#7E47FF]/20";

const SUBSECTION_LABEL = "mb-1 block text-[10px] font-semibold uppercase tracking-widest text-gray-400";

function fmtRelativeTime(iso: string): string {
  const d = new Date(iso);
  const diffMs = Date.now() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffMin < 1440) return `${Math.floor(diffMin / 60)}h ago`;
  if (diffMin < 10080) return `${Math.floor(diffMin / 1440)}d ago`;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

// ── Avatar with initials fallback ───────────────────────────

function RowAvatar({
  candidate,
  size,
}: {
  candidate: { first_name: string; last_name: string };
  size: number;
}) {
  return (
    <span
      className="relative inline-block shrink-0 overflow-hidden rounded-full bg-[#7E47FF]/10"
      style={{ width: size, height: size }}
    >
      {/* Plain <img> chosen so the onError handler can hide a missing avatar
          without next/image's loader getting in the way; the initials span
          underneath remains visible. */}
      {/* biome-ignore lint/performance/noImgElement: see comment above */}
      <img
        src={getAvatarUrl(candidate.first_name, candidate.last_name)}
        alt=""
        className="absolute inset-0 size-full object-cover"
        onError={(e) => {
          (e.target as HTMLImageElement).style.display = "none";
        }}
      />
      <span
        className="absolute inset-0 flex items-center justify-center font-bold text-[#7E47FF]"
        style={{ fontSize: Math.max(10, size / 2.6) }}
      >
        {getInitials(candidate.first_name, candidate.last_name)}
      </span>
    </span>
  );
}

// ── Star rating display ─────────────────────────────────────

function StarRating({ value }: { value: number | null }) {
  if (value == null) return <span className="text-gray-300">—</span>;
  const filled = Math.max(0, Math.min(5, Math.round(value)));
  return (
    <span className="inline-flex items-center gap-0.5 text-[#F59E0B]">
      {Array.from({ length: 5 }).map((_, i) => (
        <Star
          key={i}
          className="size-3"
          strokeWidth={0}
          fill={i < filled ? "#F59E0B" : "#E5E7EB"}
        />
      ))}
    </span>
  );
}

// ── Mobile candidate card (replaces the wide desktop table on <lg) ──

const DECISION_STYLE: Record<string, string> = {
  approve:           "bg-green-50 text-green-700",
  reject:            "bg-red-50 text-red-600",
  request_interview: "bg-[#7E47FF]/10 text-[#7E47FF]",
};

function CandidateCardMobile({
  candidate,
  onClick,
}: {
  candidate: BatchCandidate;
  onClick: () => void;
}) {
  const decisionLabel = candidate.client_decision
    ? CLIENT_DECISION_LABEL[candidate.client_decision]
    : "Awaiting client";
  const decisionCls = candidate.client_decision
    ? DECISION_STYLE[candidate.client_decision] ?? "bg-gray-100 text-gray-500"
    : "bg-gray-100 text-gray-500";

  // Surface the most recent interview URL (priority: 2nd → 1st → initial → loom).
  const interviewUrl =
    candidate.second_interview_url ||
    candidate.first_interview_url ||
    candidate.initial_interview_url ||
    candidate.loom_video_url ||
    null;

  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full flex-col overflow-hidden rounded-2xl border border-gray-100 bg-white text-left shadow-sm transition-shadow active:shadow-md"
    >
      <div className="p-4">
        <div className="flex items-start gap-3">
          <RowAvatar candidate={candidate} size={40} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2">
              <p className="truncate font-heading text-base font-bold text-gray-900">
                {fullName(candidate)}
              </p>
              <span
                className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${stageBadgeClass(candidate.stage)}`}
              >
                {candidate.stage}
              </span>
            </div>
            {candidate.position_applied && (
              <p className="mt-0.5 truncate text-xs text-gray-500">
                {candidate.position_applied}
              </p>
            )}
            {(candidate.current_role || candidate.current_company) && (
              <p className="mt-0.5 truncate text-[11px] text-gray-400">
                {[candidate.current_role, candidate.current_company]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            )}
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <span
            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ${decisionCls}`}
          >
            {candidate.client_decision &&
              CLIENT_DECISION_ICON[candidate.client_decision]}
            {decisionLabel}
          </span>
          {candidate.note_by_remotiv && (
            <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-700">
              Internal note
            </span>
          )}
        </div>

        {interviewUrl && (
          <a
            href={interviewUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="mt-3 inline-flex items-center gap-1 text-xs font-semibold text-[#7E47FF] hover:underline"
          >
            <Calendar className="size-3" strokeWidth={2.5} />
            Open interview link
          </a>
        )}
      </div>

      <div className="flex min-h-11 items-center justify-between border-t border-gray-100 bg-gray-50/50 px-4 py-3 text-sm font-semibold text-[#7E47FF]">
        View details
        <ChevronRight className="size-4" strokeWidth={2.5} />
      </div>
    </button>
  );
}

// ── Stage select with badge preview ─────────────────────────

// ── Client notes view (admin side) ──────────────────────────

function ClientNotesView({ candidateId }: { candidateId: string }) {
  const [notes, setNotes] = useState<AdminCandidateNote[]>([]);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchAdminCandidateNotes(candidateId).then((rows) => {
      if (cancelled) return;
      setNotes(rows);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [candidateId]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!draft.trim() || saving) return;
    setSaving(true);
    setError(null);
    const result = await addAdminCandidateNote(candidateId, draft);
    if (result.success) {
      setNotes((prev) => [...prev, result.data]);
      setDraft("");
    } else {
      setError(result.error);
    }
    setSaving(false);
  }

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-gray-100 bg-gray-50/60 p-3">
      <div className="max-h-56 space-y-2 overflow-y-auto pr-1">
        {loading && <p className="text-xs text-gray-500">Loading notes…</p>}
        {!loading && notes.length === 0 && (
          <p className="text-xs italic text-gray-400">
            No notes yet. The client will see anything you add here.
          </p>
        )}
        {notes.map((n) => (
          <div key={n.id} className="rounded-xl bg-white px-3 py-2 shadow-sm">
            <p className="whitespace-pre-line text-sm text-gray-800">{n.note_text}</p>
            <div className="mt-1 flex items-center gap-2 text-[10px] text-gray-500">
              <span
                className={
                  n.author_type === "admin"
                    ? "font-semibold text-[#7E47FF]"
                    : "font-semibold text-[#1a9e73]"
                }
              >
                {n.author_type === "admin" ? "Remotiv" : n.author_name || "Client"}
              </span>
              <span>•</span>
              <span>{fmtRelativeTime(n.created_at)}</span>
            </div>
          </div>
        ))}
      </div>

      <form onSubmit={handleSubmit} className="flex flex-col gap-2">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Reply to client…"
          rows={2}
          disabled={saving}
          className="w-full resize-none rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:border-[#7E47FF] focus:ring-2 focus:ring-[#7E47FF]/20"
        />
        {error && <p className="text-xs text-red-600">{error}</p>}
        <button
          type="submit"
          disabled={!draft.trim() || saving}
          className="self-end rounded-lg bg-[#7E47FF] px-4 py-1.5 text-xs font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {saving ? "Saving…" : "Send"}
        </button>
      </form>
    </div>
  );
}

function StageSelect({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={INPUT_CLS}
      >
        {BATCH_STAGES.map((s) => (
          <option key={s} value={s}>{s}</option>
        ))}
      </select>
      <span className={`inline-flex w-fit rounded-full px-2.5 py-1 text-[10px] font-semibold ${stageBadgeClass(value)}`}>
        {value}
      </span>
    </div>
  );
}

// ── Edit Batch modal (rename + status) ──────────────────────

function EditBatchModal({
  batch,
  onClose,
  onToast,
}: {
  batch: ClientBatch;
  onClose: () => void;
  onToast: (msg: string) => void;
}) {
  const router = useRouter();
  const [batchName, setBatchName] = useState(batch.batch_name);
  const [positionTitle, setPositionTitle] = useState(batch.position_title);
  const [status, setStatus] = useState<BatchStatus>(batch.status);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !submitting) onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, submitting]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!batchName.trim()) return setError("Batch name is required.");
    if (!positionTitle.trim()) return setError("Position title is required.");
    setSubmitting(true);
    const result = await updateBatch(batch.id, {
      batch_name: batchName.trim(),
      position_title: positionTitle.trim(),
      status,
    });
    setSubmitting(false);
    if (!result.success) {
      setError(result.error);
      return;
    }
    onToast("Batch updated");
    router.refresh();
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 backdrop-blur-sm sm:p-8">
      <button
        type="button"
        aria-label="Close"
        onClick={() => !submitting && onClose()}
        className="absolute inset-0 -z-10 cursor-default"
      />
      <div role="dialog" aria-modal="true" className="relative my-4 w-full max-w-[480px] rounded-2xl bg-white shadow-2xl">
        <div className="relative border-b border-gray-100 px-6 py-5">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            aria-label="Close"
            className="absolute right-4 top-4 flex size-9 items-center justify-center rounded-full text-gray-400 hover:bg-gray-100 hover:text-gray-600 disabled:opacity-50"
          >
            <X className="size-4" strokeWidth={2.5} />
          </button>
          <h2 className="font-heading text-lg font-bold text-gray-900">Edit Batch</h2>
        </div>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4 px-6 py-5">
          <div>
            <span className={SUBSECTION_LABEL}>Batch Name</span>
            <input
              type="text"
              value={batchName}
              onChange={(e) => setBatchName(e.target.value)}
              className={INPUT_CLS}
            />
          </div>
          <div>
            <span className={SUBSECTION_LABEL}>Position Title</span>
            <input
              type="text"
              value={positionTitle}
              onChange={(e) => setPositionTitle(e.target.value)}
              className={INPUT_CLS}
            />
          </div>
          <div>
            <span className={SUBSECTION_LABEL}>Status</span>
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as BatchStatus)}
              className={INPUT_CLS}
            >
              <option value="active">Active</option>
              <option value="closed">Closed</option>
              <option value="archived">Archived</option>
            </select>
          </div>
          {error && (
            <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
          )}
          <div className="mt-2 flex items-center justify-end gap-3 border-t border-gray-100 pt-4">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="rounded-xl border border-gray-200 px-5 py-2.5 text-sm font-semibold text-gray-600 hover:bg-gray-50 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="flex items-center gap-2 rounded-xl bg-[#7E47FF] px-5 py-2.5 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-60"
            >
              <Save className="size-4" strokeWidth={2.5} />
              {submitting ? "Saving…" : "Save"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Candidate edit drawer ───────────────────────────────────

function CandidateDrawer({
  candidate,
  onClose,
  onToast,
}: {
  candidate: BatchCandidate;
  onClose: () => void;
  onToast: (msg: string) => void;
}) {
  const router = useRouter();
  const [form, setForm] = useState(candidate);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-seed form ONLY when a different candidate is opened. Listing
  // `candidate` (a fresh object from the parent's `find()` on every
  // render) would wipe in-progress edits whenever the parent re-renders
  // for an unrelated reason (toast tick, pagination change, etc).
  // biome-ignore lint/correctness/useExhaustiveDependencies: see comment above
  useEffect(() => {
    setForm(candidate);
  }, [candidate.id]);

  function setField<K extends keyof BatchCandidate>(key: K, value: BatchCandidate[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSave() {
    setError(null);
    if (!form.first_name.trim() || !form.email.trim()) {
      setError("First name and email are required.");
      return;
    }
    setSaving(true);
    const result = await updateBatchCandidate(candidate.id, {
      first_name: form.first_name,
      last_name: form.last_name,
      email: form.email,
      phone: form.phone ?? "",
      linkedin_url: form.linkedin_url ?? "",
      cv_url: form.cv_url ?? "",
      location: form.location ?? "",
      university: form.university ?? "",
      position_applied: form.position_applied ?? "",
      total_experience: form.total_experience,
      current_role: form.current_role ?? "",
      current_company: form.current_company ?? "",
      current_salary: form.current_salary ?? "",
      salary_expectations: form.salary_expectations ?? "",
      notice_period: form.notice_period ?? "",
      interviewer_name: form.interviewer_name ?? "",
      initial_interview_url: form.initial_interview_url ?? "",
      loom_video_url: form.loom_video_url ?? "",
      first_interview_url: form.first_interview_url ?? "",
      second_interview_url: form.second_interview_url ?? "",
      note_by_remotiv: form.note_by_remotiv ?? "",
      stage: form.stage,
    });
    setSaving(false);
    if (!result.success) {
      setError(result.error);
      return;
    }
    onToast("Candidate saved");
    router.refresh();
    onClose();
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
      <div className="flex h-full w-full shrink-0 flex-col bg-white shadow-2xl lg:w-[520px]">
        <div className="relative shrink-0 border-b border-gray-100 px-4 py-4 lg:px-6 lg:py-5">
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="absolute right-3 top-3 flex size-11 items-center justify-center rounded-full text-gray-400 hover:bg-gray-100 hover:text-gray-600 lg:right-4 lg:top-4 lg:size-8"
          >
            <X className="size-5 lg:size-4" strokeWidth={2.5} />
          </button>
          <div className="flex items-start gap-3">
            <RowAvatar candidate={form} size={56} />
            <div className="min-w-0 flex-1">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-400">Candidate</p>
              <p className="mt-1 truncate font-heading text-lg font-bold text-gray-900 pr-8">
                {fullName(form)}
              </p>
              {form.position_applied && (
                <p className="truncate text-xs text-gray-500">{form.position_applied}</p>
              )}
              <span className={`mt-2 inline-flex rounded-full px-2.5 py-1 text-[10px] font-semibold ${stageBadgeClass(form.stage)}`}>
                {form.stage}
              </span>
            </div>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          {/* Snapshot */}
          <DrawerSection title="Snapshot Data">
            <div className="grid grid-cols-2 gap-3">
              <Field label="First Name"><input value={form.first_name} onChange={(e) => setField("first_name", e.target.value)} className={INPUT_CLS} /></Field>
              <Field label="Last Name"><input value={form.last_name} onChange={(e) => setField("last_name", e.target.value)} className={INPUT_CLS} /></Field>
              <Field label="Email"><input type="email" value={form.email} onChange={(e) => setField("email", e.target.value)} className={INPUT_CLS} /></Field>
              <Field label="Phone"><input value={form.phone ?? ""} onChange={(e) => setField("phone", e.target.value)} className={INPUT_CLS} /></Field>
              <Field label="LinkedIn URL" full><input type="url" value={form.linkedin_url ?? ""} onChange={(e) => setField("linkedin_url", e.target.value)} className={INPUT_CLS} /></Field>
              <Field label="CV URL" full><input type="url" value={form.cv_url ?? ""} onChange={(e) => setField("cv_url", e.target.value)} className={INPUT_CLS} /></Field>
              <Field label="Location"><input value={form.location ?? ""} onChange={(e) => setField("location", e.target.value)} className={INPUT_CLS} /></Field>
              <Field label="University"><input value={form.university ?? ""} onChange={(e) => setField("university", e.target.value)} className={INPUT_CLS} /></Field>
              <Field label="Position Applied" full><input value={form.position_applied ?? ""} onChange={(e) => setField("position_applied", e.target.value)} className={INPUT_CLS} /></Field>
              <Field label="Total Experience">
                <select
                  value={form.total_experience ?? ""}
                  onChange={(e) =>
                    setField("total_experience", e.target.value === "" ? null : Number.parseInt(e.target.value, 10))
                  }
                  className={INPUT_CLS}
                >
                  <option value="">—</option>
                  {[1, 2, 3, 4, 5].map((n) => (
                    <option key={n} value={n}>{`${n} ★`}</option>
                  ))}
                </select>
              </Field>
              <Field label="Notice Period"><input value={form.notice_period ?? ""} onChange={(e) => setField("notice_period", e.target.value)} className={INPUT_CLS} /></Field>
              <Field label="Current Role" full><input value={form.current_role ?? ""} onChange={(e) => setField("current_role", e.target.value)} className={INPUT_CLS} /></Field>
              <Field label="Current Company" full><input value={form.current_company ?? ""} onChange={(e) => setField("current_company", e.target.value)} className={INPUT_CLS} /></Field>
              <Field label="Current Salary"><input value={form.current_salary ?? ""} onChange={(e) => setField("current_salary", e.target.value)} className={INPUT_CLS} /></Field>
              <Field label="Salary Expectations"><input value={form.salary_expectations ?? ""} onChange={(e) => setField("salary_expectations", e.target.value)} className={INPUT_CLS} /></Field>
            </div>
          </DrawerSection>

          {/* Internal Tracking */}
          <DrawerSection title="Internal Tracking · Admin only">
            <div className="grid grid-cols-1 gap-3">
              <Field label="Interviewer Name" full><input value={form.interviewer_name ?? ""} onChange={(e) => setField("interviewer_name", e.target.value)} className={INPUT_CLS} /></Field>
              <Field label="Initial Interview URL (Mr. Waleed)" full><input type="url" value={form.initial_interview_url ?? ""} onChange={(e) => setField("initial_interview_url", e.target.value)} className={INPUT_CLS} placeholder="https://loom.com/…" /></Field>
              <Field label="Loom Video URL" full><input type="url" value={form.loom_video_url ?? ""} onChange={(e) => setField("loom_video_url", e.target.value)} className={INPUT_CLS} placeholder="https://loom.com/…" /></Field>
              <Field label="1st Interview URL" full><input type="url" value={form.first_interview_url ?? ""} onChange={(e) => setField("first_interview_url", e.target.value)} className={INPUT_CLS} /></Field>
              <Field label="2nd Interview URL" full><input type="url" value={form.second_interview_url ?? ""} onChange={(e) => setField("second_interview_url", e.target.value)} className={INPUT_CLS} /></Field>
              <Field label="Note by Remotiv" full>
                <textarea
                  rows={4}
                  value={form.note_by_remotiv ?? ""}
                  onChange={(e) => setField("note_by_remotiv", e.target.value)}
                  className={TEXTAREA_CLS}
                  placeholder="Internal notes, never shown to client."
                />
              </Field>
            </div>
          </DrawerSection>

          {/* Stage */}
          <DrawerSection title="Stage">
            <StageSelect value={form.stage} onChange={(v) => setField("stage", v)} />
          </DrawerSection>

          {/* Client Feedback (read-only) */}
          {(candidate.client_decision || candidate.client_comments || candidate.client_decision_at) && (
            <DrawerSection title="Client Feedback · Read only">
              <div className="rounded-xl bg-gray-50 px-4 py-3 text-sm">
                <p>
                  <span className="text-[10px] font-semibold uppercase tracking-widest text-gray-400">Decision</span>
                  <br />
                  <span className="text-gray-800">
                    {candidate.client_decision
                      ? `${CLIENT_DECISION_ICON[candidate.client_decision]} ${CLIENT_DECISION_LABEL[candidate.client_decision]}`
                      : "—"}
                  </span>
                </p>
                {candidate.client_comments && (
                  <p className="mt-3">
                    <span className="text-[10px] font-semibold uppercase tracking-widest text-gray-400">Comments</span>
                    <br />
                    <span className="whitespace-pre-line text-gray-700">{candidate.client_comments}</span>
                  </p>
                )}
                {candidate.client_decision_at && (
                  <p className="mt-3 text-[11px] text-gray-400">
                    Submitted {fmtDateTime(candidate.client_decision_at)}
                  </p>
                )}
              </div>
            </DrawerSection>
          )}

          {/* Client Notes — chat thread shared with the client portal */}
          <DrawerSection title="Client Notes">
            <ClientNotesView candidateId={candidate.id} />
          </DrawerSection>

          {error && (
            <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
          )}
        </div>

        <div className="flex shrink-0 items-center justify-between gap-3 border-t border-gray-100 bg-white px-6 py-4">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="rounded-xl border border-gray-200 px-5 py-2.5 text-sm font-semibold text-gray-600 hover:bg-gray-50 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="flex items-center gap-2 rounded-xl bg-[#7E47FF] px-5 py-2.5 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-60"
          >
            <Save className="size-4" strokeWidth={2.5} />
            {saving ? "Saving…" : "Save Changes"}
          </button>
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

function Field({
  label,
  children,
  full,
}: {
  label: string;
  children: React.ReactNode;
  full?: boolean;
}) {
  return (
    <div className={full ? "col-span-2" : ""}>
      <span className={SUBSECTION_LABEL}>{label}</span>
      {children}
    </div>
  );
}

// ── Add Candidate picker (slide-in from left) ───────────────

function AddCandidatePicker({
  batchId,
  onClose,
  onToast,
}: {
  batchId: string;
  onClose: () => void;
  onToast: (msg: string) => void;
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [sourceFilter, setSourceFilter] = useState<"all" | SourceType>("all");
  const [results, setResults] = useState<AvailableCandidate[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  // Debounced fetch on query / source filter changes.
  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(async () => {
      setLoading(true);
      const sourceParam = sourceFilter === "all" ? undefined : sourceFilter;
      const data = await fetchAvailableCandidates(query, sourceParam);
      if (!cancelled) {
        setResults(data);
        setLoading(false);
      }
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query, sourceFilter]);

  async function handleAdd(c: AvailableCandidate) {
    const key = `${c.source_type}:${c.id}`;
    setBusyKey(key);
    const result = await addCandidateToBatch(batchId, {
      source_type: c.source_type,
      source_id: c.id,
      first_name: c.first_name,
      last_name: c.last_name,
      email: c.email,
      phone: c.phone ?? null,
      linkedin_url: c.linkedin_url ?? null,
      cv_url: c.cv_url ?? null,
      location: c.location ?? null,
      university: c.education ?? null,
      position_applied: c.position_applied ?? null,
      current_role: c.current_role ?? null,
      current_company: c.current_company ?? null,
    });
    setBusyKey(null);
    if (!result.success) {
      onToast(`Failed: ${result.error}`);
      return;
    }
    onToast("Added");
    router.refresh();
  }

  return (
    <div className="fixed inset-0 z-40 flex">
      <div className="flex h-full w-full shrink-0 flex-col bg-white shadow-2xl lg:w-[460px]">
        <div className="relative shrink-0 border-b border-gray-100 px-4 py-4 lg:px-5">
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="absolute right-3 top-3 flex size-11 items-center justify-center rounded-full text-gray-400 hover:bg-gray-100 hover:text-gray-600 lg:size-8"
          >
            <X className="size-5 lg:size-4" strokeWidth={2.5} />
          </button>
          <p className="pr-12 text-[10px] font-semibold uppercase tracking-widest text-gray-400">Add Candidate</p>
          <p className="mt-1 font-heading text-lg font-bold text-gray-900 pr-12 lg:pr-8">Pick from existing pool</p>
          <div className="mt-3 flex items-center gap-2 rounded-xl bg-gray-50 px-3 py-2">
            <SearchIcon className="size-4 shrink-0 text-gray-400" strokeWidth={2} />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by name, email, or position…"
              className="h-8 flex-1 bg-transparent text-sm outline-none placeholder:text-gray-400"
            />
          </div>
          <div className="mt-2 flex gap-1">
            {(["all", "application", "talent"] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setSourceFilter(s)}
                className={`rounded-full px-3 py-1 text-[11px] font-semibold transition-colors ${
                  sourceFilter === s
                    ? "bg-[#7E47FF] text-white"
                    : "border border-gray-200 bg-white text-gray-500 hover:border-[#7E47FF]/30"
                }`}
              >
                {s === "all" ? "All" : s === "application" ? "Job Applications" : "Talent Network"}
              </button>
            ))}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {loading ? (
            <p className="py-10 text-center text-xs text-gray-400">Searching…</p>
          ) : results.length === 0 ? (
            <p className="py-10 text-center text-xs text-gray-400">No candidates match.</p>
          ) : (
            <div className="flex flex-col gap-2">
              {results.map((c) => {
                const key = `${c.source_type}:${c.id}`;
                return (
                  <div
                    key={key}
                    className="flex items-start gap-3 rounded-xl border border-gray-100 bg-white p-3"
                  >
                    <RowAvatar candidate={c} size={36} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-gray-800">
                        {c.first_name} {c.last_name}
                      </p>
                      <p className="truncate text-[11px] text-gray-500">{c.email}</p>
                      {c.phone && <p className="truncate text-[11px] text-gray-400">{c.phone}</p>}
                      <div className="mt-1 flex flex-wrap items-center gap-1.5">
                        <span
                          className={`rounded-full px-2 py-0.5 text-[9px] font-semibold ${
                            c.source_type === "application"
                              ? "bg-blue-100 text-blue-700"
                              : "bg-[#49D7A7]/15 text-[#1a9e73]"
                          }`}
                        >
                          {c.source_type === "application" ? "From Applications" : "From Talent"}
                        </span>
                        {c.position_applied && (
                          <span className="text-[10px] text-gray-500">{c.position_applied}</span>
                        )}
                      </div>
                      {c.location && (
                        <p className="mt-0.5 text-[10px] text-gray-400">{c.location}</p>
                      )}
                    </div>
                    <button
                      type="button"
                      disabled={busyKey === key}
                      onClick={() => handleAdd(c)}
                      className="flex shrink-0 items-center gap-1 rounded-lg bg-[#7E47FF]/10 px-3 py-1.5 text-[11px] font-semibold text-[#7E47FF] transition-colors hover:bg-[#7E47FF]/20 disabled:opacity-60"
                    >
                      {busyKey === key ? (
                        "Adding…"
                      ) : (
                        <>
                          <Plus className="size-3" strokeWidth={2.5} />
                          Add to Batch
                        </>
                      )}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="shrink-0 border-t border-gray-100 px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            className="w-full rounded-xl bg-gray-900 py-2.5 text-xs font-semibold text-white hover:opacity-90"
          >
            Done
          </button>
        </div>
      </div>
      <button
        type="button"
        aria-label="Close picker"
        className="flex-1 bg-black/30 backdrop-blur-sm"
        onClick={onClose}
      />
    </div>
  );
}

// ── Main dashboard ──────────────────────────────────────────

export function BatchDetailDashboard({
  email,
  userRole,
  batch,
  initialCandidates,
}: {
  email: string;
  userRole: UserRole;
  batch: ClientBatch;
  initialCandidates: BatchCandidate[];
}) {
  const router = useRouter();
  const [candidates, setCandidates] = useState<BatchCandidate[]>(initialCandidates);
  const [openId, setOpenId] = useState<string | null>(null);
  const [showEditBatch, setShowEditBatch] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<BatchCandidate | null>(null);
  const [removing, setRemoving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [shareCopied, setShareCopied] = useState(false);

  // Client-side pagination — see pagination-controls.tsx for rationale.
  const [page, setPage] = useState(1);
  const pageItems = paginate(candidates, page);

  useEffect(() => setCandidates(initialCandidates), [initialCandidates]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2500);
    return () => clearTimeout(t);
  }, [toast]);

  const stageCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const c of candidates) {
      map.set(c.stage, (map.get(c.stage) ?? 0) + 1);
    }
    return Array.from(map.entries())
      .filter(([s]) => s !== "-")
      .sort((a, b) => b[1] - a[1]);
  }, [candidates]);

  const openCandidate = openId ? candidates.find((c) => c.id === openId) ?? null : null;

  async function handleShareLink() {
    try {
      await navigator.clipboard.writeText(CLIENT_LOGIN_URL);
      setShareCopied(true);
      setToast("Client login link copied — send to client");
      setTimeout(() => setShareCopied(false), 1500);
    } catch {
      setToast(`Copy this URL: ${CLIENT_LOGIN_URL}`);
    }
  }

  async function handleRemove() {
    if (!removeTarget) return;
    setRemoving(true);
    const result = await removeCandidateFromBatch(removeTarget.id);
    setRemoving(false);
    if (result.success) {
      setCandidates((prev) => prev.filter((c) => c.id !== removeTarget.id));
      if (openId === removeTarget.id) setOpenId(null);
      setRemoveTarget(null);
      setToast("Candidate removed");
      router.refresh();
    } else {
      setToast(`Remove failed: ${result.error}`);
    }
  }

  const statusBadge: Record<BatchStatus, string> = {
    active: "bg-green-100 text-green-700",
    closed: "bg-blue-100 text-blue-700",
    archived: "bg-gray-100 text-gray-500",
  };

  return (
    <div className="min-h-screen bg-[#f8f4f1]">
      <TopNav email={email} userRole={userRole} />

      <main className="mx-auto max-w-screen-2xl px-4 py-6 lg:px-8 lg:py-8">
        <Link
          href="/admin/client-batches"
          className="mb-3 inline-flex min-h-11 items-center gap-1 text-xs text-gray-400 hover:text-[#7E47FF] lg:min-h-0"
        >
          <ArrowLeft className="size-4 lg:size-3" strokeWidth={2} />
          Back to Batches
        </Link>

        <div className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0">
            <p className="truncate text-xs font-semibold uppercase tracking-widest text-gray-400">
              {batch.client_name}
            </p>
            <h1 className="mt-1 truncate font-heading text-2xl font-bold text-gray-900">
              {batch.batch_name}
            </h1>
            {batch.position_title && (
              <p className="mt-0.5 truncate text-sm text-gray-500">Position: {batch.position_title}</p>
            )}
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-semibold ${statusBadge[batch.status]}`}>
                {batch.status === "active" ? "Active" : batch.status === "closed" ? "Closed" : "Archived"}
              </span>
              <button
                type="button"
                onClick={() => setShowEditBatch(true)}
                className="inline-flex items-center gap-1 rounded-lg border border-gray-200 px-3 py-1.5 text-[11px] font-semibold text-gray-600 hover:bg-gray-50"
              >
                <Edit2 className="size-3" strokeWidth={2} />
                Edit Batch
              </button>
              <button
                type="button"
                onClick={handleShareLink}
                className="inline-flex items-center gap-1 rounded-lg border border-gray-200 px-3 py-1.5 text-[11px] font-semibold text-gray-600 hover:bg-gray-50"
              >
                {shareCopied ? <Check className="size-3 text-green-600" strokeWidth={2.5} /> : <Share2 className="size-3" strokeWidth={2} />}
                {shareCopied ? "Copied" : "Share Link"}
              </button>
              <a
                href={`/client/batch/${batch.id}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 rounded-lg border border-amber-200 bg-amber-50 px-3 py-1.5 text-[11px] font-semibold text-amber-800 hover:bg-amber-100"
              >
                <Eye className="size-3" strokeWidth={2} />
                Preview as Client
              </a>
            </div>
          </div>

          <button
            type="button"
            onClick={() => setShowPicker(true)}
            className="flex min-h-11 shrink-0 items-center gap-2 rounded-xl bg-[#49D7A7] px-4 py-2.5 text-sm font-semibold text-[#1a4f3a] hover:opacity-90 lg:px-5"
          >
            <Plus className="size-4" strokeWidth={2.5} />
            <span className="lg:inline">Add Candidate</span>
          </button>
        </div>

        <div className="mb-6 flex flex-wrap items-center gap-3 rounded-2xl border border-black/[0.05] bg-white px-5 py-4 shadow-sm">
          <span className="inline-flex items-center gap-1 text-sm font-semibold text-gray-800">
            <Users className="size-4 text-gray-400" strokeWidth={2} />
            {candidates.length} {candidates.length === 1 ? "Candidate" : "Candidates"}
          </span>
          {stageCounts.length > 0 && <span className="text-gray-300">·</span>}
          {stageCounts.map(([s, n]) => (
            <span
              key={s}
              className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[10px] font-semibold ${stageBadgeClass(s)}`}
            >
              {n} {s}
            </span>
          ))}
        </div>

        {candidates.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-gray-200 bg-white py-20 text-center">
            <Users className="mb-3 size-8 text-gray-300" strokeWidth={1.5} />
            <p className="font-heading text-sm font-semibold text-gray-700">No candidates yet</p>
            <p className="mt-1 text-xs text-gray-400">Click &quot;Add Candidate&quot; to pick from your applications or talent network.</p>
          </div>
        ) : (
          <>
            {/* Mobile card list — replaces the wide desktop table on <lg */}
            <div className="flex flex-col gap-3 lg:hidden">
              {pageItems.map((c) => (
                <CandidateCardMobile
                  key={c.id}
                  candidate={c}
                  onClick={() => setOpenId(c.id)}
                />
              ))}
              <div className="mt-3">
                <PaginationControls
                  page={page}
                  setPage={setPage}
                  total={candidates.length}
                />
              </div>
            </div>

            <div className="hidden overflow-x-auto rounded-2xl border border-black/[0.05] bg-white shadow-sm lg:block">
            <table className="w-full text-sm">
              <thead className="border-b border-gray-100 bg-gray-50/60">
                <tr>
                  {[
                    "Name", "Stage", "Phone", "Email", "LinkedIn", "CV",
                    "Position", "Location", "University", "Experience",
                    "Current Role", "Current Company", "Current Salary", "Expected Salary",
                    "Notice Period", "Interviewer", "Initial Interview", "Loom Video",
                    "1st Interview", "2nd Interview", "Note by Remotiv", "Client Decision",
                    "Actions",
                  ].map((h) => (
                    <th
                      key={h}
                      className="whitespace-nowrap px-3 py-3 text-left text-[10px] font-semibold uppercase tracking-widest text-gray-400"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {pageItems.map((c) => (
                  <tr
                    key={c.id}
                    className="cursor-pointer border-b border-gray-50 hover:bg-gray-50/50"
                    onClick={() => setOpenId(c.id)}
                  >
                    <td className="whitespace-nowrap px-3 py-2 font-medium text-gray-800">
                      <div className="flex items-center gap-3">
                        <RowAvatar candidate={c} size={36} />
                        <span>{fullName(c)}</span>
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <span className={`inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-semibold ${stageBadgeClass(c.stage)}`}>
                        {c.stage}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-gray-500">{c.phone || "—"}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-gray-500">{c.email}</td>
                    <td className="px-3 py-2">
                      {c.linkedin_url ? (
                        <a
                          href={c.linkedin_url.startsWith("http") ? c.linkedin_url : `https://${c.linkedin_url}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="inline-flex items-center gap-1 rounded-lg bg-[#0A66C2]/10 px-2 py-0.5 text-[10px] font-semibold text-[#0A66C2] hover:bg-[#0A66C2]/20"
                        >
                          <ExternalLink className="size-3" strokeWidth={2} />
                          Profile
                        </a>
                      ) : (
                        <span className="text-gray-300">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {c.cv_url ? (
                        <a
                          href={c.cv_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="inline-flex items-center gap-1 rounded-lg bg-[#7E47FF]/10 px-2 py-0.5 text-[10px] font-semibold text-[#7E47FF] hover:bg-[#7E47FF]/20"
                        >
                          <Eye className="size-3" strokeWidth={2} />
                          View
                        </a>
                      ) : (
                        <span className="text-gray-300">—</span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-gray-500">{c.position_applied || "—"}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-gray-500">{c.location || "—"}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-gray-500">{c.university || "—"}</td>
                    <td className="whitespace-nowrap px-3 py-2"><StarRating value={c.total_experience} /></td>
                    <td className="whitespace-nowrap px-3 py-2 text-gray-500">{c.current_role || "—"}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-gray-500">{c.current_company || "—"}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-gray-500">{c.current_salary || "—"}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-gray-500">{c.salary_expectations || "—"}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-gray-500">{c.notice_period || "—"}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-gray-500">{c.interviewer_name || "—"}</td>
                    <td className="px-3 py-2">{linkCell(c.initial_interview_url)}</td>
                    <td className="px-3 py-2">{linkCell(c.loom_video_url)}</td>
                    <td className="px-3 py-2">{linkCell(c.first_interview_url)}</td>
                    <td className="px-3 py-2">{linkCell(c.second_interview_url)}</td>
                    <td className="px-3 py-2 text-gray-600" title={c.note_by_remotiv ?? ""}>
                      {c.note_by_remotiv ? clamp(c.note_by_remotiv, 40) : <span className="text-gray-300">—</span>}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-gray-700">
                      {c.client_decision ? (
                        <span title={CLIENT_DECISION_LABEL[c.client_decision]}>
                          {CLIENT_DECISION_ICON[c.client_decision]}
                        </span>
                      ) : (
                        <span className="text-gray-300">—</span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2" onClick={(e) => e.stopPropagation()}>
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => setOpenId(c.id)}
                          aria-label="Edit candidate"
                          className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-[#7E47FF]"
                        >
                          <Pencil className="size-3.5" strokeWidth={2} />
                        </button>
                        <button
                          type="button"
                          onClick={() => setRemoveTarget(c)}
                          aria-label="Remove candidate"
                          className="rounded-lg p-1.5 text-gray-400 hover:bg-red-50 hover:text-red-500"
                        >
                          <Trash2 className="size-3.5" strokeWidth={2} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {candidates.length > 0 && (
              <div className="border-t border-gray-100 px-6 py-4">
                <PaginationControls page={page} setPage={setPage} total={candidates.length} />
              </div>
            )}
            </div>
          </>
        )}
      </main>

      {openCandidate && (
        <CandidateDrawer
          candidate={openCandidate}
          onClose={() => setOpenId(null)}
          onToast={setToast}
        />
      )}

      {showEditBatch && (
        <EditBatchModal
          batch={batch}
          onClose={() => setShowEditBatch(false)}
          onToast={setToast}
        />
      )}

      {showPicker && (
        <AddCandidatePicker
          batchId={batch.id}
          onClose={() => setShowPicker(false)}
          onToast={setToast}
        />
      )}

      {removeTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-sm overflow-hidden rounded-2xl bg-white shadow-2xl">
            <div className="flex flex-col items-center p-8 text-center">
              <div className="mb-4 flex size-14 items-center justify-center rounded-full bg-red-50">
                <Trash2 className="size-7 text-red-500" strokeWidth={2} />
              </div>
              <h3 className="font-heading text-lg font-bold text-gray-900">Remove candidate?</h3>
              <p className="mt-2 text-sm text-gray-500">
                This removes <span className="font-semibold text-gray-700">{fullName(removeTarget)}</span> from this batch only. The original application or talent profile remains intact.
              </p>
            </div>
            <div className="flex gap-3 border-t border-gray-100 px-6 py-4">
              <button
                type="button"
                onClick={() => setRemoveTarget(null)}
                disabled={removing}
                className="flex-1 rounded-xl border border-gray-200 py-2.5 text-sm font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleRemove}
                disabled={removing}
                className="flex-1 rounded-xl bg-red-500 py-2.5 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50"
              >
                {removing ? "Removing…" : "Remove"}
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div className="fixed bottom-6 right-6 z-50 flex items-center gap-2 rounded-xl bg-gray-900 px-4 py-3 text-sm font-medium text-white shadow-xl">
          <Copy className="size-4" strokeWidth={2} />
          {toast}
        </div>
      )}
    </div>
  );
}

function linkCell(url: string | null): React.ReactNode {
  if (!url) return <span className="text-gray-300">—</span>;
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      className="inline-flex items-center gap-1 rounded-lg bg-gray-100 px-2 py-0.5 text-[10px] font-semibold text-gray-700 hover:bg-gray-200"
    >
      <ExternalLink className="size-3" strokeWidth={2} />
      Link
    </a>
  );
}
