"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  Briefcase,
  Building2,
  Calendar,
  Check,
  CheckCircle,
  ExternalLink,
  Eye,
  GraduationCap,
  Mail,
  MapPin,
  MessageSquare,
  Phone,
  PhoneCall,
  Play,
  Star,
  Users,
  XCircle,
} from "lucide-react";
import { ClientTopNav } from "./client-top-nav";
import { BATCH_STAGES, stageBadgeClass } from "@/app/admin/_components/batch-stages";
import {
  addCandidateNote,
  fetchCandidateNotes,
  saveClientFeedback,
  updateClientStage,
  type CandidateNote,
  type ClientCandidate,
} from "@/app/client/actions";
import { getClientAvatarUrl, getInitials } from "@/lib/client-avatars";

const DECISION_LABEL: Record<NonNullable<ClientCandidate["client_decision"]>, string> = {
  approve: "Approved",
  reject: "Rejected",
  request_interview: "Interview Requested",
};

const DECISION_BADGE: Record<NonNullable<ClientCandidate["client_decision"]>, string> = {
  approve: "bg-green-100 text-green-700",
  reject: "bg-red-100 text-red-700",
  request_interview: "bg-blue-100 text-blue-700",
};

type Filter = "all" | "pending" | "approve" | "reject" | "request_interview";

const FILTER_TABS: ReadonlyArray<{ key: Filter; label: string; emoji: string }> = [
  { key: "all", label: "All", emoji: "👥" },
  { key: "pending", label: "Pending", emoji: "👀" },
  { key: "approve", label: "Approved", emoji: "✅" },
  { key: "reject", label: "Rejected", emoji: "❌" },
  { key: "request_interview", label: "Interview Requested", emoji: "📞" },
];

// ── Helpers ──────────────────────────────────────────────────

function fullName(c: { first_name: string; last_name: string }): string {
  return `${c.first_name} ${c.last_name}`.trim() || "Candidate";
}

function StarRating({ value }: { value: number | null }) {
  if (value == null) return null;
  const filled = Math.max(0, Math.min(5, Math.round(value)));
  return (
    <span className="inline-flex items-center gap-0.5 text-[#F59E0B]">
      {Array.from({ length: 5 }).map((_, i) => (
        <Star
          key={i}
          className="size-3.5"
          strokeWidth={0}
          fill={i < filled ? "#F59E0B" : "#E5E7EB"}
        />
      ))}
    </span>
  );
}

function ensureHttp(url: string | null): string | null {
  if (!url) return null;
  return url.startsWith("http://") || url.startsWith("https://") ? url : `https://${url}`;
}

// ── Time formatting + notes thread shared with admin ────────

function formatRelativeTime(iso: string): string {
  const d = new Date(iso);
  const diffMs = Date.now() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffMin < 1440) return `${Math.floor(diffMin / 60)}h ago`;
  if (diffMin < 10080) return `${Math.floor(diffMin / 1440)}d ago`;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

