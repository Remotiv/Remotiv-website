"use client";

import { useState, useEffect } from "react";
import Image from "next/image";
import {
  Users,
  UserCheck,
  UserMinus,
  BarChart2,
  Mail,
  Phone,
  MoreHorizontal,
  X,
  Plus,
  AlertTriangle,
  CheckCircle,
  Copy,
  KeyRound,
  type LucideIcon,
} from "lucide-react";
import { TopNav } from "./top-nav";
import {
  addMember,
  updateMember,
  toggleMemberStatus,
  removeMember,
  resetMemberPassword,
  setAdminLoginStatus,
  type TeamMember,
  type MemberInput,
} from "@/app/admin/team/actions";
import {
  type UserRole,
  canManageTeam,
} from "@/app/admin/lib/roles";
import { getAvatarUrl } from "@/lib/avatars";

const ADMIN_LOGIN_URL =
  process.env.NEXT_PUBLIC_ADMIN_LOGIN_URL ??
  "http://localhost:3000/login";

// ── Constants ────────────────────────────────────────────────

const ROLES = [
  "Founder",
  "Project Manager",
  "Business Development",
  "Recruiter",
  "Operations",
];

const PERMISSIONS: { value: MemberInput["permission"]; label: string }[] = [
  { value: "super_admin", label: "Super Admin" },
  { value: "admin", label: "Admin" },
  { value: "viewer", label: "Viewer" },
];

// Avatar selection now flows through getAvatarUrl(first, last) from
// @/lib/avatars — see addMember handler below. Reads are also self-healing
// (we recompute the URL at render time and ignore member.avatar_url) so any
// legacy rows from the old hardcoded pool render correctly today.

function splitFullName(fullName: string): { first: string; last: string } {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first: "", last: "" };
  if (parts.length === 1) return { first: parts[0], last: "" };
  return { first: parts[0], last: parts.slice(1).join(" ") };
}

type StatCardDef = {
  label: string;
  value: number;
  from: string;
  to: string;
  icon: LucideIcon;
};

const EMPTY_FORM: MemberInput = {
  full_name: "",
  role: "Recruiter",
  email: "",
  phone: "",
  status: "active",
  permission: "admin",
  notes: "",
  gender: "male",
  avatar_url: "",
};

const INPUT_CLS =
  "w-full rounded-lg border border-gray-200 px-3.5 py-2.5 text-sm text-gray-800 outline-none transition-all focus:border-[#7E47FF] focus:ring-2 focus:ring-[#7E47FF]/20";
const LABEL_CLS =
  "mb-1.5 block text-[10px] font-semibold uppercase tracking-widest text-gray-400";

// ── Helpers ──────────────────────────────────────────────────

function getInitials(name: string): string {
  return name
    .split(" ")
    .slice(0, 2)
    .map((n) => n[0]?.toUpperCase() ?? "")
    .join("");
}

