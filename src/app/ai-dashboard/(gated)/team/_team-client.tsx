"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Check,
  ChevronDown,
  Clock,
  Mail,
  Lock,
  MoreHorizontal,
  Plus,
  RefreshCcw,
  Search as SearchIcon,
  Send,
  Trash2,
  X,
  XCircle,
} from "lucide-react";
import {
  canCreateJobs,
  canManageBilling,
  canManageTeam,
  COMPANY_ROLE_ACCESS,
  COMPANY_ROLE_LABELS,
  type CompanyRole,
  type TeamMemberRow,
} from "@/app/ai-dashboard/lib/company-roles";
import { DashboardHero } from "@/app/ai-dashboard/_components/dashboard-hero";
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

/**
 * Per-role permission hints for the invite modal.
 *
 * Deliberately not the mock's wording for Admin ("can manage billing…"):
 * billing does not exist yet, so promising it would be a claim we can't keep.
 * These describe only what the role actually reaches today.
 */
const ROLE_HINTS: Record<CompanyRole, string> = {
  owner: "Owners have full access and can't be changed here.",
  admin:
    "Admins can invite members, change roles, and manage every job and applicant.",
  recruiter:
    "Recruiters can post jobs and manage applicants, but can't change the team.",
  hiring_manager:
    "Hiring managers only see the jobs and applicants assigned to them.",
};

/**
 * What each role can do, for the Role permissions panel.
 *
 * `allows` calls the SAME helpers the guards call, so this panel cannot drift
 * out of sync with what the server actually enforces: change canCreateJobs and
 * the matrix changes with it. Rows without a helper carry a comment naming the
 * guard they mirror — never a hand-kept list of role strings.
 *
 * `pending` marks a permission the role model already defines but whose
 * surface hasn't shipped. It is shown rather than hidden because the
 * distinction is real in code today; the badge keeps the claim honest.
 */
type Capability = {
  label: string;
  allows: (role: CompanyRole) => boolean;
  pending?: boolean;
};

const CAPABILITIES: ReadonlyArray<Capability> = [
  {
    // Every gated page resolves through getCompanyContext with no role check,
    // so any active member can read the workspace.
    label: "View jobs, applicants and CVs",
    allows: () => true,
  },
  {
    label: "Create and manage jobs",
    allows: canCreateJobs,
  },
  {
    // Mirrors updateApplicationStage in (gated)/applicants/actions.ts, whose
    // requireCompanyRole admits all four roles — reviewing and advancing
    // candidates is a hiring manager's core job.
    label: "Move applicants through the pipeline",
    allows: () => true,
  },
  {
    label: "Invite members and change roles",
    allows: canManageTeam,
  },
  {
    label: "Billing and plan",
    allows: canManageBilling,
    pending: true,
  },
];

/** Bar colour per role in the hero breakdown, in the mock's order. */
const ROLE_BAR: Record<CompanyRole, string> = {
  owner: "#9886FE",
  admin: "#49D7A7",
  recruiter: "#4C8DD9",
  hiring_manager: "#D9F972",
};

/** Faces shown before the pile collapses into a "+N" chip. */
const FACE_LIMIT = 3;

/** A sign-in inside this window counts as "recently active". */
const RECENT_MS = 7 * 86_400_000;

/**
 * Mock's `.gridrow`: Member / Role / Access / Last active / ⋯
 *
 * Table and header share it so a column can never drift between the two.
 */
const ROW_GRID =
  "grid grid-cols-[minmax(0,2.4fr)_1.25fr_1.15fr_0.95fr_40px] items-center gap-4 px-5";

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

/**
 * When a pending invite stops working.
 *
 * Derived from invited_at rather than read from the row: `expires_at` lives on
 * the invite record but isn't part of TeamMemberRow, and a resend expires the
 * old invite and writes a fresh one, so invited_at always tracks the live
 * link. INVITE_TTL_MS in ./actions.ts is the source of truth for the window —
 * it cannot be imported here, because a "use server" module may only export
 * async functions.
 */
const INVITE_TTL_DAYS = 7;

function fmtInviteExpiry(row: TeamMemberRow): string {
  if (!row.invited_at) return "—";
  const sent = new Date(row.invited_at).getTime();
  if (Number.isNaN(sent)) return "—";

  const expiresAt = sent + INVITE_TTL_DAYS * 86_400_000;
  const msLeft = expiresAt - Date.now();
  const date = new Date(expiresAt).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
  });

  if (msLeft <= 0) return `Expired · ${date}`;
  const daysLeft = Math.ceil(msLeft / 86_400_000);
  return `In ${daysLeft} day${daysLeft === 1 ? "" : "s"} · ${date}`;
}

/**
 * The design system's lime highlight sticker — one keyword per page lede.
 *
 * `z-0` on the span is load-bearing: it opens a stacking context so the
 * pseudo's negative z-index resolves INSIDE the span rather than dropping
 * behind the page background, which is what makes a bare `-z-10` sticker
 * vanish.
 */
function LimeHighlight({ children }: { children: React.ReactNode }) {
  return (
    <span className="relative z-0 inline-block px-1 font-bold text-[var(--ai-t1)] before:absolute before:-left-[3px] before:-right-[3px] before:bottom-[8%] before:top-[6%] before:-z-10 before:-rotate-[1.2deg] before:rounded-[3px] before:bg-remotiv-lime before:content-['']">
      {children}
    </span>
  );
}