function YourNotesPanel({
  candidateId,
  isAdminPreview = false,
}: {
  candidateId: string;
  isAdminPreview?: boolean;
}) {
  const [notes, setNotes] = useState<CandidateNote[]>([]);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchCandidateNotes(candidateId).then((result) => {
      if (cancelled) return;
      if (result.success) setNotes(result.data);
      else setError(result.error);
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

    const result = await addCandidateNote(candidateId, draft);
    if (result.success) {
      setNotes((prev) => [...prev, result.data]);
      setDraft("");
    } else {
      setError(result.error);
    }
    setSaving(false);
  }

  return (
    <div className="flex flex-col rounded-2xl border border-[#49D7A7]/30 bg-[#49D7A7]/8 p-4">
      <p className="mb-3 text-[10px] font-semibold uppercase tracking-widest text-[#1a9e73]">
        📝 Your Notes
      </p>

      <div className="mb-3 max-h-48 flex-1 space-y-2 overflow-y-auto pr-1">
        {loading && <p className="text-xs text-gray-500">Loading notes…</p>}
        {!loading && notes.length === 0 && (
          <p className="text-xs italic text-gray-400">No notes yet. Add your thoughts below.</p>
        )}
        {notes.map((note) => (
          <div key={note.id} className="rounded-xl bg-white px-3 py-2 shadow-sm">
            <p className="whitespace-pre-line text-sm text-gray-800">{note.note_text}</p>
            <div className="mt-1 flex items-center gap-2 text-[10px] text-gray-500">
              <span
                className={
                  note.author_type === "admin"
                    ? "font-semibold text-[#7E47FF]"
                    : "font-semibold text-[#1a9e73]"
                }
              >
                {note.author_type === "admin" ? "Remotiv" : note.author_name || "You"}
              </span>
              <span>•</span>
              <span>{formatRelativeTime(note.created_at)}</span>
            </div>
          </div>
        ))}
      </div>

      {isAdminPreview ? (
        <p className="text-[11px] italic text-gray-500">🔒 Read-only preview — admins use the drawer reply on the admin batch page.</p>
      ) : (
        <form onSubmit={handleSubmit} className="flex flex-col gap-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Add a note…"
            rows={2}
            disabled={saving}
            className="w-full resize-none rounded-xl border border-[#49D7A7]/30 bg-white px-3 py-2 text-sm outline-none focus:border-[#49D7A7] focus:ring-2 focus:ring-[#49D7A7]/30"
          />
          {error && <p className="text-xs text-red-600">{error}</p>}
          <button
            type="submit"
            disabled={!draft.trim() || saving}
            className="self-end rounded-lg bg-[#49D7A7] px-4 py-1.5 text-sm font-semibold text-[#1a4f3a] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save Note"}
          </button>
        </form>
      )}
    </div>
  );
}

// ── Stage dropdown — client-editable, scoped to the same vocabulary as admin ─

