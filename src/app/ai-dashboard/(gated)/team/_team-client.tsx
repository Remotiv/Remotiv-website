"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Check,
  ChevronDown,
  Filter,
  Mail,
  MoreHorizontal,
  Plus,
  RefreshCcw,
  Send,
  ShieldCheck,
  Trash2,
  UserRound,
  Video,
  X,
  XCircle,
} from "lucide-react";
import {
  canManageTeam,
  COMPANY_ROLE_ACCESS,
  COMPANY_ROLE_LABELS,
  type CompanyRole,
  type TeamMemberRow,
} from "@/app/ai-dashboard/lib/company-roles";
import { PageContainer } from "@/app/ai-dashboard/_components/page-container";
import {
  inviteMember,
  removeMember,
  resendInvite,
  revokeInvite,
  updateMemberRole,
} from "./actions";

// ── Constants ────────────────────────────────────────────────

const ASSIGNABLE_ROLES: readonly CompanyRole[] = [
  "admin",
  "recruiter",
  "hiring_manager",
];

const ALL_ROLES: readonly CompanyRole[] = [
  "owner",
  "admin",
  "recruiter",
  "hiring_manager",
];

type Segment = "all" | "members" | "pending";

const AVATAR_TINTS = [
  { bg: "var(--ai-purple-tint)", fg: "var(--ai-purple-ink)" },
  { bg: "var(--ai-mint-tint)",   fg: "var(--ai-mint-ink)" },
  { bg: "var(--ai-peach-tint)",  fg: "var(--ai-peach-ink)" },
  { bg: "var(--ai-sky-tint)",    fg: "var(--ai-sky-ink)" },
];

// ── Helpers ──────────────────────────────────────────────────

function getInitials(name: string, email: string): string {
  const source = name.trim() || email.split("@")[0] || "";
  const parts = source.split(/[\s._-]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return source.slice(0, 2).toUpperCase() || "?";
}

function getTint(key: string, isOwner: boolean) {
  if (isOwner) return AVATAR_TINTS[0];
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  }
  return AVATAR_TINTS[hash % AVATAR_TINTS.length];
}

/** Relative headline + absolute sub-line for the LAST ACTIVE column. */
function fmtLastActive(iso: string | null): { main: string; sub: string } {
  if (!iso) return { main: "Never", sub: "No sign-in yet" };
  const then = new Date(iso);
  const ms = Date.now() - then.getTime();
  if (Number.isNaN(ms)) return { main: "Never", sub: "No sign-in yet" };

  const mins = Math.floor(ms / 60_000);
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);

  const time = then.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
  });
  const date = then.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
  });

  if (mins < 2) return { main: "Just now", sub: time };
  if (mins < 60) return { main: `${mins} minutes ago`, sub: time };
  if (hours < 24) {
    return { main: `${hours} ${hours === 1 ? "hour" : "hours"} ago`, sub: "Today" };
  }
  if (days === 1) return { main: "Yesterday", sub: time };
  return { main: `${days} days ago`, sub: date };
}