// ── Dark hero ────────────────────────────────────────────────

type RoleCount = { role: CompanyRole; count: number };

/**
 * The segment's three-part dark strip: headline metric, role breakdown,
 * recently-active facepile.
 *
 * Every <p> here sets its colour explicitly. The design system ships a global
 * `p { color:#444 }` that beats an inherited white, so a <p> without its own
 * colour renders near-invisible on #141020.
 *
 * The mock's first cell is "Seats used — 3 / 10" with a capacity bar and a
 * Manage plan CTA. Billing does not exist yet and there is no seat limit
 * anywhere in the schema, so inventing a denominator would put a fake number
 * in front of the customer. It is replaced by team size, and the lime bar is
 * kept with a denominator we genuinely have: how much of the team has
 * accepted its invite.
 */
function TeamHero({
  activeCount,
  pendingCount,
  roleCounts,
  faces,
  recentCount,
}: {
  activeCount: number;
  pendingCount: number;
  roleCounts: RoleCount[];
  faces: TeamMemberRow[];
  recentCount: number;
}) {
  const total = activeCount + pendingCount;
  const topRole = roleCounts[0]?.count ?? 0;
  const acceptedPct = total > 0 ? Math.round((activeCount / total) * 100) : 0;

  const subline =
    pendingCount === 0
      ? activeCount === 1
        ? "Just you so far"
        : "Everyone has accepted their invite"
      : `${pendingCount} invite${pendingCount === 1 ? "" : "s"} still pending`;

  const extraFaces = Math.max(0, recentCount - faces.length);

  return (
    <DashboardHero
      eyebrow="Seats used"
      value={
        <>
          {activeCount}
          <i className="text-[22px] font-bold not-italic text-[rgba(4,52,44,0.45)]">
            {activeCount === 1 ? "member" : "members"}
          </i>
        </>
      }
      subline={subline}
      belowValue={
        /* On mint now, so the track and fill both invert — a white/12 track
           and a lime fill are both invisible on #49D7A7. */
        <div className="mt-3 h-[5px] w-[168px] max-w-full overflow-hidden rounded-[3px] bg-[rgba(4,52,44,0.18)]">
          <div
            className="h-full rounded-[3px] bg-[var(--ai-sidebar)]"
            style={{ width: `${acceptedPct}%` }}
          />
        </div>
      }
      trailing={<TeamFacepile faces={faces} extraFaces={extraFaces} />}
    >
      <div className="min-w-0">
        <p className="m-0 mb-3 text-[10.5px] font-bold uppercase tracking-[0.14em] text-white/40">
          Who&apos;s on the team
        </p>
        <div className="flex flex-col gap-2">
          {roleCounts.map((r) => (
            <div
              key={r.role}
              className="grid grid-cols-[minmax(0,96px)_1fr_20px] items-center gap-3 min-[630px]:grid-cols-[minmax(0,124px)_1fr_20px]"
            >
              <span className="truncate text-[12.5px] text-white/70">
                {COMPANY_ROLE_LABELS[r.role]}
              </span>
              <span className="h-[6px] overflow-hidden rounded-[4px] bg-white/10">
                <span
                  className="block h-full origin-left rounded-[4px]"
                  style={{
                    width: `${topRole > 0 ? Math.round((r.count / topRole) * 100) : 0}%`,
                    background: ROLE_BAR[r.role],
                  }}
                />
              </span>
              <span className="text-right text-[12.5px] font-bold tabular-nums text-white">
                {r.count}
              </span>
            </div>
          ))}
        </div>
      </div>

    </DashboardHero>
  );
}

/** Recently-active avatars. Its own component so the hero's third column is
 *  one node rather than a stretch of markup inside a prop. */
function TeamFacepile({
  faces,
  extraFaces,
}: {
  faces: TeamMemberRow[];
  extraFaces: number;
}) {
  return (
    <div className="min-[1180px]:text-right">
        <p className="m-0 mb-[11px] text-[10.5px] font-bold uppercase tracking-[0.14em] text-white/40">
          Recently active
        </p>
        {faces.length === 0 ? (
          <p className="m-0 text-[12.5px] text-white/50">No sign-ins this week</p>
        ) : (
          <div className="flex min-[1180px]:justify-end">
            {faces.map((m, i) => {
              const tint = getTint(m.email || m.id, m.is_owner);
              return (
                <span
                  key={m.id}
                  // -11px overlap is the mock's facepile, not a bug.
                  className={`flex size-[38px] items-center justify-center rounded-full border-[2.5px] border-[var(--ai-sidebar)] text-[12.5px] font-bold ${
                    i === 0 ? "" : "-ml-[11px]"
                  }`}
                  style={{ background: tint.bg, color: tint.fg }}
                  title={m.name || m.email}
                >
                  {getInitials(m.name, m.email)}
                </span>
              );
            })}
            {extraFaces > 0 && (
              <span className="-ml-[11px] flex size-[38px] items-center justify-center rounded-full border-[2.5px] border-[var(--ai-sidebar)] bg-white/[0.12] text-[12.5px] font-bold text-white/70">
                +{extraFaces}
              </span>
            )}
          </div>
        )}
        {/* AI interviews ship in a later step; 0 is the honest count. */}
        <p className="m-0 mt-2.5 text-[11.5px] text-white/40">
          0 interviews run this month
        </p>
    </div>
  );
}

