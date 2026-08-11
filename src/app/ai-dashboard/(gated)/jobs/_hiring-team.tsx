"use client";

import { useCallback, useEffect, useState } from "react";
import { Eye, Plus, Trash, UserRound } from "lucide-react";
import {
  TEAM_ROLE_LABELS,
  TEAM_ROLES,
  type JobTeamRole,
} from "@/app/ai-dashboard/lib/company-roles";
import type { HiringTeamMember } from "@/app/ai-dashboard/lib/job-scope";
import {
  addToHiringTeam,
  fetchAssignableMembers,
  fetchHiringTeam,
  removeFromHiringTeam,
  updateHiringTeamRole,
} from "./team-actions";

/**
 * A job's hiring team.
 *
 * Two lists on purpose. "On this job" is the assignment — presence here is
 * what grants a recruiter or hiring manager access. "Also has access" names
 * the owners and admins who see every job without being assigned, so it is
 * never a mystery why someone can see a role nobody added them to, or why
 * removing an admin from the list does nothing.
 *
 * The team_role beside each name is a LABEL, not a permission. The copy says
 * so rather than leaving a reader to infer that "coordinator" is a tier.
 */

const SELECT_CLS =
  "rounded-[9px] border border-[var(--ai-line-strong)] bg-[var(--ai-surface)] px-2.5 py-1.5 text-xs font-semibold text-[var(--ai-t2)] outline-none transition-colors hover:border-[var(--ai-t4)] focus:border-remotiv-purple focus:ring-[3px] focus:ring-remotiv-purple/[0.16] disabled:cursor-not-allowed disabled:opacity-60";

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return parts.slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?";
}

