import "server-only";
import { removeApplicationFiles } from "@/lib/application-files";
import {
  deleteApplicationInterviews,
  deleteUnlinkedCompanyInterviews,
} from "@/lib/interviews/application-deletion";
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
 * ── Every file, or stop ──────────────────────────────────────
 *
 * Each applicant goes through the same two services as an applicant deletion
 * (B7): deleteApplicationInterviews, then removeApplicationFiles, then the
 * row. The first file left stops the call with its honest message, before that
 * applicant's row and before anything after it; a retry finishes it. A CV
 * another record still holds (findSharedPaths) stays for that record.
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
  | ({ ok: true; done: boolean } & CompanyDeletionProgress)
  | ({ ok: false; error: string } & CompanyDeletionProgress);

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
  opts: { batch?: number } = {},
): Promise<CompanyDeletionResult> {
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

  // 2. One batch of applicants, each whole or the call stops.
  const { data, error } = await service
    .from("job_applications")
    .select("id, cv_path")
    .eq("company_id_snapshot", companyId)
    .order("id", { ascending: true })
    .limit(opts.batch ?? BATCH);
  if (error) return fail(NOT_DONE);
  const batch = (data ?? []) as { id: string; cv_path: string | null }[];
  for (const app of batch) {
    const interviews = await deleteApplicationInterviews(service, companyId, app.id);
    if (!interviews.ok) return fail(interviews.error);
    const files = await removeApplicationFiles(service, companyId, app.id, app.cv_path);
    if (!files.ok) return fail(files.error);
    const { error: rowErr } = await service
      .from("job_applications")
      .delete()
      .eq("id", app.id)
      .eq("company_id_snapshot", companyId);
    if (rowErr) return fail(NOT_DONE);
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

  // 5. Nothing left: the company row, and its cascades.
  const { count: sessions, error: sErr } = await service
    .from("interview_sessions")
    .select("id", { count: "exact", head: true })
    .eq("company_id", companyId);
  if (sErr || (sessions ?? 0) > 0) return fail(NOT_DONE);
  const { error: cErr } = await service.from("companies").delete().eq("id", companyId);
  if (cErr) return fail(NOT_DONE);
  console.log(`[company-deletion] company ${companyId}: deleted`);
  return { ok: true, done: true, applicantsDeleted: deleted, applicantsLeft: 0 };
}