function StageDropdown({
  value,
  candidateId,
  onUpdate,
  disabled = false,
}: {
  value: string;
  candidateId: string;
  onUpdate: (newStage: string) => void;
  disabled?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleChange(e: React.ChangeEvent<HTMLSelectElement>) {
    if (disabled) return;
    const newStage = e.target.value;
    if (newStage === value) return;
    setBusy(true);
    setError(null);
    const previous = value;
    onUpdate(newStage); // optimistic
    const result = await updateClientStage(candidateId, newStage);
    setBusy(false);
    if (!result.success) {
      onUpdate(previous); // rollback
      setError(result.error);
    }
  }

  return (
    <span className="inline-flex items-center gap-2">
      <select
        value={value}
        onChange={handleChange}
        disabled={busy || disabled}
        className={`appearance-none rounded-full border-0 px-3 py-1 text-[10px] font-semibold outline-none transition-opacity ${
          disabled
            ? "cursor-not-allowed opacity-60"
            : "cursor-pointer disabled:cursor-not-allowed disabled:opacity-60"
        } ${stageBadgeClass(value)}`}
        title={disabled ? "Read-only preview" : "Change candidate stage"}
      >
        {BATCH_STAGES.map((stage) => (
          <option key={stage} value={stage} className="bg-white text-gray-900">
            {stage}
          </option>
        ))}
      </select>
      {error && (
        <span className="text-[10px] font-medium text-red-500" title={error}>
          ⚠ Failed
        </span>
      )}
    </span>
  );
}

// ── Avatar component with fallback ───────────────────────────

function CandidateAvatar({
  candidate,
  size,
}: {
  candidate: { first_name: string; last_name: string };
  size: number;
}) {
  const [errored, setErrored] = useState(false);
  const url = getClientAvatarUrl(candidate.first_name, candidate.last_name);

  if (errored) {
    return (
      <span
        className="flex shrink-0 items-center justify-center rounded-full bg-[#7E47FF]/10 font-bold text-[#7E47FF] ring-4 ring-white"
        style={{ width: size, height: size, fontSize: Math.max(11, size / 2.6) }}
      >
        {getInitials(candidate.first_name, candidate.last_name)}
      </span>
    );
  }

  return (
    <div
      className="relative shrink-0 overflow-hidden rounded-full bg-gray-100 ring-4 ring-white"
      style={{ width: size, height: size }}
    >
      <Image
        src={url}
        alt={fullName(candidate)}
        fill
        sizes={`${size}px`}
        className="object-cover"
        onError={() => setErrored(true)}
      />
    </div>
  );
}

// ── Single candidate card ────────────────────────────────────

function CandidateCard({
  candidate,
  onSaved,
  onStageChange,
  isAdminPreview,
}: {
  candidate: ClientCandidate;
  onSaved: (updated: ClientCandidate) => void;
  onStageChange: (candidateId: string, newStage: string) => void;
  isAdminPreview: boolean;
}) {
  const router = useRouter();
  const hasDecision = !!candidate.client_decision;

  // Edit state — only opens when user explicitly clicks a decision OR "Update Feedback".
  const [editing, setEditing] = useState(!hasDecision);
  const [decision, setDecision] = useState<ClientCandidate["client_decision"]>(candidate.client_decision);
  const [comments, setComments] = useState(candidate.client_comments ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);

  // Re-seed if the candidate prop changes (e.g., after refresh).
  useEffect(() => {
    setDecision(candidate.client_decision);
    setComments(candidate.client_comments ?? "");
    setEditing(!candidate.client_decision);
  }, [candidate.id, candidate.client_decision, candidate.client_comments]);

  async function handleSave(nextDecision: ClientCandidate["client_decision"]) {
    setError(null);
    setSaving(true);
    const result = await saveClientFeedback(candidate.id, nextDecision, comments);
    setSaving(false);

    if (!result.success) {
      setError(result.error);
      return;
    }

    const updated: ClientCandidate = {
      ...candidate,
      client_decision: nextDecision,
      client_comments: comments.trim() || null,
      client_decision_at: nextDecision ? new Date().toISOString() : null,
    };
    onSaved(updated);
    setDecision(nextDecision);
    setEditing(false);
    setSavedFlash(true);
    setTimeout(() => setSavedFlash(false), 1800);
    router.refresh();
  }

  const interviewLinks: Array<{ label: string; url: string | null }> = [
    { label: "Initial Interview with Mr. Waleed", url: candidate.initial_interview_url },
    { label: "Loom Video Walkthrough", url: candidate.loom_video_url },
    { label: "1st Interview", url: candidate.first_interview_url },
    { label: "2nd Interview", url: candidate.second_interview_url },
  ].filter((x) => !!x.url);

  return (
    <article className="overflow-hidden rounded-3xl border border-gray-100 bg-white shadow-sm transition-shadow hover:shadow-lg">
      {/* Header */}
      <div className="flex items-start gap-5 border-b border-gray-100 px-7 pt-7 pb-5">
        <CandidateAvatar candidate={candidate} size={72} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate font-heading text-xl font-bold text-gray-900">
              {fullName(candidate)}
            </h3>
            <StageDropdown
              value={candidate.stage}
              candidateId={candidate.id}
              onUpdate={(newStage) => onStageChange(candidate.id, newStage)}
              disabled={isAdminPreview}
            />
            {hasDecision && candidate.client_decision && (
              <span
                className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[10px] font-semibold ${DECISION_BADGE[candidate.client_decision]}`}
              >
                <Check className="size-3" strokeWidth={2.5} />
                Your decision: {DECISION_LABEL[candidate.client_decision]}
              </span>
            )}
          </div>
          <div className="mt-1 flex items-center gap-3">
            {candidate.position_applied && (
              <p className="truncate text-sm text-gray-500">{candidate.position_applied}</p>
            )}
            {candidate.total_experience != null && (
              <StarRating value={candidate.total_experience} />
            )}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-500">
            {candidate.location && (
              <span className="inline-flex items-center gap-1">
                <MapPin className="size-3 text-gray-400" strokeWidth={2} />
                {candidate.location}
              </span>
            )}
            {candidate.university && (
              <span className="inline-flex items-center gap-1">
                <GraduationCap className="size-3 text-gray-400" strokeWidth={2} />
                {candidate.university}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Profile facts — always render all four with "—" fallback */}
      <div className="px-7 py-5">
        <div className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
          <FactBlock
            label="Current Role"
            value={candidate.current_role || "—"}
            suffix={
              candidate.current_role && candidate.current_company
                ? ` @ ${candidate.current_company}`
                : null
            }
          />
          <FactBlock label="Current Salary" value={candidate.current_salary || "—"} />
          <FactBlock label="Expected Salary" value={candidate.salary_expectations || "—"} />
          <FactBlock label="Notice Period" value={candidate.notice_period || "—"} />
        </div>

        <div className="mt-5 flex flex-wrap gap-3 border-t border-gray-100 pt-4 text-xs">
          {candidate.phone && (
            <a
              href={`tel:${candidate.phone}`}
              className="inline-flex items-center gap-1.5 rounded-lg bg-gray-100 px-3 py-1.5 font-semibold text-gray-700 hover:bg-gray-200"
            >
              <Phone className="size-3.5" strokeWidth={2} />
              {candidate.phone}
            </a>
          )}
          {candidate.email && (
            <a
              href={`mailto:${candidate.email}`}
              className="inline-flex items-center gap-1.5 rounded-lg bg-gray-100 px-3 py-1.5 font-semibold text-gray-700 hover:bg-gray-200"
            >
              <Mail className="size-3.5" strokeWidth={2} />
              {candidate.email}
            </a>
          )}
          {candidate.linkedin_url && (
            <a
              href={ensureHttp(candidate.linkedin_url) ?? "#"}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-lg bg-[#0A66C2]/10 px-3 py-1.5 font-semibold text-[#0A66C2] hover:bg-[#0A66C2]/20"
            >
              <ExternalLink className="size-3.5" strokeWidth={2} />
              LinkedIn
            </a>
          )}
          {candidate.cv_url && (
            <a
              href={candidate.cv_url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-lg bg-[#7E47FF]/10 px-3 py-1.5 font-semibold text-[#7E47FF] hover:bg-[#7E47FF]/20"
            >
              <Eye className="size-3.5" strokeWidth={2} />
              View CV
            </a>
          )}
        </div>

        <div className="mt-5 grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div className="rounded-2xl border border-[#7E47FF]/15 bg-[#7E47FF]/[0.04] p-4">
            <p className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-widest text-[#7E47FF]">
              <MessageSquare className="size-3" strokeWidth={2} />
              Note from Remotiv
            </p>
            <p className={`whitespace-pre-line text-sm leading-relaxed ${candidate.note_by_remotiv ? "text-gray-700" : "text-gray-400"}`}>
              {candidate.note_by_remotiv || "—"}
            </p>
          </div>

          <YourNotesPanel candidateId={candidate.id} isAdminPreview={isAdminPreview} />
        </div>

        {interviewLinks.length > 0 && (
          <div className="mt-5">
            <p className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-gray-400">
              🎥 Interview Recordings
            </p>
            <ul className="flex flex-col gap-1.5">
              {interviewLinks.map((it) => (
                <li key={it.label}>
                  <a
                    href={it.url ?? "#"}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-2 text-sm text-gray-700 hover:text-[#7E47FF]"
                  >
                    <Play className="size-3.5 text-[#7E47FF]" strokeWidth={2.5} />
                    {it.label}
                    <span className="text-[11px] text-gray-400">— Watch ▶</span>
                  </a>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* Decision footer */}
      <div className="border-t border-gray-100 bg-gray-50/50 px-7 py-5">
        {isAdminPreview ? (
          <div className="flex flex-col gap-2">
            <span className="text-[10px] font-semibold uppercase tracking-widest text-gray-400">
              Client decision
            </span>
            {candidate.client_decision ? (
              <>
                <span
                  className={`inline-flex w-fit items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold ${DECISION_BADGE[candidate.client_decision]}`}
                >
                  {candidate.client_decision === "approve" && <CheckCircle className="size-3.5" strokeWidth={2.5} />}
                  {candidate.client_decision === "reject" && <XCircle className="size-3.5" strokeWidth={2.5} />}
                  {candidate.client_decision === "request_interview" && <PhoneCall className="size-3.5" strokeWidth={2.5} />}
                  {DECISION_LABEL[candidate.client_decision]}
                </span>
                {candidate.client_comments && (
                  <p className="max-w-md whitespace-pre-line text-sm text-gray-600">
                    &ldquo;{candidate.client_comments}&rdquo;
                  </p>
                )}
              </>
            ) : (
              <span className="text-sm text-gray-400">— Pending review</span>
            )}
            <p className="mt-2 text-[11px] italic text-gray-500">
              🔒 Read-only preview
            </p>
          </div>
        ) : !editing && hasDecision && candidate.client_decision ? (
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-col gap-1">
              <span className="text-[10px] font-semibold uppercase tracking-widest text-gray-400">
                Your decision
              </span>
              <span
                className={`inline-flex w-fit items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold ${DECISION_BADGE[candidate.client_decision]}`}
              >
                {candidate.client_decision === "approve" && <CheckCircle className="size-3.5" strokeWidth={2.5} />}
                {candidate.client_decision === "reject" && <XCircle className="size-3.5" strokeWidth={2.5} />}
                {candidate.client_decision === "request_interview" && <PhoneCall className="size-3.5" strokeWidth={2.5} />}
                {DECISION_LABEL[candidate.client_decision]}
              </span>
              {candidate.client_comments && (
                <p className="mt-1 max-w-md whitespace-pre-line text-sm text-gray-600">
                  &ldquo;{candidate.client_comments}&rdquo;
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="rounded-xl border border-gray-200 px-4 py-2 text-xs font-semibold text-gray-600 hover:bg-gray-100"
            >
              Update Feedback
            </button>
          </div>
        ) : (
          <>
            <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-400">
              Your decision
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <DecisionButton
                label="Approve"
                emoji="✅"
                active={decision === "approve"}
                onClick={() => handleSave("approve")}
                disabled={saving}
                color="green"
              />
              <DecisionButton
                label="Reject"
                emoji="❌"
                active={decision === "reject"}
                onClick={() => handleSave("reject")}
                disabled={saving}
                color="red"
              />
              <DecisionButton
                label="Request Interview"
                emoji="📞"
                active={decision === "request_interview"}
                onClick={() => handleSave("request_interview")}
                disabled={saving}
                color="blue"
              />
            </div>

            <div className="mt-4">
              <label
                htmlFor={`comments-${candidate.id}`}
                className="mb-1.5 block text-[10px] font-semibold uppercase tracking-widest text-gray-400"
              >
                Comments (optional)
              </label>
              <textarea
                id={`comments-${candidate.id}`}
                rows={3}
                value={comments}
                onChange={(e) => setComments(e.target.value)}
                placeholder="Add your feedback or notes here…"
                className="w-full resize-none rounded-xl border border-gray-200 bg-white px-3.5 py-2.5 text-sm text-gray-800 outline-none focus:border-[#7E47FF] focus:ring-2 focus:ring-[#7E47FF]/20"
              />
            </div>

            {hasDecision && (
              <button
                type="button"
                onClick={() => setEditing(false)}
                disabled={saving}
                className="mt-3 text-xs font-semibold text-gray-400 hover:text-gray-600 disabled:opacity-50"
              >
                Cancel
              </button>
            )}

            {error && (
              <p className="mt-3 rounded-xl border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-700">
                {error}
              </p>
            )}
            {savedFlash && (
              <p className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-green-100 px-3 py-1 text-xs font-semibold text-green-700">
                <CheckCircle className="size-3.5" strokeWidth={2.5} />
                Feedback saved
              </p>
            )}
          </>
        )}
      </div>
    </article>
  );
}

function DecisionButton({
  label,
  emoji,
  active,
  disabled,
  onClick,
  color,
}: {
  label: string;
  emoji: string;
  active: boolean;
  disabled: boolean;
  onClick: () => void;
  color: "green" | "red" | "blue";
}) {
  const palette: Record<typeof color, string> = {
    green: active
      ? "bg-green-500 text-white border-green-500"
      : "bg-white text-green-700 border-green-200 hover:bg-green-50 hover:border-green-300",
    red: active
      ? "bg-red-500 text-white border-red-500"
      : "bg-white text-red-700 border-red-200 hover:bg-red-50 hover:border-red-300",
    blue: active
      ? "bg-blue-500 text-white border-blue-500"
      : "bg-white text-blue-700 border-blue-200 hover:bg-blue-50 hover:border-blue-300",
  };
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center gap-2 rounded-xl border px-4 py-2.5 text-sm font-semibold transition-colors disabled:opacity-50 ${palette[color]}`}
    >
      <span aria-hidden>{emoji}</span>
      {label}
    </button>
  );
}

function Fact({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-start gap-2">
      <Icon className="mt-0.5 size-3.5 shrink-0 text-gray-400" strokeWidth={2} />
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-400">{label}</p>
        <p className="text-sm text-gray-700">{value}</p>
      </div>
    </div>
  );
}

/**
 * Always-rendered fact tile used by the client batch view. Shows a "—"
 * placeholder when the value is empty so the layout stays stable across
 * candidates with different levels of profile detail.
 */
function FactBlock({
  label,
  value,
  suffix,
}: {
  label: string;
  value: string;
  suffix?: string | null;
}) {
  const empty = value === "—";
  return (
    <div>
      <p className="mb-1 text-[10px] font-semibold uppercase tracking-widest text-gray-400">
        {label}
      </p>
      <p className={`text-sm ${empty ? "text-gray-400" : "text-gray-900"}`}>
        {value}
        {suffix && <span className="text-gray-500">{suffix}</span>}
      </p>
    </div>
  );
}

// ── Main view ───────────────────────────────────────────────

export function ClientBatchView({
  companyName,
  batch,
  initialCandidates,
  isAdminPreview = false,
}: {
  companyName: string;
  batch: { id: string; batch_name: string; position_title: string; status: string; created_at: string };
  initialCandidates: ClientCandidate[];
  isAdminPreview?: boolean;
}) {
  const [candidates, setCandidates] = useState<ClientCandidate[]>(initialCandidates);
  const [filter, setFilter] = useState<Filter>("all");

  useEffect(() => setCandidates(initialCandidates), [initialCandidates]);

  const counts = useMemo(() => {
    const total = candidates.length;
    const pending = candidates.filter((c) => !c.client_decision).length;
    const approved = candidates.filter((c) => c.client_decision === "approve").length;
    const rejected = candidates.filter((c) => c.client_decision === "reject").length;
    const interview = candidates.filter((c) => c.client_decision === "request_interview").length;
    return { total, pending, approved, rejected, interview };
  }, [candidates]);

  const filtered = useMemo(() => {
    if (filter === "all") return candidates;
    if (filter === "pending") return candidates.filter((c) => !c.client_decision);
    return candidates.filter((c) => c.client_decision === filter);
  }, [candidates, filter]);

  function handleSaved(updated: ClientCandidate) {
    setCandidates((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
  }

  /** Optimistic local stage swap. Server already accepted the change before
   *  we get here (see StageDropdown). We just keep the rendered list in
   *  sync without forcing a full router.refresh round-trip. */
  function handleStageChange(candidateId: string, newStage: string) {
    setCandidates((prev) =>
      prev.map((c) => (c.id === candidateId ? { ...c, stage: newStage } : c)),
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-[#f8f4f1] via-white to-[#f8f4f1]">
      <ClientTopNav companyName={companyName} isAdminPreview={isAdminPreview} />

      <main className="mx-auto max-w-screen-xl px-6 py-10 md:px-10">
        <Link
          href="/client/dashboard"
          className="mb-6 inline-flex items-center gap-1 text-xs font-semibold text-gray-400 hover:text-[#7E47FF]"
        >
          <ArrowLeft className="size-3" strokeWidth={2} />
          Back to dashboard
        </Link>

        <div className="mb-8">
          <p className="text-[11px] font-semibold uppercase tracking-widest text-[#7E47FF]">
            {batch.batch_name}
          </p>
          <h1 className="mt-2 font-heading text-3xl font-extrabold tracking-tight text-gray-900 md:text-4xl">
            {batch.position_title || "Candidate batch"}
          </h1>
          <p className="mt-2 inline-flex items-center gap-1.5 text-sm text-gray-500">
            <Users className="size-4 text-gray-400" strokeWidth={2} />
            {counts.total} {counts.total === 1 ? "candidate" : "candidates"} ready for review
          </p>
        </div>

        {/* Stats pills */}
        <div className="mb-6 flex flex-wrap gap-2">
          <StatPill emoji="👀" label="Pending Review" count={counts.pending} tone="bg-blue-100 text-blue-700" />
          <StatPill emoji="✅" label="Approved" count={counts.approved} tone="bg-green-100 text-green-700" />
          <StatPill emoji="❌" label="Rejected" count={counts.rejected} tone="bg-red-100 text-red-700" />
          <StatPill emoji="📞" label="Interview Requested" count={counts.interview} tone="bg-[#7E47FF]/10 text-[#7E47FF]" />
        </div>

        {/* Filter tabs */}
        <div className="mb-6 flex flex-wrap gap-2">
          {FILTER_TABS.map((t) => {
            const active = filter === t.key;
            const tabCount =
              t.key === "all"
                ? counts.total
                : t.key === "pending"
                ? counts.pending
                : t.key === "approve"
                ? counts.approved
                : t.key === "reject"
                ? counts.rejected
                : counts.interview;
            return (
              <button
                key={t.key}
                type="button"
                onClick={() => setFilter(t.key)}
                className={`inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-xs font-semibold transition-colors ${
                  active
                    ? "bg-[#7E47FF] text-white"
                    : "border border-gray-200 bg-white text-gray-500 hover:border-[#7E47FF]/30"
                }`}
              >
                <span aria-hidden>{t.emoji}</span>
                {t.label}
                <span
                  className={`rounded-full px-1.5 text-[10px] ${
                    active ? "bg-white/20" : "bg-gray-100 text-gray-500"
                  }`}
                >
                  {tabCount}
                </span>
              </button>
            );
          })}
        </div>

        {/* Candidate list */}
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-3xl border border-dashed border-gray-200 bg-white py-16 text-center shadow-sm">
            <Users className="mb-3 size-9 text-gray-300" strokeWidth={1.5} />
            <p className="font-heading text-base font-semibold text-gray-700">
              {candidates.length === 0
                ? "No candidates in this batch yet"
                : "No candidates match this filter"}
            </p>
            <p className="mt-1 max-w-sm text-sm text-gray-400">
              {candidates.length === 0
                ? "Your account manager is finalising the shortlist. Check back soon."
                : "Switch the filter above to see other candidates."}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-6">
            {filtered.map((c) => (
              <CandidateCard
                key={c.id}
                candidate={c}
                onSaved={handleSaved}
                onStageChange={handleStageChange}
                isAdminPreview={isAdminPreview}
              />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

function StatPill({
  emoji,
  label,
  count,
  tone,
}: {
  emoji: string;
  label: string;
  count: number;
  tone: string;
}) {
  return (
    <span className={`inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-semibold ${tone}`}>
      <span aria-hidden>{emoji}</span>
      {label}
      <span className="rounded-full bg-white/40 px-2 text-xs">{count}</span>
    </span>
  );
}
