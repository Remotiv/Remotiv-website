import "server-only";
import { isSuperAdminEmail } from "@/app/admin/lib/roles";
import { deleteForRemotiv } from "@/lib/applicant-deletion-complete";
import { sweepCleanupsForCompany } from "@/lib/calendar/cleanups";
import { disconnectAllForCompany, disconnectAllForMember } from "@/lib/calendar/connections";
import { deleteUnlinkedCompanyInterviews } from "@/lib/interviews/application-deletion";
import { removeObjects } from "@/lib/storage-objects";
import type { createServiceClient } from "@/lib/supabase/server";

/**
 * Delete a company and everything it holds about candidates: every applicant
 * with their interviews, recordings and CV, its interviews that belong to no
 * applicant, its WhatsApp inbox, then the company row, whose cascades take the
 * rest (jobs, members, plans, messages, notifications, bookings, final
 * interviews, queued jobs). For a super admin only (admin/companies).
 *
 * ── Resumable ────────────────────────────────────────────────
 *
 * One call does one batch of BATCH applicants and returns how far it got. The
 * company is archived (the dashboard refuses it) and its jobs closed (no one
 * can apply) on the first call, so nothing new arrives while it runs. Calling
 * again carries on: the applicants already deleted are gone, so the next batch
 * is simply the next ones. The company row goes only once no applicant and no
 * interview is left; until then it stays, archived, and the super admin sees
 * how many applicants are left.
 *
 * ── Each applicant through the safe pipeline (#69 step 5) ─────
 *
 * Each applicant goes through the same delete as a single applicant
 * (deleteForRemotiv, applicant-deletion-complete.ts): 071's Close (every link
 * closed, queued sends failed, nothing new can start), Google (each event
 * removed; a connected calendar that does not confirm stops the call), the
 * interview and CV files, then Finish. All of it runs BEFORE anything
 * cascades, while the company's calendar connections still exist. The first
 * failure stops the call with its honest message; a retry carries on. A CV
 * another record still holds (findSharedPaths) stays for that record.
 *
 * ── The company's own tail ───────────────────────────────────
 *
 * Once no applicant is left, before the company row:
 *   - its open calendar cleanups are tried while the hosts' tokens still work
 *     (the rows and the tokens go with the company);
 *   - every member's calendar connection is revoked at Google, then deleted
 *     (disconnectAllForMember, the removeMember rule: a revoke Google does not
 *     confirm still deletes the row, and the super admin is told);
 *   - its logos (company-logos/<company_id>/) are removed, every one or stop.
 * After the company row, the logins of its owner and members are deleted
 * ONLY when they belong to nothing else (see deleteLoginsIfUnused).
 *
 * ── Only this company ────────────────────────────────────────
 *
 * Applicants by company_id_snapshot, interviews, jobs and inbox rows by
 * company_id, and every write filtered by it again. Never by email or name.
 * Remotiv's own applicants (company_id_snapshot null) cannot match.
 *
 * ── Kept ─────────────────────────────────────────────────────
 *
 * usage_events (the allowance's record; migration 052 drops its cascade),
 * company_plan_history, and the access logs (signed_url_logs,
 * admin_access_logs): ids and counts only, no foreign key to the company.
 *
 * A company row that is already gone (deleted before this existed) is not an
 * error: its leftover applicants are deleted the same way.
 */

type Service = ReturnType<typeof createServiceClient>;

/** Applicants per call. */
export const BATCH = 25;
const NOT_DONE = "The company could not be deleted yet - try again.";

export type CompanyDeletionProgress = {
  /** Applicants deleted by this call. */
  applicantsDeleted: number;
  /** Applicants of this company still there after this call. */
  applicantsLeft: number;
};

export type CompanyDeletionResult =
  | ({ ok: true; done: boolean; warnings?: string[] } & CompanyDeletionProgress)
  | ({ ok: false; error: string } & CompanyDeletionProgress);

/** The per-applicant delete. deleteForRemotiv in production; a test passes its own. */
export type DeleteApplicant = typeof deleteForRemotiv;

/** deleteForRemotiv's answer when the applicant is already gone: not a failure here. */
const APPLICANT_GONE = "__applicant_gone__";

const LOGO_BUCKET = "company-logos";
/** Logos listed per page, and pages per call: a folder still not empty after that stops the call. */
const LOGO_PAGE = 100;
const LOGO_ROUNDS = 20;

async function applicantsLeft(service: Service, companyId: string): Promise<number | null> {
  const { count, error } = await service
    .from("job_applications")
    .select("id", { count: "exact", head: true })
    .eq("company_id_snapshot", companyId);
  return error ? null : (count ?? 0);
}