function memberColor(email: string): string {
  const n = email.split("").reduce((s, c) => s + c.charCodeAt(0), 0);
  return n % 2 === 0 ? "#7E47FF" : "#49D7A7";
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

/**
 * Self-healing avatar for a team member. We always recompute the URL via
 * getAvatarUrl(first, last) — never trust member.avatar_url — because
 * legacy rows may store broken "male 2.png" strings (the old hardcoded
 * pool used filenames that don't exist on disk). Initials chip fallback
 * if the image still fails to load.
 */
function MemberAvatar({ member }: { member: TeamMember }) {
  const { first, last } = splitFullName(member.full_name);
  const url = getAvatarUrl(first, last);
  const [errored, setErrored] = useState(false);

  if (errored) {
    return (
      <div
        className="flex size-12 shrink-0 items-center justify-center rounded-full text-sm font-bold text-white"
        style={{ background: memberColor(member.email) }}
      >
        {getInitials(member.full_name)}
      </div>
    );
  }

  return (
    <div className="relative size-12 shrink-0 overflow-hidden rounded-full">
      <Image
        src={url}
        alt={member.full_name}
        fill
        sizes="48px"
        className="object-cover"
        onError={() => setErrored(true)}
      />
    </div>
  );
}

// ── Component ────────────────────────────────────────────────

export function TeamDashboard({
  email,
  userRole = "viewer",
  initialMembers,
}: {
  email: string;
  userRole?: UserRole;
  initialMembers: TeamMember[];
}) {
  const canManage = canManageTeam(userRole);

  // ── Local state (optimistic) ──────────────────────────────
  const [members, setMembers] = useState<TeamMember[]>(initialMembers);
  const [mutating, setMutating] = useState(false);
  const [mutError, setMutError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [credentials, setCredentials] = useState<{
    full_name: string;
    email: string;
    password: string;
    title: string;
    description: string;
  } | null>(null);

  useEffect(() => {
    if (!successMsg) return;
    const t = setTimeout(() => setSuccessMsg(null), 7000);
    return () => clearTimeout(t);
  }, [successMsg]);

  // ── Three-dot menus ───────────────────────────────────────
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);

  useEffect(() => {
    if (openMenuId === null) return;
    function close() { setOpenMenuId(null); }
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [openMenuId]);

  // ── Modal (add / edit) ────────────────────────────────────
  const [showModal, setShowModal] = useState(false);
  const [editingMember, setEditingMember] = useState<TeamMember | null>(null);
  const [form, setForm] = useState<MemberInput>(EMPTY_FORM);

  function openAddModal() {
    setEditingMember(null);
    setForm(EMPTY_FORM);
    setMutError(null);
    setShowModal(true);
  }

  function openEditModal(member: TeamMember) {
    setEditingMember(member);
    setForm({
      full_name: member.full_name,
      role: member.role,
      email: member.email,
      phone: member.phone ?? "",
      status: member.status,
      permission: member.permission,
      notes: member.notes ?? "",
      gender: member.gender ?? "male",
      avatar_url: member.avatar_url ?? "",
    });
    setMutError(null);
    setShowModal(true);
  }

  function closeModal() {
    setShowModal(false);
    setEditingMember(null);
    setForm(EMPTY_FORM);
    setMutError(null);
  }

  function updateForm(key: keyof MemberInput, value: string) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setMutating(true);
    setMutError(null);

    if (editingMember) {
      const result = await updateMember(editingMember.id, form);
      if (!result.success) {
        setMutError(result.error);
        setMutating(false);
        return;
      }
      setMembers((prev) =>
        prev.map((m) => (m.id === editingMember.id ? result.data : m)),
      );
    } else {
      const { first, last } = splitFullName(form.full_name);
      const result = await addMember({
        ...form,
        avatar_url: getAvatarUrl(first, last),
      });
      if (!result.success) {
        setMutError(result.error);
        setMutating(false);
        return;
      }
      setMembers((prev) => [result.data.member, ...prev]);
      setCredentials({
        full_name: result.data.member.full_name,
        email: result.data.member.email,
        password: result.data.password,
        title: "Team Member Added",
        description: "Send these credentials to",
      });
    }

    setMutating(false);
    closeModal();
  }

  // ── Reset password (super_admin only) ─────────────────────
  async function handleResetPassword(member: TeamMember) {
    if (!member.auth_user_id) return;
    setMutating(true);
    const result = await resetMemberPassword(member.auth_user_id);
    setMutating(false);
    if (!result.success) {
      setSuccessMsg(`Failed to reset password: ${result.error}`);
      return;
    }
    setCredentials({
      full_name: member.full_name,
      email: member.email,
      password: result.data.password,
      title: "Password Reset",
      description: "The previous password is now invalid. Send the new credentials to",
    });
  }

  // ── Deactivate (optimistic) ───────────────────────────────
  async function handleToggleStatus(member: TeamMember) {
    const newStatus = member.status === "active" ? "inactive" : "active";
    setMembers((prev) =>
      prev.map((m) => (m.id === member.id ? { ...m, status: newStatus } : m)),
    );
    await toggleMemberStatus(member.id, newStatus);
  }

  // ── Pause / Resume Login (admin_users.status) ────────────
  async function handleToggleLoginPaused(member: TeamMember) {
    if (!member.auth_user_id) return;
    const newAuthStatus = member.auth_status === "active" ? "paused" : "active";
    setMembers((prev) =>
      prev.map((m) => (m.id === member.id ? { ...m, auth_status: newAuthStatus } : m)),
    );
    await setAdminLoginStatus(member.auth_user_id, newAuthStatus);
  }

  // ── Remove ────────────────────────────────────────────────
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  async function handleConfirmRemove() {
    if (!confirmDeleteId) return;
    setMembers((prev) => prev.filter((m) => m.id !== confirmDeleteId));
    setConfirmDeleteId(null);
    await removeMember(confirmDeleteId);
  }

  // ── Derived stats ─────────────────────────────────────────
  const activeCount = members.filter((m) => m.status === "active").length;
  const inactiveCount = members.filter((m) => m.status === "inactive").length;
  const avgPlacements =
    members.length > 0
      ? Math.round(
          members.reduce((s, m) => s + m.avg_placements, 0) / members.length,
        )
      : 0;

  const updateDate = new Date().toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });

  const STAT_CARDS: StatCardDef[] = [
    { label: "Total Members", value: members.length, from: "#c084fc", to: "#7E47FF", icon: Users },
    { label: "Active", value: activeCount, from: "#6ee7c7", to: "#49D7A7", icon: UserCheck },
    { label: "Inactive", value: inactiveCount, from: "#fdba74", to: "#f97316", icon: UserMinus },
    { label: "Avg Placements / Month", value: avgPlacements, from: "#93c5fd", to: "#3b82f6", icon: BarChart2 },
  ];

  return (
    <div className="min-h-full bg-[#f8f4f1] font-sans">

      <TopNav email={email} userRole={userRole} />

      {/* ── Page content ── */}
      <div className="p-5 lg:p-8">

        {/* Page header */}
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="font-heading text-2xl font-bold text-[#111]">Team</h1>
            <p className="mt-0.5 text-sm text-gray-400">Manage your team</p>
          </div>
          {canManage && (
            <button
              type="button"
              onClick={openAddModal}
              className="flex items-center gap-2 rounded-xl bg-[#7E47FF] px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-[#6a38e0]"
            >
              <Plus className="size-4" strokeWidth={2.5} />
              Add Member
            </button>
          )}
        </div>

        {/* ── Stat cards ── */}
        <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {STAT_CARDS.map(({ label, value, from, to, icon: Icon }) => (
            <div
              key={label}
              className="relative overflow-hidden rounded-2xl p-6 text-white"
              style={{ background: `linear-gradient(135deg, ${from}, ${to})` }}
            >
              <div className="pointer-events-none absolute -right-8 -top-8 size-32 rounded-full bg-white/10" />
              <div className="pointer-events-none absolute -bottom-4 right-8 size-16 rounded-full bg-white/10" />
              <Icon className="mb-4 size-7 opacity-90" strokeWidth={1.8} />
              <p className="font-heading text-[2.6rem] font-bold leading-none">{value}</p>
              <p className="mt-2 text-sm font-medium opacity-80">{label}</p>
              <p className="mt-3 text-[11px] opacity-50">Update: {updateDate}</p>
            </div>
          ))}
        </div>

        {/* ── Member cards grid ── */}
        {members.length === 0 ? (
          <div className="rounded-2xl border border-gray-100 bg-white py-16 text-center shadow-sm">
            <p className="text-sm text-gray-400">No team members yet. Add your first member to get started.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {members.map((member) => (
              <div key={member.id} className="relative rounded-2xl border border-gray-100 bg-white p-6 shadow-sm">

                {/* Three-dot menu — super_admin only */}
                {canManage && (
                  <div className="absolute right-4 top-4">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setOpenMenuId(openMenuId === member.id ? null : member.id);
                      }}
                      className="flex size-8 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-gray-50 hover:text-gray-700"
                    >
                      <MoreHorizontal className="size-4" strokeWidth={2} />
                    </button>
                    {openMenuId === member.id && (
                      <div className="absolute right-0 top-9 z-20 w-36 overflow-hidden rounded-xl border border-gray-100 bg-white shadow-lg">
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); setOpenMenuId(null); openEditModal(member); }}
                          className="w-full px-4 py-2.5 text-left text-sm text-gray-600 transition-colors hover:bg-gray-50"
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); setOpenMenuId(null); handleToggleStatus(member); }}
                          className="w-full px-4 py-2.5 text-left text-sm text-gray-600 transition-colors hover:bg-gray-50"
                        >
                          {member.status === "active" ? "Deactivate" : "Activate"}
                        </button>
                        {member.auth_user_id && (
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); setOpenMenuId(null); handleToggleLoginPaused(member); }}
                            className="w-full px-4 py-2.5 text-left text-sm text-amber-600 transition-colors hover:bg-amber-50"
                          >
                            {member.auth_status === "active" ? "Pause Login" : "Resume Login"}
                          </button>
                        )}
                        {member.auth_user_id && (
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); setOpenMenuId(null); handleResetPassword(member); }}
                            className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm text-gray-600 transition-colors hover:bg-gray-50"
                          >
                            <KeyRound className="size-3.5" strokeWidth={2} />
                            Reset Password
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); setOpenMenuId(null); setConfirmDeleteId(member.id); }}
                          className="w-full px-4 py-2.5 text-left text-sm text-red-500 transition-colors hover:bg-red-50"
                        >
                          Remove
                        </button>
                      </div>
                    )}
                  </div>
                )}

                {/* Avatar + name */}
                <div className="mb-4 flex items-center gap-3.5">
                  <MemberAvatar member={member} />
                  <div className="min-w-0 pr-8">
                    <p className="font-heading font-bold text-[#111]">{member.full_name}</p>
                    <p className="text-sm text-gray-400">{member.role}</p>
                  </div>
                </div>

                {/* Contact */}
                <div className="mb-4 flex flex-col gap-1.5">
                  <div className="flex items-center gap-2 text-xs text-gray-400">
                    <Mail className="size-3.5 shrink-0" strokeWidth={2} />
                    <span className="truncate">{member.email}</span>
                  </div>
                  {member.phone && (
                    <div className="flex items-center gap-2 text-xs text-gray-400">
                      <Phone className="size-3.5 shrink-0" strokeWidth={2} />
                      <span>{member.phone}</span>
                    </div>
                  )}
                </div>

                {/* Status badges */}
                <div className="mb-4 flex flex-wrap items-center gap-1.5">
                  <span
                    className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider ${
                      member.status === "active"
                        ? "bg-[#49D7A7]/10 text-[#1a9e73]"
                        : "bg-gray-100 text-gray-400"
                    }`}
                  >
                    <span className={`size-1.5 rounded-full ${member.status === "active" ? "bg-[#49D7A7]" : "bg-gray-400"}`} />
                    {member.status === "active" ? "Active" : "Inactive"}
                  </span>
                  {member.auth_status !== "active" && (
                    <span
                      className="inline-flex items-center gap-1.5 rounded-full bg-amber-100 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-amber-700"
                      title="This member can't log in until a super admin resumes their account."
                    >
                      🔒 Login {member.auth_status === "paused" ? "Paused" : member.auth_status}
                    </span>
                  )}
                </div>

                {/* Assigned pills */}
                <div className="mb-4 flex flex-wrap items-center gap-1.5">
                  <span className="rounded-lg bg-[#7E47FF]/10 px-2.5 py-1 text-xs font-medium text-[#7E47FF]">
                    {member.candidates_assigned} Candidates
                  </span>
                  {member.clients_assigned > 0 && (
                    <span className="rounded-lg bg-[#49D7A7]/10 px-2.5 py-1 text-xs font-medium text-[#1a9e73]">
                      {member.clients_assigned} Clients
                    </span>
                  )}
                </div>

                {/* Date joined */}
                <p className="text-[11px] text-gray-300">Joined {fmtDate(member.joined_at)}</p>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Add / Edit modal ── */}
      {showModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={(e) => { if (e.target === e.currentTarget) closeModal(); }}
        >
          <div className="w-full max-w-md rounded-2xl bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-gray-100 px-6 py-5">
              <h2 className="font-heading text-base font-bold text-[#111]">
                {editingMember ? "Edit Team Member" : "Add Team Member"}
              </h2>
              <button
                type="button"
                onClick={closeModal}
                className="flex size-8 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-gray-50 hover:text-gray-600"
              >
                <X className="size-4" strokeWidth={2} />
              </button>
            </div>

            <form onSubmit={handleSubmit} className="px-6 py-5">
              <div className="flex flex-col gap-4">
                <div>
                  <label className={LABEL_CLS} htmlFor="tm-name">Full Name</label>
                  <input
                    id="tm-name"
                    type="text"
                    required
                    placeholder="e.g. Waleed Khan"
                    className={INPUT_CLS}
                    value={form.full_name}
                    onChange={(e) => updateForm("full_name", e.target.value)}
                  />
                </div>

                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <label className={LABEL_CLS} htmlFor="tm-role">Role</label>
                    <select id="tm-role" className={INPUT_CLS} value={form.role} onChange={(e) => updateForm("role", e.target.value)}>
                      {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className={LABEL_CLS} htmlFor="tm-permission">Permission</label>
                    <select id="tm-permission" className={INPUT_CLS} value={form.permission} onChange={(e) => updateForm("permission", e.target.value)}>
                      {PERMISSIONS.map(({ value, label }) => <option key={value} value={value}>{label}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className={LABEL_CLS} htmlFor="tm-gender">Gender</label>
                    <select id="tm-gender" className={INPUT_CLS} value={form.gender} onChange={(e) => updateForm("gender", e.target.value)}>
                      <option value="male">Male</option>
                      <option value="female">Female</option>
                    </select>
                  </div>
                </div>

                <div>
                  <label className={LABEL_CLS} htmlFor="tm-email">Email</label>
                  <input
                    id="tm-email"
                    type="email"
                    required
                    placeholder="name@remotiv.work"
                    className={INPUT_CLS}
                    value={form.email}
                    onChange={(e) => updateForm("email", e.target.value)}
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className={LABEL_CLS} htmlFor="tm-phone">Phone</label>
                    <input
                      id="tm-phone"
                      type="tel"
                      placeholder="+92 300 0000000"
                      className={INPUT_CLS}
                      value={form.phone}
                      onChange={(e) => updateForm("phone", e.target.value)}
                    />
                  </div>
                  <div>
                    <label className={LABEL_CLS} htmlFor="tm-status">Status</label>
                    <select id="tm-status" className={INPUT_CLS} value={form.status} onChange={(e) => updateForm("status", e.target.value)}>
                      <option value="active">Active</option>
                      <option value="inactive">Inactive</option>
                    </select>
                  </div>
                </div>

                <div>
                  <label className={LABEL_CLS} htmlFor="tm-notes">Notes</label>
                  <textarea
                    id="tm-notes"
                    rows={3}
                    placeholder="Optional notes about this team member..."
                    className={`${INPUT_CLS} resize-none`}
                    value={form.notes}
                    onChange={(e) => updateForm("notes", e.target.value)}
                  />
                </div>

                {mutError && (
                  <p className="rounded-lg bg-red-50 px-3.5 py-2.5 text-sm text-red-500">
                    {mutError}
                  </p>
                )}
              </div>

              <div className="mt-6 flex items-center justify-end gap-3">
                <button
                  type="button"
                  onClick={closeModal}
                  className="rounded-xl border border-gray-200 px-4 py-2.5 text-sm font-medium text-gray-600 transition-colors hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={mutating}
                  className="rounded-xl bg-[#7E47FF] px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-[#6a38e0] disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {mutating ? "Saving…" : editingMember ? "Save Changes" : "Add Member"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── Success toast ── */}
      {successMsg && (
        <div className="fixed bottom-6 right-6 z-[60] flex max-w-sm items-start gap-3 rounded-2xl border border-[#49D7A7]/30 bg-white px-4 py-3.5 shadow-xl">
          <div className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-[#49D7A7]/15 text-[#1a9e73]">
            <svg viewBox="0 0 12 12" className="size-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
              <polyline points="1.5 6.5 4.5 9.5 10.5 2.5" />
            </svg>
          </div>
          <p className="text-sm leading-snug text-gray-700">{successMsg}</p>
          <button
            type="button"
            onClick={() => setSuccessMsg(null)}
            className="ml-1 mt-0.5 shrink-0 text-gray-300 transition-colors hover:text-gray-500"
          >
            <X className="size-3.5" strokeWidth={2.5} />
          </button>
        </div>
      )}

      {/* ── Remove confirmation modal ── */}
      {confirmDeleteId && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={(e) => { if (e.target === e.currentTarget) setConfirmDeleteId(null); }}
        >
          <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl">
            <div className="mb-4 flex size-11 items-center justify-center rounded-full bg-red-50">
              <AlertTriangle className="size-5 text-red-500" strokeWidth={2} />
            </div>
            <h2 className="font-heading text-base font-bold text-[#111]">Remove Member?</h2>
            <p className="mt-2 text-sm text-gray-400">
              This will permanently delete this team member. This action cannot be undone.
            </p>
            <div className="mt-6 flex items-center justify-end gap-3">
              <button
                type="button"
                onClick={() => setConfirmDeleteId(null)}
                className="rounded-xl border border-gray-200 px-4 py-2.5 text-sm font-medium text-gray-600 transition-colors hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmRemove}
                className="rounded-xl bg-red-500 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-red-600"
              >
                Remove
              </button>
            </div>
          </div>
        </div>
      )}

      {credentials && (
        <CredentialsModal
          creds={credentials}
          onClose={() => setCredentials(null)}
        />
      )}
    </div>
  );
}

// ── Credentials modal — shown after addMember + resetPassword ────
// The plaintext password is visible exactly once. Once this modal closes
// it is gone forever — there is no read endpoint and no DB column.

function CredentialsModal({
  creds,
  onClose,
}: {
  creds: {
    full_name: string;
    email: string;
    password: string;
    title: string;
    description: string;
  };
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);

  const blob = `Email: ${creds.email}\nPassword: ${creds.password}\nURL: ${ADMIN_LOGIN_URL}`;

  async function copyAll() {
    try {
      await navigator.clipboard.writeText(blob);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard write blocked — leave the user to copy manually.
    }
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md overflow-hidden rounded-2xl bg-white shadow-2xl">
        <div className="px-6 py-5 text-center">
          <div className="mx-auto mb-3 flex size-12 items-center justify-center rounded-full bg-green-100">
            <CheckCircle className="size-6 text-green-600" strokeWidth={2} />
          </div>
          <h3 className="font-heading text-lg font-bold text-gray-900">
            {creds.title}
          </h3>
          <p className="mt-1 text-xs text-gray-500">
            {creds.description}{" "}
            <span className="font-semibold text-gray-700">{creds.full_name}</span>
            :
          </p>
        </div>

        <div className="mx-6 mb-4 flex flex-col gap-2 rounded-xl border border-gray-100 bg-gray-50 p-4 font-mono text-[12px] text-gray-700">
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
              href={ADMIN_LOGIN_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="font-semibold text-[#7E47FF] hover:underline"
            >
              {ADMIN_LOGIN_URL}
            </a>
          </div>
        </div>

        <p className="mx-6 mb-4 rounded-lg bg-amber-50 px-3 py-2 text-[11px] text-amber-700">
          This password is shown <strong>once</strong>. Copy it now — there is
          no way to retrieve it later.
        </p>

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
            className="flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-[#49D7A7] py-2.5 text-sm font-semibold text-[#1a4f3a] transition-opacity hover:opacity-90"
          >
            <CheckCircle className="size-4" strokeWidth={2.5} />
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