/** Sub-line for a pending invite row: "Invited by Ayesha · 2 days ago". */
function fmtInvitedBy(row: TeamMemberRow): string {
  const who = row.invited_by_name?.trim();
  const prefix = who ? `Invited by ${who}` : "Invited";
  if (!row.invited_at) return `${prefix} · awaiting acceptance`;

  const ms = Date.now() - new Date(row.invited_at).getTime();
  if (Number.isNaN(ms)) return `${prefix} · awaiting acceptance`;

  const days = Math.floor(ms / 86_400_000);
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) return `${prefix} · just now`;
  if (days < 1) return `${prefix} · ${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  if (days === 1) return `${prefix} · yesterday`;
  return `${prefix} · ${days} days ago`;
}

// ── Stat card ────────────────────────────────────────────────

function StatCard({
  label,
  value,
  suffix,
  icon: Icon,
  tintBg,
  tintFg,
}: {
  label: string;
  value: number;
  suffix?: string;
  icon: typeof UserRound;
  tintBg: string;
  tintFg: string;
}) {
  return (
    <div className="rounded-2xl border border-[var(--ai-line)] bg-[var(--ai-surface)] px-[18px] py-4">
      <div className="flex items-center gap-[7px] text-xs font-medium text-[var(--ai-t3)]">
        <span
          className="flex size-[26px] items-center justify-center rounded-lg"
          style={{ background: tintBg, color: tintFg }}
        >
          <Icon className="size-[15px]" strokeWidth={1.9} />
        </span>
        {label}
      </div>
      <div className="mt-3 flex items-baseline gap-2 font-heading text-[28px] font-extrabold leading-none tracking-[-0.02em]">
        {value}
        {suffix && (
          <small className="font-sans text-xs font-semibold tracking-normal text-[var(--ai-t3)]">
            {suffix}
          </small>
        )}
      </div>
    </div>
  );
}

// ── Row menu ─────────────────────────────────────────────────

type MenuItem = {
  label: string;
  icon: typeof Trash2;
  onSelect: () => void;
  danger?: boolean;
};

function RowMenu({
  memberName,
  items,
}: {
  memberName: string;
  items: ReadonlyArray<MenuItem>;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onOutside);
    return () => document.removeEventListener("mousedown", onOutside);
  }, [open]);

  return (
    <div ref={ref} className="relative justify-self-end">
      <button
        type="button"
        onClick={() => setOpen((p) => !p)}
        aria-label={`Actions for ${memberName}`}
        aria-expanded={open}
        aria-haspopup="menu"
        className="flex size-8 items-center justify-center rounded-[9px] text-[var(--ai-t3)] transition-colors hover:bg-black/[0.06] hover:text-[var(--ai-t1)]"
      >
        <MoreHorizontal className="size-[18px]" strokeWidth={2} />
      </button>

      {open && (
        <div className="absolute right-0 top-[38px] z-30 min-w-[184px] rounded-[13px] border border-[var(--ai-line)] bg-white p-1.5 shadow-[0_20px_54px_rgba(20,16,32,0.18)]">
          {items.map(({ label, icon: Icon, onSelect, danger }) => (
            <button
              key={label}
              type="button"
              onClick={() => {
                setOpen(false);
                onSelect();
              }}
              className={`flex w-full items-center gap-2.5 rounded-[9px] px-2.5 py-2.5 text-left text-[13px] transition-colors ${
                danger
                  ? "text-[var(--ai-danger)] hover:bg-[var(--ai-danger-tint)]"
                  : "text-[var(--ai-t2)] hover:bg-[var(--ai-inset)] hover:text-[var(--ai-t1)]"
              }`}
            >
              <Icon className="size-4" strokeWidth={1.7} />
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Invite modal ─────────────────────────────────────────────

function InviteModal({
  companyName,
  onClose,
  onSent,
}: {
  companyName: string;
  onClose: () => void;
  onSent: (email: string) => void;
}) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<CompanyRole>("recruiter");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Sending creates an invite row and dispatches mail — a double-click would
  // expire the first invite and issue a second.
  const inFlightRef = useRef(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (inFlightRef.current) return;
    setError(null);

    const trimmedEmail = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      setError("Please enter a valid email address.");
      return;
    }

    inFlightRef.current = true;
    setSubmitting(true);
    try {
      const result = await inviteMember({
        email: trimmedEmail,
        name: name.trim(),
        role,
      });
      if (result.success) {
        onSent(trimmedEmail.toLowerCase());
      } else {
        setError(result.error);
      }
    } finally {
      inFlightRef.current = false;
      setSubmitting(false);
    }
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !submitting) onClose();
    }
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose, submitting]);

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-[rgba(20,16,32,0.4)] p-6 backdrop-blur-sm">
      <button
        type="button"
        aria-label="Close modal"
        onClick={onClose}
        className="absolute inset-0 -z-10 cursor-default"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="invite-modal-title"
        className="w-full max-w-[460px] rounded-[20px] bg-white p-7 shadow-[0_40px_100px_rgba(0,0,0,0.35)]"
      >
        <div className="mb-5 flex items-start justify-between gap-4">
          <div>
            <h2
              id="invite-modal-title"
              className="font-heading text-[21px] font-extrabold tracking-[-0.02em]"
            >
              Invite a member
            </h2>
            <p className="mt-1 text-[13.5px] text-[var(--ai-t3)]">
              They&apos;ll get an email invite to join the {companyName} workspace.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex size-9 shrink-0 items-center justify-center rounded-full text-[var(--ai-t3)] transition-colors hover:bg-[var(--ai-inset)] hover:text-[var(--ai-t1)]"
          >
            <X className="size-4" strokeWidth={2.5} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div>
            <label
              htmlFor="invite-email"
              className="mb-1.5 block text-xs font-semibold text-[var(--ai-t2)]"
            >
              Email address <span className="text-red-500">*</span>
            </label>
            <input
              id="invite-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="name@company.com"
              autoComplete="off"
              autoFocus
              className={MODAL_INPUT_CLS}
            />
          </div>

          <div>
            <label
              htmlFor="invite-name"
              className="mb-1.5 block text-xs font-semibold text-[var(--ai-t2)]"
            >
              Full name
            </label>
            <input
              id="invite-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Jane Doe"
              className={MODAL_INPUT_CLS}
            />
          </div>

          <div>
            <label
              htmlFor="invite-role"
              className="mb-1.5 block text-xs font-semibold text-[var(--ai-t2)]"
            >
              Role <span className="text-red-500">*</span>
            </label>
            <div className="relative">
              <select
                id="invite-role"
                value={role}
                onChange={(e) => setRole(e.target.value as CompanyRole)}
                className={`${MODAL_INPUT_CLS} appearance-none pr-10`}
              >
                {ASSIGNABLE_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {COMPANY_ROLE_LABELS[r]}
                  </option>
                ))}
              </select>
              <ChevronDown
                className="pointer-events-none absolute right-3.5 top-1/2 size-3 -translate-y-1/2 text-[var(--ai-t3)]"
                strokeWidth={2}
              />
            </div>
            <p className="mt-1.5 text-xs leading-relaxed text-[var(--ai-t3)]">
              {COMPANY_ROLE_LABELS[role]}s get access to:{" "}
              {COMPANY_ROLE_ACCESS[role]}.
            </p>
          </div>

          {error && (
            <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {error}
            </div>
          )}

          <div className="mt-2 flex justify-end gap-2.5">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="rounded-[11px] border border-[var(--ai-line)] px-[17px] py-[11px] text-sm font-semibold text-[var(--ai-t2)] transition-colors hover:bg-[var(--ai-inset)] hover:text-[var(--ai-t1)] disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              aria-busy={submitting}
              className="inline-flex items-center gap-2 rounded-[11px] bg-remotiv-purple px-[18px] py-[11px] text-sm font-semibold text-white transition-colors hover:bg-[var(--ai-purple-hover)] disabled:opacity-60"
            >
              <Send className="size-4" strokeWidth={2} />
              {submitting ? "Sending…" : "Send invite"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

const MODAL_INPUT_CLS =
  "w-full rounded-[11px] border border-[var(--ai-line)] bg-white px-3.5 py-3 text-sm text-[var(--ai-t1)] outline-none transition-colors focus:border-remotiv-purple focus:ring-2 focus:ring-remotiv-purple/20";

// ── Main ─────────────────────────────────────────────────────

export function TeamClient({
  companyName,
  viewerRole,
  members: initialMembers,
}: {
  companyName: string;
  viewerRole: CompanyRole;
  members: TeamMemberRow[];
}) {
  const router = useRouter();
  const canManage = canManageTeam(viewerRole);

  const [members, setMembers] = useState<TeamMemberRow[]>(initialMembers);
  const [segment, setSegment] = useState<Segment>("all");
  const [roleFilter, setRoleFilter] = useState<"all" | CompanyRole>("all");
  const [showInvite, setShowInvite] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<TeamMemberRow | null>(null);
  const [removing, setRemoving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    setMembers(initialMembers);
  }, [initialMembers]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(t);
  }, [toast]);

  const activeMembers = members.filter((m) => m.status === "active");
  const pendingMembers = members.filter((m) => m.status === "invited");

  // 4th stat: how many of the four roles are actually represented. Real number
  // from data we already have, and it stays meaningful once teams grow.
  const rolesInUse = new Set(activeMembers.map((m) => m.role)).size;

  const filtered = useMemo(() => {
    return members.filter((m) => {
      if (segment === "members" && m.status !== "active") return false;
      if (segment === "pending" && m.status !== "invited") return false;
      if (roleFilter !== "all" && m.role !== roleFilter) return false;
      return true;
    });
  }, [members, segment, roleFilter]);

  async function handleRoleChange(member: TeamMemberRow, nextRole: CompanyRole) {
    const previous = member.role;
    setMembers((prev) =>
      prev.map((m) => (m.id === member.id ? { ...m, role: nextRole } : m)),
    );

    const result = await updateMemberRole(member.id, nextRole);
    if (result.success) {
      setToast(`${member.name} is now ${COMPANY_ROLE_LABELS[nextRole]}`);
      router.refresh();
    } else {
      setMembers((prev) =>
        prev.map((m) => (m.id === member.id ? { ...m, role: previous } : m)),
      );
      setToast(result.error);
    }
  }

  async function handleRemove(member: TeamMemberRow) {
    setRemoving(true);
    // Members are removed; pending invites are revoked. Both drop the row.
    const result =
      member.status === "invited"
        ? await revokeInvite(member.id)
        : await removeMember(member.id);
    setRemoving(false);
    if (result.success) {
      setMembers((prev) => prev.filter((m) => m.id !== member.id));
      setRemoveTarget(null);
      setToast(
        member.status === "invited"
          ? `Invitation to ${member.email} revoked`
          : `${member.name} removed from team`,
      );
      router.refresh();
    } else {
      setToast(result.error);
    }
  }

  async function handleResend(member: TeamMemberRow) {
    setToast(`Resending invitation to ${member.email}…`);
    const result = await resendInvite(member.id);
    if (result.success) {
      setToast(`Invitation resent to ${member.email}`);
      router.refresh();
    } else {
      setToast(result.error);
    }
  }

  const segments: ReadonlyArray<{ key: Segment; label: string; count: number }> = [
    { key: "all", label: "All", count: members.length },
    { key: "members", label: "Members", count: activeMembers.length },
    { key: "pending", label: "Pending", count: pendingMembers.length },
  ];

  return (
    <PageContainer>
      {/* Header */}
      <div className="mb-[22px] flex flex-col items-start justify-between gap-4 min-[525px]:flex-row min-[525px]:gap-6">
        <div>
          <h1 className="font-heading text-[32px] font-extrabold leading-none tracking-[-0.035em]">
            Team
          </h1>
          <p className="mt-2 max-w-[440px] text-sm text-[var(--ai-t2)]">
            Manage who can access your {companyName} workspace and what they can
            do inside it.
          </p>
        </div>
        {canManage && (
          <button
            type="button"
            onClick={() => setShowInvite(true)}
            className="inline-flex shrink-0 items-center gap-2 rounded-xl bg-remotiv-purple px-[18px] py-3 text-sm font-semibold text-white shadow-[0_4px_16px_rgba(126,71,255,0.28)] transition-colors hover:bg-[var(--ai-purple-hover)]"
          >
            <Plus className="size-4" strokeWidth={2.5} />
            Invite member
          </button>
        )}
      </div>

      {/* Stats */}
      <div className="mb-6 grid grid-cols-1 gap-3.5 min-[525px]:grid-cols-2 min-[1049px]:grid-cols-4">
        <StatCard
          label="Active members"
          value={activeMembers.length}
          icon={UserRound}
          tintBg="var(--ai-purple-tint)"
          tintFg="var(--ai-purple-ink)"
        />
        <StatCard
          label="Pending invites"
          value={pendingMembers.length}
          icon={Mail}
          tintBg="var(--ai-amber-tint)"
          tintFg="var(--ai-amber-ink)"
        />
        <StatCard
          label="Roles in use"
          value={rolesInUse}
          suffix={`of ${ALL_ROLES.length}`}
          icon={ShieldCheck}
          tintBg="var(--ai-mint-tint)"
          tintFg="var(--ai-mint-ink)"
        />
        <StatCard
          label="Interviews run"
          value={0}
          suffix="this month"
          icon={Video}
          tintBg="var(--ai-sky-tint)"
          tintFg="var(--ai-sky-ink)"
        />
      </div>

      {/* Panel */}
      <div className="overflow-hidden rounded-[18px] border border-[var(--ai-line)] bg-[var(--ai-surface)] shadow-[0_4px_24px_rgba(20,16,32,0.05)]">
        <div className="flex flex-wrap items-center gap-3 border-b border-[var(--ai-line)] px-[18px] py-3.5">
          <div className="flex rounded-[10px] border border-[var(--ai-line)] bg-[var(--ai-inset)] p-[3px]">
            {segments.map((s) => (
              <button
                key={s.key}
                type="button"
                onClick={() => setSegment(s.key)}
                className={`flex items-center gap-1.5 rounded-lg px-[13px] py-1.5 text-[12.5px] font-semibold transition-colors ${
                  segment === s.key
                    ? "bg-[var(--ai-surface)] text-[var(--ai-t1)] shadow-[0_1px_4px_rgba(0,0,0,0.08)]"
                    : "text-[var(--ai-t3)] hover:text-[var(--ai-t1)]"
                }`}
              >
                {s.label}
                <span className="text-[11px] opacity-70">{s.count}</span>
              </button>
            ))}
          </div>

          <div className="relative ml-auto">
            <Filter
              className="pointer-events-none absolute left-3 top-1/2 size-[15px] -translate-y-1/2 text-[var(--ai-t3)]"
              strokeWidth={1.8}
            />
            <select
              aria-label="Filter by role"
              value={roleFilter}
              onChange={(e) => setRoleFilter(e.target.value as "all" | CompanyRole)}
              className="appearance-none rounded-[10px] border border-[var(--ai-line)] bg-[var(--ai-surface)] py-[7px] pl-9 pr-8 text-[13px] font-medium text-[var(--ai-t2)] outline-none transition-colors hover:bg-[var(--ai-inset)] focus:border-remotiv-purple"
            >
              <option value="all">All roles</option>
              {ALL_ROLES.map((r) => (
                <option key={r} value={r}>
                  {COMPANY_ROLE_LABELS[r]}
                </option>
              ))}
            </select>
            <ChevronDown
              className="pointer-events-none absolute right-2.5 top-1/2 size-3 -translate-y-1/2 text-[var(--ai-t3)]"
              strokeWidth={2}
            />
          </div>
        </div>

        <div className="overflow-x-auto">
          <div className="min-w-[820px]">
            <div className="grid grid-cols-[minmax(0,2.6fr)_1.2fr_1fr_0.9fr_40px] items-center gap-4 border-b border-[var(--ai-line)] bg-[var(--ai-inset)] px-5 py-[11px] text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--ai-t3)]">
              <span>Member</span>
              <span>Role</span>
              <span>Access</span>
              <span>Last active</span>
              <span />
            </div>

            {filtered.length === 0 ? (
              <div className="px-5 py-16 text-center">
                <p className="font-heading text-sm font-semibold text-[var(--ai-t2)]">
                  No members match these filters
                </p>
                <p className="mt-1 text-xs text-[var(--ai-t3)]">
                  Try switching the segment or clearing the role filter.
                </p>
              </div>
            ) : (
              filtered.map((m) => {
                const tint = getTint(m.email || m.id, m.is_owner);
                const last = fmtLastActive(m.last_sign_in_at);
                const pending = m.status === "invited";
                // Owner and your own row are never editable, by the same rules
                // the server enforces in updateMemberRole / removeMember.
                const editable = canManage && !m.is_owner && !m.is_self && !pending;

                // Pending rows get resend/revoke; member rows get remove.
                // "Copy invite link" is deliberately absent — the raw token is
                // never stored (only its hash), so it can't be recovered here.
                const menuItems: MenuItem[] = !canManage
                  ? []
                  : pending
                    ? [
                        {
                          label: "Resend invite",
                          icon: RefreshCcw,
                          onSelect: () => handleResend(m),
                        },
                        {
                          label: "Revoke invite",
                          icon: XCircle,
                          onSelect: () => setRemoveTarget(m),
                          danger: true,
                        },
                      ]
                    : editable
                      ? [
                          {
                            label: "Remove from team",
                            icon: Trash2,
                            onSelect: () => setRemoveTarget(m),
                            danger: true,
                          },
                        ]
                      : [];

                return (
                  <div
                    key={m.id}
                    className="grid grid-cols-[minmax(0,2.6fr)_1.2fr_1fr_0.9fr_40px] items-center gap-4 border-b border-[var(--ai-line-soft)] px-5 py-[15px] transition-colors last:border-b-0 hover:bg-[#FCFBFA]"
                  >
                    <div className="flex min-w-0 items-center gap-[13px]">
                      {pending ? (
                        <span className="flex size-10 shrink-0 items-center justify-center rounded-full border-[1.5px] border-dashed border-[var(--ai-line-strong)] bg-[var(--ai-inset)] text-[var(--ai-t3)]">
                          <Mail className="size-4" strokeWidth={1.6} />
                        </span>
                      ) : (
                        <span
                          className="flex size-10 shrink-0 items-center justify-center rounded-full text-[13px] font-semibold"
                          style={{ background: tint.bg, color: tint.fg }}
                        >
                          {getInitials(m.name, m.email)}
                        </span>
                      )}
                      <div className="min-w-0">
                        <p className="flex items-center text-[14.5px] font-semibold leading-tight text-[var(--ai-t1)]">
                          <span className="truncate">{pending ? m.email : m.name}</span>
                          {m.is_self && (
                            <span className="ml-2 shrink-0 rounded-full bg-[var(--ai-purple-tint)] px-[7px] py-px text-[10px] font-bold text-remotiv-purple">
                              You
                            </span>
                          )}
                        </p>
                        <p className="mt-0.5 truncate text-[12.5px] text-[var(--ai-t3)]">
                          {pending ? fmtInvitedBy(m) : m.email}
                        </p>
                      </div>
                    </div>

                    <div>
                      {m.is_owner ? (
                        <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--ai-purple-tint)] px-3 py-1 text-xs font-semibold text-[var(--ai-purple-ink)]">
                          <span className="size-[5px] rounded-full bg-remotiv-purple" />
                          Owner
                        </span>
                      ) : pending ? (
                        <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--ai-amber-tint)] px-3 py-1 text-xs font-semibold text-[var(--ai-amber-ink)]">
                          <span className="size-[5px] rounded-full bg-[var(--ai-amber-dot)]" />
                          Pending · {COMPANY_ROLE_LABELS[m.role]}
                        </span>
                      ) : editable ? (
                        <div className="relative inline-block">
                          <select
                            aria-label={`Role for ${m.name}`}
                            value={m.role}
                            onChange={(e) =>
                              handleRoleChange(m, e.target.value as CompanyRole)
                            }
                            className="appearance-none rounded-[9px] border border-[var(--ai-line)] bg-[var(--ai-surface)] py-[7px] pl-3 pr-8 text-[13px] font-semibold leading-none text-[var(--ai-t1)] outline-none transition-colors hover:border-[var(--ai-line-strong)] focus:border-remotiv-purple"
                          >
                            {ASSIGNABLE_ROLES.map((r) => (
                              <option key={r} value={r}>
                                {COMPANY_ROLE_LABELS[r]}
                              </option>
                            ))}
                          </select>
                          <ChevronDown
                            className="pointer-events-none absolute right-[11px] top-1/2 size-3 -translate-y-1/2 text-[var(--ai-t3)]"
                            strokeWidth={2}
                          />
                        </div>
                      ) : (
                        <span className="text-[13px] font-semibold text-[var(--ai-t1)]">
                          {COMPANY_ROLE_LABELS[m.role]}
                        </span>
                      )}
                    </div>

                    <span className="text-[12.5px] text-[var(--ai-t3)]">
                      {pending ? "Awaiting acceptance" : COMPANY_ROLE_ACCESS[m.role]}
                    </span>

                    <span className="text-[13px] text-[var(--ai-t2)]">
                      {last.main}
                      <small className="block text-[11.5px] text-[var(--ai-t4)]">
                        {last.sub}
                      </small>
                    </span>

                    {menuItems.length > 0 ? (
                      <RowMenu memberName={m.name} items={menuItems} />
                    ) : (
                      <span />
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>

        <div className="border-t border-[var(--ai-line)] bg-[var(--ai-inset)] px-5 py-[13px]">
          <p className="text-[12.5px] text-[var(--ai-t3)]">
            Owners and admins can invite members and change roles.
          </p>
        </div>
      </div>

      {showInvite && (
        <InviteModal
          companyName={companyName}
          onClose={() => setShowInvite(false)}
          onSent={(sentTo) => {
            setShowInvite(false);
            setToast(`Invitation sent to ${sentTo}`);
            router.refresh();
          }}
        />
      )}

      {removeTarget && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-[rgba(20,16,32,0.4)] p-6 backdrop-blur-sm">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="remove-member-title"
            className="w-full max-w-sm overflow-hidden rounded-[20px] bg-white shadow-[0_40px_100px_rgba(0,0,0,0.35)]"
          >
            <div className="flex flex-col items-center p-8 text-center">
              <div className="mb-4 flex size-14 items-center justify-center rounded-full bg-[var(--ai-danger-tint)]">
                <Trash2 className="size-6 text-[var(--ai-danger)]" strokeWidth={2} />
              </div>
              <h3
                id="remove-member-title"
                className="font-heading text-lg font-bold text-[var(--ai-t1)]"
              >
                {removeTarget.status === "invited"
                  ? "Revoke invitation?"
                  : "Remove member?"}
              </h3>
              <p className="mt-2 text-sm text-[var(--ai-t2)]">
                {removeTarget.status === "invited" ? (
                  <>
                    The invitation link sent to{" "}
                    <span className="font-semibold">{removeTarget.email}</span> will
                    stop working immediately. You can invite them again later.
                  </>
                ) : (
                  <>
                    <span className="font-semibold">{removeTarget.name}</span> will
                    lose access to the {companyName} workspace. Their account
                    isn&apos;t deleted — you can re-invite them later.
                  </>
                )}
              </p>
            </div>
            <div className="flex gap-3 border-t border-[var(--ai-line)] px-6 py-4">
              <button
                type="button"
                onClick={() => setRemoveTarget(null)}
                disabled={removing}
                aria-busy={removing}
                className="flex-1 rounded-xl border border-[var(--ai-line)] py-2.5 text-sm font-medium text-[var(--ai-t2)] transition-colors hover:bg-[var(--ai-inset)] disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => handleRemove(removeTarget)}
                disabled={removing}
                aria-busy={removing}
                className="flex-1 rounded-xl bg-[var(--ai-danger)] py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {removing
                  ? "Working…"
                  : removeTarget.status === "invited"
                    ? "Revoke"
                    : "Remove"}
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className="fixed bottom-7 left-1/2 z-[200] flex -translate-x-1/2 items-center gap-2.5 rounded-xl bg-[var(--ai-sidebar)] px-[18px] py-3 text-[13.5px] font-medium text-white shadow-[0_16px_40px_rgba(0,0,0,0.3)]"
        >
          <Check className="size-4 text-remotiv-green" strokeWidth={2.4} />
          {toast}
        </div>
      )}
    </PageContainer>
  );
}