// ── Drawer ───────────────────────────────────────────────────

function DrawerSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-6 last:mb-2">
      <p className="mb-3 text-[10px] font-semibold uppercase tracking-widest text-[var(--ai-t3)]">
        {title}
      </p>
      {children}
    </section>
  );
}

function DrawerKv({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-3">
      <span className="w-24 shrink-0 text-[10px] uppercase tracking-widest text-[var(--ai-t4)]">
        {label}
      </span>
      <span className="flex-1 break-words text-[var(--ai-t2)]">{value}</span>
    </div>
  );
}

/**
 * Right-hand slide-in panel, replacing the row dropdown that clipped inside
 * the table's horizontal-scroll container. Structure and mechanics mirror the
 * shipped jobs drawer — Escape, scrim, body scroll lock, focus into the panel,
 * full-width on mobile — but it is a local copy: the two products never import
 * each other's components.
 */
function MemberDrawer({
  member,
  companyName,
  canManage,
  editable,
  onClose,
  onRoleChange,
  onResend,
  onRemove,
}: {
  member: TeamMemberRow;
  companyName: string;
  canManage: boolean;
  editable: boolean;
  onClose: () => void;
  onRoleChange: (role: CompanyRole) => void;
  onResend: () => void;
  onRemove: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const pending = member.status === "invited";
  const tint = getTint(member.email || member.id, member.is_owner);
  const last = fmtLastActive(member.last_sign_in_at);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panelRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  const title = pending ? member.email : member.name;

  return (
    <div className="fixed inset-0 z-40 flex">
      {/* Backdrop is desktop-only: on mobile the panel covers the whole
          viewport, so a separate dim layer would never be visible. */}
      <button
        type="button"
        aria-label="Close drawer"
        onClick={onClose}
        className="hidden flex-1 bg-black/30 backdrop-blur-sm min-[840px]:block"
      />
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={`Actions for ${title}`}
        className="flex h-full w-full shrink-0 flex-col bg-[var(--ai-surface)] shadow-2xl outline-none min-[840px]:w-[420px]"
      >
        <div className="relative shrink-0 border-b border-[var(--ai-line)] px-4 py-5 min-[840px]:px-6 min-[840px]:py-6">
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="absolute right-3 top-3 flex size-11 items-center justify-center rounded-full text-[var(--ai-t3)] transition-colors hover:bg-[var(--ai-inset)] hover:text-[var(--ai-t1)] min-[840px]:right-4 min-[840px]:top-4 min-[840px]:size-8"
          >
            <X className="size-5 min-[840px]:size-4" strokeWidth={2.5} />
          </button>

          <div className="flex items-start gap-4 pr-8">
            {pending ? (
              <span className="flex size-[46px] shrink-0 items-center justify-center rounded-full border-[1.5px] border-dashed border-[var(--ai-line-strong)] bg-[var(--ai-inset)] text-[var(--ai-t3)]">
                <Mail className="size-[18px]" strokeWidth={1.6} />
              </span>
            ) : (
              <span
                className="flex size-[46px] shrink-0 items-center justify-center rounded-full text-sm font-bold"
                style={{ background: tint.bg, color: tint.fg }}
              >
                {getInitials(member.name, member.email)}
              </span>
            )}
            <div className="min-w-0 flex-1">
              <p className="flex min-w-0 items-center gap-2 font-heading text-lg font-bold text-[var(--ai-t1)]">
                <span className="min-w-0 truncate">{title}</span>
                {member.is_self && (
                  <span className="shrink-0 rounded-[5px] bg-remotiv-lime px-[7px] py-0.5 text-[9.5px] font-extrabold uppercase tracking-[0.06em] text-[#2F3A00]">
                    You
                  </span>
                )}
              </p>
              <p className="mt-0.5 truncate text-[12.5px] text-[var(--ai-t3)]">
                {pending ? fmtInvitedBy(member) : member.email}
              </p>
              <span
                className={`mt-2 inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-bold ${
                  pending
                    ? "bg-[var(--ai-amber-tint)] text-[var(--ai-amber-ink)]"
                    : "bg-[var(--ai-purple-tint)] text-[var(--ai-purple-ink)]"
                }`}
              >
                <span
                  className={`size-[5px] rounded-full ${
                    pending ? "bg-[var(--ai-amber-dot)]" : "bg-remotiv-purple"
                  }`}
                />
                {pending
                  ? `Pending · ${COMPANY_ROLE_LABELS[member.role]}`
                  : COMPANY_ROLE_LABELS[member.role]}
              </span>
            </div>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          <DrawerSection title="Details">
            <div className="grid grid-cols-1 gap-2 text-xs">
              <DrawerKv label="Role" value={COMPANY_ROLE_LABELS[member.role]} />
              <DrawerKv
                label="Access"
                value={
                  pending ? "Awaiting acceptance" : COMPANY_ROLE_ACCESS[member.role]
                }
              />
              {pending ? (
                <>
                  <DrawerKv label="Invited" value={fmtInvitedBy(member)} />
                  <DrawerKv label="Expires" value={fmtInviteExpiry(member)} />
                </>
              ) : (
                <DrawerKv
                  label="Last active"
                  value={`${last.main} · ${last.sub}`}
                />
              )}
            </div>
          </DrawerSection>

          {canManage && (editable || pending) && (
            <DrawerSection title="Actions">
              {editable && (
                <div>
                  <label
                    htmlFor="drawer-role"
                    className="mb-1.5 block text-xs font-semibold text-[var(--ai-t2)]"
                  >
                    Change role
                  </label>
                  <div className="relative">
                    <select
                      id="drawer-role"
                      value={member.role}
                      onChange={(e) => onRoleChange(e.target.value as CompanyRole)}
                      className="w-full appearance-none rounded-xl border border-[var(--ai-line-strong)] bg-[var(--ai-surface)] py-2.5 pl-3.5 pr-10 text-[13px] font-bold text-[var(--ai-t1)] outline-none transition-colors hover:border-remotiv-purple focus:border-remotiv-purple focus:ring-[3px] focus:ring-remotiv-purple/[0.16]"
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
                    {COMPANY_ROLE_ACCESS[member.role]} — changes apply
                    immediately.
                  </p>
                </div>
              )}

              {/* "Send message" and "Copy invite link" are deliberately absent.
                  There is no messaging surface, and the invite token is stored
                  only as a hash, so an existing invite's link cannot be
                  reconstructed — a resend mints a fresh one instead. */}
              {pending && (
                <button
                  type="button"
                  onClick={onResend}
                  className="flex w-full items-center gap-2 rounded-xl border border-[var(--ai-line)] bg-[var(--ai-surface)] px-3 py-2.5 text-xs font-semibold text-[var(--ai-t2)] transition-colors hover:bg-[var(--ai-inset)] hover:text-[var(--ai-t1)]"
                >
                  <RefreshCcw className="size-3.5 text-remotiv-purple" strokeWidth={2} />
                  Resend invite
                </button>
              )}
            </DrawerSection>
          )}

          {canManage && (editable || pending) && (
            <DrawerSection title="Danger">
              <button
                type="button"
                onClick={onRemove}
                className="flex w-full items-center justify-center gap-1.5 rounded-xl bg-[var(--ai-danger-tint)] px-3 py-2.5 text-xs font-semibold text-[var(--ai-danger)] transition-opacity hover:opacity-80"
              >
                {pending ? (
                  <XCircle className="size-3.5" strokeWidth={2} />
                ) : (
                  <Trash2 className="size-3.5" strokeWidth={2} />
                )}
                {pending ? "Revoke invite" : "Remove from team"}
              </button>
              <p className="mt-2 text-[10px] leading-relaxed text-[var(--ai-t4)]">
                {pending
                  ? "The invitation link stops working immediately. You can invite them again later."
                  : `They lose access to the ${companyName} workspace. Their account isn't deleted — you can re-invite them later.`}
              </p>
            </DrawerSection>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Read-only reference panel: what each of the four roles can do.
 *
 * Informational, so it is NOT gated on canManageTeam — a recruiter asking
 * "why can't I invite anyone?" is exactly who needs it. Same drawer mechanics
 * as MemberDrawer: Escape, scrim, focus, body scroll lock, full-width on
 * mobile.
 */
function RolePermissionsDrawer({
  viewerRole,
  onClose,
}: {
  viewerRole: CompanyRole;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panelRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-40 flex">
      <button
        type="button"
        aria-label="Close drawer"
        onClick={onClose}
        className="hidden flex-1 bg-black/30 backdrop-blur-sm min-[840px]:block"
      />
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Role permissions"
        className="flex h-full w-full shrink-0 flex-col bg-[var(--ai-surface)] shadow-2xl outline-none min-[840px]:w-[420px]"
      >
        {/* Dark header. Both <p> here set an explicit colour — the DS's global
            `p { color:#444 }` beats inherited white. */}
        <div className="relative shrink-0 bg-[var(--ai-sidebar)] px-4 py-5 min-[840px]:px-6 min-[840px]:py-6">
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="absolute right-3 top-3 z-[2] flex size-11 items-center justify-center rounded-full text-white/60 transition-colors hover:bg-white/10 hover:text-white min-[840px]:right-4 min-[840px]:top-4 min-[840px]:size-8"
          >
            <X className="size-5 min-[840px]:size-4" strokeWidth={2.5} />
          </button>
          <div className="relative z-[1] pr-8">
            <p className="m-0 mb-2 flex items-center gap-2 text-[10.5px] font-bold uppercase tracking-[0.14em] text-white/40">
              <Lock className="size-3" strokeWidth={2.2} />
              Role permissions
            </p>
            <h2 className="font-heading text-[21px] font-extrabold tracking-[-0.028em] text-white">
              Who can do what
            </h2>
            <p className="m-0 mt-1.5 text-[13px] leading-relaxed text-white/55">
              Four roles, from the whole workspace down to a single assigned
              job. Everyone can see the workspace; the differences are below.
            </p>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          {ALL_ROLES.map((role) => (
            <section key={role} className="mb-6 last:mb-2">
              <p className="mb-3 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-widest text-[var(--ai-t3)]">
                {COMPANY_ROLE_LABELS[role]}
                {role === viewerRole && (
                  <span className="rounded-[5px] bg-remotiv-lime px-[7px] py-0.5 text-[9.5px] font-extrabold uppercase tracking-[0.06em] text-[#2F3A00]">
                    Your role
                  </span>
                )}
              </p>

              <div className="rounded-xl border border-[var(--ai-line)] bg-[var(--ai-surface)]">
                {CAPABILITIES.map((cap) => {
                  const allowed = cap.allows(role);
                  return (
                    <div
                      key={cap.label}
                      className="flex items-start gap-2.5 border-b border-[var(--ai-line-soft)] px-3.5 py-2.5 last:border-b-0"
                    >
                      {allowed ? (
                        <Check
                          className="mt-px size-3.5 shrink-0 text-remotiv-green"
                          strokeWidth={2.6}
                        />
                      ) : (
                        <span
                          aria-hidden
                          className="mt-[7px] h-px w-3.5 shrink-0 bg-[var(--ai-t4)]"
                        />
                      )}
                      <span
                        className={`flex-1 text-[12.5px] leading-snug ${
                          allowed ? "text-[var(--ai-t2)]" : "text-[var(--ai-t4)]"
                        }`}
                      >
                        {cap.label}
                        <span className="sr-only">
                          {allowed ? " — allowed" : " — not allowed"}
                        </span>
                        {cap.pending && allowed && (
                          <span className="ml-1.5 whitespace-nowrap rounded-[5px] bg-[var(--ai-amber-tint)] px-1.5 py-px text-[9.5px] font-bold uppercase tracking-[0.04em] text-[var(--ai-amber-ink)]">
                            Not yet available
                          </span>
                        )}
                      </span>
                    </div>
                  );
                })}
              </div>
            </section>
          ))}

          <p className="m-0 rounded-xl bg-[var(--ai-inset)] px-3.5 py-3 text-[11.5px] leading-relaxed text-[var(--ai-t3)]">
            AI interviews and candidate verification aren&apos;t built yet. When
            they ship they&apos;ll follow these same roles, and this list updates
            with them. Only the owner&apos;s role is fixed — it can&apos;t be
            changed or reassigned here.
          </p>
        </div>
      </div>
    </div>
  );
}

/** The mock's empty-state glyph. Local so the panel needs no extra import. */
function UsersIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-7"
      aria-hidden="true"
    >
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
    </svg>
  );
}

// ── Mobile card ──────────────────────────────────────────────

/**
 * Stacked card shown below the table breakpoint. Same information as the
 * desktop row — identity, role, access, last active — laid out vertically so
 * nothing needs horizontal scrolling.
 *
 * Tappable only for managers, mirroring the desktop row: there the ⋯ is the
 * only way into the drawer and it isn't rendered for recruiters or hiring
 * managers, so a tappable card would hand them actions the table withholds.
 */
function MemberCard({
  member,
  hasActions,
  onOpen,
}: {
  member: TeamMemberRow;
  hasActions: boolean;
  onOpen: () => void;
}) {
  const pending = member.status === "invited";
  const tint = getTint(member.email || member.id, member.is_owner);
  const last = fmtLastActive(member.last_sign_in_at);

  const body = (
    <>
      <div className="flex items-start gap-3">
        {pending ? (
          <span className="flex size-10 shrink-0 items-center justify-center rounded-full border-[1.5px] border-dashed border-[var(--ai-line-strong)] bg-[var(--ai-inset)] text-[var(--ai-t3)]">
            <Mail className="size-4" strokeWidth={1.6} />
          </span>
        ) : (
          <span
            className="flex size-10 shrink-0 items-center justify-center rounded-full text-[13px] font-bold"
            style={{ background: tint.bg, color: tint.fg }}
          >
            {getInitials(member.name, member.email)}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <p className="m-0 flex min-w-0 items-center gap-2 text-[14.5px] font-bold leading-tight tracking-[-0.01em] text-[var(--ai-t1)]">
            <span className="min-w-0 truncate">
              {pending ? member.email : member.name}
            </span>
            {member.is_self && (
              <span className="shrink-0 rounded-[5px] bg-remotiv-lime px-[7px] py-0.5 text-[9.5px] font-extrabold uppercase tracking-[0.06em] text-[#2F3A00]">
                You
              </span>
            )}
          </p>
          <p className="m-0 mt-0.5 truncate text-[12.5px] text-[var(--ai-t3)]">
            {pending ? fmtInvitedBy(member) : member.email}
          </p>
        </div>
      </div>

      <div className="mt-3 flex items-center justify-between gap-3">
        <span
          className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-[5px] text-xs font-bold ${
            pending
              ? "bg-[var(--ai-amber-tint)] text-[var(--ai-amber-ink)]"
              : member.is_owner
                ? "bg-[var(--ai-purple-tint)] text-[var(--ai-purple-ink)]"
                : "bg-[var(--ai-slate-tint)] text-[var(--ai-slate-ink)]"
          }`}
        >
          <span
            className={`size-[5px] shrink-0 rounded-full ${
              pending
                ? "bg-[var(--ai-amber-dot)]"
                : member.is_owner
                  ? "bg-remotiv-purple"
                  : "bg-[var(--ai-t4)]"
            }`}
          />
          {pending
            ? `Pending · ${COMPANY_ROLE_LABELS[member.role]}`
            : COMPANY_ROLE_LABELS[member.role]}
        </span>
        <span className="truncate text-[12.5px] text-[var(--ai-t3)]">
          {pending ? "Awaiting acceptance" : COMPANY_ROLE_ACCESS[member.role]}
        </span>
      </div>

      <p className="m-0 mt-3 flex items-center gap-1.5 text-[11.5px] text-[var(--ai-t4)]">
        <Clock className="size-3" strokeWidth={1.9} />
        {pending ? fmtInviteExpiry(member) : `${last.main} · ${last.sub}`}
      </p>
    </>
  );

  const shell =
    "w-full border-b border-[var(--ai-line-soft)] px-4 py-4 text-left last:border-b-0";

  if (!hasActions) return <div className={shell}>{body}</div>;

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-haspopup="dialog"
      aria-label={`Actions for ${pending ? member.email : member.name}`}
      className={`${shell} bg-[var(--ai-surface)] transition-colors active:bg-[#FCFBFA]`}
    >
      {body}
    </button>
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
        className="w-full max-w-[470px] overflow-hidden rounded-[24px] bg-white shadow-[0_44px_110px_rgba(0,0,0,0.4)]"
      >
        {/* Dark modal hero. Both <p> elements below carry an explicit colour —
            the DS's global `p { color:#444 }` beats inherited white here. */}
        <div className="bg-[var(--ai-sidebar)] px-7 pb-[22px] pt-6">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h2
                id="invite-modal-title"
                className="font-heading text-[21px] font-extrabold tracking-[-0.028em] text-white"
              >
                Invite a member
              </h2>
              <p className="mt-1.5 text-[13px] leading-relaxed text-white/55">
                They&apos;ll get an email invite to join the {companyName}{" "}
                workspace.
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="flex size-9 shrink-0 items-center justify-center rounded-full text-white/60 transition-colors hover:bg-white/10 hover:text-white"
            >
              <X className="size-4" strokeWidth={2.5} />
            </button>
          </div>
        </div>

        <form
          onSubmit={handleSubmit}
          className="flex flex-col gap-4 px-7 pb-[26px] pt-[22px]"
        >
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
            <p className="mt-2 text-xs leading-relaxed text-[var(--ai-t3)]">
              {ROLE_HINTS[role]}
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
  const [search, setSearch] = useState("");
  const [showInvite, setShowInvite] = useState(false);
  const [showRoles, setShowRoles] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
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

  /**
   * Role breakdown for the hero, biggest first. Only roles actually present
   * appear — an empty "Recruiter 0" bar says nothing and the mock never shows
   * one. Ties break on the canonical role order so the list can't shuffle.
   */
  const roleCounts = useMemo<RoleCount[]>(() => {
    const counts = new Map<CompanyRole, number>();
    for (const m of activeMembers) {
      counts.set(m.role, (counts.get(m.role) ?? 0) + 1);
    }
    return ALL_ROLES.filter((r) => (counts.get(r) ?? 0) > 0)
      .map((role) => ({ role, count: counts.get(role) ?? 0 }))
      .sort((a, b) =>
        b.count !== a.count
          ? b.count - a.count
          : ALL_ROLES.indexOf(a.role) - ALL_ROLES.indexOf(b.role),
      );
  }, [activeMembers]);

  /**
   * Recently-active facepile. Derived from last_sign_in_at, NOT live presence
   * — nothing in this product tracks who is online right now, so the label
   * says "recently active" rather than the mock's "active now".
   */
  const recentlyActive = useMemo(
    () =>
      activeMembers
        .filter((m) => {
          if (!m.last_sign_in_at) return false;
          const t = new Date(m.last_sign_in_at).getTime();
          return !Number.isNaN(t) && Date.now() - t <= RECENT_MS;
        })
        .sort(
          (a, b) =>
            new Date(b.last_sign_in_at ?? 0).getTime() -
            new Date(a.last_sign_in_at ?? 0).getTime(),
        ),
    [activeMembers],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return members.filter((m) => {
      if (segment === "members" && m.status !== "active") return false;
      if (segment === "pending" && m.status !== "invited") return false;
      if (roleFilter !== "all" && m.role !== roleFilter) return false;
      if (q && !`${m.name} ${m.email}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [members, segment, roleFilter, search]);

  const openMember = openId
    ? (members.find((m) => m.id === openId) ?? null)
    : null;

  /** Owner and your own row are never editable — the same rules the server
   *  enforces in updateMemberRole / removeMember. */
  function isEditable(m: TeamMemberRow) {
    return canManage && !m.is_owner && !m.is_self && m.status !== "invited";
  }

  /** Whether the row gets a ⋯ trigger at all. */
  function hasActions(m: TeamMemberRow) {
    return canManage && (isEditable(m) || m.status === "invited");
  }

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

  /**
   * Opening clause of the lede. Says nothing about seats or plans — there is
   * no seat limit in the schema and no billing surface, so any "N of M" here
   * would be invented.
   */
  const ledeCount = (() => {
    const n = activeMembers.length;
    const people = n === 1 ? "1 person runs" : `${n} people run`;
    const base = `${people} hiring at ${companyName}.`;
    if (pendingMembers.length === 0) return base;
    return `${base.slice(0, -1)}, with ${pendingMembers.length} invite${
      pendingMembers.length === 1 ? "" : "s"
    } out.`;
  })();

  return (
    <PageContainer>
      {/* Header */}
      <div className="mb-5 flex flex-col items-start justify-between gap-4 min-[630px]:flex-row min-[630px]:items-end min-[630px]:gap-6">
        <div>
          <h1 className="font-heading text-[32px] font-extrabold leading-none tracking-[-0.035em]">
            Team
          </h1>
          <p className="mt-2.5 max-w-[520px] text-[14.5px] leading-relaxed text-[var(--ai-t2)]">
            {ledeCount} Roles decide <LimeHighlight>who sees what</LimeHighlight>{" "}
            — from the whole workspace down to a single assigned job.
          </p>
        </div>
        <div className="flex shrink-0 gap-2.5">
          {/* Informational, so every role sees it — a recruiter asking why
              they can't invite anyone is exactly who needs it. */}
          <button
            type="button"
            onClick={() => setShowRoles(true)}
            className="inline-flex items-center gap-2 whitespace-nowrap rounded-xl border border-[var(--ai-line-strong)] bg-[var(--ai-surface)] px-4 py-[11px] text-[13.5px] font-semibold text-[var(--ai-t2)] transition-colors hover:border-[var(--ai-sidebar)] hover:bg-[var(--ai-sidebar)] hover:text-white"
          >
            <Lock className="size-[15px]" strokeWidth={1.9} />
            Role permissions
          </button>
          {canManage && (
            <button
              type="button"
              onClick={() => setShowInvite(true)}
              className="inline-flex items-center gap-2 whitespace-nowrap rounded-xl bg-remotiv-purple px-[18px] py-[11px] text-[13.5px] font-bold text-white shadow-[0_6px_20px_rgba(126,71,255,0.3)] transition-colors hover:bg-[var(--ai-purple-hover)] hover:shadow-[0_10px_28px_rgba(126,71,255,0.4)]"
            >
              <Plus className="size-[15px]" strokeWidth={2.2} />
              Invite member
            </button>
          )}
        </div>
      </div>

      <TeamHero
        activeCount={activeMembers.length}
        pendingCount={pendingMembers.length}
        roleCounts={roleCounts}
        faces={recentlyActive.slice(0, FACE_LIMIT)}
        recentCount={recentlyActive.length}
      />

      {/* Panel */}
      <div className="overflow-hidden rounded-[20px] border border-[var(--ai-line)] bg-[var(--ai-surface)] shadow-[0_6px_30px_rgba(20,16,32,0.06)]">
        <div className="flex flex-wrap items-center gap-3 border-b border-[var(--ai-line)] px-[18px] py-3.5">
          {/* Active tab is solid ink with a white count badge. The strip
              scrolls WITHIN itself so it can never widen the page. */}
          <div className="flex max-w-full overflow-x-auto rounded-[11px] border border-[var(--ai-line)] bg-[var(--ai-inset)] p-[3px]">
            {segments.map((s) => (
              <button
                key={s.key}
                type="button"
                onClick={() => setSegment(s.key)}
                className={`flex items-center gap-[7px] whitespace-nowrap rounded-lg px-3.5 py-[7px] text-[12.5px] font-semibold transition-colors min-[525px]:px-[14px] ${
                  segment === s.key
                    ? "bg-[var(--ai-sidebar)] text-white shadow-[0_3px_10px_rgba(20,16,32,0.2)]"
                    : "text-[var(--ai-t3)] hover:text-[var(--ai-t1)]"
                }`}
              >
                {s.label}
                <span
                  className={`rounded-full px-1.5 py-px text-[10.5px] font-bold ${
                    segment === s.key
                      ? "bg-white/20 text-white"
                      : "bg-[rgba(20,16,32,0.07)]"
                  }`}
                >
                  {s.count}
                </span>
              </button>
            ))}
          </div>

          {/* Full-width on phones so the filter and search stack under the
              tabs instead of forcing the toolbar wider than the viewport. */}
          <div className="flex w-full items-center gap-[9px] min-[630px]:ml-auto min-[630px]:w-auto">
            <div className="relative shrink-0">
              <select
                aria-label="Filter by role"
                value={roleFilter}
                onChange={(e) =>
                  setRoleFilter(e.target.value as "all" | CompanyRole)
                }
                className="w-full appearance-none rounded-[10px] border border-[var(--ai-line)] bg-[var(--ai-surface)] py-2 pl-3 pr-[30px] text-[12.5px] font-semibold text-[var(--ai-t2)] outline-none transition-colors hover:bg-[var(--ai-inset)] focus:border-remotiv-purple focus:ring-[3px] focus:ring-remotiv-purple/[0.14]"
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

            <div className="flex min-w-0 flex-1 items-center gap-2 rounded-[10px] border border-[var(--ai-line)] bg-[var(--ai-surface)] px-3 py-[7px] text-[var(--ai-t3)] focus-within:border-remotiv-purple min-[630px]:w-[200px] min-[630px]:flex-none">
              <SearchIcon className="size-[15px] shrink-0" strokeWidth={1.8} />
              <input
                type="search"
                aria-label="Search team"
                placeholder="Search team…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full min-w-0 bg-transparent text-[13px] text-[var(--ai-t1)] outline-none placeholder:text-[var(--ai-t3)]"
              />
            </div>
          </div>
        </div>

        {/* Hoisted OUT of the table wrapper: nested inside it, the empty state
            inherits the min-width and only renders at desktop widths, leaving
            phones with a blank panel. */}
        {filtered.length === 0 && (
          <div className="flex flex-col items-center px-6 pb-[60px] pt-14 text-center">
            <div className="mb-[18px] flex size-[66px] items-center justify-center rounded-[20px] bg-[var(--ai-purple-tint)] text-remotiv-purple">
              <UsersIcon />
            </div>
            <h3 className="font-heading text-[19px] font-extrabold tracking-[-0.02em]">
              {search.trim() ? `No one matches “${search.trim()}”` : "No one here"}
            </h3>
            <p className="m-0 mt-1.5 max-w-[340px] text-[13.5px] leading-relaxed text-[var(--ai-t3)]">
              {search.trim()
                ? "Try a different name or email, or clear the filters."
                : "Nothing matches these filters. Switch tabs or pick a different role."}
            </p>
          </div>
        )}

        {/* Stacked cards below the table breakpoint. The 5-column grid needs
            840 design px; the widest phone in scope offers 415. */}
        {filtered.length > 0 && (
          <div className="min-[1049px]:hidden">
            {filtered.map((m) => (
              <MemberCard
                key={m.id}
                member={m}
                hasActions={hasActions(m)}
                onOpen={() => setOpenId(m.id)}
              />
            ))}
          </div>
        )}

        {/* Desktop table — overflow-x-auto is a belt-and-braces guard; at
            >=1049px the grid fits. */}
        <div className="hidden overflow-x-auto min-[1049px]:block">
          <div className="min-w-[840px]">
            <div
              className={`${ROW_GRID} border-b border-[var(--ai-line)] bg-[var(--ai-inset)] py-[11px] text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--ai-t3)]`}
            >
              <span>Member</span>
              <span>Role</span>
              <span>Access</span>
              <span>Last active</span>
              <span />
            </div>

            {filtered.map((m) => {
                const tint = getTint(m.email || m.id, m.is_owner);
                const last = fmtLastActive(m.last_sign_in_at);
                const pending = m.status === "invited";
                const editable = isEditable(m);

                return (
                  <div
                    key={m.id}
                    // `group` drives the ⋯ reveal; `hover:z-[2]` lets the lift
                    // shadow sit over the rows either side of it.
                    className={`${ROW_GRID} group relative border-b border-[var(--ai-line-soft)] py-[15px] transition-[background-color,box-shadow] before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:bg-remotiv-purple before:opacity-0 before:transition-opacity before:content-[''] last:border-b-0 hover:z-[2] hover:bg-[#FCFBFA] hover:shadow-[0_6px_22px_rgba(20,16,32,0.07)] hover:before:opacity-100 ${
                      pending ? "bg-[#FDFCFA]" : ""
                    }`}
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

                    {hasActions(m) ? (
                      <button
                        type="button"
                        onClick={() => setOpenId(m.id)}
                        aria-label={`Actions for ${pending ? m.email : m.name}`}
                        aria-haspopup="dialog"
                        // Hidden until row hover, per the mock — focus-visible
                        // brings it back so it stays keyboard-reachable.
                        className="flex size-8 items-center justify-center justify-self-end rounded-[9px] text-[var(--ai-t4)] opacity-0 transition-[opacity,background-color,color] hover:bg-[var(--ai-sidebar)] hover:text-white focus-visible:opacity-100 group-hover:opacity-100"
                      >
                        <MoreHorizontal className="size-[18px]" strokeWidth={2} />
                      </button>
                    ) : (
                      <span />
                    )}
                  </div>
                );
            })}
          </div>
        </div>

        <div className="flex items-center justify-between gap-4 border-t border-[var(--ai-line)] bg-[var(--ai-inset)] px-5 py-[13px]">
          <p className="m-0 text-[12.5px] text-[var(--ai-t3)]">
            Owners and admins can invite members and change roles.
          </p>
          {/* The mock's "3 of 10 seats used" needs a seat limit that doesn't
              exist. This counts what we actually have. */}
          <span className="whitespace-nowrap text-[12.5px] font-semibold text-[var(--ai-t2)]">
            <b className="text-remotiv-purple">{activeMembers.length}</b>{" "}
            {activeMembers.length === 1 ? "member" : "members"}
            {pendingMembers.length > 0 && ` · ${pendingMembers.length} pending`}
          </span>
        </div>
      </div>

      {showRoles && (
        <RolePermissionsDrawer
          viewerRole={viewerRole}
          onClose={() => setShowRoles(false)}
        />
      )}

      {openMember && (
        <MemberDrawer
          member={openMember}
          companyName={companyName}
          canManage={canManage}
          editable={isEditable(openMember)}
          onClose={() => setOpenId(null)}
          onRoleChange={(role) => {
            handleRoleChange(openMember, role);
          }}
          onResend={() => {
            setOpenId(null);
            handleResend(openMember);
          }}
          onRemove={() => {
            // The confirm dialog owns the destructive step; closing the drawer
            // first keeps the two overlays from stacking.
            setOpenId(null);
            setRemoveTarget(openMember);
          }}
        />
      )}

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