export function HiringTeamSection({
  jobId,
  onToast,
}: {
  jobId: string;
  onToast?: (message: string) => void;
}) {
  const [assigned, setAssigned] = useState<HiringTeamMember[]>([]);
  const [siteWide, setSiteWide] = useState<{ name: string; accountRole: string }[]>([]);
  const [canManage, setCanManage] = useState(false);
  const [candidates, setCandidates] = useState<
    { id: string; name: string; email: string; accountRole: string }[]
  >([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [pickMember, setPickMember] = useState("");
  const [pickRole, setPickRole] = useState<JobTeamRole>("recruiter");

  const load = useCallback(async () => {
    try {
      const [team, members] = await Promise.all([
        fetchHiringTeam(jobId),
        fetchAssignableMembers(),
      ]);
      setAssigned(team.assigned);
      setSiteWide(team.siteWide);
      setCanManage(team.canManage);
      setCandidates(members);
    } catch {
      setAssigned([]);
      setSiteWide([]);
      setCanManage(false);
    } finally {
      setLoading(false);
    }
  }, [jobId]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  const assignedIds = new Set(assigned.map((a) => a.memberId));
  const addable = candidates.filter((c) => !assignedIds.has(c.id));

  async function handleAdd() {
    if (!pickMember) return;
    setBusy(true);
    const result = await addToHiringTeam({
      jobId,
      memberId: pickMember,
      teamRole: pickRole,
    });
    setBusy(false);
    if (!result.success) {
      onToast?.(result.error);
      return;
    }
    setPickMember("");
    setAdding(false);
    onToast?.("Added to the hiring team");
    await load();
  }

  async function handleRole(memberId: string, teamRole: JobTeamRole) {
    setAssigned((prev) =>
      prev.map((a) => (a.memberId === memberId ? { ...a, teamRole } : a)),
    );
    const result = await updateHiringTeamRole({ jobId, memberId, teamRole });
    if (!result.success) {
      onToast?.(result.error);
      await load();
    }
  }

  async function handleRemove(member: HiringTeamMember) {
    setBusy(true);
    const result = await removeFromHiringTeam({ jobId, memberId: member.memberId });
    setBusy(false);
    if (!result.success) {
      onToast?.(result.error);
      return;
    }
    onToast?.(`${member.name} removed from this job`);
    await load();
  }

  if (loading) {
    return <div className="h-[11px] w-1/2 animate-pulse rounded-full bg-[var(--ai-inset)]" />;
  }

  return (
    <div className="flex flex-col gap-2.5">
      {assigned.length === 0 && (
        <p className="m-0 text-[13px] italic text-[var(--ai-t4)]">
          Nobody is assigned to this job yet.
        </p>
      )}

      {assigned.map((m) => (
        <div
          key={m.id}
          className="flex items-center gap-2.5 rounded-xl border border-[var(--ai-line)] bg-[var(--ai-surface)] px-3 py-2.5"
        >
          <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-[var(--ai-purple-tint)] text-[11px] font-bold text-[var(--ai-purple-ink)]">
            {initialsOf(m.name)}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-bold text-[var(--ai-t1)]">
              {m.name}
            </span>
            <span className="block truncate text-[11.5px] text-[var(--ai-t3)]">
              {m.accountRole}
            </span>
          </span>

          {canManage ? (
            <>
              <select
                value={m.teamRole}
                aria-label={`${m.name}'s role on this job`}
                onChange={(e) => {
                  void handleRole(m.memberId, e.target.value as JobTeamRole);
                }}
                className={`${SELECT_CLS} cursor-pointer appearance-none`}
              >
                {TEAM_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {TEAM_ROLE_LABELS[r]}
                  </option>
                ))}
              </select>
              <button
                type="button"
                disabled={busy}
                aria-label={`Remove ${m.name} from this job`}
                onClick={() => {
                  void handleRemove(m);
                }}
                className="flex size-8 shrink-0 items-center justify-center rounded-[9px] text-[var(--ai-t4)] transition-colors hover:bg-[var(--ai-danger-tint)] hover:text-[var(--ai-danger)] disabled:opacity-50"
              >
                <Trash className="size-3.5" strokeWidth={2} />
              </button>
            </>
          ) : (
            <span className="shrink-0 rounded-full bg-[var(--ai-slate-tint)] px-2.5 py-1 text-[11px] font-bold text-[var(--ai-slate-ink)]">
              {TEAM_ROLE_LABELS[m.teamRole]}
            </span>
          )}
        </div>
      ))}

      {canManage &&
        (adding ? (
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-dashed border-[var(--ai-line-strong)] bg-[var(--ai-inset)] px-3 py-2.5">
            <select
              value={pickMember}
              aria-label="Team member"
              onChange={(e) => setPickMember(e.target.value)}
              className={`${SELECT_CLS} min-w-0 flex-1 cursor-pointer appearance-none`}
            >
              <option value="">Choose someone…</option>
              {addable.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} — {c.accountRole}
                </option>
              ))}
            </select>
            <select
              value={pickRole}
              aria-label="Role on this job"
              onChange={(e) => setPickRole(e.target.value as JobTeamRole)}
              className={`${SELECT_CLS} cursor-pointer appearance-none`}
            >
              {TEAM_ROLES.map((r) => (
                <option key={r} value={r}>
                  {TEAM_ROLE_LABELS[r]}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={!pickMember || busy}
              onClick={() => {
                void handleAdd();
              }}
              className="rounded-[9px] bg-remotiv-purple px-3 py-1.5 text-xs font-bold text-white transition-colors hover:bg-[var(--ai-purple-hover)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              Add
            </button>
            <button
              type="button"
              onClick={() => setAdding(false)}
              className="px-1 text-xs font-semibold text-[var(--ai-t3)] hover:text-[var(--ai-t1)]"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setAdding(true)}
            disabled={addable.length === 0}
            className="inline-flex w-fit items-center gap-2 rounded-xl border-[1.5px] border-dashed border-[var(--ai-line-strong)] px-3 py-2 text-xs font-bold text-[var(--ai-t2)] transition-colors hover:border-solid hover:border-remotiv-purple hover:bg-[var(--ai-purple-tint)] hover:text-remotiv-purple disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Plus className="size-3.5" strokeWidth={2.4} />
            {addable.length === 0 ? "Everyone is already on this job" : "Add someone"}
          </button>
        ))}

      {/* Who else can see this, and why. Without it, an owner appearing on
          candidates they were never assigned to reads as a bug. */}
      <div className="mt-1 rounded-xl border border-[var(--ai-line)] bg-[var(--ai-inset)] px-3 py-2.5">
        <p className="m-0 mb-1.5 flex items-center gap-1.5 text-[10.5px] font-extrabold uppercase tracking-[0.08em] text-[var(--ai-t3)]">
          <Eye className="size-3 shrink-0" strokeWidth={2.2} />
          Who can see this job
        </p>
        <p className="m-0 text-[11.5px] leading-relaxed text-[var(--ai-t3)]">
          {assigned.length > 0 && (
            <>
              <b className="font-bold text-[var(--ai-t2)]">
                {assigned.map((a) => a.name).join(", ")}
              </b>
              {siteWide.length > 0 ? ", plus " : "."}
            </>
          )}
          {siteWide.length > 0 && (
            <>
              <b className="font-bold text-[var(--ai-t2)]">
                {siteWide.map((s) => s.name).join(", ")}
              </b>{" "}
              — owners and admins see every job without being assigned.
            </>
          )}
          {assigned.length === 0 && siteWide.length === 0 && (
            <>Only owners and admins can see this job.</>
          )}
        </p>
        <p className="m-0 mt-1.5 flex items-start gap-1.5 text-[11px] leading-relaxed text-[var(--ai-t4)]">
          <UserRound className="mt-px size-3 shrink-0" strokeWidth={2} />
          The role beside each name describes what they do on this job. Being on
          the list is what grants access, not which role is picked.
        </p>
      </div>
    </div>
  );
}