export async function deleteCompanyData(
  service: Service,
  companyId: string,
  opts: { batch?: number; deleteApplicant?: DeleteApplicant } = {},
): Promise<CompanyDeletionResult> {
  const deleteApplicant = opts.deleteApplicant ?? deleteForRemotiv;
  let deleted = 0;
  const progress = async (): Promise<CompanyDeletionProgress> => ({
    applicantsDeleted: deleted,
    applicantsLeft: (await applicantsLeft(service, companyId)) ?? -1,
  });
  const fail = async (error: string): Promise<CompanyDeletionResult> => ({
    ok: false,
    error,
    ...(await progress()),
  });
  if (!companyId) return { ok: false, error: NOT_DONE, applicantsDeleted: 0, applicantsLeft: -1 };

  // 1. Frozen, with existing states: the company archived, its jobs closed.
  const archived = await service
    .from("companies")
    .update({ status: "archived" })
    .eq("id", companyId);
  if (archived.error) return fail(NOT_DONE);
  const closed = await service
    .from("jobs")
    .update({ status: "closed" })
    .eq("company_id", companyId)
    .neq("status", "closed");
  if (closed.error) return fail(NOT_DONE);

  // 2. One batch of applicants, each through the whole pipeline or the call stops.
  const { data, error } = await service
    .from("job_applications")
    .select("id, cv_path, job_id")
    .eq("company_id_snapshot", companyId)
    .order("id", { ascending: true })
    .limit(opts.batch ?? BATCH);
  if (error) return fail(NOT_DONE);
  const batch = (data ?? []) as { id: string; cv_path: string | null; job_id: string | null }[];
  for (const app of batch) {
    const one = await deleteApplicant(
      service,
      {
        applicationId: app.id,
        applicationCompany: companyId,
        cvPath: app.cv_path,
        jobId: app.job_id,
        anyway: false,
      },
      APPLICANT_GONE,
    );
    if (!one.success) {
      if (one.error === APPLICANT_GONE) continue;
      return fail(one.error);
    }
    deleted += 1;
  }
  const left = await applicantsLeft(service, companyId);
  if (left === null) return fail(NOT_DONE);
  if (left > 0) return { ok: true, done: false, applicantsDeleted: deleted, applicantsLeft: left };

  // 3. Its interviews that belong to no applicant.
  const unlinked = await deleteUnlinkedCompanyInterviews(service, companyId);
  if (!unlinked.ok) return fail(unlinked.error);

  // 4. Its WhatsApp inbox (its foreign key would only set the company to null).
  const inbox = await service.from("whatsapp_inbound").delete().eq("company_id", companyId);
  if (inbox.error) return fail(NOT_DONE);

  // 4b. Its open calendar cleanups, tried while the hosts' tokens still work.
  const eventsLeft = await sweepCleanupsForCompany(companyId);

  // 4c. Every member's calendar connection: revoked at Google, then deleted,
  //     before the company row would cascade them away unrevoked.
  const { data: memberRows, error: mErr } = await service
    .from("company_members")
    .select("id, user_id")
    .eq("company_id", companyId);
  if (mErr) return fail(NOT_DONE);
  const members = (memberRows ?? []) as { id: string; user_id: string | null }[];
  let unconfirmed = 0;
  for (const m of members) {
    const out = await disconnectAllForMember(m.id);
    if (!out.ok || out.results.some((r) => !r.deleted)) return fail(NOT_DONE);
    unconfirmed += out.results.filter((r) => !r.revokedAtProvider).length;
  }

  // 4d. Its logos: every object under company-logos/<company_id>/, a page at a
  //     time until the folder lists empty, or stop.
  for (let round = 0; ; round++) {
    if (round === LOGO_ROUNDS) return fail(NOT_DONE);
    const listed = await service.storage.from(LOGO_BUCKET).list(companyId, { limit: LOGO_PAGE });
    if (listed.error) return fail(NOT_DONE);
    const logos = (listed.data ?? []).map((o) => `${companyId}/${o.name}`);
    if (logos.length === 0) break;
    const removed = await removeObjects(service, LOGO_BUCKET, logos);
    if (!removed.complete) return fail(NOT_DONE);
  }

  // The logins to consider afterwards: the owner's and every member's.
  const { data: ownerRow } = await service
    .from("companies")
    .select("user_id")
    .eq("id", companyId)
    .maybeSingle();
  const logins = [
    ...new Set(
      [
        (ownerRow as { user_id: string | null } | null)?.user_id,
        ...members.map((m) => m.user_id),
      ].filter((u): u is string => typeof u === "string" && u !== ""),
    ),
  ];

  // 5. Nothing left: the company row, and its cascades.
  const { count: sessions, error: sErr } = await service
    .from("interview_sessions")
    .select("id", { count: "exact", head: true })
    .eq("company_id", companyId);
  if (sErr || (sessions ?? 0) > 0) return fail(NOT_DONE);
  // 5a. Right before the row: any calendar connection the company still has
  //     (one made after step 4c) is revoked and deleted by the same rule, so
  //     the cascade never takes a token unrevoked. A row that will not delete
  //     stops the call; a retry carries on.
  const late = await disconnectAllForCompany(companyId);
  if (!late.ok || late.results.some((r) => !r.deleted)) {
    console.error(
      `[company-deletion] company ${companyId}: calendar connection not disconnected before the row (${late.ok ? "delete_failed" : "read_failed"})`,
    );
    return fail(NOT_DONE);
  }
  unconfirmed += late.results.filter((r) => !r.revokedAtProvider).length;
  const { error: cErr } = await service.from("companies").delete().eq("id", companyId);
  if (cErr) return fail(NOT_DONE);

  // 6. The logins, only those that belong to nothing else.
  const loginOutcome = await deleteLoginsIfUnused(service, logins);
  console.log(
    `[company-deletion] company ${companyId}: deleted; logins deleted=${loginOutcome.deleted} in use=${loginOutcome.inUse} unchecked=${loginOutcome.unchecked} delete failed=${loginOutcome.failed}; calendar revokes unconfirmed=${unconfirmed}; calendar events maybe left=${eventsLeft ?? "unknown"}`,
  );

  const warnings: string[] = [];
  if (loginOutcome.failed > 0) {
    warnings.push(
      `${loginOutcome.failed} login${loginOutcome.failed === 1 ? "" : "s"} could not be deleted; remove ${loginOutcome.failed === 1 ? "it" : "them"} in Supabase Auth.`,
    );
  }
  if (loginOutcome.unchecked > 0) {
    warnings.push(
      `${loginOutcome.unchecked} login${loginOutcome.unchecked === 1 ? "" : "s"} could not be checked for other access and ${loginOutcome.unchecked === 1 ? "was" : "were"} kept; check ${loginOutcome.unchecked === 1 ? "it" : "them"} in Supabase Auth.`,
    );
  }
  if (unconfirmed > 0) {
    warnings.push(
      `Google did not confirm that Remotiv's access was removed for ${unconfirmed} calendar connection${unconfirmed === 1 ? "" : "s"}. Each person can remove Remotiv under their Google Account > Security > Third-party access.`,
    );
  }
  if (eventsLeft === null || eventsLeft > 0) {
    warnings.push(
      eventsLeft === null
        ? "Some calendar events for deleted applicants may still be in the hosts' Google Calendars."
        : `${eventsLeft} calendar event${eventsLeft === 1 ? "" : "s"} for deleted applicants could not be removed and may still be in the hosts' Google Calendars.`,
    );
  }
  return {
    ok: true,
    done: true,
    applicantsDeleted: deleted,
    applicantsLeft: 0,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

/**
 * Delete each login that belongs to nothing else (Q10, decided 23 Nov 2026):
 * only when the user has NO membership of another company. Also kept, because
 * deleting them would lock someone out of something this delete is not about:
 * a Remotiv admin (admin_users) or super admin, a client-portal user
 * (clients) and a talent profile's owner (talent_profiles). The company's own
 * membership rows are already gone with the company, so any membership left
 * is another company's. A check that cannot be answered keeps the login.
 * Returns the counts, so nothing is kept or left silently: a login whose check
 * could not be answered (unchecked) or whose delete failed (failed) becomes a
 * warning for the super admin. Never logs an id or an address.
 */
type LoginOutcome = { deleted: number; inUse: number; unchecked: number; failed: number };

async function deleteLoginsIfUnused(service: Service, userIds: string[]): Promise<LoginOutcome> {
  const out: LoginOutcome = { deleted: 0, inUse: 0, unchecked: 0, failed: 0 };
  for (const userId of userIds) {
    // Each table named literally, so the tenant-surface scans can follow it.
    const head = { count: "exact", head: true } as const;
    const checks = await Promise.all([
      service.from("company_members").select("user_id", head).eq("user_id", userId),
      service.from("admin_users").select("user_id", head).eq("user_id", userId),
      service.from("clients").select("user_id", head).eq("user_id", userId),
      service.from("talent_profiles").select("user_id", head).eq("user_id", userId),
    ]);
    if (checks.some(({ count, error }) => !error && (count ?? 0) > 0)) {
      out.inUse += 1;
      continue;
    }
    if (checks.some(({ error }) => Boolean(error))) {
      console.error(
        "[company-deletion] a login was kept: its other access could not be checked (check_failed)",
      );
      out.unchecked += 1;
      continue;
    }
    const { data, error: userErr } = await service.auth.admin.getUserById(userId);
    if (userErr) {
      console.error(
        `[company-deletion] a login was kept: it could not be read (${userErr.status ?? "error"})`,
      );
      out.unchecked += 1;
      continue;
    }
    if (isSuperAdminEmail(data?.user?.email)) {
      out.inUse += 1;
      continue;
    }
    const { error } = await service.auth.admin.deleteUser(userId);
    if (error) {
      console.error(`[company-deletion] a login could not be deleted (${error.status ?? "error"})`);
      out.failed += 1;
      continue;
    }
    out.deleted += 1;
  }
  return out;
}
